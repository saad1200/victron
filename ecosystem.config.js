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
    }
  ]
};
