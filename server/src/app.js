/**
 * app.js — the HyphAeon Node server: PLAN.md 3.5's REST API and the 3.6 MCP mount on one Express 5 app.
 *
 * WHY THIS FILE EXISTS
 *
 * The web app runs everything in the browser; this server exists for the two things a browser
 * cannot do — serve MCP over HTTP to claude.ai and other remote clients, and run jobs above the
 * browser's caps (PLAN.md 3.5 "the same package under onnxruntime-node"). `createApp(config)`
 * builds the app and everything behind it, and returns a handle the bin listens on and the tests
 * drive with supertest without a port:
 *
 *   POST   /api/v1/validate               library diagnostics + this server's caps (src/validate.js)
 *   POST   /api/v1/jobs                   {analysis, alignment, tree?, options?, seed?} -> 202 {id}
 *   GET    /api/v1/jobs/:id               status, progress, warnings, expiry, section states
 *   GET    /api/v1/jobs/:id/events        SSE: status / progress / section / done
 *   GET    /api/v1/jobs/:id/result        JSON + provenance; ?format=csv|graphml ?fields= ?top= ?section= ?file=
 *   POST   /api/v1/jobs/:id/cancel        stop the run and KEEP what it produced (Phase 6)
 *   DELETE /api/v1/jobs/:id               early deletion (the default is the 7-day TTL)
 *   GET    /api/v1/models                 the weights manifest and the engine's status
 *   GET    /api/v1/health, /version       liveness; package versions
 *   /.well-known/*, /register, /authorize, /token, /revoke   the OAuth ceremony (src/oauth.js)
 *   POST/GET/DELETE /mcp                  the MCP transport (src/mcp-mount.js)
 *
 * Product rule (PLAN.md 4.0, D21): `analysis: "analyze"` is the one the report page uses — it runs
 * everything and streams sections; the per-pillar analyses exist for the MCP tools and for
 * scripts. A job request carries no analysis picker beyond that word.
 *
 * A TREE IS OPTIONAL ON EVERY ANALYSIS (PLAN.md D22): a job with no tree, or with a tree that has
 * no usable branch lengths, uses pairwise TN93 distances, and the result's
 * `provenance.preprocessing.tree_source` says which happened. `analysis: "phenotype"` (and the
 * report's `options.phenotype` block) runs in the worker like every other pillar since Phase 3 —
 * this server starts no subprocess and needs no Python.
 *
 * PHASE 6 ADDS THE TIME PILLARS, as first-class analyses beside the rest: `dates` (the date review
 * — reads a sampling date for every sequence from the FASTA headers, an Auspice JSON, a JSON map
 * or a CSV/TSV, runs NO model and needs no models directory), `dating` (the molecular clock and
 * MRCA estimate; takes no tree, D34) and `temporal` (per-site selection through calendar time with
 * a refining permutation null). The metadata document rides as `dates_file`, the phenotype table's
 * precedent: TEXT in the body, never a server path, under the same 8 MiB field cap. Three rules
 * follow from what those pillars are and are enforced here rather than discovered later:
 *
 *   - THE DATE LAYER IS CHECKED AT THE DOOR. An unreadable metadata file, a date set with no time
 *     axis, and the two confirmation gates the browser puts to a human (dates read mostly as a
 *     bare number in the name; undated sequences that would be dropped silently) are 422 with the
 *     date layer's own code — `DATES_*`, `DATING_*`, `TEMPORAL_*`, all `kind: "input"`, each with
 *     a hint naming the METADATA fix — before a worker is spent. src/validate.js `dateCheck`.
 *   - A TEMPORAL NULL REFINES, AND THE STREAM SAYS SO. It walks 200 -> 500 -> 1,000 draws in
 *     chunks, and the `permutations` section is re-emitted per chunk with the achieved count and
 *     the p-values at the stage-one candidates. The count MEANS the number it says: draw b is
 *     seeded from splitmix64(seed, b), so a run stopped at 313 is bit-identical to one configured
 *     at 313.
 *   - STOPPING IS NOT DELETING. `POST /jobs/:id/cancel` aborts the run and keeps what it produced;
 *     the temporal pillar then completes with a truncated null and a `RUN_STOPPED_EARLY` warning,
 *     and every other pillar is `cancelled` as before. DELETE still removes everything.
 *   - THE GRID IS A COST AND IS SIZED LIKE ONE. `options.time_points` sets the size of the
 *     [codons x T] store every stage after the model pass walks, and the caps' `L x N^2` work term
 *     is blind to it, so a request whose every checked number was small could hold a worker past
 *     the job timeout. `sizeCheck` now carries `temporalGridCheck` (src/time.js, with the
 *     measurements): 422 `TEMPORAL_TIME_POINTS_EXCEEDED` above 2,000 points,
 *     `TEMPORAL_TIME_POINTS_INVALID` below 2, `TEMPORAL_GRID_TOO_LARGE` above 1.2e6 cells.
 *   - AN OPTION THIS SERVER CANNOT NAME IS REFUSED, NOT DROPPED. `options` used to be a free
 *     record: a misspelled key bought a 202 and a run at the default the caller thought they had
 *     changed. 422 `UNKNOWN_OPTION` with the keys and the nearest real one (src/options.js), over a
 *     vocabulary DERIVED from the MCP tools' own input schemas.
 *   - ONE ENVELOPE FOR `?section=`, WHATEVER THE JOB'S STATE, with `honesty` at the top level in
 *     both (src/formats.js `sectionEnvelope`), and a temporal record above 4 MiB is answered 406
 *     `TEMPORAL_RECORD_TOO_LARGE` naming `?section=` and `?file=` instead of being parsed and
 *     re-serialised whole on the HTTP event loop.
 *
 * Boundaries, all from PLAN.md 3.5: JSON bodies up to 8 MiB (the alignment cap, so the limit and
 * the cap refuse the same files), per-IP rate limits (src/config.js), no accounts, 128-bit ids,
 * same-origin only (an Origin header that is present and not the issuer is refused; a same-origin
 * browser and a curl without Origin both pass), `Content-Security-Policy: default-src 'none'` on
 * API responses (they are data, never documents), the OOB page excepted.
 *
 * Every error body is `{error: {kind, code?, message, hint?}}` with the MCP's two kinds, `input`
 * (fix your request or your alignment) and `server` (this deployment is broken), so a client
 * shows the right message; a refused upload is 422 with `kind: "input"` and the caps' hint.
 */

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import express from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { MAX_ALIGNMENT_CHARS, MAX_PERMUTATIONS, MAX_PERMULATIONS } from "@veg/hyphaeon-mcp/caps";
import { loadManifest, listVariants, pickVariant } from "@veg/hyphaeon-runtime";
import { loadConfig, defaultModelsCandidates } from "./config.js";
import { createLogger } from "./logger.js";
import { createPool } from "./pool.js";
import { createJobManager } from "./jobs.js";
import { createOAuth } from "./oauth.js";
import { mountMcp } from "./mcp-mount.js";
import { validate, sizeCheck, dateCheck, ANALYSES } from "./validate.js";
import { optionCheck } from "./options.js";
import { TEMPORAL_RECORD_BYTES_MAX, TEMPORAL_SECTIONS, referenceFileNames } from "./time.js";
import { LIVE_SECTIONS } from "./runner.js";
import { shapeResponse, sectionEnvelope, FormatError } from "./formats.js";

