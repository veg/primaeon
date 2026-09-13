/**
 * runner.js — turns one job request into one result, inside an analysis worker.
 *
 * WHY THIS FILE EXISTS
 *
 * The server accepts ten `analysis` values (PLAN.md 3.5: `analyze`, the product's one action
 * that runs everything, and the per-pillar `meme`, `busted`, `epistasis`, `dms`, `phenotype`,
 * `evaluate`, plus Phase 6's `dates`, `dating` and `temporal`) and has two entry points to run
 * them with:
 *
 *   - `@veg/hyphaeon-mcp/engine` (mcp/src/engine.js): the in-process engine the MCP already
 *     built. It memoises one ONNX session per variant, maps the CLI-shaped options, writes the
 *     document `hyphaeon <cmd> -o` writes and stamps a PLAN.md 3.5 provenance block. The server
 *     runs the per-pillar analyses through it so `POST /api/v1/jobs {analysis:"meme"}` and the MCP
 *     tool `hyphaeon_meme` are the same code and the same bytes, only `provenance.surface` differs
 *     ("node-server" here).
 *   - `runEverything` from `@veg/hyphaeon-runtime` (runtime/src/analyze.js, the orchestrator
 *     contract of this phase): diagnostics -> sites -> gene -> epistasis + sectors -> attribution
 *     -> filter -> DMS, streaming sections through `onSection`, returning the ReportRecord the
 *     report page renders (PLAN.md 4.0, D21). `analyze` jobs run through it, and the engine fills
 *     `sections.phenotype` from the same pass when the request carried a trait.
 *
 * NO TREE IS REQUIRED, AND NOTHING IS ESTIMATED (PLAN.md D22). A tree with branch lengths is used
 * as it is; a job with no tree, with a tree that has no usable branch lengths, or with
 * `options.use_tn93` takes the library's pairwise TN93 distances instead. This server therefore
 * has no branch-length estimator and no tree inference of its own, and
 * `provenance.preprocessing.tree_source` ('user' | 'embedded' | 'tn93') records which path ran.
 *
 * NOTHING SPAWNS A PROCESS. Every pillar, phenotype included, is JavaScript in this worker thread
 * over onnxruntime-node (PLAN.md 8, phase 3's exit criterion). A deployment needs the model files
 * and Node, and nothing else.
 *
 * One seam is documented as app-side rather than reference behaviour: while the runtime does not
 * export `runEverything`, `analyze` degrades to `composeReportFallback` — the same ReportRecord
 * shape with `sites` and `gene` computed through the engine and the other sections `null`, each
 * absence recorded as a `SECTION_UNAVAILABLE` warning in the provenance. The report page shows the
 * sections it has; nothing is invented.
 *
 * Errors are classified into the two classes the MCP established (engine.js
 * `classifyEngineError`): `kind: "input"` (the alignment has a problem; the job fails with a hint)
 * and `kind: "server"` (the model or the process is broken). `EngineError` instances pass through;
 * anything else is a server error.
 *
 * ── PHASE 6: THE TIME PILLARS ────────────────────────────────────────────────────────────────
 *
 * THREE THINGS ARE DIFFERENT FROM EVERY PILLAR ABOVE, and each one is handled here rather than
 * pushed down into the engine (which already handles its own half) or up into app.js:
 *
 *  - `dates` NEVER REACHES THE ENGINE. `engine.run` refuses it by name, on purpose: the date layer
 *    runs no model and must not pay for one (the runtime's `./dates` subtree imports no manifest,
 *    no session and no predict.js). It runs here, in the worker, through src/time.js's `datesBody`,
 *    so a deployment with no models/ directory still answers a dates job.
 *  - A TEMPORAL JOB STREAMS ITS NULL. `engine.run` relays `runTemporal`'s interim payloads through
 *    `onProgress`, and every one of them is the WHOLE record (measured upstream at ~6.7 MiB, 17 of
 *    them at the reference's defaults). They are projected to a few kilobytes here
 *    (src/time.js `temporalNullSection`) before they reach `hooks.onSection`, because jobs.js hands
 *    a section payload straight to the SSE stream.
 *  - A CANCELLED TEMPORAL RUN STILL HAS AN ANSWER. `runTemporalNull` catches its own abort and
 *    `runTemporal` then RESOLVES with a valid record at the achieved draw count, so this runner
 *    must not convert an aborted temporal run into a cancellation: the `signal.aborted` clause in
 *    `run()` below rewrites an ERROR's class and never touches a resolved value. jobs.js records
 *    what stopped it.
 */

