/**
 * http.js — mounts the HyphAeon MCP on an Express-style app over streamable HTTP.
 *
 * WHY THIS FILE EXISTS
 *
 * PLAN.md 3.6, remote transport: "streamable HTTP, https://<host>/mcp mounted in server/". The
 * session handling follows datamonkey-js-server lib/mcp/index.js:430-690 — one McpServer and one
 * StreamableHTTPServerTransport per session, a session map keyed by mcp-session-id, a stale
 * session id replaced by a fresh session rather than rejected (reconnects after a restart), and
 * teardown on both the transport's onclose (explicit DELETE) and the GET stream's socket close
 * (the common network-drop case the SDK does not report through onclose).
 *
 * AUTHENTICATION IS THE SERVER'S, SUPPLIED AS MIDDLEWARE. PLAN.md 3.6 puts the auto-approving
 * OAuth 2.1 ceremony (discovery documents, dynamic client registration, PKCE, the out-of-band
 * redirect, token and revocation endpoints, the Bearer check with RFC 8707 audience binding) in
 * `server/` — that is where datamonkey-js-server keeps it too — because the ceremony owns routes
 * of its own (/.well-known/*, /register, /authorize, /token) that have nothing to do with the MCP
 * mount path. This module therefore takes ONE thing from it: `authenticate`, an Express middleware
 * `(req, res, next)` that rejects an unauthenticated request itself (401 with the
 * WWW-Authenticate challenge) and calls `next()` otherwise. It is placed in front of the POST,
 * GET and DELETE handlers of the mount path, so no request reaches a transport — and no session
 * is created — without passing it. When it is absent the mount still works, for a trusted origin
 * (localhost, a test, an authenticating reverse proxy), and says so LOUDLY at startup on stderr
 * through the logger, because a remote MCP that accepts anyone's alignments is a mistake nobody
 * should make silently. `file://` inputs are disabled over HTTP regardless of authentication.
 *
 * Origin/Host validation and rate limiting are the deployer's (server/) responsibility; the SDK's
 * own DNS-rebinding guard can be switched on through `allowedHosts` / `allowedOrigins`.
 *
 * The stdio transport (bin/hyphaeon-mcp.js) does not go through here and is unchanged.
 */

import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, createLogger } from "./server.js";
import { createEngine } from "./engine.js";

/** The text the mount logs when it is unauthenticated; a test pins it so nobody softens it. */
export const UNAUTHENTICATED_WARNING =
  "MCP over HTTP is mounted WITHOUT AUTHENTICATION: no `authenticate` middleware was given to mountHttp. " +
  "Anyone who can reach this path can run analyses and read finished reports. This is acceptable only on " +
  "localhost, in a test, or behind a reverse proxy that authenticates; for a public host pass the server's " +
  "OAuth middleware (server/src/oauth.js) as `authenticate`.";

/**
 * @param {object} app  an Express-style app with post/get/delete(path, ...handlers)
 * @param {object} [opts]
 * @param {string} [opts.path]               mount path, default "/mcp"
 * @param {(req: object, res: object, next: Function) => unknown} [opts.authenticate]
 *                                           Express middleware run BEFORE every MCP request on the
 *                                           mount path (the server's OAuth Bearer check). Absent →
 *                                           unauthenticated mount with a loud startup warning.
 * @param {object} [opts.serverOptions]      options for createServer (allowFilePaths is forced false,
 *                                           surface is "mcp-http")
 * @param {object} [opts.engine]             a shared in-process engine; default: one for the mount,
 *                                           so every session reuses the same loaded ONNX sessions
 * @param {object} [opts.logger]
 * @param {string[]} [opts.allowedHosts]     enables the SDK's DNS-rebinding host check
 * @param {string[]} [opts.allowedOrigins]   enables the SDK's origin check
 * @param {boolean} [opts.enableJsonResponse]
 * @returns {{sessions: Map<string, object>, engine: object, authenticated: boolean, path: string, close: () => Promise<void>}}
 */
