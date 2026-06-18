const WebSocket = require('ws');
const { exec, spawn } = require('child_process');
const os = require('os');

const CONTROL_PLANE_HOST = process.env.CONTROL_PLANE_HOST || '51.81.87.208:3005';
const NODE_ID = os.hostname();

const ws = new WebSocket(`ws://${CONTROL_PLANE_HOST}/worker/ws`);

console.log(`[Worker] Connecting to ws://${CONTROL_PLANE_HOST}/worker/ws`);

let isProcessing = false;

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
  
  // Safe default path, dynamically received from Control Plane / MySQL
  const workDir = job.deploy_path || `/home/ubuntu/${repoName}`;
  const imageName = `${repoName}-image`;
  const containerName = job.container_name || `${repoName}-container`;

  const portArg = job.port_mapping ? `-p ${job.port_mapping}` : '';
  const cloneUrl = job.clone_url || `https://github.com/${repoName}.git`;

  // The actual commands to run
  const script = `
    if [ ! -d "${workDir}" ]; then
      echo "Repository not found locally. Cloning..."
      git clone ${cloneUrl} ${workDir} || exit 1
    fi
    cd ${workDir} || exit 1
    
    # Securely update the remote URL in case the token changed
    git remote set-url origin ${cloneUrl}
    git pull || exit 1
    
    # Delete old image (only if it exists to avoid messy error logs)
    if [ "$(docker images -q ${imageName} 2> /dev/null)" ]; then docker rmi -f ${imageName}; fi
    
    # Build the new image (old container is still running here, zero downtime during build!)
    docker build -t ${imageName} . || exit 1
    
    # Delete the old container (only if it exists)
    if [ "$(docker ps -aq -f name=^${containerName}$ 2> /dev/null)" ]; then docker rm -f ${containerName}; fi
    
    # Build new container and start new
    docker run -d --name ${containerName} --restart unless-stopped ${portArg} ${imageName}
  `;

  try {
    const output = await executeShell(script);
    await sendLog(repoName, 'success', output);
  } catch (err) {
    console.error(`[Worker] Job failed: ${err.message}`);
    await sendLog(repoName, 'failure', err.message + '\n' + err.output);
  }
}


function executeShell(script) {
  return new Promise((resolve, reject) => {
    console.log(`[Worker] Executing deployment script...`);
    const child = spawn('/bin/bash', ['-c', script]);
    
    let fullLog = '';
    
    child.stdout.on('data', (data) => {
      process.stdout.write(data); // Stream live to PM2 logs
      fullLog += data.toString();
    });
    
    child.stderr.on('data', (data) => {
      process.stderr.write(data); // Stream live to PM2 logs
      fullLog += data.toString();
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

async function sendLog(repoName, status, logOutput) {
  try {
    const res = await fetch(`http://${CONTROL_PLANE_HOST}/worker/log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        node_id: NODE_ID,
        repo_name: repoName,
        status: status,
        log_output: logOutput
      })
    });
    console.log(`[Worker] Log submitted. Status: ${res.status}`);
  } catch (err) {
    console.error(`[Worker] Failed to submit log:`, err.message);
  }
}
