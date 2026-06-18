#!/bin/bash
# Exit on any error
set -e

# --- Configuration ---
GH_OWNER="kadi1m"
GH_REPO="autobuilder-worker"
TARGET_DIR="/opt/worker"
SERVICE_NAME="worker-update"

# Ensure the script is run as root
if [ "$EUID" -ne 0 ]; then
  echo "❌ Please run this script as root (sudo)."
  exit 1
fi

# Check for required Control Plane token
if [ -z "$1" ]; then
    echo "Usage: sudo ./bootstrap.sh <CONTROL_PLANE_TOKEN>"
    exit 1
fi

CP_TOKEN="$1"

echo "⚙️  Setting up directories..."
mkdir -p "$TARGET_DIR"
cd "$TARGET_DIR"

echo "📦 Downloading latest deploy script from public repository..."
# Fetch the deployment script directly from your main branch
curl -sL -o deploy-worker.sh "https://raw.githubusercontent.com/$GH_OWNER/$GH_REPO/main/deploy-worker.sh"
chmod +x deploy-worker.sh

echo "📝 Creating Systemd Service File..."
cat <<EOF > /etc/systemd/system/${SERVICE_NAME}.service
[Unit]
Description=Pull Latest Worker Repo and Deploy
After=network.target

[Service]
Type=oneshot
User=root
WorkingDirectory=$TARGET_DIR
# Executes the local script using only the Control Plane token
ExecStart=/bin/bash $TARGET_DIR/deploy-worker.sh "$CP_TOKEN"

[Install]
WantedBy=multi-user.target
EOF

echo "📝 Creating Systemd Timer File (5-minute loop)..."
cat <<EOF > /etc/systemd/system/${SERVICE_NAME}.timer
[Unit]
Description=Run worker auto-update every 5 minutes

[Timer]
OnBootSec=1min
OnUnitActiveSec=5min
Persistent=true

[Install]
WantedBy=timers.target
EOF

echo "🔄 Loading automation configs into Systemd..."
systemctl daemon-reload
systemctl enable --now ${SERVICE_NAME}.timer

echo "🚀 Triggering initial worker deployment immediately..."
systemctl start ${SERVICE_NAME}.service

echo "✨ Node bootstrap complete! Your worker is online and auto-updating."