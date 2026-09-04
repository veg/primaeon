/**
 * server.js — builds one HyphAeon McpServer with its tools, prompts, resources, engine and job store.
 *
 * WHY THIS FILE EXISTS
 *
 * Both transports need the same server: bin/hyphaeon-mcp.js (stdio, one server for the life of
 * the process) and src/http.js (streamable HTTP, one server per session, as the SDK requires).
 * datamonkey-js-server builds it twice, in stdio.js and in index.js createMcpServer(); here it is
 * built once so the two transports cannot drift.
 *
 * Two things differ between the transports and are passed in: `allowFilePaths` (over stdio the
 * server runs on the caller's own machine and may read `file://` inputs, PLAN.md 3.6; over HTTP
 * it must not) and `surface`, the name native results claim in `provenance.surface`
 * ("mcp-stdio" | "mcp-http", PLAN.md 3.5). The in-process engine (src/engine.js) is created once
 * per process and shared by every HTTP session through `opts.engine`, so the memoised ONNX
 * sessions are loaded once, not once per client.
 *
 * Job-completion notifications are sent as MCP logging messages, best-effort, the way
 * datamonkey-js-server lib/mcp/job-notifier.js describes: the standalone SSE stream may not be
 * open, the stdio client may ignore logging, and a missed message never loses a job because
 * job_status polling is the source of truth. That is why the server declares the `logging`
 * capability — Server.sendLoggingMessage early-returns without it.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFileSync } from "node:fs";
import { createJobStore } from "./jobs.js";
import { registerTools } from "./tools.js";
import { registerPrompts } from "./prompts.js";
import { registerResources } from "./resources.js";
import { createEngine } from "./engine.js";

const PKG = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

/**
 * A stderr logger. stdout belongs to the stdio transport, so nothing here may ever write to it.
 *
 * @param {object} [env]
 * @param {string} [level]  overrides env.HYPHAEON_MCP_LOG (default "info")
 */
export function createLogger(env = process.env, level) {
  const name = (level || env.HYPHAEON_MCP_LOG || "info").toLowerCase();
  const threshold = LEVELS[name] ?? LEVELS.info;
  const write = (lvl, msg) => {
    if (LEVELS[lvl] < threshold) return;
    process.stderr.write("[hyphaeon-mcp] " + new Date().toISOString() + " " + lvl.toUpperCase() + " " + msg + "\n");
  };
  return {
    debug: (m) => write("debug", m),
    info: (m) => write("info", m),
    warn: (m) => write("warn", m),
    error: (m) => write("error", m)
  };
}

export const INSTRUCTIONS =
  "HyphAeon is a neural surrogate for HyPhy MEME (site-level episodic selection) with " +
  "derived analyses: gene-level omnibus (BUSTED surrogate), co-selection networks and " +
  "epistatic sectors, digital deep mutational scanning, and phenotype association. Run " +
  "hyphaeon_validate before any analysis. Results are rankings evaluated against MEME, not " +
  "truth: rank is strong, scale is compressed, calibration depends on tree regime. Every " +
  "result carries a provenance block: surface \"mcp-stdio\" / \"mcp-http\" means the numbers were " +
  "computed in this process by the JavaScript port (hyphaeon_meme, hyphaeon_busted, " +
  "hyphaeon_evaluate); surface \"python-reference\" means the Python reference ran through a " +
  "bridge (hyphaeon_epistasis, hyphaeon_dms, hyphaeon_phenotype). Sequences submitted to a " +
  "remote server are unpublished research: say so before sending them.";

/**
 * @param {object} [opts]
 * @param {boolean} [opts.allowFilePaths]   accept file:// inputs (stdio only)
 * @param {"mcp-stdio"|"mcp-http"} [opts.surface]  default "mcp-stdio"
 * @param {object} [opts.env]               defaults to process.env
 * @param {object} [opts.logger]            defaults to createLogger(env)
 * @param {object} [opts.engine]            a shared createEngine() (HTTP sessions); default: a new one
 * @param {Function} [opts.bridge]          override the Python bridge (tests)
 * @param {object} [opts.jobStore]          override the job store options
 * @param {string} [opts.name]
 * @returns {{server: McpServer, jobs: object, logger: object, engine: object, close: () => Promise<void>}}
 */
export function createServer(opts = {}) {
  const env = opts.env || process.env;
  const logger = opts.logger || createLogger(env);
  const surface = opts.surface || "mcp-stdio";
  // An engine passed in is shared (HTTP sessions) and outlives this server; one created here is
  // ours to release on close (its ONNX sessions must be released before the process exits).
  const ownsEngine = !opts.engine;
  const engine = opts.engine || createEngine({ env, logger });
  const server = new McpServer(
    { name: opts.name || "hyphaeon", version: PKG.version, websiteUrl: "https://github.com/veg/HyphAeon" },
    { capabilities: { tools: {}, prompts: {}, resources: {}, logging: {} }, instructions: INSTRUCTIONS }
  );

  const jobs = createJobStore(
    Object.assign(
      {
        onTerminal: (job) => {
          logger.info("job " + job.job_id + " " + job.status);
          server
            .sendLoggingMessage({
              level: job.status === "completed" ? "info" : "warning",
              logger: "hyphaeon-jobs",
              data: Object.assign({ event: "job." + job.status }, job)
            })
            .catch(() => {
              // best-effort; job_status polling is the source of truth
            });
        }
      },
      opts.jobStore || {}
    )
  );

  registerTools(server, {
    jobs,
    env,
    logger,
    surface,
    engine,
    allowFilePaths: !!opts.allowFilePaths,
    bridge: opts.bridge
  });
  registerPrompts(server);
  registerResources(server, { env, logger });

  return {
    server,
    jobs,
    logger,
    engine,
    async close() {
      jobs.close();
      await server.close().catch(() => {});
      if (ownsEngine) await engine.close().catch(() => {});
    }
  };
}
