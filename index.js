const WebSocket = require('ws');
const { exec, spawn } = require('child_process');
const os = require('os');
const si = require('systeminformation');
const Docker = require('dockerode');

// Assuming a standard Docker socket setup. If on Windows it might differ, but typical Linux is /var/run/docker.sock
const docker = new Docker(); 

const CONTROL_PLANE_HOST = process.env.CONTROL_PLANE_HOST || '51.81.87.208:3005';
const NODE_ID = os.hostname();

const ws = new WebSocket(`ws://${CONTROL_PLANE_HOST}/worker/ws`);

console.log(`[Worker] Connecting to ws://${CONTROL_PLANE_HOST}/worker/ws`);

let isProcessing = false;
const containerLogStreams = {};

// Keep-alive to prevent load balancers/proxies from dropping idle connections
setInterval(() => {
  if (ws.readyState === WebSocket.OPEN) {
    ws.ping();
  }
}, 15000);

ws.on('open', function open() {
  console.log('[Worker] Connected to Control Plane');
  // Initially idle
  ws.send('idle');
});

ws.on('message', async function message(data) {
  const msgStr = data.toString();
  console.log(`[Worker] Received: ${msgStr}`);

  try {
    const msg = JSON.parse(msgStr);

    if (msg.error) {
      console.error('[Worker] Fatal Error from Control Plane:', msg.error);
      ws.close(); // Let the close handler manage the retry
      return;
    }

    if (msg.type === 'no_job') {
      // Wait a bit, then report idle again
      setTimeout(() => {
        if (!isProcessing && ws.readyState === WebSocket.OPEN) {
          ws.send('idle');
        }
      }, 5000);
      return;
    }

    if (msg.type === 'job') {
      isProcessing = true;
      const job = msg.payload;
      console.log(`[Worker] Starting job for ${job.repo_name}`);

      await processJob(job);
      
      console.log(`[Worker] Job finished. Reporting idle.`);
      isProcessing = false;
      ws.send('idle');
      return;
    }

    if (msg.type === 'start_container_log') {
      const containerName = msg.payload?.container_name;
      if (!containerName) return;
      if (containerLogStreams[containerName]) return; // Already streaming

      console.log(`[Worker] Starting live log stream for container: ${containerName}`);
      const logProcess = spawn('docker', ['logs', '-f', '--tail', '100', containerName]);
      containerLogStreams[containerName] = logProcess;

      logProcess.stdout.on('data', (data) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'container_log',
            payload: { container_name: containerName, data: data.toString() }
          }));
        }
      });

      logProcess.stderr.on('data', (data) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'container_log',
            payload: { container_name: containerName, data: data.toString() }
          }));
        }
      });

      logProcess.on('close', () => {
        delete containerLogStreams[containerName];
      });
      return;
    }

    if (msg.type === 'stop_container_log') {
      const containerName = msg.payload?.container_name;
      if (containerName && containerLogStreams[containerName]) {
        console.log(`[Worker] Stopping live log stream for container: ${containerName}`);
        containerLogStreams[containerName].kill();
        delete containerLogStreams[containerName];
      }
      return;
    }
  } catch (err) {
    console.error('[Worker] Error processing message:', err);
  }
});

ws.on('error', async function error(err) {
  console.error('[Worker] WebSocket error:', err.message);
  await sendLog('system', 'failure', `WebSocket connection error: ${err.message}`);
});

ws.on('close', function close() {
  console.log('[Worker] Disconnected from Control Plane. Retrying in 10s...');
  setTimeout(() => {
    process.exit(1); // PM2 will restart it
  }, 10000);
});

async function processJob(job) {
  const repoName = job.repo_name;
  const commitId = job.commit_id;
  
  // Safe default path, dynamically received from Control Plane / MySQL
  const workDir = job.deploy_path || `/home/ubuntu/${repoName}`;
  const imageName = `${repoName}-image`;
  const containerName = job.container_name || `${repoName}-container`;

  const portArg = job.port_mapping ? `-p ${job.port_mapping}` : '';
  const cloneUrl = job.clone_url || `https://github.com/${repoName}.git`;

  // The actual commands to run
  const script = `
    echo "[Bash] Setting up repository..."
    if [ ! -d "${workDir}" ]; then
      echo "Repository not found locally. Cloning..."
      sudo mkdir -p "$(dirname "${workDir}")" || exit 1
      sudo chown -R $(whoami) "$(dirname "${workDir}")" || exit 1
      cd "$(dirname "${workDir}")" || exit 1
      git clone ${cloneUrl} "${workDir}" || exit 1
    fi
    cd ${workDir} || exit 1
    
    echo "[Bash] Updating remote and pulling..."
    # Securely update the remote URL in case the token changed
    git remote set-url origin ${cloneUrl}
    git pull || exit 1
    
    echo "[Bash] Removing old container if exists..."
    # Delete the old container (only if it exists) to free memory before build
    if [ "$(docker ps -aq -f name=^${containerName}$ 2> /dev/null)" ]; then docker rm -f ${containerName}; fi

    echo "[Bash] Removing old image if exists..."
    # Delete old image (only if it exists to avoid messy error logs)
    if [ "$(docker images -q ${imageName} 2> /dev/null)" ]; then docker rmi -f ${imageName}; fi
    
    echo "[Bash] Building new image..."
    # Build the new image
    docker build -t ${imageName} . || exit 1
    
    echo "[Bash] Cleaning up repository files..."
    # Delete the repo to save disk space
    cd ..
    rm -rf "${workDir}"
    
    echo "[Bash] Starting new container..."
    # Build new container and start new (using host network)
    docker run -d --name ${containerName} --network host --restart unless-stopped ${portArg} ${imageName}
    
    echo "[Bash] Pruning docker system..."
    # Prune system to save space
    docker system prune -a --volumes -f
    
    echo "[Bash] Deployment script finished successfully."
  `;

  try {
    const output = await executeShell(script, repoName, commitId);
    await sendLog(repoName, commitId, 'success', output, containerName);
  } catch (err) {
    console.error(`[Worker] Job failed: ${err.message}`);
    await sendLog(repoName, commitId, 'failure', err.message + '\n' + err.output, containerName);
  }
}


