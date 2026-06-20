module.exports = {
  apps: [
    {
      name: 'victron.collection',
      cwd: __dirname,
      script: './src/victron.collection.js',
      interpreter: 'node',
      env: {
        NODE_ENV: 'production'
      }
    },
    {
      name: 'victron.monitoring',
      cwd: __dirname,
      script: './src/victron.monitoring.js',
      interpreter: 'node',
      env: {
        NODE_ENV: 'production'
      }
    },
    {
      name: 'victron.controller',
      cwd: __dirname,
      script: './src/victron.controller.js',
      interpreter: 'node',
      env: {
        NODE_ENV: 'production'
      }
    },
    {
      name: 'dashboard.api',
      cwd: __dirname,
      script: './src/dashboard-api.js',
      interpreter: 'node',
      env: {
        NODE_ENV: 'production'
      }
    },
    {
      name: 'victron.smart',
      cwd: __dirname,
      script: './src/victron.smart.controller.js',
      interpreter: 'node',
      env: {
        NODE_ENV: 'production'
      }
    },
    {
      name: 'flux.sync',
      cwd: __dirname,
      script: './src/victron.flux.sync.js',
      interpreter: 'node',
      env: {
        NODE_ENV: 'production'
      }
    },
    {
      name: 'strategy.advisor',
      cwd: __dirname,
      script: './src/victron.strategy.advisor.js',
      interpreter: 'node',
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
};