import { createEngine, EngineError, NATIVE_ANALYSES, mapOptions, runPhenotypeSection, stampTreeSource } from "@veg/hyphaeon-mcp/engine";
import { datesBody, temporalNullSection, temporalSummarySection, TEMPORAL_LIVE_SECTIONS } from "./time.js";

export const SURFACE = "node-server";
/** Surfaces a task may claim (PLAN.md 3.5); anything else is recorded as the server's own. */
const TASK_SURFACES = new Set(["node-server", "mcp-http"]);
const surfaceOf = (task) => (task && TASK_SURFACES.has(task.surface) ? task.surface : SURFACE);
export const ANALYSES = Object.freeze(["analyze", "meme", "busted", "epistasis", "dms", "phenotype", "evaluate", "dates", "dating", "temporal"]);
export const REPORT_SECTIONS = Object.freeze(["sites", "gene", "epistasis", "attribution", "filter", "dms", "phenotype"]);
export const REPORT_SCHEMA_VERSION = 2;

/**
 * The sections a RUNNING job of each analysis publishes — what `GET /jobs/:id` reports states for
 * and what `GET /jobs/:id/result?section=` can serve before the job is complete. An analysis
 * absent from this table streams nothing, which is the honest answer for `dates` (3-24 ms; there
 * is no "during") and for `dating` (a 52 KB record either way, and 88 % of the wall clock of a
 * `use_model` run is one forward pass with nothing to publish in the middle of it).
 */
export const LIVE_SECTIONS = Object.freeze({ analyze: REPORT_SECTIONS, temporal: TEMPORAL_LIVE_SECTIONS });

/** The analyze-options the orchestrator contract names, with the CLI spellings it also accepts. */
const ANALYZE_OPTION_ALIASES = {
  model_variant: "variant",
  max_species: "maxSpecies",
  reference_sequence: "referenceSequence",
  call_mode: "callMode",
  n_permutations: "permutations",
  use_tn93: "useTn93",
  no_tree: "useTn93"
};

/**
 * The report's `phenotype` block, as `POST /api/v1/jobs` accepts it (`options.phenotype`, plus the
 * table's text as the job input `phenotype_file`), turned into the trait and option objects the
 * runtime's `runPhenotype` takes. Null when the request carried no trait, which is the normal case:
 * a trait cannot be guessed (PLAN.md 4.0 row 8).
 *
 * @param {object} task the job task
 * @param {object} options the normalised analyze options
 */
export function phenotypeRequestFor(task, options = {}) {
  const block = options.phenotype && typeof options.phenotype === "object" ? options.phenotype : {};
  const csv = typeof task.phenotype_file === "string" && task.phenotype_file.trim() ? task.phenotype_file : null;
  if (!block.preset && !block.foreground && !csv) return null;
  const cli = {};
  for (const k of ["preset", "foreground", "background", "trait_col", "species_col", "continuous", "permulations", "n_permutations", "alpha", "min_taxa", "max_perm_p", "seed"]) {
    if (block[k] !== undefined && block[k] !== null) cli[k] = block[k];
  }
  if (csv) {
    cli.phenotype_file = csv;
    cli.phenotype_file_name = (task.names && task.names.phenotype_file) || block.phenotype_file_name || "phenotype.csv";
  }
  // The report's own seed and B are the section's defaults, so one report has one null.
  if (cli.seed === undefined && options.seed !== undefined) cli.seed = options.seed;
  if (cli.n_permutations === undefined && options.permutations !== undefined) cli.n_permutations = options.permutations;
  return mapOptions("phenotype", cli).runtime;
}