export function mountHttp(app, opts = {}) {
  const mountPath = opts.path || "/mcp";
  const logger = opts.logger || createLogger(process.env);
  const ownsEngine = !opts.engine;
  const engine = opts.engine || createEngine({ env: (opts.serverOptions && opts.serverOptions.env) || process.env, logger });
  const sessions = new Map();

  const authenticate = typeof opts.authenticate === "function" ? opts.authenticate : null;
  if (authenticate) {
    logger.info("MCP over HTTP mounted at " + mountPath + " behind the supplied authenticate middleware");
  } else {
    logger.warn("*".repeat(78));
    logger.warn(UNAUTHENTICATED_WARNING);
    logger.warn("*".repeat(78));
  }
  /** The handler chain for a method: the authentication middleware first, when there is one. */
  const guarded = (handler) => (authenticate ? [authenticate, handler] : [handler]);

  function teardown(sessionId, reason) {
    if (!sessionId) return;
    const s = sessions.get(sessionId);
    if (!s) return;
    sessions.delete(sessionId);
    logger.info("session " + sessionId + " closed (" + reason + "), remaining=" + sessions.size);
    s.handle.close().catch(() => {});
  }

  async function startSession(req, res, stale) {
    const handle = createServer(Object.assign({ logger, engine }, opts.serverOptions || {}, { allowFilePaths: false, surface: "mcp-http" }));
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: !!opts.enableJsonResponse,
      allowedHosts: opts.allowedHosts,
      allowedOrigins: opts.allowedOrigins,
      enableDnsRebindingProtection: !!(opts.allowedHosts || opts.allowedOrigins),
      onsessioninitialized: (sid) => {
        sessions.set(sid, { transport, handle });
        logger.info("session " + sid + " initialised" + (stale ? " (replacement)" : "") + ", total=" + sessions.size);
      },
      onsessionclosed: (sid) => teardown(sid, "onsessionclosed")
    });
    transport.onclose = () => teardown(transport.sessionId, "onclose");
    await handle.server.connect(transport);
    if (stale) delete req.headers["mcp-session-id"];
    await transport.handleRequest(req, res, req.body);
  }

  app.post(
    mountPath,
    ...guarded(async (req, res) => {
      const sid = req.headers["mcp-session-id"];
      try {
        if (sid && sessions.has(sid)) {
          await sessions.get(sid).transport.handleRequest(req, res, req.body);
        } else {
          if (sid) logger.warn("stale session id " + sid + "; starting a replacement session");
          await startSession(req, res, !!sid);
        }
      } catch (err) {
        logger.error("POST " + mountPath + " failed: " + err.message);
        if (!res.headersSent) {
          res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
        }
      }
    })
  );

  app.get(
    mountPath,
    ...guarded(async (req, res) => {
      const sid = req.headers["mcp-session-id"];
      if (!sid || !sessions.has(sid)) {
        res.status(400).json({ jsonrpc: "2.0", error: { code: -32000, message: "Invalid or missing session" }, id: null });
        return;
      }
      res.on("close", () => teardown(sid, "sse-close"));
      try {
        await sessions.get(sid).transport.handleRequest(req, res);
      } catch (err) {
        logger.error("GET " + mountPath + " failed: " + err.message);
        if (!res.headersSent) res.status(500).end();
      }
    })
  );

  app.delete(
    mountPath,
    ...guarded(async (req, res) => {
      const sid = req.headers["mcp-session-id"];
      if (!sid || !sessions.has(sid)) {
        res.status(400).json({ jsonrpc: "2.0", error: { code: -32000, message: "Invalid or missing session" }, id: null });
        return;
      }
      try {
        await sessions.get(sid).transport.handleRequest(req, res);
      } catch (err) {
        logger.error("DELETE " + mountPath + " failed: " + err.message);
        if (!res.headersSent) res.status(500).end();
      }
    })
  );

  return {
    sessions,
    engine,
    authenticated: !!authenticate,
    path: mountPath,
    async close() {
      for (const [sid, s] of sessions) {
        sessions.delete(sid);
        await s.transport.close().catch(() => {});
        await s.handle.close().catch(() => {});
      }
      // The shared engine outlives every session; release its ONNX sessions only when this
      // mount created it (see engine.close: onnxruntime-node aborts at exit otherwise).
      if (ownsEngine) await engine.close().catch(() => {});
    }
  };
}
