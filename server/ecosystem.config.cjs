/**
 * PM2 config for the NOVA E*TRADE stack.
 *
 * Deliberately separate process names, ports and cwd from the IBKR stack so a restart here
 * can never touch the live IBKR instance. Start with:  pm2 start ecosystem.config.cjs && pm2 save
 */

module.exports = {
  apps: [
    {
      name: 'etrade-proxy',
      cwd: '/var/www/nova-etrade/server',
      script: 'etrade-proxy.cjs',
      instances: 1,
      exec_mode: 'fork', // single instance only — it owns one token and one bracket state file
      autorestart: true,
      max_restarts: 20,
      restart_delay: 3000,
      max_memory_restart: '400M',
      env: { NODE_ENV: 'production' },
      error_file: '/var/log/nova-etrade/proxy-error.log',
      out_file: '/var/log/nova-etrade/proxy-out.log',
      time: true,
    },
    {
      name: 'quant-forge-etrade',
      cwd: '/var/www/nova-etrade/app',
      script: 'dist/server/index.mjs',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '600M',
      env: { NODE_ENV: 'production', PORT: 7180 },
      error_file: '/var/log/nova-etrade/app-error.log',
      out_file: '/var/log/nova-etrade/app-out.log',
      time: true,
    },
  ],
};