/**
 * Normalise `analyze` options: camelCase per the orchestrator contract, CLI snake_case accepted.
 * @param {object} raw
 * @param {number} [seed]
 */
export function normaliseAnalyzeOptions(raw = {}, seed) {
  const out = {};
  for (const [k, v] of Object.entries(raw || {})) {
    if (v === undefined) continue;
    out[ANALYZE_OPTION_ALIASES[k] || k] = v;
  }
  if (seed !== undefined && out.seed === undefined) out.seed = seed;
  if (out.dms === undefined) out.dms = { enabled: true };
  else if (typeof out.dms === "boolean") out.dms = { enabled: out.dms };
  return out;
}

function toError(err) {
  // `details` carries a bounded, structured explanation a client can act on without parsing prose:
  // today only the date layer sets it (which column was looked for, which names did not match),
  // and it is preserved through worker.js, pool.js and jobs.js so a refused metadata file is as
  // useful in `GET /jobs/:id` as it is in the browser's review table.
  if (err instanceof EngineError) return { kind: err.kind || "server", message: err.message, hint: err.hint, code: err.code, details: err.details };
  if (err && (err.kind === "input" || err.kind === "server")) return { kind: err.kind, message: err.message || String(err), hint: err.hint, code: err.code, details: err.details };
  if (err && err.name === "AbortError") return { kind: "cancelled", message: err.message || "The run was cancelled." };
  return { kind: "server", message: (err && err.message) || String(err), hint: err && err.hint };
}

/**
 * @param {object} opts
 * @param {object} opts.env      the environment the engine resolves models from (HYPHAEON_MODELS_DIR)
 * @param {number} [opts.threads]
 * @param {object} [opts.logger]
 * @param {object} [opts.runtime]  an already-imported @veg/hyphaeon-runtime module (tests)
 * @param {object} [opts.engine]   an already-created engine (tests)
 * @param {number} [opts.temporalPermBudget]  work cap on the temporal null (src/config.js)
 */
