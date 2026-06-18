#!/bin/bash
set -e

GH_OWNER="kadi1m"
GH_REPO="autobuilder-worker"
TARGET_DIR="/opt/worker"
SERVICE_NAME="worker-update"

# Enforce that the installer infrastructure setup uses administrative privileges
if [ "$EUID" -ne 0 ]; then
  echo "❌ This setup script must be run with administrative privileges. Please use 'sudo bash'."
  exit 1
fi

if [ -z "$1" ]; then
    echo "Usage: curl ... | sudo bash -s -- <CONTROL_PLANE_TOKEN>"
    exit 1
fi
CP_TOKEN="$1"

echo "⚙️  Configuring environment paths..."
mkdir -p "$TARGET_DIR"
chown -R ubuntu:ubuntu "$TARGET_DIR"

# Fetch execution block
curl -sL -o "$TARGET_DIR/deploy-worker.sh" "https://raw.githubusercontent.com/$GH_OWNER/$GH_REPO/main/deploy-worker.sh"
chmod +x "$TARGET_DIR/deploy-worker.sh"
chown ubuntu:ubuntu "$TARGET_DIR/deploy-worker.sh"

echo "📝 Registering systemd system units..."
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

echo "🔄 Refreshing system orchestration configuration..."
systemctl daemon-reload
systemctl enable --now ${SERVICE_NAME}.timer

# Fire immediate update
systemctl start ${SERVICE_NAME}.service
echo "✨ Active provisioning complete. The system will handle updates cleanly as 'ubuntu'."