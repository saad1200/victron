// Shared defaults for all apps
const defaults = {
  cwd: __dirname,
  interpreter: 'node',
  autorestart: true,          // restart on crash
  watch: false,               // file-watch off by default (enable per-app if needed)
  max_restarts: 50,           // max restarts within restart_delay window before stopping
  min_uptime: '10s',          // consider started only if alive > 10s (avoids rapid crash loops)
  restart_delay: 5000,        // wait 5s between crash restarts
  exp_backoff_restart_delay: 100, // exponential backoff starting at 100ms (caps at 15s)
  max_memory_restart: '200M', // restart if memory exceeds 200MB (leak protection)
  merge_logs: true,           // combine cluster logs into single file
  log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
  env: {
    NODE_ENV: 'production'
  }
};

module.exports = {
  apps: [
    {
      ...defaults,
      name: 'victron.collection',
      script: './src/victron.collection.js',
    },
    {
      ...defaults,
      name: 'victron.monitoring',
      script: './src/victron.monitoring.js',
    },
    {
      ...defaults,
      name: 'victron.controller',
      script: './src/victron.controller.js',
    },
    {
      ...defaults,
      name: 'dashboard.api',
      script: './src/dashboard-api.js',
      listen_timeout: 10000,  // give Express time to bind
    },
    {
      ...defaults,
      name: 'victron.smart',
      script: './src/victron.smart.controller.js',
    },
    {
      ...defaults,
      name: 'flux.sync',
      script: './src/victron.flux.sync.js',
      autorestart: false,         // manages own cron schedule
    },
    {
      ...defaults,
      name: 'strategy.advisor',
      script: './src/victron.strategy.advisor.js',
      autorestart: false,         // manages own cron schedule; PM2 restart loops burn API quota
    },
    {
      ...defaults,
      name: 'daily.report',
      script: './src/analyse-day.js',
      autorestart: false,         // manages own cron schedule
    }
  ]
};