export function createRunner(opts) {
  const env = opts.env || process.env;
  const logger = opts.logger || { debug() {}, info() {}, warn() {}, error() {} };
  const engine = opts.engine || createEngine({ env, logger, threads: opts.threads });
  const permBudget = Number.isFinite(opts.temporalPermBudget) && opts.temporalPermBudget > 0 ? opts.temporalPermBudget : Number(env.HYPHAEON_TEMPORAL_PERM_BUDGET) || NaN;
  let runtimePromise = opts.runtime ? Promise.resolve(opts.runtime) : null;

  function runtime() {
    if (!runtimePromise) runtimePromise = import("@veg/hyphaeon-runtime");
    return runtimePromise;
  }

  /**
   * Run everything (PLAN.md 4.0) and return the ReportRecord.
   */
  async function analyze(task, hooks) {
    const rt = await runtime();
    const options = normaliseAnalyzeOptions(task.options, task.seed);
    const variant = options.variant || env.HYPHAEON_VARIANT || "general";
    const handle = await engine.session(variant, { bustedHead: true });
    const inputs = {
      alignmentName: (task.names && task.names.alignment) || "alignment.fasta",
      treeName: task.tree ? (task.names && task.names.tree) || "tree.nwk" : null
    };
    if (task.names && task.names.demo) inputs.demo = task.names.demo;
    const common = {
      alignmentText: task.alignment,
      treeText: task.tree || null,
      inputs,
      options: Object.assign({}, options, { variant }),
      session: handle.backbone,
      head: handle.head || (typeof handle.loadHead === "function" ? await handle.loadHead().catch(() => null) : null),
      surface: surfaceOf(task),
      signal: hooks.signal,
      progress: hooks.progress,
      onSection: hooks.onSection
    };
    if (typeof rt.runEverything === "function") {
      const report = await rt.runEverything(common);
      // The phenotype section, when the request carried a trait: the SAME helper the MCP's
      // hyphaeon_analyze uses, over the pass the report already ran (no second forward pass).
      const phenoOptions = phenotypeRequestFor(task, options);
      if (phenoOptions) {
        const filled = await runPhenotypeSection(rt, report, {
          trait: phenoOptions.phenotype,
          options: phenoOptions,
          session: handle.backbone,
          inputs: { alignment: inputs.alignmentName, tree: inputs.treeName },
          progress: hooks.progress,
          signal: hooks.signal
        });
        report.sections.phenotype = filled.section;
        report.provenance = Object.assign({}, report.provenance, { phenotype_source: filled.source });
        hooks.onSection("phenotype", filled.section, { final: true });
      }
      stampTreeSource(report.provenance, (report.sections && report.sections.sites && report.sections.sites.loaded) || null, {
        treeGiven: Boolean(task.tree && task.tree.trim()),
        alignmentText: task.alignment
      });
      return rt.jsonSafe ? rt.jsonSafe(report) : report;
    }
    logger.warn("runtime has no runEverything yet; composing the report from runMeme + runBusted");
    return composeReportFallback(task, common, options, handle, hooks, rt);
  }

  /**
   * ReportRecord from the engine's meme + busted alone (see the header, seam 1).
   */
  async function composeReportFallback(task, common, options, handle, hooks, rt) {
    const t0 = Date.now();
    const timings = {};
    const mark = (phase, since) => {
      timings[phase] = Math.round((Date.now() - since) / 100) / 10;
    };
    const cliOptions = {};
    if (options.variant) cliOptions.model_variant = options.variant;
    if (options.maxSpecies !== undefined && options.maxSpecies !== null) cliOptions.max_species = options.maxSpecies === Infinity ? null : options.maxSpecies;
    const names = Object.assign({}, task.names || {});
    const surface = surfaceOf(task);
    const base = { alignment: task.alignment, tree: task.tree || undefined, names, surface, signal: hooks.signal, progress: hooks.progress };

    let t = Date.now();
    const meme = await engine.run(Object.assign({ analysis: "meme", options: cliOptions }, base));
    mark("infer", t);
    const sites = { sites: meme.result.sites, summary: meme.result.summary, taxa_count: meme.result.taxa_count, codon_count: meme.result.codon_count };
    hooks.onSection("sites", sites, { final: true });

    t = Date.now();
    const busted = await engine.run(Object.assign({ analysis: "busted", options: Object.assign({}, cliOptions) }, base));
    mark("gene", t);
    const gene = { record: busted.result, statistics: busted.result.statistics };
    delete gene.record.statistics;
    delete gene.record.sites_detail;
    delete gene.record.summary;
    hooks.onSection("gene", gene, { final: true });

    const warnings = Array.isArray(meme.provenance.warnings) ? [...meme.provenance.warnings] : [];
    const sections = { sites, gene, epistasis: null, attribution: null, filter: null, dms: null, phenotype: null };
    for (const name of ["epistasis", "attribution", "filter", "dms"]) {
      warnings.push({
        code: "SECTION_UNAVAILABLE",
        severity: "info",
        message: "Section `" + name + "` was not computed: this server's runtime build has no runEverything orchestrator yet; only site selection and the gene-level omnibus ran.",
        data: { section: name }
      });
      hooks.onSection(name, null, { final: true });
    }
    const provenance = Object.assign({}, meme.provenance, {
      surface,
      warnings,
      options: Object.assign({}, options),
      elapsed_sec: (Date.now() - t0) / 1000,
      busted_head_sha256: (handle.head && handle.head.sha256) || null
    });
    return jsonSafeVia(rt, {
      schema_version: REPORT_SCHEMA_VERSION,
      kind: "report",
      createdAt: new Date().toISOString(),
      inputs: common.inputs,
      options: Object.assign({}, options),
      diagnostics: { warnings: meme.provenance.warnings || [], preprocessing: meme.provenance.preprocessing || null },
      sections,
      provenance,
      timings
    });
  }

  function jsonSafeVia(rt, value) {
    return typeof rt.jsonSafe === "function" ? rt.jsonSafe(value) : JSON.parse(JSON.stringify(value));
  }

  /**
   * One per-pillar analysis as `hyphaeon <cmd> -o` would write it, plus `provenance`.
   */
  async function pillar(task, hooks) {
    const analysis = task.analysis;
    // The REST API nests the trait under `options.phenotype` (so one `analyze` request can carry
    // it beside the report's own settings); the engine takes the CLI's flat names, as the MCP
    // tool does. Both spellings are accepted here, the flat one winning.
    if (analysis === "phenotype" && task.options && task.options.phenotype && typeof task.options.phenotype === "object") {
      const { phenotype, ...rest } = task.options;
      task = Object.assign({}, task, { options: Object.assign({}, phenotype, rest) });
    }
    const request = {
      analysis,
      alignment: task.alignment,
      tree: task.tree || undefined,
      prediction: task.prediction,
      meme_result: task.meme_result,
      phenotype_file: task.phenotype_file,
      // The date metadata document: its TEXT, like the phenotype table and for the same two
      // reasons — this process must never read a caller's disk over HTTP, and an option is copied
      // into the job store and into `provenance.options`, where a caller's Auspice JSON has no
      // business being. Only its NAME is an option, and the name is load-bearing rather than
      // decoration: it is the sole source of `-d <name>` on the reproduction line.
      dates_file: task.dates_file,
      options: Object.assign({}, task.options || {}),
      names: Object.assign({}, task.names || {}),
      surface: surfaceOf(task),
      signal: hooks.signal,
      progress: hooks.progress
    };
    if (task.seed !== undefined && request.options.seed === undefined) request.options.seed = task.seed;
    if (analysis === "temporal") {
      // The null's own work budget. The runtime's default (5.0e10) is the BROWSER's, chosen so a
      // tab stays responsive; this server's real bound is HYPHAEON_JOB_TIMEOUT_MS, and a null the
      // clock stops still returns a valid record at the achieved draw count, so a work cap here can
      // only refuse work the timeout would have stopped anyway. See src/config.js
      // `temporalPermBudget` for the arithmetic behind the default.
      if (request.options.perm_work_budget === undefined && Number.isFinite(permBudget)) request.options.perm_work_budget = permBudget;
      // Every interim payload `runTemporal` fires is the WHOLE record (measured upstream at ~6.7
      // MiB, 17 of them at the reference's own defaults) and jobs.js hands a section payload
      // straight to the SSE stream. Project first — and publish each projection to the section it
      // is actually about, at most once per distinct answer.
      //
      // THE RUNTIME FIRES MORE INTERIMS THAN THERE ARE ANSWERS (runtime/src/temporal/run.js:538,
      // 592, 714 and null.js:509). At the end of the null the last CHUNK emits, then the round
      // boundary emits the same count again, then `runTemporal` emits the finished record, and then
      // `pillar()` below emits the final pair — MEASURED on this server at B = 4,000: a
      // `permutations` tail of 3945, 4000, 4000, 4000, 4000 whose null states read running,
      // running, running, finished, finished. Three of those five said nothing the one before them
      // had not, and two of the redundant three still said the null was running after it had
      // stopped. `seen` below is the whole fix: a `permutations` payload goes out only when the
      // pair a client reads it for — the achieved draw count and the null's state — has actually
      // moved.
      //
      // AND THE STAGE DECIDES THE SECTION, not "scored or else". An interim at stage `complete` is
      // the finished record arriving early; it is a `summary` refresh, not another draw count.
      // Routing it to `permutations` is what produced the third of those four events.
      const seen = { perm: null, summary: null };
      request.onProgress = (partial) => {
        if (!partial || typeof partial !== "object") return;
        if (partial.stage === "null") {
          const payload = temporalNullSection(partial);
          const key = payload.null_state + ":" + ((payload.permutations && payload.permutations.completed) || 0);
          if (key !== seen.perm) {
            seen.perm = key;
            hooks.onSection("permutations", payload, { final: false });
          }
          // THE SUMMARY MUST NOT SAY `not-started` WHILE THE NULL RUNS. It is emitted once at the
          // scored payload and would otherwise never be refreshed, so `GET /result?section=summary`
          // mid-null served the state the null had before it began — REPRODUCED at phase
          // `temporal-null`, done > 400 of 9,000, honesty `{null_state: 'not-started'}`. It is
          // re-emitted on a STATE CHANGE rather than per chunk: the draw count is the
          // `permutations` section's business, and re-sending a summary twelve times to move one
          // word is the noise this same change is removing from the other section.
          if (payload.null_state !== seen.summary) {
            seen.summary = payload.null_state;
            hooks.onSection("summary", temporalSummarySection(partial), { final: false });
          }
          return;
        }
        // The last interim `runTemporal` fires is the FINISHED record (run.js:714), and `pillar()`
        // publishes that same record as both sections' FINAL payload a moment later. Emitting it
        // here as well would put two identical bodies on the stream to flip one boolean.
        if (partial.stage === "complete") return;
        const payload = temporalSummarySection(partial);
        if (payload.honesty.null_state !== seen.summary || partial.stage === "scored") {
          seen.summary = payload.honesty.null_state;
          hooks.onSection("summary", payload, { final: false });
        }
      };
    }
    if (!NATIVE_ANALYSES.includes(analysis)) {
      throw new EngineError("input", "Analysis '" + analysis + "' is not one this server runs.", {
        hint: "One of " + ANALYSES.join(", ") + ".",
        code: "ANALYSIS_UNAVAILABLE"
      });
    }
    const out = await engine.run(request);
    const result = Object.assign({ analysis }, out.result, { provenance: Object.assign({}, out.provenance, { surface: surfaceOf(task) }) });
    if (analysis === "temporal" && result.record) {
      // The two live sections, finalised. A client that watched the null refine reads the same two
      // names at the same URLs; `sections.permutations === "final"` in the job view is what says the
      // draw count on them is the one the record was classified at.
      hooks.onSection("summary", temporalSummarySection(result.record), { final: true });
      hooks.onSection("permutations", temporalNullSection(result.record), { final: true });
    }
    return result;
  }

  /**
   * The date review: no engine, no session, no graph (src/time.js `datesBody`). It runs in the
   * worker like every other analysis so one code path owns cancellation, timeouts and the job
   * store, not because it needs a thread — measured at 3-24 ms on the bundled examples.
   */
  function dates(task) {
    if (typeof task.alignment !== "string" || !task.alignment.trim()) {
      throw new EngineError("input", "An alignment is required.", { code: "MISSING_INPUT" });
    }
    return Object.assign(datesBody(task), {
      provenance: {
        surface: surfaceOf(task),
        engine: "in-process (no model, no graph)",
        model_variant: null,
        is_surrogate: false,
        surrogate_for: null,
        options: Object.assign({}, task.options || {}),
        warnings: []
      }
    });
  }

  return {
    engine,
    /**
     * @param {object} task  {analysis, alignment?, tree?, prediction?, meme_result?, options, seed?, names?}
     * @param {{signal: AbortSignal, progress: Function, onSection: Function}} hooks
     * @returns {Promise<object>}
     */
    async run(task, hooks) {
      const h = Object.assign({ progress() {}, onSection() {} }, hooks);
      try {
        if (!ANALYSES.includes(task.analysis)) {
          throw new EngineError("input", "Unknown analysis '" + task.analysis + "'.", { hint: "One of " + ANALYSES.join(", ") + "." });
        }
        if (task.analysis === "analyze") return await analyze(task, h);
        if (task.analysis === "dates") return dates(task);
        return await pillar(task, h);
      } catch (err) {
        const e = toError(err);
        if (h.signal && h.signal.aborted && e.kind !== "input") {
          e.kind = "cancelled";
          const reason = h.signal.reason && h.signal.reason.message;
          e.message = "The run was cancelled" + (reason ? " (" + reason + ")" : "") + ".";
          delete e.hint;
        }
        throw Object.assign(new Error(e.message), e);
      }
    },
    status: () => engine.status(),
    capabilities: () => engine.capabilities(),
    close: () => engine.close()
  };
}
