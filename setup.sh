#!/bin/bash
# Enhanced setup with auto-restart capability
pm2 delete victron.collection 2>/dev/null || true
pm2 delete victron.controller 2>/dev/null || true

pm2 start "npm run victron.collection" --name victron.collection --restart-delay=3000
pm2 start "./src/victron.controller.js" --name victron.controller --restart-delay=3000

# Save PM2 configuration
pm2 save

echo "PM2 processes started and saved for persistence"