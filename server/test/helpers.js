/**
 * helpers.js — shared test scaffolding: a throwaway configuration, the bat_oas1 example, an SSE
 * reader, and a PKCE pair.
 *
 * WHY THIS FILE EXISTS. Every server test needs the same three things: an app on a temporary data
 * directory (so SQLite and job directories never touch the real ones), the small bat_oas1 example
 * (18 taxa x 351 codons, tree with branch lengths, ~300 ms through the general graph), and a way
 * to read a server-sent-event stream to its end. Keeping them here keeps each test about one thing.
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";
import { silentLogger } from "../src/logger.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");

export const INPUTS = path.join(REPO, "web/static/gallery/inputs");

export function example(name) {
  const fasta = path.join(INPUTS, name + ".fasta");
  const nwk = path.join(INPUTS, name + ".nwk");
  return {
    alignment: readFileSync(fasta, "utf8"),
    tree: existsSync(nwk) ? readFileSync(nwk, "utf8") : undefined,
    names: { alignment: name + ".fasta", tree: existsSync(nwk) ? name + ".nwk" : undefined }
  };
}

/**
 * An example from the sibling HyphAeon checkout (or HYPHAEON_EXAMPLES_DIR), the same resolution
 * mcp/test/helpers.js uses. The time pillars' examples live there rather than in the web gallery:
 * the gallery holds the five selection demos, and korber / H5N1 / H1N1 are the DATED sets.
 */
export function engineExamplesDir() {
  const candidates = [process.env.HYPHAEON_EXAMPLES_DIR, path.resolve(REPO, "../HyphAeon/examples")].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

/** `{alignment, tree?, dates_file?, names}` for one engine example; `null` when the checkout is absent. */
export function engineExample(name, { tree, dates } = {}) {
  const dir = engineExamplesDir();
  if (!dir || !existsSync(path.join(dir, name + ".fasta"))) return null;
  const out = { alignment: readFileSync(path.join(dir, name + ".fasta"), "utf8"), names: { alignment: name + ".fasta" } };
  if (tree && existsSync(path.join(dir, tree))) {
    out.tree = readFileSync(path.join(dir, tree), "utf8");
    out.names.tree = tree;
  }
  if (dates && existsSync(path.join(dir, dates))) {
    out.dates_file = readFileSync(path.join(dir, dates), "utf8");
    out.names.dates_file = dates;
  }
  return out;
}

export function modelsDir() {
  if (process.env.HYPHAEON_MODELS_DIR) return process.env.HYPHAEON_MODELS_DIR;
  for (const c of [path.join(REPO, "web/static/models"), path.resolve(REPO, "../HyphAeon/models")]) {
    if (existsSync(path.join(c, "manifest.json"))) return c;
  }
  return null;
}

/** A configuration on a fresh temporary data directory under server/.test-data. */
export function testConfig(overrides = {}) {
  const root = path.join(HERE, "..", ".test-data");
  mkdirSync(root, { recursive: true });
  const dataDir = mkdtempSync(path.join(root, "run-"));
  const env = Object.assign({}, process.env, {
    HYPHAEON_SERVER_PORT: "7041",
    HYPHAEON_SERVER_ISSUER: "http://localhost:7041",
    HYPHAEON_DATA_DIR: dataDir,
    HYPHAEON_SERVER_WORKERS: "1",
    HYPHAEON_SERVER_THREADS: process.env.HYPHAEON_SERVER_THREADS || "2",
    HYPHAEON_SERVER_LOG: "silent"
  });
  const md = modelsDir();
  if (md) env.HYPHAEON_MODELS_DIR = md;
  const config = loadConfig(env, Object.assign({ dataDir }, overrides));
  config.cleanup = () => rmSync(dataDir, { recursive: true, force: true });
  return config;
}

export { silentLogger };

/**
 * Read an SSE stream from a listening server until `done` (or the connection closes).
 * @returns {Promise<Array<{event: string, data: any}>>}
 */
export function readSse(baseUrl, pathname, { until = "done", timeoutMs = 90_000, onEvent } = {}) {
  return new Promise((resolve, reject) => {
    const events = [];
    const req = http.get(baseUrl + pathname, { headers: { Accept: "text/event-stream" } }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error("SSE status " + res.statusCode));
        return;
      }
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf("\n\n")) !== -1) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          let event = "message";
          let data = "";
          for (const line of block.split("\n")) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) data += line.slice(5).trim();
          }
          if (!data) continue;
          // `bytes` is what actually crossed the wire for this event, which is the thing a test
          // about a streaming null has to be able to assert on.
          events.push({ event, data: JSON.parse(data), bytes: data.length });
          if (onEvent) onEvent(events[events.length - 1], events);
          if (event === until) {
            req.destroy();
            resolve(events);
            return;
          }
        }
      });
      res.on("end", () => resolve(events));
      res.on("error", reject);
    });
    req.on("error", (err) => (err.code === "ECONNRESET" ? resolve(events) : reject(err)));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error("SSE timed out"));
    });
  });
}

/** Listen on an ephemeral port; returns {baseUrl, close}. */
export function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ baseUrl: "http://127.0.0.1:" + port, port, server, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

export function pkcePair() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** Parse the SSE body a StreamableHTTP POST answers with into its JSON-RPC messages. */
export function parseSseBody(text) {
  const out = [];
  for (const block of String(text).split("\n\n")) {
    for (const line of block.split("\n")) {
      if (line.startsWith("data:")) out.push(JSON.parse(line.slice(5).trim()));
    }
  }
  return out;
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
