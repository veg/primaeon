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
 * NO AUTH YET. TODO (Phase 2, PLAN.md 8 and D15): port the auto-approving OAuth 2.1 ceremony from
 * datamonkey-js-server lib/mcp/index.js — /.well-known/oauth-authorization-server and
 * /.well-known/oauth-protected-resource[/mcp] discovery, dynamic client registration (/register),
 * /authorize with PKCE S256 and the urn:ietf:wg:oauth:2.0:oob out-of-band page for headless
 * clients, /token with authorization_code + refresh_token grants, /revoke, the redirect_uri
 * allow-list (index.js:44-51), the in-memory token stores with sweep, and the Bearer check on
 * /mcp with RFC 8707 audience binding. Until then this mount is for a trusted origin (localhost
 * or behind an authenticating proxy), and `file://` inputs are disabled regardless.
 *
 * Origin/Host validation and rate limiting are the deployer's (server/) responsibility; the SDK's
 * own DNS-rebinding guard can be switched on through `allowedHosts` / `allowedOrigins`.
 */

import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, createLogger } from "./server.js";
import { createEngine } from "./engine.js";

/**
 * @param {object} app  an Express-style app with post/get/delete(path, handler)
 * @param {object} [opts]
 * @param {string} [opts.path]               mount path, default "/mcp"
 * @param {object} [opts.serverOptions]      options for createServer (allowFilePaths is forced false,
 *                                           surface is "mcp-http")
 * @param {object} [opts.engine]             a shared in-process engine; default: one for the mount,
 *                                           so every session reuses the same loaded ONNX sessions
 * @param {object} [opts.logger]
 * @param {string[]} [opts.allowedHosts]     enables the SDK's DNS-rebinding host check
 * @param {string[]} [opts.allowedOrigins]   enables the SDK's origin check
 * @param {boolean} [opts.enableJsonResponse]
 * @returns {{sessions: Map<string, object>, close: () => Promise<void>}}
 */
export function mountHttp(app, opts = {}) {
  const mountPath = opts.path || "/mcp";
  const logger = opts.logger || createLogger(process.env);
  const ownsEngine = !opts.engine;
  const engine = opts.engine || createEngine({ env: (opts.serverOptions && opts.serverOptions.env) || process.env, logger });
  const sessions = new Map();

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

  app.post(mountPath, async (req, res) => {
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
  });

  app.get(mountPath, async (req, res) => {
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
  });

  app.delete(mountPath, async (req, res) => {
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
  });

  return {
    sessions,
    engine,
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
