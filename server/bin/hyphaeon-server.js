#!/usr/bin/env node
/**
 * hyphaeon-server.js — start the HyphAeon server from the environment.
 *
 * WHY THIS FILE EXISTS
 *
 * pm2 (deploy/ecosystem.config.cjs), Docker (deploy/docker-compose.yml) and a developer's shell all
 * need one command that reads the configuration (src/config.js), builds the app (src/app.js),
 * listens on HYPHAEON_SERVER_PORT (default 7040) and shuts down cleanly on SIGINT/SIGTERM: stop
 * accepting connections, close the MCP sessions, ask every worker to release its ONNX sessions,
 * close SQLite, then let the event loop drain. The order matters — onnxruntime-node 1.23.2 aborts
 * the process when a session is alive at exit (PHASE1.md) — and so does not calling
 * `process.exit()` while sessions may still be alive; the bin sets `process.exitCode` instead.
 *
 * node:sqlite prints an ExperimentalWarning on Node 22. The `npm start` script and the deploy
 * configs pass `--disable-warning=ExperimentalWarning`; when the bin is run bare, the listener
 * below drops that one warning class and forwards every other warning to the default printer.
 */

process.removeAllListeners("warning");
process.on("warning", (w) => {
  if (w && w.name === "ExperimentalWarning" && /sqlite/i.test(w.message)) return;
  process.stderr.write((w && w.stack) || String(w));
  process.stderr.write("\n");
});

const { loadConfig } = await import("../src/config.js");
const { createApp } = await import("../src/app.js");
const { existsSync } = await import("node:fs");

const config = loadConfig(process.env);
const handle = createApp(config);
const { app, logger } = handle;

const server = app.listen(config.port, () => {
  logger.info("hyphaeon-server listening on port " + config.port);
  logger.info("issuer " + config.issuer + " | data " + config.dataDir + " | models " + (config.modelsDir || "(searching defaults)") + " | workers " + config.workers + " x " + config.threads + " threads");
  if (config.mcpEnabled) logger.info("MCP at " + config.issuer + "/mcp (" + (config.mcpAuth ? "OAuth" : "UNAUTHENTICATED") + ")");
  if (config.modelsDir && !existsSync(config.modelsDir)) logger.warn("HYPHAEON_MODELS_DIR does not exist: " + config.modelsDir);
});
server.keepAliveTimeout = 65 * 1000;
server.headersTimeout = 70 * 1000;

let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  logger.info("received " + signal + "; shutting down");
  const forced = setTimeout(() => {
    logger.error("shutdown timed out; exiting");
    process.exit(1);
  }, 30 * 1000);
  forced.unref();
  server.close();
  server.closeAllConnections && server.closeAllConnections();
  try {
    await handle.close();
    logger.info("shutdown complete");
    process.exitCode = 0;
  } catch (err) {
    logger.error("shutdown error: " + (err && err.message));
    process.exitCode = 1;
  }
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
