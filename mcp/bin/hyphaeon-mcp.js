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
 * Environment: HYPHAEON_PY_BIN (Python CLI; default `hyphaeon` on PATH), HYPHAEON_WEIGHTS,
 * HYPHAEON_VARIANT, HF_HUB_OFFLINE (all passed to the CLI), HYPHAEON_MODELS_DIR,
 * HYPHAEON_EXAMPLES_DIR, HYPHAEON_MCP_LOG (debug|info|warn|error|silent).
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "../src/server.js";

const handle = createServer({ allowFilePaths: true });
const transport = new StdioServerTransport();

async function shutdown(signal) {
  handle.logger.info("received " + signal + ", shutting down");
  await handle.close();
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

await handle.server.connect(transport);
process.stderr.write("HyphAeon MCP server running on stdio\n");
