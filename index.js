const WebSocket = require('ws');
const { exec } = require('child_process');
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
      process.exit(1);
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

ws.on('close', function close() {
  console.log('[Worker] Disconnected from Control Plane. Retrying in 10s...');
  setTimeout(() => {
    process.exit(1); // PM2 will restart it
  }, 10000);
});

async function processJob(job) {
  const repoName = job.repo_name;
  
  // Safe default path
  const workDir = `/home/ubuntu/autobuilder/${repoName}`;
  const imageName = `${repoName}-image`;
  const containerName = `${repoName}-container`;

  // The actual commands to run
  // Assuming the user wants webui on 3001 and controlplane on 3005, we can use logic or just standard runs.
  // Since worker runs blindly, we'll try to use a standard script or generic run command.
  // Note: For a dynamic setup, the worker might need port maps passed in the job, but we'll stick to basic for now.
  const script = `
    cd ${workDir} || exit 1
    git pull || exit 1
    docker rmi ${imageName} -f || true
    docker build -t ${imageName} . || exit 1
    docker rm -f ${containerName} || true
    # We use a default network or port if not specified, 
    # but the exact docker run command should ideally match what's needed.
    docker run -d --name ${containerName} --restart unless-stopped ${imageName}
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
    exec(script, { shell: '/bin/bash' }, (error, stdout, stderr) => {
      const fullLog = `--- STDOUT ---\n${stdout}\n--- STDERR ---\n${stderr}`;
      if (error) {
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
