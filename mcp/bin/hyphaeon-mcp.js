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
 * hyphaeon_meme, hyphaeon_busted and hyphaeon_evaluate run in this process (src/engine.js over
 * onnxruntime-node; provenance.surface "mcp-stdio"); hyphaeon_epistasis, hyphaeon_dms and
 * hyphaeon_phenotype run through the Python reference bridge (src/bridge.js).
 *
 * Environment: HYPHAEON_MODELS_DIR (manifest.json and the graphs; default web/static/models,
 * then the sibling HyphAeon/models), HYPHAEON_VARIANT (default variant, in-process and CLI),
 * HYPHAEON_MCP_THREADS (onnxruntime intra-op threads, default 1), HYPHAEON_PY_BIN (Python CLI
 * for the bridged pillars; default `hyphaeon` on PATH), HYPHAEON_WEIGHTS, HF_HUB_OFFLINE (passed
 * to the CLI), HYPHAEON_EXAMPLES_DIR, HYPHAEON_GALLERY_DIR, HYPHAEON_MCP_LOG
 * (debug|info|warn|error|silent).
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
