/**
 * ecosystem.config.cjs — pm2 process file for the HyphAeon Node server.
 *
 * WHY THIS FILE EXISTS. One process, restarted on crash, with the environment PLAN.md 3.5 and
 * server/src/config.js expect. `--disable-warning=ExperimentalWarning` silences node:sqlite's
 * notice on Node 22. `kill_timeout` gives the server's SIGTERM handler time to release the ONNX
 * sessions in every worker (server/bin/hyphaeon-server.js) before pm2 SIGKILLs it; a session
 * alive at exit aborts the process. One instance only: SQLite and the job directories are
 * per-process state, and the model already uses every ORT thread it is given.
 *
 * Usage: pm2 start deploy/ecosystem.config.cjs && pm2 save
 */
module.exports = {
  apps: [
    {
      name: "hyphaeon-server",
      cwd: __dirname + "/../server",
      script: "bin/hyphaeon-server.js",
      node_args: "--disable-warning=ExperimentalWarning --max-old-space-size=4096",
      interpreter: "node",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_restarts: 10,
      min_uptime: "10s",
      kill_timeout: 30000,
      max_memory_restart: "6G",
      env: {
        NODE_ENV: "production",
        HYPHAEON_SERVER_PORT: "7040",
        HYPHAEON_SERVER_ISSUER: "https://hyphaeon.example.org",
        HYPHAEON_MODELS_DIR: "/var/www/hyphaeon/build/models",
        HYPHAEON_DATA_DIR: "/var/lib/hyphaeon",
        HYPHAEON_SERVER_WORKERS: "1",
        HYPHAEON_SERVER_THREADS: "4",
        HYPHAEON_TRUST_PROXY: "loopback",
        HYPHAEON_SERVER_LOG: "info"
      },
      out_file: "/var/log/hyphaeon/server.out.log",
      error_file: "/var/log/hyphaeon/server.err.log",
      merge_logs: true,
      time: true
    }
  ]
};
