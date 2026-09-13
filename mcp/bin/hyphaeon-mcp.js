#!/usr/bin/env node
/**
 * hyphaeon-mcp — stdio entry point for the HyphAeon MCP server.
 *
 * WHY THIS FILE EXISTS
 *
 * PLAN.md 3.6: `npx @veg/hyphaeon-mcp` (or `claude mcp add hyphaeon -- npx @veg/hyphaeon-mcp`)
 * runs the server on the user's own machine over stdio, the analysis-engine analogue of the
 * browser: private, offline once the weights are local, and allowed to read `file://` inputs.
 * The shape is datamonkey-js-server lib/mcp/stdio.js. stdout is the transport, so every log line
 * goes to stderr.
 *
 * EVERY tool runs in this process (src/engine.js over onnxruntime-node; provenance.surface
 * "mcp-stdio"): hyphaeon_analyze (the whole report), hyphaeon_meme, hyphaeon_busted,
 * hyphaeon_epistasis, hyphaeon_dms, hyphaeon_phenotype, hyphaeon_evaluate and, since Phase 6, the
 * time pillars — hyphaeon_dates, hyphaeon_dating and hyphaeon_temporal. Since Phase 3 nothing
 * spawns a subprocess — no Python, no WebAssembly tree tool — so the only thing this process needs
 * on disk is the models directory (PLAN.md 8, phase 3; D16, D22).
 *
 * TWO OF THOSE NEED NO MODELS AT ALL. `hyphaeon_dates` runs the runtime's `./dates` subtree, which
 * imports no manifest, no session and no `predict.js` (measured: 93 ms of module import, zero
 * onnxruntime modules loaded), and `hyphaeon_dating` loads a graph only when `use_model` is set —
 * so a checkout with no models directory still serves both, and says so rather than failing at the
 * first call. `hyphaeon_dating use_model: true` needs a SECOND artifact, `<variant>_taxa.onnx`;
 * `list_models` reports `dating_graph` per variant so a client can tell before it asks.
 *
 * Environment: HYPHAEON_MODELS_DIR (manifest.json and the graphs; default web/static/models,
 * then the sibling HyphAeon/models), HYPHAEON_VARIANT (default model variant),
 * HYPHAEON_MCP_THREADS (onnxruntime intra-op threads, default 1), HYPHAEON_EXAMPLES_DIR,
 * HYPHAEON_GALLERY_DIR, HYPHAEON_MCP_LOG (debug|info|warn|error|silent).
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "../src/server.js";

const handle = createServer({ allowFilePaths: true, surface: "mcp-stdio" });
const transport = new StdioServerTransport();

async function shutdown(signal) {
  handle.logger.info("received " + signal + ", shutting down");
  // handle.close() releases the engine's ONNX sessions first: onnxruntime-node 1.23.2 aborts
  // (SIGABRT, "mutex lock failed") when the process exits with a session still alive, so the
  // exit must happen after the release and, preferably, by draining the loop rather than
  // process.exit(). The unref'd timer is the fallback if a transport keeps the loop alive.
  await handle.close();
  process.exitCode = 0;
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

await handle.server.connect(transport);
process.stderr.write("HyphAeon MCP server running on stdio\n");
