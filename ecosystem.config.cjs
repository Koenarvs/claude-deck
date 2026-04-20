module.exports = {
  apps: [
    {
      name: 'claude-deck',
      script: 'dist/server/index.js',
      cwd: __dirname,
      env: {
        NODE_ENV: 'production',
        PORT: 4100,
        DATA_DIR: './data',
      },
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
    },
  ],
};
