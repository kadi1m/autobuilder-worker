#!/bin/bash
set -e

GH_OWNER="kadi1m"
GH_REPO="autobuilder-worker"
CONTROL_PLANE_URL="http://51.81.87.208:3005/register"
TARGET_DIR="/opt/worker"

if [ -z "$1" ]; then
    echo "❌ Error: Control Plane registration token is required."
    exit 1
fi
CP_TOKEN="$1"

# Automatically resolve the host identity without manual hardcoding
NODE_ID=$(hostname)
echo "🚀 Beginning worker build tasks on node: $NODE_ID"

# Fetch source code via public archive endpoint
curl -sL -o source.tar.gz "https://api.github.com/repos/$GH_OWNER/$GH_REPO/tarball/main"

mkdir -p "$TARGET_DIR/app"
tar -xzf source.tar.gz -C "$TARGET_DIR/app" --strip-components=1
rm source.tar.gz

# --- Execute App Build Dependencies Here ---
cd "$TARGET_DIR/app"
# e.g., npm install, go build, etc.

# Announce health state to your controller loop
curl -X POST "$CONTROL_PLANE_URL" \
  -H "Authorization: Bearer $CP_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"node_id\": \"$NODE_ID\", \"status\": \"active\"}"

echo "✅ Node sync complete."