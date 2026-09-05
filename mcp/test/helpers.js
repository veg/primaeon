/**
 * helpers.js — an in-process MCP client/server pair for the tests.
 *
 * WHY THIS FILE EXISTS
 *
 * The SDK's InMemoryTransport links a Client to a McpServer without a process boundary, so every
 * tool, prompt and resource is exercised through the real protocol (schema validation included)
 * without spawning the bin. Example inputs come from the sibling HyphAeon checkout (or
 * HYPHAEON_EXAMPLES_DIR), the same files the reference implementation's tests and the parity
 * harness use, so a fixture and a tool call are always about the same bytes.
 *
 * Nothing in this suite starts a subprocess: since Phase 3 every pillar, phenotype included,
 * runs in the test process through src/engine.js over onnxruntime-node.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "../src/server.js";
import { createEngine } from "../src/engine.js";
import { examplesDirCandidates } from "../src/models.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const SILENT = { debug() {}, info() {}, warn() {}, error() {} };

/**
 * ONNX Runtime intra-op threads for the model-running tests: HYPHAEON_MCP_THREADS when set, else
 * 4. The stdio server's own default is 1 (one client, a laptop); the epistasis, DMS and report
 * tests run thousands of forward passes and are wall-clock bound on this x64/Rosetta Node.
 */
export const TEST_THREADS = Number.parseInt(process.env.HYPHAEON_MCP_THREADS || "", 10) >= 1 ? Number.parseInt(process.env.HYPHAEON_MCP_THREADS, 10) : 4;

/**
 * @param {object} [opts] createServer options; `threads` builds an engine with that many ORT
 *   threads (the engine is then this helper's to release on close, as createServer would).
 */
export async function connect(opts = {}) {
  const { threads, ...serverOpts } = opts;
  let engine = null;
  if (Number.isInteger(threads) && threads >= 1 && !serverOpts.engine) {
    engine = createEngine({ env: process.env, logger: SILENT, threads });
    serverOpts.engine = engine;
  }
  const handle = createServer(Object.assign({ logger: SILENT }, serverOpts));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await handle.server.connect(serverTransport);
  const client = new Client({ name: "hyphaeon-mcp-test", version: "0.0.0" });
  await client.connect(clientTransport);
  return {
    client,
    handle,
    engine: engine || handle.engine,
    async close() {
      await client.close();
      await handle.close();
      if (engine) await engine.close();
    }
  };
}

/** |got - want| <= tol * max(1, |want|): the relative class PLAN.md 5.4 uses for model outputs. */
export function withinRel(got, want, tol) {
  return Math.abs(got - want) <= tol * Math.max(1, Math.abs(want));
}

/**
 * Compare a record against the reference's, key by key: numbers within `tol` (relative to
 * max(1, |ref|), or to `opts.scale` when given — the LRT magnitude a DMS record's deltas were
 * differenced from), everything else exact; nested objects recurse with their key ORDER checked
 * too (the Python writes dicts in insertion order and the writers reproduce it). Returns the
 * worst numeric difference seen and throws on the first non-numeric mismatch.
 */
export function compareRecord(got, want, tol, where = "record", opts = {}) {
  let worst = { diff: 0, where: null };
  const walk = (g, w, p) => {
    if (typeof w === "number") {
      if (typeof g !== "number") throw new Error(p + ": expected a number, got " + JSON.stringify(g));
      const d = Math.abs(g - w) / (opts.scale ? opts.scale : Math.max(1, Math.abs(w)));
      if (d > worst.diff) worst = { diff: d, where: p, got: g, want: w };
      if (d > tol) throw new Error(p + ": " + g + " vs " + w + " (relative " + d.toExponential(2) + " > " + tol + ")");
      return;
    }
    if (Array.isArray(w)) {
      if (!Array.isArray(g) || g.length !== w.length) throw new Error(p + ": array length " + (g && g.length) + " vs " + w.length);
      w.forEach((x, i) => walk(g[i], x, p + "[" + i + "]"));
      return;
    }
    if (w && typeof w === "object") {
      if (!g || typeof g !== "object") throw new Error(p + ": expected an object");
      const wk = Object.keys(w);
      const gk = Object.keys(g);
      if (JSON.stringify(gk) !== JSON.stringify(wk)) throw new Error(p + ": keys " + JSON.stringify(gk) + " vs " + JSON.stringify(wk));
      for (const k of wk) walk(g[k], w[k], p + "." + k);
      return;
    }
    if (g !== w) throw new Error(p + ": " + JSON.stringify(g) + " vs " + JSON.stringify(w));
  };
  walk(got, want, where);
  return worst;
}

/**
 * A DMS plasticity table against the reference's, record by record, at the graph class. Every
 * number in a record is an LRT (`baseline_lrt`), a DIFFERENCE of two LRTs (`mutant_deltas`,
 * `mean/max/min_delta_lrt`, `intrinsic_plasticity`) or a function of the baseline (`p_value`),
 * and each LRT through ORT carries 1e-5 x max(1, |lrt|) (PLAN.md 5.4), so a delta carries the
 * sum of the two: the scale is max(1, |baseline|) + max(1, |baseline + largest delta|). Keys,
 * their order, `site` and `wt_aa` are exact. Returns the worst |delta| / scale.
 */
export function compareDmsRecords(got, want, tol = 1e-5, where = "plasticity") {
  if (!Array.isArray(got) || got.length !== want.length) throw new Error(where + ": " + (got && got.length) + " records vs " + want.length);
  let worst = { diff: 0, where: null };
  for (let i = 0; i < want.length; i++) {
    const w = want[i];
    const deltas = Object.values(w.mutant_deltas || {});
    const biggest = deltas.length ? Math.max(...deltas.map((d) => Math.abs(d))) : 0;
    const scale = Math.max(1, Math.abs(w.baseline_lrt)) + Math.max(1, Math.abs(w.baseline_lrt) + biggest);
    if (got[i].site !== w.site || got[i].wt_aa !== w.wt_aa) throw new Error(where + "[" + i + "]: site/wt_aa " + got[i].site + got[i].wt_aa + " vs " + w.site + w.wt_aa);
    const r = compareRecord(got[i], w, tol, where + "[" + i + "]", { scale });
    if (r.diff > worst.diff) worst = Object.assign(r, { scale });
  }
  return worst;
}

export function parseText(res) {
  if (!res.content || !res.content[0] || res.content[0].type !== "text") {
    throw new Error("tool result has no text content: " + JSON.stringify(res));
  }
  return JSON.parse(res.content[0].text);
}

export function examplesDir() {
  return examplesDirCandidates(process.env)[0];
}

export async function example(name) {
  return readFile(path.join(examplesDir(), name), "utf8");
}

export async function waitFor(fn, { timeoutMs = 5000, stepMs = 20 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

export { HERE };