function executeShell(script, repoName, commitId) {
  return new Promise((resolve, reject) => {
    console.log(`[Worker] Executing deployment script...`);
    const child = spawn('/bin/bash', ['-c', script]);
    
    let fullLog = '';
    
    child.stdout.on('data', (data) => {
      process.stdout.write(data); // Stream live to PM2 logs
      const chunk = data.toString();
      fullLog += chunk;
      if (ws.readyState === WebSocket.OPEN && repoName && commitId) {
        ws.send(JSON.stringify({ type: 'live_log', payload: { repo_name: repoName, commit_id: commitId, data: chunk } }));
      }
    });
    
    child.stderr.on('data', (data) => {
      process.stderr.write(data); // Stream live to PM2 logs
      const chunk = data.toString();
      fullLog += chunk;
      if (ws.readyState === WebSocket.OPEN && repoName && commitId) {
        ws.send(JSON.stringify({ type: 'live_log', payload: { repo_name: repoName, commit_id: commitId, data: chunk } }));
      }
    });
    
    child.on('error', (err) => {
      console.error(`[Worker] Script execution error:`, err);
      err.output = fullLog;
      reject(err);
    });

    child.on('close', (code) => {
      console.log(`[Worker] Script finished with exit code ${code}`);
      if (code !== 0) {
        const error = new Error(`Command failed with exit code ${code}`);
        error.output = fullLog;
        reject(error);
      } else {
        resolve(fullLog);
      }
    });
  });
}

async function sendLog(repoName, commitId, status, logOutput, containerName) {
  try {
    const res = await fetch(`http://${CONTROL_PLANE_HOST}/worker/log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        node_id: NODE_ID,
        repo_name: repoName,
        commit_id: commitId,
        status: status,
        log_output: logOutput,
        container_name: containerName
      })
    });
    console.log(`[Worker] Log submitted. Status: ${res.status}`);
  } catch (err) {
    console.error(`[Worker] Failed to submit log:`, err.message);
  }
}

async function collectStats() {
  try {
    const [cpu, mem, fs, net, containers] = await Promise.all([
      si.currentLoad(),
      si.mem(),
      si.fsSize(),
      si.networkStats(),
      docker.listContainers()
    ]);

    const diskPct = fs.length > 0 ? fs[0].use : 0;
    const netRx = net.length > 0 ? net[0].rx_bytes : 0;
    const netTx = net.length > 0 ? net[0].tx_bytes : 0;

    let dockerStats = [];
    for (const container of containers) {
      try {
        const c = docker.getContainer(container.Id);
        const stats = await c.stats({ stream: false });
        
        let cpuPct = 0;
        if (stats.cpu_stats && stats.precpu_stats) {
          const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
          const systemDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
          if (systemDelta > 0.0 && cpuDelta > 0.0) {
            cpuPct = (cpuDelta / systemDelta) * stats.cpu_stats.online_cpus * 100.0;
          }
        }
        
        const memUsage = stats.memory_stats?.usage || 0;
        const netRxContainer = Object.values(stats.networks || {}).reduce((acc, curr) => acc + curr.rx_bytes, 0);
        const netTxContainer = Object.values(stats.networks || {}).reduce((acc, curr) => acc + curr.tx_bytes, 0);

        dockerStats.push({
          id: container.Id.substring(0, 12),
          name: container.Names[0],
          cpu_pct: cpuPct,
          mem_usage: memUsage,
          net_rx: netRxContainer,
          net_tx: netTxContainer
        });
      } catch (err) {
        // Ignore stats errors for individual containers
      }
    }

    const payload = {
      node_id: NODE_ID,
      cpu: cpu.currentLoad,
      mem: (mem.active / mem.total) * 100,
      disk_pct: diskPct,
      net_rx: netRx,
      net_tx: netTx,
      docker_stats: dockerStats
    };

    const res = await fetch(`http://${CONTROL_PLANE_HOST}/worker/stats`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    
    if (!res.ok) {
      console.error(`[Worker] Failed to send stats. Status: ${res.status}`);
    }
  } catch (err) {
    console.error(`[Worker] Error collecting stats:`, err.message);
  }
}

// Start collecting stats every 30 seconds
setInterval(collectStats, 30000);
// Send initial stats shortly after start
setTimeout(collectStats, 2000);
