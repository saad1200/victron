#!/bin/bash
# Enhanced setup with auto-restart capability
# Stops any existing processes, starts all services, and configures boot persistence

# Clean up any existing PM2 processes for this project
pm2 delete victron.collection 2>/dev/null || true
pm2 delete victron.controller 2>/dev/null || true
pm2 delete victron.monitoring 2>/dev/null || true
pm2 delete victron.smart 2>/dev/null || true
pm2 delete dashboard.api 2>/dev/null || true
pm2 delete flux.sync 2>/dev/null || true
pm2 delete strategy.advisor 2>/dev/null || true
pm2 delete daily.report 2>/dev/null || true

## Start all apps via PM2 ecosystem (ensures consistent names and options)
pm2 start ecosystem.config.js --restart-delay=3000

# Save PM2 configuration
pm2 save

## Configure PM2 to launch on boot (Synology DSM uses systemd)
## Ensure PATH contains required locations so PM2 writes them into the systemd unit
export PATH="/usr/local/bin:/usr/bin:$PATH"
pm2 startup systemd -u "$USER" --hp "$HOME" || true

## Save the current process list again to ensure resurrection on boot
pm2 save

echo "PM2 processes started and saved. Autostart configured via systemd."