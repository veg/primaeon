/**
 * oauth.js — the auto-approving OAuth 2.1 ceremony in front of the HTTP MCP mount.
 *
 * WHY THIS FILE EXISTS
 *
 * PLAN.md 3.6: the remote MCP is "OAuth 2.1 with dynamic client registration, PKCE, and the
 * out-of-band redirect for headless clients, auto-approved exactly as Datamonkey's is, so it can
 * be added as a claude.ai connector the same way the Datamonkey connector was". This is a port of
 * that ceremony — datamonkey-js-server `lib/mcp/index.js` (the OAuth section, module constants
 * ACCESS_TOKEN_TTL_MS / REFRESH_TOKEN_TTL_MS / OAUTH_SWEEP_INTERVAL_MS / OOB_REDIRECT_URI, the
 * `isRedirectUriAllowed` guard, the discovery, registration, authorize, token, revoke handlers and
 * the Bearer check on /mcp) — rewritten as an ES module with the same semantics and the same wire
 * behaviour:
 *
 *   - GET /.well-known/oauth-authorization-server — issuer metadata: code flow, authorization_code
 *     + refresh_token grants, client_secret_post, S256;
 *   - GET /.well-known/oauth-protected-resource and its /mcp variant (RFC 9728): `resource` is the
 *     canonical MCP endpoint `<issuer>/mcp`, not the bare issuer — Claude Code validates the match
 *     and silently aborts discovery on a mismatch (Datamonkey's comment, kept because it cost a day);
 *   - GET /.well-known/mcp.json — the client-manifest Datamonkey serves;
 *   - POST /register — dynamic client registration: random client_id / client_secret, the
 *     redirect_uris as given, 201;
 *   - GET /authorize — AUTO-APPROVES: there are no accounts (PLAN.md 3.5). It refuses a missing
 *     redirect_uri and, per `isRedirectUriAllowed` (RFC 6749 3.1.2.3 exact-match, OOB always
 *     allowed, permissive fallback for an unknown client or one that registered none), refuses an
 *     unregistered redirect_uri with 400 and NO redirect so an open-redirect can never carry a
 *     code; stores {client_id, redirect_uri, code_challenge, resource, expires +10 min}; renders
 *     the copy-paste HTML page for urn:ietf:wg:oauth:2.0:oob, 302s otherwise with code + state;
 *   - POST /token — authorization_code (PKCE S256 verified when a challenge was stored; the code
 *     is single-use; RFC 8707 resource bound from authorize-time, else the token request) and
 *     refresh_token (new access token, same refresh token), access 1 h / refresh 30 d, 400
 *     invalid_grant / unsupported_grant_type;
 *   - POST /revoke — deletes the token if known, 200 either way;
 *   - the Bearer check: 401 with `WWW-Authenticate: Bearer resource_metadata="<issuer>/.well-known/
 *     oauth-protected-resource/mcp"` when the header is missing, the token unknown, wrong-type or
 *     expired (an expired token is deleted on sight), and with `error="invalid_token"` when the
 *     token's bound resource is not this server's; JSON-RPC error bodies (code -32000);
 *   - in-memory stores swept every 10 min (codes and tokens by `expires`; clients never, they are
 *     long-lived and small), the timer unref'd.
 *
 * What differs, deliberately: the store is a factory (`createOAuth`) so tests build one per
 * server with a fake clock; the Bearer check is offered both as Express middleware
 * (`requireBearer`) and as a transport-agnostic `authenticate(req)` for `mountHttp`'s
 * `authenticate` option; the OOB page is unbranded and links back to the web app. Nothing about
 * what is accepted or refused differs.
 */

import { createHash, randomUUID } from "node:crypto";
import express from "express";

export const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000; // 1h, matches the advertised expires_in
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30d
export const AUTH_CODE_TTL_MS = 10 * 60 * 1000; // 10m
export const OAUTH_SWEEP_INTERVAL_MS = 10 * 60 * 1000; // 10m
export const OOB_REDIRECT_URI = "urn:ietf:wg:oauth:2.0:oob";