const require = createRequire(import.meta.url);
const PKG = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

/** A dependency's version: through its exported package.json, or by walking up from its entry. */
function versionOf(spec) {
  try {
    return JSON.parse(readFileSync(require.resolve(spec + "/package.json"), "utf8")).version;
  } catch {
    // The exports map hides package.json (the library does this): walk up from the entry file.
  }
  try {
    let dir = path.dirname(require.resolve(spec));
    for (let i = 0; i < 6; i++) {
      const p = path.join(dir, "package.json");
      if (existsSync(p)) {
        const pkg = JSON.parse(readFileSync(p, "utf8"));
        if (pkg.name === spec) return pkg.version;
      }
      dir = path.dirname(dir);
    }
  } catch {
    // not installed
  }
  return null;
}

const textField = (label) =>
  z
    .string()
    .max(MAX_ALIGNMENT_CHARS, label + " is above the " + MAX_ALIGNMENT_CHARS + "-character cap (8 MiB).")
    .optional();

const JobRequest = z
  .object({
    analysis: z.enum(ANALYSES),
    alignment: textField("alignment"),
    tree: textField("tree"),
    prediction: textField("prediction"),
    meme_result: textField("meme_result"),
    /** The phenotype table's TEXT (hyphaeon phenotype --phenotype-file), never a server path. */
    phenotype_file: textField("phenotype_file"),
    /**
     * The date metadata's TEXT (hyphaeon dating/temporal -d/--dates): a Nextstrain Auspice JSON, a
     * name-to-date JSON object, or a CSV/TSV. Never a server path — the same rule as
     * `phenotype_file`, and for the same reason: this process must not read a caller's disk over
     * HTTP. Omit it and the dates are read from the FASTA headers, which is the reference's own
     * fallback; `analysis: "dates"` says which rule read each one.
     */
    dates_file: textField("dates_file"),
    variant: z.string().max(64).optional(),
    options: z.record(z.string(), z.unknown()).optional(),
    seed: z.number().int().min(0).max(2 ** 32 - 1).optional(),
    names: z
      .object({
        alignment: z.string().max(255).optional(),
        tree: z.string().max(255).optional(),
        phenotype_file: z.string().max(255).optional(),
        /** Printed as `-d <name>` on the time pillars' reproduction line; recorded either way. */
        dates_file: z.string().max(255).optional(),
        demo: z.string().max(64).optional()
      })
      .optional()
  })
  .strict();

