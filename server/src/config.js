/**
 * config.js — one place where the HyphAeon server reads its environment.
 *
 * WHY THIS FILE EXISTS
 *
 * PLAN.md 3.5 fixes the server's numbers (alignment <= 8 MiB, job timeout 10 min, TTL 7 days,
 * per-IP rate limit, no accounts, same-origin CSP) and the operator supplies the paths: where the
 * ONNX graphs are, where job directories and the SQLite file live, which public URL the OAuth
 * issuer advertises. Every other module takes a `config` object built here rather than reading
 * `process.env` itself, so tests can build a configuration in memory (a temp data directory, a
 * short TTL, one worker) and the bin can print what it resolved.
 *
 * The caps themselves are NOT redefined here: they are imported from `@veg/hyphaeon-mcp/caps`,
 * the leaf module the MCP and the web app already share, so the three surfaces cannot drift
 * (PLAN.md 3.3 "one manifest, one parity harness"). Only the operator-tunable values (TTL, worker
 * count, ORT threads, rate limits) are read from the environment, and every one of them has the
 * PLAN's figure as its default.
 *
 * Allowed origins are the issuer only (PLAN.md 3.5 "CSP default-src 'self'"; the web app and the
 * API are served from the same host behind Apache, deploy/apache-hyphaeon.conf), plus the local
 * development origins the operator lists in HYPHAEON_SERVER_EXTRA_ORIGINS.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { JOB_TIMEOUT_MS, JOB_TTL_MS, MAX_ALIGNMENT_CHARS } from "@veg/hyphaeon-mcp/caps";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_PORT = 7040;

/**
 * The work cap on the temporal pillar's date-shuffling null, on THIS surface.
 *
 * THE BROWSER'S NUMBER IS NOT THIS SURFACE'S NUMBER, and this is the one place Phase 6 raises a
 * limit rather than inheriting one. `TEMPORAL_PERM_BUDGET_DEFAULT` (runtime/src/temporal/null.js)
 * is 5.0e10 units, chosen so a tab stays responsive: about 91 s at that file's own measured
 * throughput anchor of 5.5e8 units/s, and 139 s at the slowest dense measurement it records
 * (3.59e8 on a loaded machine). A server has no tab to keep responsive, runs the null in a worker
 * thread, and — the load-bearing part — a null the clock stops STILL RETURNS A VALID RECORD at the
 * achieved draw count, because `runTemporalNull` catches its own abort and draw `b` is seeded from
 * `splitmix64(seed, b)`, so a run stopped at 313 draws is bit-identical to one configured at 313.
 *
 * So this server's real bound on a long null is HYPHAEON_JOB_TIMEOUT_MS (600 s by default), not a
 * work cap, and the work cap's job is only to refuse a null that could never finish inside any
 * timeout. 1.0e12 units is about 30 min at the anchor rate and about 46 min at the slowest rate
 * that file measured — deliberately above the default job timeout in both cases, so at the shipped
 * settings the TIMEOUT is what stops a long null (leaving a usable record) and this number never
 * fires. An operator who raises HYPHAEON_JOB_TIMEOUT_MS past half an hour gets the runtime's own
 * decline (TEMPORAL_NULL_SKIPPED, which withholds the null and computes everything else) instead of
 * a job that runs for hours.
 *
 * Those throughput figures are ANCHORS, not floors: null.js's own header forbids quoting either as
 * a bound, and four of six dense measurements on a loaded machine came in below the anchor. The
 * conversion above is a sanity check on the ordering of two numbers, not a promise about seconds.
 *
 * Set HYPHAEON_TEMPORAL_PERM_BUDGET to override; a caller may lower or raise it per job with the
 * `perm_work_budget` option.
 */
export const TEMPORAL_PERM_BUDGET = 1.0e12;

/** Where the models directory is looked for when HYPHAEON_MODELS_DIR is not set. */
export function defaultModelsCandidates() {
  return [
    path.resolve(HERE, "../../web/static/models"),
    path.resolve(HERE, "../../../HyphAeon/models"),
    path.resolve(HERE, "../models")
  ];
}

