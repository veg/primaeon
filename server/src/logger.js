/**
 * logger.js — the server's stderr logger, in the shape the MCP package expects.
 *
 * WHY THIS FILE EXISTS
 *
 * `@veg/hyphaeon-mcp` takes a `{debug, info, warn, error}` object everywhere (createServer,
 * createEngine, mountHttp) and ships `createLogger(env)` writing "[hyphaeon-mcp]" lines to
 * stderr. The server reuses that contract with its own prefix so one pm2 log carries both the
 * API's and the MCP mount's lines with a visible source, and so tests can pass a silent logger.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

/**
 * @param {{level?: string, prefix?: string, stream?: {write: (s: string) => void}}} [opts]
 */
export function createLogger(opts = {}) {
  const threshold = LEVELS[(opts.level || "info").toLowerCase()] ?? LEVELS.info;
  const prefix = opts.prefix || "[hyphaeon-server]";
  const stream = opts.stream || process.stderr;
  const write = (lvl, msg) => {
    if (LEVELS[lvl] < threshold) return;
    stream.write(prefix + " " + new Date().toISOString() + " " + lvl.toUpperCase() + " " + msg + "\n");
  };
  return {
    level: opts.level || "info",
    debug: (m) => write("debug", m),
    info: (m) => write("info", m),
    warn: (m) => write("warn", m),
    error: (m) => write("error", m),
    /** A child logger with a different prefix and the same threshold and stream. */
    child(prefixSuffix) {
      return createLogger({ level: opts.level, prefix: prefix + prefixSuffix, stream });
    }
  };
}

export const silentLogger = Object.freeze({
  level: "silent",
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silentLogger;
  }
});
