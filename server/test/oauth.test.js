/**
 * oauth.test.js — the Datamonkey ceremony end to end and the guarded MCP mount.
 *
 * WHY THIS FILE EXISTS. PLAN.md 3.6: the remote MCP must be addable as a claude.ai connector
 * "the same way the Datamonkey connector was", which means discovery documents whose `resource`
 * is `<issuer>/mcp`, dynamic registration, an auto-approving /authorize that still refuses an
 * unregistered redirect_uri, PKCE S256 verification, refresh, revocation, and a Bearer check on
 * /mcp that answers 401 with the `resource_metadata` challenge. Each step is checked at the wire.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import express from "express";
import { createApp } from "../src/app.js";
import { createOAuth, isRedirectUriAllowed, OOB_REDIRECT_URI, ACCESS_TOKEN_TTL_MS } from "../src/oauth.js";
import { parseSseBody, pkcePair, silentLogger, testConfig } from "./helpers.js";

let handle;
let config;
const ISSUER = "http://localhost:7041";

beforeAll(() => {
  config = testConfig();
  handle = createApp(config, { logger: silentLogger });
});

afterAll(async () => {
  await handle.close();
  config.cleanup();
});

describe("isRedirectUriAllowed", () => {
  it("mirrors the Datamonkey rule", () => {
    expect(isRedirectUriAllowed(OOB_REDIRECT_URI, { redirect_uris: ["http://a/cb"] })).toBe(true);
    expect(isRedirectUriAllowed("http://a/cb", { redirect_uris: ["http://a/cb"] })).toBe(true);
    expect(isRedirectUriAllowed("http://a/cb/", { redirect_uris: ["http://a/cb"] })).toBe(false);
    expect(isRedirectUriAllowed("http://evil/cb", { redirect_uris: ["http://a/cb"] })).toBe(false);
    expect(isRedirectUriAllowed("http://evil/cb", { redirect_uris: [] })).toBe(true);
    expect(isRedirectUriAllowed("http://evil/cb", null)).toBe(true);
  });
});

describe("OAuth ceremony", () => {
  let client;
  let token;

  it("publishes the discovery documents with the /mcp resource", async () => {
    const as = await request(handle.app).get("/.well-known/oauth-authorization-server");
    expect(as.status).toBe(200);
    expect(as.body).toMatchObject({
      issuer: ISSUER,
      authorization_endpoint: ISSUER + "/authorize",
      token_endpoint: ISSUER + "/token",
      registration_endpoint: ISSUER + "/register",
      revocation_endpoint: ISSUER + "/revoke",
      code_challenge_methods_supported: ["S256"],
      grant_types_supported: ["authorization_code", "refresh_token"]
    });
    for (const p of ["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource"]) {
      const pr = await request(handle.app).get(p);
      expect(pr.status).toBe(200);
      expect(pr.body.resource).toBe(ISSUER + "/mcp");
      expect(pr.body.authorization_servers).toEqual([ISSUER]);
    }
    const manifest = await request(handle.app).get("/.well-known/mcp.json");
    expect(manifest.body.url).toBe(ISSUER + "/mcp");
    expect(manifest.body.authentication).toEqual({ type: "bearer" });
  });

  it("registers a client dynamically", async () => {
    const res = await request(handle.app).post("/register").send({ redirect_uris: ["http://localhost:9999/cb"], client_name: "test" });
    expect(res.status).toBe(201);
    expect(res.body.client_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body.client_secret).toBeTruthy();
    expect(res.body.redirect_uris).toEqual(["http://localhost:9999/cb"]);
    expect(res.body.token_endpoint_auth_method).toBe("client_secret_post");
    client = res.body;
  });

  it("refuses an unregistered redirect_uri without redirecting, and a missing one", async () => {
    const bad = await request(handle.app).get("/authorize").query({ client_id: client.client_id, redirect_uri: "http://evil.example/cb", response_type: "code" });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("invalid redirect_uri");
    expect(bad.headers.location).toBeUndefined();
    const missing = await request(handle.app).get("/authorize").query({ client_id: client.client_id });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toBe("missing redirect_uri");
  });

  it("auto-approves with PKCE, redirects with code and state, and issues tokens", async () => {
    const { verifier, challenge } = pkcePair();
    const auth = await request(handle.app).get("/authorize").query({
      client_id: client.client_id,
      redirect_uri: "http://localhost:9999/cb",
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "xyz",
      resource: ISSUER + "/mcp"
    });
    expect(auth.status).toBe(302);
    const loc = new URL(auth.headers.location);
    expect(loc.origin + loc.pathname).toBe("http://localhost:9999/cb");
    expect(loc.searchParams.get("state")).toBe("xyz");
    const code = loc.searchParams.get("code");
    expect(code).toBeTruthy();

    // Wrong verifier is refused; the code survives for the right one.
    const wrong = await request(handle.app)
      .post("/token")
      .type("form")
      .send({ grant_type: "authorization_code", code, code_verifier: "not-it", client_id: client.client_id, client_secret: client.client_secret });
    expect(wrong.status).toBe(400);
    expect(wrong.body).toEqual({ error: "invalid_grant", error_description: "code_verifier mismatch" });

    const tok = await request(handle.app)
      .post("/token")
      .type("form")
      .send({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: client.client_id, client_secret: client.client_secret, redirect_uri: "http://localhost:9999/cb" });
    expect(tok.status).toBe(200);
    expect(tok.body.token_type).toBe("Bearer");
    expect(tok.body.expires_in).toBe(3600);
    expect(tok.body.access_token).toBeTruthy();
    expect(tok.body.refresh_token).toBeTruthy();
    token = tok.body;

    // A code is single-use.
    const reuse = await request(handle.app).post("/token").type("form").send({ grant_type: "authorization_code", code, code_verifier: verifier });
    expect(reuse.status).toBe(400);
    expect(reuse.body.error).toBe("invalid_grant");
  });

  it("renders the out-of-band page for headless clients", async () => {
    const res = await request(handle.app).get("/authorize").query({ redirect_uri: OOB_REDIRECT_URI, response_type: "code" });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.text).toMatch(/<code id="code">[0-9a-f-]{36}<\/code>/);
    expect(res.text).toMatch(/valid for 10 minutes/);
  });

  it("refreshes and revokes", async () => {
    const r = await request(handle.app).post("/token").type("form").send({ grant_type: "refresh_token", refresh_token: token.refresh_token });
    expect(r.status).toBe(200);
    expect(r.body.access_token).not.toBe(token.access_token);
    expect(r.body.refresh_token).toBe(token.refresh_token);
    const bad = await request(handle.app).post("/token").type("form").send({ grant_type: "refresh_token", refresh_token: token.access_token });
    expect(bad.status).toBe(400);
    const unsupported = await request(handle.app).post("/token").type("form").send({ grant_type: "password" });
    expect(unsupported.body.error).toBe("unsupported_grant_type");

    const revoke = await request(handle.app).post("/revoke").type("form").send({ token: r.body.access_token });
    expect(revoke.status).toBe(200);
    const after = await request(handle.app).post("/mcp").set("Authorization", "Bearer " + r.body.access_token).set("Accept", "application/json, text/event-stream").send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
    expect(after.status).toBe(401);
    expect(after.body.error.message).toMatch(/invalid or expired token/);
  });

  describe("the /mcp mount", () => {
    const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "vitest", version: "0" } } };

    it("returns 401 with the resource_metadata challenge without a bearer", async () => {
      const res = await request(handle.app).post("/mcp").set("Accept", "application/json, text/event-stream").send(initialize);
      expect(res.status).toBe(401);
      expect(res.headers["www-authenticate"]).toBe('Bearer resource_metadata="' + ISSUER + '/.well-known/oauth-protected-resource/mcp"');
      expect(res.body).toEqual({ jsonrpc: "2.0", error: { code: -32000, message: "Unauthorized: Bearer token required" }, id: null });
      const get = await request(handle.app).get("/mcp").set("Accept", "text/event-stream");
      expect(get.status).toBe(401);
      const del = await request(handle.app).delete("/mcp").set("mcp-session-id", "nope");
      expect(del.status).toBe(401);
      expect(handle.mcp.mount.sessions.size).toBe(0);
    });

    it("rejects a foreign Origin before anything else", async () => {
      const res = await request(handle.app).post("/mcp").set("Origin", "https://evil.example").set("Authorization", "Bearer " + token.access_token).send(initialize);
      expect(res.status).toBe(403);
    });

    it("initialises a session and lists the tools with the bearer", async () => {
      const init = await request(handle.app)
        .post("/mcp")
        .set("Authorization", "Bearer " + token.access_token)
        .set("Accept", "application/json, text/event-stream")
        .set("Content-Type", "application/json")
        .send(initialize);
      expect(init.status).toBe(200);
      const sid = init.headers["mcp-session-id"];
      expect(sid).toBeTruthy();
      const initMsgs = parseSseBody(init.text);
      expect(initMsgs[0].result.serverInfo.name).toBe("hyphaeon");
      expect(initMsgs[0].result.capabilities.tools).toBeDefined();

      const list = await request(handle.app)
        .post("/mcp")
        .set("Authorization", "Bearer " + token.access_token)
        .set("Accept", "application/json, text/event-stream")
        .set("Content-Type", "application/json")
        .set("mcp-session-id", sid)
        .send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
      expect(list.status).toBe(200);
      const msgs = parseSseBody(list.text);
      const names = msgs[0].result.tools.map((t) => t.name);
      expect(names).toEqual(expect.arrayContaining(["hyphaeon_validate", "hyphaeon_meme", "hyphaeon_busted", "job_status", "get_results", "list_models"]));

      // hyphaeon_validate runs in-process on the same server (no model needed).
      const validate = await request(handle.app)
        .post("/mcp")
        .set("Authorization", "Bearer " + token.access_token)
        .set("Accept", "application/json, text/event-stream")
        .set("Content-Type", "application/json")
        .set("mcp-session-id", sid)
        .send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "hyphaeon_validate", arguments: { alignment: ">a\nATGAAA\n>b\nATGAAG\n>c\nATGAAC\n", tree: "(a:0.1,b:0.1,c:0.1);" } } });
      expect(validate.status).toBe(200);
      const v = JSON.parse(parseSseBody(validate.text)[0].result.content[0].text);
      expect(v.summary.sequence_count).toBe(3);

      const del = await request(handle.app).delete("/mcp").set("Authorization", "Bearer " + token.access_token).set("mcp-session-id", sid);
      expect([200, 204]).toContain(del.status);
    });

    it("rejects a token bound to another resource (RFC 8707)", async () => {
      const { verifier, challenge } = pkcePair();
      const auth = await request(handle.app).get("/authorize").query({ redirect_uri: OOB_REDIRECT_URI, code_challenge: challenge, resource: "https://other.example/mcp" });
      const code = /<code id="code">([^<]+)<\/code>/.exec(auth.text)[1];
      const tok = await request(handle.app).post("/token").type("form").send({ grant_type: "authorization_code", code, code_verifier: verifier });
      expect(tok.status).toBe(200);
      const res = await request(handle.app).post("/mcp").set("Authorization", "Bearer " + tok.body.access_token).set("Accept", "application/json, text/event-stream").send(initialize);
      expect(res.status).toBe(401);
      expect(res.headers["www-authenticate"]).toMatch(/^Bearer error="invalid_token", resource_metadata=/);
      expect(res.body.error.message).toMatch(/audience mismatch/);
    });
  });
});

describe("token expiry and the sweep (fake clock)", () => {
  it("expires access tokens after 1 h, reaps codes and tokens, keeps clients", async () => {
    let now = 1_000_000;
    const oauth = createOAuth({ issuer: "http://x", logger: silentLogger, now: () => now, sweep: false });
    const app = express();
    oauth.mount(app);
    const reg = await request(app).post("/register").send({});
    const auth = await request(app).get("/authorize").query({ client_id: reg.body.client_id, redirect_uri: OOB_REDIRECT_URI });
    const code = /<code id="code">([^<]+)<\/code>/.exec(auth.text)[1];
    const tok = await request(app).post("/token").type("form").send({ grant_type: "authorization_code", code });
    expect(oauth.authenticate({ headers: { authorization: "Bearer " + tok.body.access_token } }).ok).toBe(true);
    now += ACCESS_TOKEN_TTL_MS + 1;
    const a = oauth.authenticate({ headers: { authorization: "Bearer " + tok.body.access_token } });
    expect(a.ok).toBe(false);
    expect(a.status).toBe(401);
    expect(oauth.stores.tokens.has(tok.body.access_token)).toBe(false); // deleted on sight
    // Refresh still works (30 d), then the sweep reaps the expired remainder.
    const r = await request(app).post("/token").type("form").send({ grant_type: "refresh_token", refresh_token: tok.body.refresh_token });
    expect(r.status).toBe(200);
    const auth2 = await request(app).get("/authorize").query({ redirect_uri: OOB_REDIRECT_URI });
    expect(auth2.status).toBe(200);
    now += 11 * 60 * 1000; // the new code (10 min) expires
    const reaped = oauth.sweep();
    expect(reaped).toBeGreaterThanOrEqual(1);
    expect(oauth.stores.clients.size).toBe(1);
    oauth.close();
  });
});
