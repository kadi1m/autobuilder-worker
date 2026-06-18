#!/bin/bash
set -e

GH_OWNER="kadi1m"
GH_REPO="autobuilder-worker"
TARGET_DIR="/opt/worker"
SERVICE_NAME="worker-update"

if [ "$EUID" -ne 0 ]; then
  echo "❌ This setup script must be run with administrative privileges. Please use 'sudo bash'."
  exit 1
fi

if [ -z "$1" ]; then
    echo "Usage: curl ... | sudo bash -s -- <CONTROL_PLANE_TOKEN>"
    exit 1
fi
CP_TOKEN="$1"

echo "⚙️  Configuring target directory structure..."
mkdir -p "$TARGET_DIR"
chown -R ubuntu:ubuntu "$TARGET_DIR"

echo "📦 Verifying system runtime dependencies (Node.js/npm)..."
if ! command -v npm &> /dev/null; then
    echo "⚙️ Node.js/npm not found. Installing via NodeSource LTS..."
    curl -fsSL https://deb.nodesource.com/setup_lts.x | bash -
    apt-get install -y nodejs
else
    echo "✅ Node.js/npm is already installed."
fi

echo "🔄 Overwriting and pulling fresh deploy manager script..."
curl -sL -o "$TARGET_DIR/deploy-worker.sh" "https://raw.githubusercontent.com/$GH_OWNER/$GH_REPO/main/deploy-worker.sh"
chmod +x "$TARGET_DIR/deploy-worker.sh"
chown ubuntu:ubuntu "$TARGET_DIR/deploy-worker.sh"

echo "📝 Rewriting systemd target unit specifications..."
cat <<EOF > /etc/systemd/system/${SERVICE_NAME}.service
[Unit]
Description=Pull Latest Worker Repo and Deploy
After=network.target

[Service]
Type=oneshot
User=ubuntu
Group=ubuntu
WorkingDirectory=$TARGET_DIR
ExecStart=/bin/bash $TARGET_DIR/deploy-worker.sh "$CP_TOKEN"

[Install]
WantedBy=multi-user.target
EOF

cat <<EOF > /etc/systemd/system/${SERVICE_NAME}.timer
[Unit]
Description=Run worker auto-update interval timer

[Timer]
OnBootSec=1min
OnUnitActiveSec=5min
Persistent=true

[Install]
WantedBy=timers.target
EOF

echo "🔄 Hard-reloading system configuration states..."
systemctl daemon-reload
systemctl enable --now ${SERVICE_NAME}.timer

echo "🚀 Forcing execution of a completely fresh repository synchronization now..."
systemctl restart ${SERVICE_NAME}.service

echo "✨ Active provisioning complete! Node has been fully wiped and updated."