/**
 * RFC 6749 3.1.2.3 / 4.1.2.1: a redirect_uri must exactly match one the client registered.
 *   - the OOB URI is always allowed (it renders a page, never redirects);
 *   - a client that registered one or more redirect_uris is held to them exactly;
 *   - an unknown client, or a known client that registered NO redirect_uris, falls back to the
 *     permissive behaviour (dynamic registration + auto-approval).
 *
 * @param {string} redirectUri
 * @param {{redirect_uris?: string[]}|null|undefined} client
 */
export function isRedirectUriAllowed(redirectUri, client) {
  if (redirectUri === OOB_REDIRECT_URI) return true;
  const registered = client && Array.isArray(client.redirect_uris) ? client.redirect_uris : [];
  if (registered.length === 0) return true; // permissive fallback
  return registered.indexOf(redirectUri) !== -1;
}

export function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function renderOobPage(code, webUrl) {
  const safeCode = escapeHtml(code);
  return (
    "<!doctype html>\n" +
    '<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    "<title>HyphAeon MCP — authorization code</title>" +
    "<style>" +
    "body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:640px;margin:4rem auto;padding:0 1.5rem;color:#1a1a1a;line-height:1.5}" +
    "h1{font-size:1.25rem;margin-bottom:1rem}" +
    "code{font-family:'SF Mono',Menlo,Consolas,monospace;background:#f4f4f5;padding:.75rem 1rem;border-radius:6px;display:block;word-break:break-all;font-size:1rem;user-select:all}" +
    "p{color:#52525b}a{color:#2563eb}" +
    "</style></head><body>" +
    "<h1>Authorization code</h1>" +
    '<code id="code">' + safeCode + "</code>" +
    "<p>Paste this code back into your MCP client to complete authorization. The code is valid for 10 minutes.</p>" +
    (webUrl ? '<p><a href="' + escapeHtml(webUrl) + '">HyphAeon</a></p>' : "") +
    "</body></html>"
  );
}

/**
 * @param {object} opts
 * @param {string} opts.issuer          public base URL, no trailing slash
 * @param {string} [opts.resourcePath]  the MCP mount path, default "/mcp"
 * @param {string} [opts.webUrl]        link on the OOB page
 * @param {string} [opts.documentation] resource_documentation URL
 * @param {object} [opts.logger]
 * @param {() => number} [opts.now]     clock (tests)
 * @param {boolean} [opts.sweep]        run the periodic sweep (default true)
 */