const ValidateRequest = z
  .object({
    alignment: z.string().max(MAX_ALIGNMENT_CHARS),
    tree: textField("tree"),
    analysis: z.enum(ANALYSES).optional(),
    /** D22: force the tree-free TN93 path even when a usable tree was supplied. */
    use_tn93: z.boolean().optional(),
    max_species: z.number().int().min(2).optional(),
    /** The date metadata's TEXT, for a rehearsal of the time pillars' door checks. */
    dates_file: textField("dates_file"),
    /** The job's options, so a validate answers the caps and the gates the job would meet. */
    options: z.record(z.string(), z.unknown()).optional()
  })
  .strict();

class HttpError extends Error {
  constructor(status, kind, message, extra = {}) {
    super(message);
    this.status = status;
    this.kind = kind;
    this.hint = extra.hint;
    this.code = extra.code;
    this.details = extra.details;
  }
}

function errorBody(err) {
  const body = { error: { kind: err.kind || "server", message: err.message || String(err) } };
  if (err.code) body.error.code = err.code;
  if (err.hint) body.error.hint = err.hint;
  if (err.details) body.error.details = err.details;
  return body;
}

/** Read the models manifest from the configured directory or the default candidates. */
export function readModels(config) {
  const candidates = config.modelsDir ? [config.modelsDir] : defaultModelsCandidates();
  for (const dir of candidates) {
    const p = path.join(dir, "manifest.json");
    if (!existsSync(p)) continue;
    try {
      const doc = JSON.parse(readFileSync(p, "utf8"));
      const manifest = loadManifest(doc);
      const done = (m) => ({
        available: true,
        dir,
        path: p,
        manifest: m,
        variants: listVariants(m).map((name) => {
          const v = pickVariant(m, name);
          return { name, onnx_file: v.onnxFile, onnx_sha256: v.onnxSha256, busted_head_file: v.bustedHeadFile, busted_head_sha256: v.bustedHeadSha256, trained_on: v.trainedOn, regime: v.regime };
        })
      });
      return typeof manifest.then === "function" ? manifest.then(done) : done(manifest);
    } catch (err) {
      return { available: false, dir, path: p, error: "manifest.json could not be read: " + err.message, searched: candidates };
    }
  }
  return { available: false, searched: candidates, error: "No models/manifest.json found. Set HYPHAEON_MODELS_DIR." };
}

