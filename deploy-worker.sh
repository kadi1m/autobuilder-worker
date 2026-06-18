#!/bin/bash
set -e

GH_OWNER="kadi1m"
GH_REPO="autobuilder-worker"
CONTROL_PLANE_URL="http://51.81.87.208:3005/register"
TARGET_DIR="/opt/worker"

if [ -z "$1" ]; then
    echo "Error: Control Plane token missing."
    exit 1
fi
CP_TOKEN="$1"

# Automatically resolve the host VPS identifier
NODE_ID=$(hostname)
echo "Running deployment tasks on Node: $NODE_ID"

# Download the public repo main branch tarball (No authorization headers required)
echo "Fetching source bundle..."
curl -sL -o source.tar.gz "https://api.github.com/repos/$GH_OWNER/$GH_REPO/tarball/main"

echo "Unpacking source files..."
mkdir -p "$TARGET_DIR/app"
tar -xzf source.tar.gz -C "$TARGET_DIR/app" --strip-components=1
rm source.tar.gz

# --- Custom App Startup / Compilation ---
cd "$TARGET_DIR/app"
echo "Initializing application dependencies..."
# Add your specific runtime setups here:
# npm install && pm2 restart worker OR go build -o worker main.go

echo "Notifying Control Plane..."
curl -X POST "$CONTROL_PLANE_URL" \
  -H "Authorization: Bearer $CP_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"node_id\": \"$NODE_ID\", \"status\": \"active\"}"

echo "Node updated successfully."