export function createOAuth(opts) {
  const issuer = String(opts.issuer).replace(/\/$/, "");
  const resourcePath = opts.resourcePath || "/mcp";
  const logger = opts.logger || { debug() {}, info() {}, warn() {}, error() {} };
  const now = opts.now || Date.now;
  const mcpResourceUrl = issuer + resourcePath;
  const metadataUrl = issuer + "/.well-known/oauth-protected-resource" + resourcePath;

  // In-memory stores (Datamonkey keeps the same three).
  const clients = new Map();
  const authCodes = new Map();
  const tokens = new Map();

  function sweep() {
    const t = now();
    let reaped = 0;
    for (const [code, rec] of authCodes) {
      if (rec.expires < t) {
        authCodes.delete(code);
        reaped++;
      }
    }
    for (const [tok, rec] of tokens) {
      if (rec.expires && rec.expires < t) {
        tokens.delete(tok);
        reaped++;
      }
    }
    if (reaped > 0) logger.info("OAuth sweep: reaped " + reaped + " expired code(s)/token(s)");
    return reaped;
  }

  let sweepTimer = null;
  if (opts.sweep !== false) {
    sweepTimer = setInterval(sweep, OAUTH_SWEEP_INTERVAL_MS);
    if (sweepTimer.unref) sweepTimer.unref();
  }

  const serverMetadata = () => ({
    issuer,
    authorization_endpoint: issuer + "/authorize",
    token_endpoint: issuer + "/token",
    registration_endpoint: issuer + "/register",
    revocation_endpoint: issuer + "/revoke",
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["client_secret_post"],
    code_challenge_methods_supported: ["S256"]
  });

  const protectedResourceMetadata = () => ({
    resource: mcpResourceUrl,
    authorization_servers: [issuer],
    bearer_methods_supported: ["header"],
    resource_documentation: opts.documentation || issuer + "/mcp"
  });

  const unauthorized = (message, headerValue) => ({
    status: 401,
    headers: { "WWW-Authenticate": headerValue },
    body: { jsonrpc: "2.0", error: { code: -32000, message }, id: null }
  });

  /**
   * Transport-agnostic bearer check. Returns `{ok: true, token}` or `{ok: false, status, headers, body}`.
   * @param {{headers: Record<string, string|string[]|undefined>}} req
   */
  function authenticate(req) {
    const raw = req.headers && req.headers.authorization;
    const authHeader = Array.isArray(raw) ? raw[0] : raw;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return Object.assign(unauthorized("Unauthorized: Bearer token required", 'Bearer resource_metadata="' + metadataUrl + '"'), { ok: false });
    }
    const token = authHeader.substring(7);
    const rec = tokens.get(token);
    if (!rec || rec.type !== "access" || (rec.expires && rec.expires < now())) {
      if (rec && rec.expires && rec.expires < now()) tokens.delete(token);
      return Object.assign(unauthorized("Unauthorized: invalid or expired token", 'Bearer resource_metadata="' + metadataUrl + '"'), { ok: false });
    }
    // RFC 8707 audience binding.
    if (rec.resource && rec.resource !== mcpResourceUrl) {
      return Object.assign(
        unauthorized("Unauthorized: token audience mismatch", 'Bearer error="invalid_token", resource_metadata="' + metadataUrl + '"'),
        { ok: false }
      );
    }
    return { ok: true, token, record: rec };
  }

  /** Express middleware form of `authenticate`. */
  function requireBearer(req, res, next) {
    const a = authenticate(req);
    if (a.ok) {
      req.oauth = a.record;
      return next();
    }
    res.set(a.headers);
    return res.status(a.status).json(a.body);
  }

  /** Register the ceremony's routes on an Express app. */
  function mount(app) {
    app.get("/.well-known/oauth-authorization-server", (req, res) => res.json(serverMetadata()));
    app.get("/.well-known/oauth-protected-resource" + resourcePath, (req, res) => res.json(protectedResourceMetadata()));
    app.get("/.well-known/oauth-protected-resource", (req, res) => res.json(protectedResourceMetadata()));
    app.get("/.well-known/mcp.json", (req, res) =>
      res.json({
        name: "HyphAeon",
        description: "Neural surrogate for HyPhy MEME: site selection, gene-level omnibus, epistasis networks, digital DMS",
        version: opts.version || null,
        url: mcpResourceUrl,
        authentication: { type: "bearer" },
        tools: opts.toolNames || []
      })
    );

    app.post("/register", express.json(), (req, res) => {
      const clientId = randomUUID();
      const clientSecret = randomUUID();
      const body = req.body || {};
      const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u) => typeof u === "string") : [];
      logger.info("OAuth register: clientId=" + clientId + " redirect_uris=" + JSON.stringify(redirectUris));
      clients.set(clientId, { client_id: clientId, client_secret: clientSecret, redirect_uris: redirectUris, created: now() });
      res.status(201).json({
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uris: redirectUris,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "client_secret_post"
      });
    });

    app.get("/authorize", (req, res) => {
      const redirectUri = typeof req.query.redirect_uri === "string" ? req.query.redirect_uri : undefined;
      const state = typeof req.query.state === "string" ? req.query.state : "";
      const clientId = typeof req.query.client_id === "string" ? req.query.client_id : undefined;
      logger.info("OAuth authorize: clientId=" + clientId + " redirect_uri=" + redirectUri);

      if (!redirectUri) {
        logger.warn("OAuth authorize: missing redirect_uri");
        res.status(400).json({ error: "missing redirect_uri" });
        return;
      }
      if (!isRedirectUriAllowed(redirectUri, clientId ? clients.get(clientId) : null)) {
        logger.warn("OAuth authorize: redirect_uri not registered for clientId=" + clientId + " redirect_uri=" + redirectUri);
        res.status(400).json({ error: "invalid redirect_uri" });
        return;
      }

      const code = randomUUID();
      authCodes.set(code, {
        client_id: clientId,
        redirect_uri: redirectUri,
        code_challenge: typeof req.query.code_challenge === "string" ? req.query.code_challenge : undefined,
        resource: typeof req.query.resource === "string" ? req.query.resource : undefined, // RFC 8707
        expires: now() + AUTH_CODE_TTL_MS
      });

      if (redirectUri === OOB_REDIRECT_URI) {
        logger.info("OAuth authorize: issued code, rendering OOB page");
        res.set("Content-Type", "text/html; charset=utf-8");
        res.send(renderOobPage(code, opts.webUrl));
        return;
      }
      logger.info("OAuth authorize: issued code, redirecting");
      const sep = redirectUri.indexOf("?") === -1 ? "?" : "&";
      res.redirect(redirectUri + sep + "code=" + encodeURIComponent(code) + "&state=" + encodeURIComponent(state));
    });

    const formOrJson = [express.urlencoded({ extended: false }), express.json()];

    app.post("/token", ...formOrJson, (req, res) => {
      const body = req.body || {};
      const grantType = body.grant_type;
      logger.info("OAuth token: grant_type=" + grantType);

      if (grantType === "authorization_code") {
        const code = body.code;
        const stored = authCodes.get(code);
        if (!stored || stored.expires < now()) {
          logger.warn("OAuth token: invalid or expired auth code");
          res.status(400).json({ error: "invalid_grant" });
          return;
        }
        if (stored.code_challenge) {
          const verifier = body.code_verifier;
          if (!verifier) {
            logger.warn("OAuth token: code_verifier required but missing");
            res.status(400).json({ error: "invalid_grant", error_description: "code_verifier required" });
            return;
          }
          const expected = createHash("sha256").update(String(verifier)).digest("base64url");
          if (expected !== stored.code_challenge) {
            logger.warn("OAuth token: code_verifier mismatch");
            res.status(400).json({ error: "invalid_grant", error_description: "code_verifier mismatch" });
            return;
          }
        }
        authCodes.delete(code);
        const tokenResource = stored.resource || body.resource;
        const accessToken = randomUUID();
        const refreshToken = randomUUID();
        tokens.set(accessToken, { type: "access", client_id: stored.client_id, resource: tokenResource, expires: now() + ACCESS_TOKEN_TTL_MS });
        tokens.set(refreshToken, { type: "refresh", client_id: stored.client_id, resource: tokenResource, expires: now() + REFRESH_TOKEN_TTL_MS });
        logger.info("OAuth token: issued access_token for clientId=" + stored.client_id);
        res.json({ access_token: accessToken, token_type: "Bearer", expires_in: ACCESS_TOKEN_TTL_MS / 1000, refresh_token: refreshToken });
        return;
      }

      if (grantType === "refresh_token") {
        const rt = body.refresh_token;
        const rec = tokens.get(rt);
        if (!rec || rec.type !== "refresh" || (rec.expires && rec.expires < now())) {
          logger.warn("OAuth token: invalid refresh_token");
          res.status(400).json({ error: "invalid_grant" });
          return;
        }
        const newAccessToken = randomUUID();
        tokens.set(newAccessToken, { type: "access", client_id: rec.client_id, resource: rec.resource, expires: now() + ACCESS_TOKEN_TTL_MS });
        logger.info("OAuth token: refreshed access_token for clientId=" + rec.client_id);
        res.json({ access_token: newAccessToken, token_type: "Bearer", expires_in: ACCESS_TOKEN_TTL_MS / 1000, refresh_token: rt });
        return;
      }

      logger.warn("OAuth token: unsupported grant_type=" + grantType);
      res.status(400).json({ error: "unsupported_grant_type" });
    });

    app.post("/revoke", ...formOrJson, (req, res) => {
      const token = req.body && req.body.token;
      logger.info("OAuth revoke: token=" + (token ? String(token).substring(0, 8) + "..." : "none"));
      if (token && tokens.has(token)) tokens.delete(token);
      res.status(200).end();
    });
  }

  return {
    issuer,
    resourceUrl: mcpResourceUrl,
    metadataUrl,
    mount,
    authenticate,
    requireBearer,
    sweep,
    serverMetadata,
    protectedResourceMetadata,
    /** Exposed for tests and for the status route (counts only). */
    stores: { clients, authCodes, tokens },
    close() {
      if (sweepTimer) clearInterval(sweepTimer);
    }
  };
}
