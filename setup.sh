#!/bin/bash
# Enhanced setup with auto-restart capability
# Stops any existing processes, starts all services, and configures boot persistence
#
# Usage:  bash setup.sh          — normal setup
#         bash setup.sh --startup — also configure boot persistence (needs sudo)

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== Stopping existing PM2 processes ==="
pm2 delete victron.collection 2>/dev/null || true
pm2 delete victron.controller 2>/dev/null || true
pm2 delete victron.monitoring 2>/dev/null || true
pm2 delete victron.smart 2>/dev/null || true
pm2 delete dashboard.api 2>/dev/null || true
pm2 delete flux.sync 2>/dev/null || true
pm2 delete strategy.advisor 2>/dev/null || true
pm2 delete daily.report 2>/dev/null || true

echo "=== Starting all services ==="
pm2 start "$SCRIPT_DIR/ecosystem.config.js"

echo "=== Saving PM2 process list ==="
pm2 save

# Configure PM2 to start on boot (run once, or with --startup flag)
if [ "$1" = "--startup" ]; then
  echo "=== Configuring PM2 boot persistence ==="
  # pm2 startup prints a sudo command — capture and execute it
  STARTUP_CMD=$(pm2 startup systemd -u "$USER" --hp "$HOME" 2>&1 | grep -o 'sudo .*' || true)
  if [ -n "$STARTUP_CMD" ]; then
    echo "Running: $STARTUP_CMD"
    eval "$STARTUP_CMD"
  else
    echo "pm2 startup already configured or could not parse command."
    pm2 startup systemd -u "$USER" --hp "$HOME" || true
  fi
  pm2 save
  echo "Boot persistence configured. PM2 will auto-start on reboot."
else
  echo ""
  echo "NOTE: To survive reboots, run once:  bash setup.sh --startup"
  echo "  Or manually:  pm2 startup   (copy & run the sudo command it prints)"
  echo "                pm2 save"
fi

echo ""
pm2 list
echo ""
echo "Setup complete."