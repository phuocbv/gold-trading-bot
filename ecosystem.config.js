module.exports = {
  apps: [
    {
      name: 'gold-trading-bot',
      script: 'bot.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production',
        TZ: 'Asia/Ho_Chi_Minh',
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: 'logs/error.log',
      out_file: 'logs/combined.log',
      merge_logs: true,
    },
    {
      name: 'gold-scalp-bot',
      script: 'bot-scalp.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production',
        TZ: 'Asia/Ho_Chi_Minh',
        SCALP_PORT: 3001,
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: 'logs/scalp_error.log',
      out_file: 'logs/scalp_combined.log',
      merge_logs: true,
    },
  ],
};
