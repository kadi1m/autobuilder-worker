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

NODE_ID=$(hostname)
echo "🚀 Beginning worker build tasks on node: $NODE_ID"

# 1. Fetch the absolute latest source archive from the public repo main branch
echo "📥 Fetching complete fresh source bundle from GitHub..."
curl -sL -o /tmp/source.tar.gz "https://api.github.com/repos/$GH_OWNER/$GH_REPO/tarball/main"

# 2. FORCE PURGE old app state to avoid file contamination or caching bugs
echo "🧹 Wiping old installation directory to guarantee a clean state..."
rm -rf "$TARGET_DIR/app"
mkdir -p "$TARGET_DIR/app"

# 3. Extract fresh codebase
echo "📦 Extracting new codebase..."
tar -xzf /tmp/source.tar.gz -C "$TARGET_DIR/app" --strip-components=1
rm /tmp/source.tar.gz

# --- Execute App Build / Runtime Setup Here ---
cd "$TARGET_DIR/app"
echo "🛠️ Compiling/Installing dependencies..."
# Add your execution commands here (e.g., npm install, go build, etc.)

# 4. Notify Control Plane of successful sync
echo "📡 Announcing state to Control Plane..."
curl -X POST "$CONTROL_PLANE_URL" \
  -H "Authorization: Bearer $CP_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"node_id\": \"$NODE_ID\", \"status\": \"active\"}"

echo "✅ Node sync and clean rebuild complete."