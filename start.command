#!/bin/bash
# WhatsApp Ordering (Instamart) — double-click launcher for macOS.
# Everything runs on your laptop. Nothing is sent anywhere.

set -e
cd "$(dirname "$0")"

echo ""
echo "=========================================="
echo "  WhatsApp Ordering — starting up"
echo "=========================================="
echo ""

# 1) Check for Node.js.
NODE_LTS="v22.14.0"
NODE_PKG_URL="https://nodejs.org/dist/${NODE_LTS}/node-${NODE_LTS}.pkg"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed."
  echo "Downloading the official installer now: ${NODE_PKG_URL}"
  echo "Run the .pkg, then double-click this file again."
  osascript -e "display alert \"Node.js is not installed\" message \"Your browser will open the official Node.js installer (${NODE_LTS}). Run it, then double-click start.command again.\" as critical" >/dev/null 2>&1 || true
  open "${NODE_PKG_URL}" >/dev/null 2>&1 || open "https://nodejs.org/" >/dev/null 2>&1 || true
  echo ""
  read -p "Press Return to close this window..." _
  exit 1
fi

# 2) Install dependencies on first run.
if [ ! -d "node_modules" ]; then
  echo "First run — installing dependencies (this takes 1-2 minutes)..."
  npm install
fi

# 3) Build TypeScript on first run or if dist/ is missing.
if [ ! -d "dist" ] || [ ! -f "dist/whatsapp-bot.js" ]; then
  echo "Building..."
  npm run build
fi

# 4) Open the browser once the bot has bound a port (auto-retries 3000..3004).
(
  for i in 1 2 3 4 5 6 7 8 9 10; do
    if [ -f "data/server.port" ]; then
      port=$(cat data/server.port 2>/dev/null)
      if [ -n "$port" ]; then
        open "http://localhost:$port"
        exit 0
      fi
    fi
    sleep 1
  done
  # Fallback if the port file never appears.
  open "http://localhost:3000"
) &

echo ""
echo "Bot is starting. Your browser will open to http://localhost:3000 in a moment."
echo "Keep this window open. To stop the bot, close this window or press Ctrl+C."
echo ""

node dist/whatsapp-bot.js
