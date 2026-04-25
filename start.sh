#!/bin/bash
# WhatsApp Ordering (Instamart) — launcher for Linux.
# Everything runs on your laptop. Nothing is sent anywhere.

set -e
cd "$(dirname "$0")"

echo ""
echo "=========================================="
echo "  WhatsApp Ordering — starting up"
echo "=========================================="
echo ""

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed."
  echo "Linux distros vary — install Node 22 LTS via your package manager:"
  echo "  Ubuntu/Debian: curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs"
  echo "  Fedora/RHEL:   sudo dnf install -y nodejs:22/common"
  echo "  Arch:          sudo pacman -S nodejs npm"
  echo "Then run this script again."
  xdg-open "https://nodejs.org/" >/dev/null 2>&1 || true
  exit 1
fi

if [ ! -d "node_modules" ]; then
  echo "First run — installing dependencies (this takes 1-2 minutes)..."
  npm install
fi

if [ ! -d "dist" ] || [ ! -f "dist/whatsapp-bot.js" ]; then
  echo "Building..."
  npm run build
fi

(
  for i in 1 2 3 4 5 6 7 8 9 10; do
    if [ -f "data/server.port" ]; then
      port=$(cat data/server.port 2>/dev/null)
      if [ -n "$port" ]; then
        xdg-open "http://localhost:$port" >/dev/null 2>&1
        exit 0
      fi
    fi
    sleep 1
  done
  xdg-open "http://localhost:3000" >/dev/null 2>&1
) &

echo ""
echo "Bot is starting. Your browser will open to http://localhost:3000 in a moment."
echo "Keep this terminal open. To stop the bot, press Ctrl+C."
echo ""

node dist/whatsapp-bot.js
