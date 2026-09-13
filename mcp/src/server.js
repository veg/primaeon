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
  "epistatic sectors, digital deep mutational scanning, and phenotype association. The product " +
  "has one action: hyphaeon_analyze takes an alignment (and a tree if there is one) and runs " +
  "everything that needs no further input into one report whose sections arrive in order — " +
  "diagnostics, sites, gene, epistasis + sectors, attribution, artifact filter, then a capped " +
  "digital DMS; phenotype needs a trait and is offered, not run. Large reports come back as a " +
  "summary plus a job id: page them with get_results section=..., and read hyphaeon://report/{id}. " +
  "The per-pillar tools (hyphaeon_meme, hyphaeon_busted, hyphaeon_epistasis, hyphaeon_dms, " +
  "hyphaeon_phenotype, hyphaeon_evaluate) mirror the CLI one option at a time; hyphaeon_validate " +
  "checks an alignment without running the model. " +
  "THE TIME PILLARS, for sequences that carry sampling dates: call hyphaeon_dates FIRST — it runs no " +
  "model, costs milliseconds and reports which sequence got a date and by what rule — then " +
  "hyphaeon_dating (the molecular clock and MRCA date; model-free by default, and `use_model` is a " +
  "DIFFERENT estimator rather than a better one) and hyphaeon_temporal (per-site selection " +
  "trajectories through calendar time with a permutation null). Both REFUSE a date set whose dates " +
  "are mostly bare numbers read out of sequence names, and one that leaves sequences undated, until " +
  "you pass the named override: the browser asks a human those two questions and a tool call has " +
  "nobody to ask. hyphaeon_temporal always runs as a job and its record is never inline (megabytes of " +
  "trajectories): read it with get_results section=<summary|sites|curves|waves|permutations|dates|" +
  "candidates|warnings|honesty|provenance>, and read `honesty.null_state` before quoting any negative " +
  "finding — a null that is still running or was stopped is not a finished result. These two pillars' " +
  "`provenance.reference_command` is a {command, reproduces, caveats} object rather than the argv " +
  "array the others carry, because neither can promise a reproduction. Results are rankings evaluated against MEME, " +
  "not truth: rank is strong, scale is compressed, calibration depends on tree regime. Every " +
  "result carries a provenance block: surface \"mcp-stdio\" / \"mcp-http\" means the numbers were " +
  "computed in this process by the JavaScript port — every tool, phenotype included, since Phase 3; " +
  "no Python runs anywhere. `preprocessing.tree_source` says whether the distances came from the " +
  "tree you gave (\"user\"/\"embedded\") or from pairwise TN93 because there was no usable tree " +
  "(\"tn93\"); a tree is optional on every tool. Sequences submitted to a remote server are " +
  "unpublished research: say so before sending them.";

/**
 * @param {object} [opts]
 * @param {boolean} [opts.allowFilePaths]   accept file:// inputs (stdio only)
 * @param {"mcp-stdio"|"mcp-http"} [opts.surface]  default "mcp-stdio"
 * @param {object} [opts.env]               defaults to process.env
 * @param {object} [opts.logger]            defaults to createLogger(env)
 * @param {object} [opts.engine]            a shared createEngine() (HTTP sessions); default: a new one
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
    allowFilePaths: !!opts.allowFilePaths
  });
  registerPrompts(server);
  // The job store is handed to the resources for hyphaeon://report/{id}: a finished
  // hyphaeon_analyze report is readable as a resource for as long as the job lives.
  registerResources(server, { env, logger, jobs });

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
