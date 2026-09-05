/**
 * mcp-mount.js — the streamable-HTTP MCP at /mcp, behind OAuth, on the server's worker pool.
 *
 * WHY THIS FILE EXISTS
 *
 * PLAN.md 3.6 puts the remote MCP transport in `server/`: `@veg/hyphaeon-mcp`'s `mountHttp`
 * (mcp/src/http.js) does the session bookkeeping — one McpServer and one
 * StreamableHTTPServerTransport per `mcp-session-id`, stale ids replaced rather than refused,
 * teardown on DELETE and on the GET stream's socket close — and takes from this server the three
 * things a public host needs that the package deliberately does not own:
 *
 *   1. `authenticate`: src/oauth.js `requireBearer`, run before every POST/GET/DELETE on the mount
 *      path, so no request reaches a transport and no session is created without a valid,
 *      unexpired, correctly-audienced access token (401 + WWW-Authenticate otherwise);
 *   2. Origin validation (the MCP spec's DNS-rebinding MUST) and a per-IP rate limit on the
 *      mount path, both of which datamonkey-js-server applies as Express middleware before its
 *      Bearer check (lib/mcp/index.js) — the order is kept: origin, rate limit, bearer, transport;
 *   3. an `engine`. mountHttp would build its own in-process engine and run tool calls on the HTTP
 *      event loop; here the MCP gets a thin adapter over the server's worker pool (src/pool.js),
 *      exposing the three engine methods the tools use (`run`, `status`, `close`), so an MCP tool
 *      call and a REST job are the same code on the same warm ONNX sessions and neither stalls the
 *      other's polling. Results claim `provenance.surface = "mcp-http"`.
 *
 * JOB-COMPLETION NOTIFICATIONS ARE BEST-EFFORT, as datamonkey-js-server/lib/mcp/job-notifier.js
 * documents and mcp/src/server.js implements: when a tool hands back a job id (above the sync
 * caps or `run_async`), the MCP job store's `onTerminal` hook sends a `notifications/message`
 * logging notification down the session's standalone GET stream. The transport is created with
 * no eventStore, so a notification sent before the client opens that stream, or during a
 * reconnect gap, is dropped by the SDK and never retried; a client that disconnects mid-job
 * loses nothing because `job_status` polling is the source of truth and the job keeps running.
 * This mount adds nothing to that path on purpose — no redis, no eventStore — and the README says
 * so where the connector is documented.
 *
 * NOTHING IS SHELLED OUT. Since Phase 3 every pillar — phenotype included — is JavaScript in a
 * worker thread over onnxruntime-node, so this mount has no subprocess path to disable and the
 * host needs no Python (PLAN.md 8, phase 3's exit criterion; D16). `hyphaeon_analyze` with a
 * `phenotype` block fills the report's phenotype section from the run's own forward pass.
 */

import rateLimit from "express-rate-limit";
import { mountHttp } from "@veg/hyphaeon-mcp/http";
import { createLogger as createMcpLogger } from "@veg/hyphaeon-mcp";

/**
 * An MCP engine over the worker pool. Only what mcp/src/tools.js calls (run, capabilities, status)
 * plus close.
 *
 * @param {ReturnType<import("./pool.js").createPool>} pool
 * @param {{threads?: number}} [opts]
 */
export function poolEngine(pool, opts = {}) {
  let statusCache = null;
  const status = async () => {
    if (!statusCache) {
      statusCache = pool.status().catch((err) => {
        statusCache = null;
        throw err;
      });
    }
    const s = await statusCache;
    return Object.assign({}, s, { engine: "onnxruntime-node (worker pool)", workers: pool.size });
  };
  return {
    threads: opts.threads,
    /**
     * @param {object} req  {analysis, alignment?, tree?, prediction?, meme_result?, phenotype_file?, options?, names?, signal?, surface?, progress?}
     * @returns {Promise<{result: object, provenance: object}>}
     */
    async run(req) {
      const task = {
        analysis: req.analysis,
        alignment: req.alignment,
        tree: req.tree,
        prediction: req.prediction,
        meme_result: req.meme_result,
        phenotype_file: req.phenotype_file,
        options: Object.assign({}, req.options || {}),
        names: Object.assign({}, req.names || {}),
        surface: req.surface || "mcp-http"
      };
      const handle = pool.run(task, { progress: req.progress });
      if (req.signal) {
        if (req.signal.aborted) handle.cancel("aborted");
        else req.signal.addEventListener("abort", () => handle.cancel("aborted"), { once: true });
      }
      const out = await handle.promise;
      const { provenance, analysis: _analysis, ...result } = out;
      return { result, provenance };
    },
    status,
    async close() {
      // The pool is the server's; src/app.js closes it.
    }
  };
}

/**
 * @param {import("express").Express} app
 * @param {object} deps
 * @param {object} deps.config     src/config.js
 * @param {object} deps.oauth      src/oauth.js createOAuth() (or null for an unauthenticated mount)
 * @param {object} deps.pool       src/pool.js
 * @param {object} [deps.logger]
 * @param {string} [deps.path]     default "/mcp"
 * @returns {{path: string, engine: object, mount: object, close: () => Promise<void>}}
 */
export function mountMcp(app, { config, oauth, pool, logger, path = "/mcp" }) {
  const log = logger || createMcpLogger(config.env);
  const engine = poolEngine(pool, { threads: config.threads });

  // 1. Origin validation (MCP spec MUST): reject only when Origin is present and not allowed.
  app.use(path, (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && !config.allowedOrigins.includes(origin.replace(/\/$/, ""))) {
      log.warn("MCP: rejected request from Origin " + origin);
      return res.status(403).json({ jsonrpc: "2.0", error: { code: -32000, message: "Forbidden: invalid origin" }, id: null });
    }
    next();
  });

  // 2. Rate limit (MCP spec: servers MUST rate limit tool invocations).
  app.use(
    path,
    rateLimit({
      windowMs: config.rateLimit.windowMs,
      limit: config.rateLimit.mcp,
      standardHeaders: true,
      legacyHeaders: false,
      message: { jsonrpc: "2.0", error: { code: -32000, message: "Rate limit exceeded" }, id: null }
    })
  );

  // 3 + 4. Bearer check (as mountHttp's `authenticate`) and the transport.
  const mount = mountHttp(app, {
    path,
    authenticate: oauth ? oauth.requireBearer : undefined,
    engine,
    logger: log,
    serverOptions: { env: config.env }
  });

  return {
    path,
    engine,
    mount,
    async close() {
      await mount.close();
    }
  };
}
