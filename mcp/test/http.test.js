/**
 * http.test.js — mountHttp with and without the server's `authenticate` middleware.
 *
 * WHY THIS FILE EXISTS
 *
 * PLAN.md 3.6 puts the OAuth ceremony in server/ and this package takes only its Bearer check as
 * an Express middleware. What has to be pinned on this side is the seam, not OAuth: with
 * `authenticate` given, no MCP request reaches a transport — and no session is created —
 * unless the middleware calls next(); without it the mount still serves, and says so loudly at
 * startup. The app here is a forty-line Express look-alike over node:http (post/get/delete with
 * a handler chain, req.body, res.status().json()) so the test needs neither express nor a
 * port-squatting dev server: it listens on the first free port in 4240-4299 and stops itself.
 * The client is the SDK's own StreamableHTTPClientTransport, so the initialize round trip and
 * tools/list run through the real protocol.
 */

import { describe, it, expect, afterAll } from "vitest";
import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mountHttp, UNAUTHENTICATED_WARNING } from "../src/http.js";
import { TOOL_NAMES } from "../src/tools.js";

/** An Express look-alike: enough of app.post/get/delete, req.body and res.status().json(). */
function miniApp() {
  const routes = [];
  const add = (method) => (p, ...handlers) => routes.push({ method, path: p, handlers });
  const app = { post: add("POST"), get: add("GET"), delete: add("DELETE") };
  const server = http.createServer(async (req, res) => {
    res.status = (code) => {
      res.statusCode = code;
      return res;
    };
    res.json = (obj) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(obj));
    };
    const url = new URL(req.url, "http://localhost");
    const route = routes.find((r) => r.method === req.method && r.path === url.pathname);
    if (!route) {
      res.status(404).json({ error: "no route" });
      return;
    }
    if (req.method === "POST") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const text = Buffer.concat(chunks).toString("utf8");
      try {
        req.body = text ? JSON.parse(text) : undefined;
      } catch {
        req.body = undefined;
      }
    }
    try {
      for (let i = 0; i < route.handlers.length; i++) {
        const h = route.handlers[i];
        if (i < route.handlers.length - 1) {
          let advanced = false;
          await new Promise((resolve, reject) => {
            Promise.resolve(
              h(req, res, (err) => {
                advanced = true;
                err ? reject(err) : resolve();
              })
            ).then(() => {
              // middleware that responded without calling next(): stop the chain
              if (!advanced) resolve();
            }, reject);
          });
          if (!advanced) return;
        } else {
          await h(req, res);
        }
      }
    } catch (err) {
      if (!res.headersSent) res.status(500).json({ error: String(err && err.message) });
    }
  });
  return { app, server };
}

async function listenInRange(server) {
  for (let port = 4240; port <= 4299; port++) {
    const ok = await new Promise((resolve) => {
      const onError = () => {
        server.removeListener("listening", onListening);
        resolve(false);
      };
      const onListening = () => {
        server.removeListener("error", onError);
        resolve(true);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, "127.0.0.1");
    });
    if (ok) return port;
  }
  throw new Error("no free port in 4240-4299");
}

const logs = { warn: [], info: [] };
const logger = { debug() {}, info: (m) => logs.info.push(m), warn: (m) => logs.warn.push(m), error() {} };

async function clientFor(url, headers) {
  const transport = new StreamableHTTPClientTransport(new URL(url), headers ? { requestInit: { headers } } : undefined);
  const client = new Client({ name: "hyphaeon-http-test", version: "0.0.0" });
  await client.connect(transport);
  return { client, transport };
}

const cleanups = [];
afterAll(async () => {
  for (const fn of cleanups.reverse()) await fn();
});

describe("mountHttp with an authenticate middleware", () => {
  it("runs the middleware before every MCP request: 401 without the token, a working session with it", async () => {
    const { app, server } = miniApp();
    let calls = 0;
    const authenticate = (req, res, next) => {
      calls++;
      if (req.headers.authorization !== "Bearer secret") {
        res.status(401).setHeader("www-authenticate", 'Bearer realm="hyphaeon"');
        res.json({ error: "invalid_token" });
        return;
      }
      next();
    };
    const mount = mountHttp(app, { path: "/mcp", authenticate, logger, enableJsonResponse: true });
    expect(mount.authenticated).toBe(true);
    expect(mount.path).toBe("/mcp");
    const port = await listenInRange(server);
    cleanups.push(async () => {
      await mount.close();
      await new Promise((r) => server.close(r));
    });
    const url = "http://127.0.0.1:" + port + "/mcp";

    // No token: the middleware answers and no session is created.
    await expect(clientFor(url)).rejects.toThrow();
    expect(mount.sessions.size).toBe(0);
    expect(calls).toBeGreaterThan(0);

    // With the token: initialize, tools/list, and one session in the map.
    const { client } = await clientFor(url, { Authorization: "Bearer secret" });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    expect(mount.sessions.size).toBe(1);
    const res = await client.callTool({ name: "job_status", arguments: { job_id: "0".repeat(32) } });
    expect(JSON.parse(res.content[0].text).status).toBe("not_found");
    await client.close();
    expect(logs.info.some((m) => /behind the supplied authenticate middleware/.test(m))).toBe(true);
    expect(logs.warn.some((m) => m === UNAUTHENTICATED_WARNING)).toBe(false);
  });
});

describe("mountHttp without authenticate", () => {
  it("mounts unauthenticated, warns loudly at startup, and still serves the protocol (file:// refused)", async () => {
    const { app, server } = miniApp();
    const before = logs.warn.length;
    const mount = mountHttp(app, { path: "/mcp", logger, enableJsonResponse: true });
    expect(mount.authenticated).toBe(false);
    expect(logs.warn.slice(before)).toContain(UNAUTHENTICATED_WARNING);
    expect(UNAUTHENTICATED_WARNING).toMatch(/WITHOUT AUTHENTICATION/);
    const port = await listenInRange(server);
    cleanups.push(async () => {
      await mount.close();
      await new Promise((r) => server.close(r));
    });
    const { client } = await clientFor("http://127.0.0.1:" + port + "/mcp");
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(TOOL_NAMES.length);
    // Over HTTP file:// inputs are never read, authenticated or not.
    const res = await client.callTool({ name: "hyphaeon_validate", arguments: { alignment: "file:///etc/hosts" } });
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).error).toMatch(/file:\/\/ URL/);
    await client.close();
  });
});
