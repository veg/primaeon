/**
 * helpers.js — an in-process MCP client/server pair for the tests.
 *
 * WHY THIS FILE EXISTS
 *
 * The SDK's InMemoryTransport links a Client to a McpServer without a process boundary, so every
 * tool, prompt and resource is exercised through the real protocol (schema validation included)
 * without spawning the bin. Example inputs come from the sibling HyphAeon checkout (or
 * HYPHAEON_EXAMPLES_DIR), the same files the Python tests and the parity harness use.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "../src/server.js";
import { examplesDirCandidates } from "../src/models.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const SILENT = { debug() {}, info() {}, warn() {}, error() {} };

export async function connect(opts = {}) {
  const handle = createServer(Object.assign({ logger: SILENT }, opts));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await handle.server.connect(serverTransport);
  const client = new Client({ name: "hyphaeon-mcp-test", version: "0.0.0" });
  await client.connect(clientTransport);
  return {
    client,
    handle,
    async close() {
      await client.close();
      await handle.close();
    }
  };
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
