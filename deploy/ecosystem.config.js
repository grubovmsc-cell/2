// PM2 Ecosystem Config — FleetDesk Bot Manager
// Документация: https://pm2.keymetrics.io/docs/usage/application-declaration/
module.exports = {
  apps: [
    {
      name: 'fleetdesk-bot',
      script: '/opt/fleetdesk/bot-manager.js',
      cwd: '/opt/fleetdesk',

      // Переменные окружения (берутся из /opt/fleetdesk/.env)
      env_file: '/opt/fleetdesk/.env',

      // Перезапуск при падении
      restart_delay: 3000,
      max_restarts: 10,
      autorestart: true,

      // Логи
      out_file: '/var/log/fleetdesk/bot.log',
      error_file: '/var/log/fleetdesk/bot.error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,

      // Запускать при старте сервера
      // После настройки: pm2 startup && pm2 save
      watch: false,

      // Потребление ресурсов
      max_memory_restart: '400M',
      node_args: '--max-old-space-size=384',

      // Graceful shutdown (Telegraf требует времени на остановку)
      kill_timeout: 10000,
      listen_timeout: 8000,
    },
  ],
};