function intEnv(env, key, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function floatEnv(env, key, fallback) {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseTrustProxy(raw) {
  if (raw === undefined || raw === "") return "loopback";
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^\d+$/.test(raw)) return Number(raw);
  return raw;
}

function listEnv(env, key) {
  const raw = env[key];
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim().replace(/\/$/, ""))
    .filter(Boolean);
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @param {object} [overrides]  values that win over the environment (tests)
 */
export function loadConfig(env = process.env, overrides = {}) {
  const port = intEnv(env, "HYPHAEON_SERVER_PORT", intEnv(env, "PORT", DEFAULT_PORT), { min: 1, max: 65535 });
  const issuer = (env.HYPHAEON_SERVER_ISSUER || "http://localhost:" + port).replace(/\/$/, "");
  const dataDir = env.HYPHAEON_DATA_DIR ? path.resolve(env.HYPHAEON_DATA_DIR) : path.resolve(HERE, "../data");
  const config = {
    port,
    /** Public base URL: OAuth issuer, protected-resource URI (`<issuer>/mcp`), allowed origin. */
    issuer,
    /** Directory holding manifest.json and the .onnx graphs; null = search defaultModelsCandidates(). */
    modelsDir: env.HYPHAEON_MODELS_DIR ? path.resolve(env.HYPHAEON_MODELS_DIR) : null,
    /** SQLite file and per-job directories live here. */
    dataDir,
    dbPath: path.join(dataDir, "jobs.sqlite"),
    jobsDir: path.join(dataDir, "jobs"),
    /** PLAN.md 3.5: TTL 7 days, timeout 10 min, alignment <= 8 MiB. */
    jobTtlMs: intEnv(env, "HYPHAEON_JOB_TTL_MS", JOB_TTL_MS, { min: 1000 }),
    jobTimeoutMs: intEnv(env, "HYPHAEON_JOB_TIMEOUT_MS", JOB_TIMEOUT_MS, { min: 1000 }),
    sweepIntervalMs: intEnv(env, "HYPHAEON_SWEEP_INTERVAL_MS", 10 * 60 * 1000, { min: 100 }),
    bodyLimitBytes: MAX_ALIGNMENT_CHARS,
    /** Worker pool: one analysis worker by default (each holds its own ONNX sessions). */
    workers: intEnv(env, "HYPHAEON_SERVER_WORKERS", 1, { min: 1, max: 8 }),
    /** ORT intra-op threads per worker (onnxruntime-node). */
    threads: intEnv(env, "HYPHAEON_SERVER_THREADS", intEnv(env, "HYPHAEON_MCP_THREADS", 2), { min: 1, max: 32 }),
    /** How long a cancelled run may take to acknowledge before its worker is terminated and replaced. */
    cancelGraceMs: intEnv(env, "HYPHAEON_CANCEL_GRACE_MS", 5000, { min: 100 }),
    /** Work cap on the temporal null; see TEMPORAL_PERM_BUDGET above for why it is not the browser's. */
    temporalPermBudget: floatEnv(env, "HYPHAEON_TEMPORAL_PERM_BUDGET", TEMPORAL_PERM_BUDGET),
    /** Per-IP rate limits (requests per minute). */
    rateLimit: {
      windowMs: 60 * 1000,
      api: intEnv(env, "HYPHAEON_RATE_API", 120, { min: 1 }),
      jobs: intEnv(env, "HYPHAEON_RATE_JOBS", 20, { min: 1 }),
      mcp: intEnv(env, "HYPHAEON_RATE_MCP", 120, { min: 1 }),
      oauth: intEnv(env, "HYPHAEON_RATE_OAUTH", 60, { min: 1 })
    },
    /** Same origin only, plus any development origins the operator lists. */
    allowedOrigins: [issuer, ...listEnv(env, "HYPHAEON_SERVER_EXTRA_ORIGINS")],
    /** Where the browser is told to find the web app (for the OOB page's link back); default issuer. */
    webUrl: (env.HYPHAEON_WEB_URL || issuer).replace(/\/$/, ""),
    logLevel: (env.HYPHAEON_SERVER_LOG || env.HYPHAEON_MCP_LOG || "info").toLowerCase(),
    /** Express `trust proxy`: "loopback" (Apache on the same host), a hop count, or false. */
    trustProxy: parseTrustProxy(env.HYPHAEON_TRUST_PROXY),
    /** Whether the MCP mount is served at all (an API-only deployment sets HYPHAEON_MCP=0). */
    mcpEnabled: env.HYPHAEON_MCP !== "0" && env.HYPHAEON_MCP !== "false",
    /** Whether the HTTP MCP requires a bearer token (never disable on a public host). */
    mcpAuth: env.HYPHAEON_MCP_AUTH !== "0" && env.HYPHAEON_MCP_AUTH !== "false",
    /** Bag of environment for the runtime/MCP engine (models dir, variant, thread count). */
    env: Object.assign({}, env)
  };
  Object.assign(config, overrides);
  if (overrides.dataDir && !overrides.dbPath) config.dbPath = path.join(config.dataDir, "jobs.sqlite");
  if (overrides.dataDir && !overrides.jobsDir) config.jobsDir = path.join(config.dataDir, "jobs");
  if (config.modelsDir) config.env.HYPHAEON_MODELS_DIR = config.modelsDir;
  config.env.HYPHAEON_MCP_THREADS = String(config.threads);
  return config;
}