/**
 * @param {object} [config]   from loadConfig(); default loadConfig(process.env)
 * @param {object} [deps]
 * @param {object} [deps.logger]
 * @returns {{app: import("express").Express, config: object, jobs: object, pool: object, oauth: object|null, mcp: object|null, close: () => Promise<void>}}
 */
export function createApp(config = loadConfig(), deps = {}) {
  const logger = deps.logger || createLogger({ level: config.logLevel });
  const startedAt = Date.now();

  const pool = createPool({
    size: config.workers,
    env: config.env,
    threads: config.threads,
    cancelGraceMs: config.cancelGraceMs,
    temporalPermBudget: config.temporalPermBudget,
    logger: logger.child("[pool]")
  });
  const jobs = createJobManager({ config, pool, logger: logger.child("[jobs]") });

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", config.trustProxy ?? "loopback");
  app.set("etag", false);

  // Same-origin only: refuse a foreign Origin; answer preflights for the allowed ones.
  app.use((req, res, next) => {
    res.set("X-Content-Type-Options", "nosniff");
    const origin = req.headers.origin;
    if (origin) {
      const o = origin.replace(/\/$/, "");
      if (!config.allowedOrigins.includes(o)) {
        return res.status(403).json({ error: { kind: "input", code: "ORIGIN_FORBIDDEN", message: "Origin " + origin + " is not allowed; the API is same-origin." } });
      }
      res.set("Access-Control-Allow-Origin", origin);
      res.set("Vary", "Origin");
      res.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
      res.set("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID");
      res.set("Access-Control-Expose-Headers", "Mcp-Session-Id, WWW-Authenticate, Content-Disposition");
      if (req.method === "OPTIONS") return res.status(204).end();
    }
    next();
  });

  // ── the API ─────────────────────────────────────────────────────────────
  const api = express.Router();
  api.use((req, res, next) => {
    res.set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
    res.set("Cache-Control", "no-store");
    next();
  });
  api.use(
    rateLimit({
      windowMs: config.rateLimit.windowMs,
      limit: config.rateLimit.api,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: { kind: "input", code: "RATE_LIMITED", message: "Rate limit exceeded; try again in a minute." } }
    })
  );
  api.use(express.json({ limit: config.bodyLimitBytes, strict: true }));

  api.get("/health", (req, res) => {
    res.json({ ok: true, status: "ok", uptime_sec: Math.round((Date.now() - startedAt) / 1000), jobs: jobs.stats(), mcp: config.mcpEnabled ? "/mcp" : null });
  });

  api.get("/version", async (req, res) => {
    const models = await readModels(config);
    res.json({
      server: PKG.version,
      hyphaeon_runtime: versionOf("@veg/hyphaeon-runtime"),
      hyphaeon_mcp: versionOf("@veg/hyphaeon-mcp"),
      hyphaeon_js: versionOf("@veg/hyphaeon-js"),
      onnxruntime_node: versionOf("onnxruntime-node"),
      mcp_sdk: versionOf("@modelcontextprotocol/sdk"),
      express: versionOf("express"),
      node: process.version,
      model_version: models.available ? models.manifest.model_version || null : null,
      surface: "node-server"
    });
  });

  let engineStatus = null;
  const statusOnce = () => {
    if (!engineStatus) {
      engineStatus = pool.status().catch((err) => {
        engineStatus = null;
        throw err;
      });
    }
    return engineStatus;
  };

  api.get("/models", async (req, res, next) => {
    try {
      const models = await readModels(config);
      let engine = null;
      try {
        engine = await statusOnce();
      } catch (err) {
        engine = { available: false, reason: err.message };
      }
      res.status(models.available ? 200 : 503).json(Object.assign({}, models, { engine }));
    } catch (err) {
      next(err);
    }
  });

  api.post("/validate", async (req, res, next) => {
    try {
      const parsed = ValidateRequest.safeParse(req.body);
      if (!parsed.success) throw new HttpError(400, "input", "Invalid request body.", { code: "BAD_REQUEST", details: parsed.error.issues });
      const out = validate(Object.assign({ analysis: "analyze" }, parsed.data));
      res.status(200).json(out);
    } catch (err) {
      next(err);
    }
  });

  api.post(
    "/jobs",
    rateLimit({
      windowMs: config.rateLimit.windowMs,
      limit: config.rateLimit.jobs,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: { kind: "input", code: "RATE_LIMITED", message: "Too many jobs from this address; try again in a minute." } }
    }),
    (req, res, next) => {
      try {
        const parsed = JobRequest.safeParse(req.body);
        if (!parsed.success) throw new HttpError(400, "input", "Invalid job request.", { code: "BAD_REQUEST", details: parsed.error.issues });
        const body = parsed.data;
        const options = Object.assign({}, body.options || {});
        if (body.variant) options[body.analysis === "analyze" ? "variant" : "model_variant"] = body.variant;

        // AN OPTION THIS SERVER CANNOT NAME IS REFUSED, NOT DROPPED. `JobRequest` is `.strict()`,
        // so a misspelled top-level field was already a 400; `options` was the hole in that, and a
        // typo in it bought a 202, an echo of the option in the job view, and a run at the default
        // the caller thought they had changed. This is the same check on the same body and it is
        // first, because it is about the request's SHAPE rather than its size: a caller who
        // misspelled an option should be told that, not told about their alignment. src/options.js.
        const opts = optionCheck(body.analysis, options);
        if (!opts.ok) throw new HttpError(422, "input", opts.message, { code: opts.code, hint: opts.hint, details: opts.details });

        if (body.analysis === "evaluate") {
          if (!body.prediction || !body.meme_result) {
            throw new HttpError(422, "input", "evaluate needs `prediction` (hyphaeon meme CSV) and `meme_result` (HyPhy MEME JSON).", { code: "MISSING_INPUT" });
          }
        } else {
          if (!body.alignment || !body.alignment.trim()) throw new HttpError(422, "input", "An alignment is required.", { code: "MISSING_INPUT" });
          const check = sizeCheck(body.analysis, body.alignment, options);
          if (!check.ok) throw new HttpError(422, "input", check.reason, { code: check.code || "CAPS_EXCEEDED", hint: check.hint, details: check.size });
          const perms = options.permutations ?? options.n_permutations;
          if (perms !== undefined && (!Number.isInteger(perms) || perms < 0 || perms > MAX_PERMUTATIONS)) {
            throw new HttpError(422, "input", "`permutations` must be an integer between 0 and " + MAX_PERMUTATIONS + ".", { code: "CAPS_EXCEEDED" });
          }
          const permul = options.permulations ?? options.n_permulations;
          if (permul !== undefined && (!Number.isInteger(permul) || permul < 0 || permul > MAX_PERMULATIONS)) {
            throw new HttpError(422, "input", "`permulations` must be an integer between 0 and " + MAX_PERMULATIONS + ".", { code: "CAPS_EXCEEDED" });
          }
          // THE DATE LAYER IS CHECKED BEFORE A WORKER IS SPENT ON IT, exactly as the caps are, and
          // AFTER them: a request whose own numbers are out of range is refused for that, not for
          // its metadata, so a caller fixing one thing at a time is told about the thing they can
          // see. The date layer reads sequence NAMES and a metadata document, loads no model and is
          // 3-24 ms on the bundled examples, so an unreadable metadata file, a date set with no
          // time axis, or either of the two confirmation gates the browser puts to a human is a
          // synchronous 422 with the date layer's own code — not a 202 followed by a failed job a
          // minute later. The worker checks again (the engine ingests the dates itself); this is
          // the door, not the only lock.
          if (body.analysis === "dating" || body.analysis === "temporal") {
            const dates = dateCheck(body.analysis, body.alignment, body.dates_file, options, body.names || {});
            if (!dates.ok) throw new HttpError(422, "input", dates.message, { code: dates.code, hint: dates.hint, details: dates.details });
          }
          body.size = check.size;
        }

        const job = jobs.create({
          analysis: body.analysis,
          alignment: body.alignment,
          tree: body.tree,
          prediction: body.prediction,
          meme_result: body.meme_result,
          phenotype_file: body.phenotype_file,
          dates_file: body.dates_file,
          options,
          seed: body.seed,
          names: body.names || {},
          size: body.size || null,
          clientIp: req.ip
        });
        res.status(202).location(job.links.self).json(job);
      } catch (err) {
        next(err);
      }
    }
  );

  api.get("/jobs/:id", (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json(errorBody(new HttpError(404, "input", "No such job.", { code: "NOT_FOUND" })));
    res.json(job);
  });

  api.get("/jobs/:id/events", (req, res) => {
    const snap = jobs.snapshot(req.params.id);
    if (!snap) return res.status(404).json(errorBody(new HttpError(404, "input", "No such job.", { code: "NOT_FOUND" })));
    res.status(200);
    res.set({ "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.flushHeaders();
    let seq = 0;
    const send = (event, data) => {
      res.write("id: " + ++seq + "\nevent: " + event + "\ndata: " + JSON.stringify(data) + "\n\n");
    };
    const terminal = (v) => ["completed", "failed", "cancelled", "deleted"].includes(v.status);

    send("status", snap.view);
    for (const s of snap.sections) send("section", s);
    if (terminal(snap.view)) {
      send("done", snap.view);
      return res.end();
    }
    const heartbeat = setInterval(() => res.write(": keep-alive\n\n"), 15000);
    const unsubscribe = jobs.subscribe(snap.view.id, (ev) => {
      if (ev.type === "progress") send("progress", ev);
      else if (ev.type === "section") send("section", { name: ev.name, final: ev.final, payload: ev.payload });
      else if (ev.type === "status") {
        const v = jobs.get(snap.view.id) || { id: snap.view.id, status: ev.status };
        send("status", v);
        if (terminal(v) || ev.status === "deleted") {
          send("done", v);
          cleanup();
          res.end();
        }
      }
    });
    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    req.on("close", cleanup);
  });

  /**
   * Stop a running job and KEEP what it produced.
   *
   * DELETE has always cancelled, but it also removes the row and the directory, which is exactly
   * wrong for the temporal pillar: `runTemporalNull` catches its own abort and `runTemporal` then
   * resolves with a VALID record at the achieved draw count, so a caller who stops a refining null
   * at draw 313 has an answer that means 313 — and DELETE would throw it away. This route aborts
   * the run and lets the worker land wherever it lands: a pillar that cannot answer partially
   * rejects and the job is `cancelled`; the temporal pillar resolves and the job is `completed`
   * with a `RUN_STOPPED_EARLY` warning naming what stopped it and at which draw. Idempotent: a
   * job already in a terminal state is returned unchanged.
   */
  api.post("/jobs/:id/cancel", (req, res) => {
    const view = jobs.cancel(req.params.id, "cancelled by client");
    if (!view) return res.status(404).json(errorBody(new HttpError(404, "input", "No such job.", { code: "NOT_FOUND" })));
    res.status(200).json(view);
  });

  api.get("/jobs/:id/result", (req, res, next) => {
    try {
      const job = jobs.get(req.params.id);
      if (!job) throw new HttpError(404, "input", "No such job.", { code: "NOT_FOUND" });
      if (job.status !== "completed") {
        const section = req.query.section ? String(req.query.section) : null;
        // A RUNNING job serves the sections it has already published. For `analyze` those are the
        // report's; for `temporal` they are `summary` and `permutations`, the latter refining with
        // every chunk of the null, so a client that never opened the SSE stream can still poll the
        // draw count and the p-values at the candidates.
        if (section && LIVE_SECTIONS[job.analysis] && (req.query.format || "json") === "json") {
          const s = jobs.section(job.id, section);
          // ONE ENVELOPE, WHATEVER THE STATE. This used to nest the live payload under `payload`
          // while the finished answer put the section body at the top level, so `body.honesty` was
          // undefined exactly while a run was in flight. `sectionEnvelope` is the single shape both
          // paths now go through (src/formats.js).
          if (s) return res.json(sectionEnvelope({ analysis: job.analysis, section, status: job.status, final: s.final, body: s.payload }));
        }
        return res.status(job.status === "failed" || job.status === "cancelled" ? 410 : 409).json(Object.assign({ error: { kind: "input", code: "NOT_READY", message: "The job is " + job.status + "." } }, { job }));
      }
      // THE ONE ANSWER THIS ROUTE WILL NOT GIVE: A WHOLE TEMPORAL RECORD THAT IS MEGABYTES.
      //
      // The MCP refuses inline delivery of a temporal record outright (`caps.temporal.
      // record_never_inline`, mcp/src/resources.js) because a tool result is spent in a model's
      // CONTEXT WINDOW. That reason does not apply to an HTTP client, which asked for a file and
      // which this API has answered with megabyte `analyze` reports since Phase 2 — so this route
      // keeps serving the record, and the two surfaces differ for a reason each can state.
      //
      // What does apply here is THIS PROCESS. `jobs.result()` reads and parses the stored document
      // and `res.json()` re-serialises it, both on the HTTP event loop that the worker pool exists
      // to keep free, and the record is a caller-sized object: MEASURED 2,162,993 bytes at the
      // reference's default grid on the bundled 566-codon example and 16,272,879 at
      // `time_points: 2000`. Above TEMPORAL_RECORD_BYTES_MAX the answer is 406 naming the two doors
      // that serve the same numbers without the parse — `?section=` (the MCP's own ten sections,
      // the same implementation) and `?file=` (the reference's four output files as text) — which
      // is exactly where `record_never_inline` points a caller. Checked on the stored byte count
      // from the job row, BEFORE the parse, because a guard that has to read the file to decide
      // whether reading the file is affordable is not a guard.
      const whole = !req.query.section && !req.query.file && (req.query.format || "json") === "json";
      if (job.analysis === "temporal" && whole && job.result_bytes > TEMPORAL_RECORD_BYTES_MAX) {
        throw new HttpError(406, "input", "This temporal record is " + job.result_bytes + " bytes, above the " + TEMPORAL_RECORD_BYTES_MAX + "-byte cap this route serves whole.", {
          code: "TEMPORAL_RECORD_TOO_LARGE",
          hint:
            "Ask for a section — ?section=" + TEMPORAL_SECTIONS.join("|") + " — or one of the reference's own files, " +
            "?file=" + (referenceFileNames("temporal") || []).join("|") + ", which are streamed as text. `summary` is the " +
            "whole record's eighteen reference keys plus the honesty block; `curves` is what makes the record large and is " +
            "budgeted per call. A smaller `time_points` makes a smaller record: it is about 8 KB a grid point.",
          details: { result_bytes: job.result_bytes, cap_bytes: TEMPORAL_RECORD_BYTES_MAX, sections: TEMPORAL_SECTIONS, files: referenceFileNames("temporal") }
        });
      }
      const doc = jobs.result(job.id);
      if (!doc) throw new HttpError(410, "server", "The result file is gone.", { code: "RESULT_MISSING" });
      const shaped = shapeResponse(job, doc, req.query);
      if (shaped.type === "json") return res.json(shaped.body);
      // `json-text` is a reference output FILE that happens to be JSON (temporal's `_summary.json`,
      // dating's `-o out.json`). It is sent as the writer produced it, byte for byte, because the
      // whole point of those writers is that the bytes match a CLI run's; re-serialising it through
      // res.json() would reformat the numbers it went to trouble to format.
      res.set("Content-Type", shaped.type === "csv" ? "text/csv; charset=utf-8" : shaped.type === "json-text" ? "application/json; charset=utf-8" : "application/graphml+xml; charset=utf-8");
      res.set("Content-Disposition", 'attachment; filename="' + shaped.filename + '"');
      res.send(shaped.body);
    } catch (err) {
      if (err instanceof FormatError) return res.status(err.status).json({ error: { kind: "input", message: err.message } });
      next(err);
    }
  });

  api.delete("/jobs/:id", (req, res) => {
    if (!jobs.delete(req.params.id)) return res.status(404).json(errorBody(new HttpError(404, "input", "No such job.", { code: "NOT_FOUND" })));
    res.status(204).end();
  });

  api.use((req, res) => res.status(404).json({ error: { kind: "input", code: "NOT_FOUND", message: "No such route: " + req.method + " " + req.originalUrl } }));

  // Errors: body-parser's (413 too large, 400 bad JSON), ours (HttpError), and the rest (500).
  api.use((err, req, res, _next) => {
    if (err instanceof HttpError) return res.status(err.status).json(errorBody(err));
    if (err && err.type === "entity.too.large") {
      return res.status(413).json({ error: { kind: "input", code: "PAYLOAD_TOO_LARGE", message: "The request body is above the 8 MiB cap.", hint: "Submit fewer sequences or fewer sites." } });
    }
    if (err && (err.type === "entity.parse.failed" || err.type === "charset.unsupported" || err.status === 400)) {
      return res.status(400).json({ error: { kind: "input", code: "BAD_JSON", message: "The request body is not valid JSON." } });
    }
    logger.error("API error: " + (err && err.stack ? err.stack : err));
    res.status(500).json({ error: { kind: "server", code: "INTERNAL", message: "Internal error." } });
  });

  app.use("/api/v1", api);

  // ── OAuth + MCP ─────────────────────────────────────────────────────────
  let oauth = null;
  let mcp = null;
  if (config.mcpEnabled) {
    if (config.mcpAuth) {
      oauth = createOAuth({ issuer: config.issuer, resourcePath: "/mcp", webUrl: config.webUrl, logger: logger.child("[oauth]"), version: PKG.version });
      app.use(
        ["/register", "/authorize", "/token", "/revoke"],
        rateLimit({ windowMs: config.rateLimit.windowMs, limit: config.rateLimit.oauth, standardHeaders: true, legacyHeaders: false })
      );
      oauth.mount(app);
    }
    app.use("/mcp", express.json({ limit: config.bodyLimitBytes }));
    mcp = mountMcp(app, { config, oauth, pool, logger: logger.child("[mcp]") });
  }

  app.use((req, res) => res.status(404).json({ error: { kind: "input", code: "NOT_FOUND", message: "No such route." } }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err && err.type === "entity.too.large") return res.status(413).json({ jsonrpc: "2.0", error: { code: -32000, message: "Payload too large" }, id: null });
    if (err && err.type === "entity.parse.failed") return res.status(400).json({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null });
    logger.error("error: " + (err && err.stack ? err.stack : err));
    res.status(500).json({ error: { kind: "server", code: "INTERNAL", message: "Internal error." } });
  });

  return {
    app,
    config,
    logger,
    jobs,
    pool,
    oauth,
    mcp,
    async close() {
      if (mcp) await mcp.close().catch(() => {});
      if (oauth) oauth.close();
      await jobs.close();
    }
  };
}

export { loadConfig };
