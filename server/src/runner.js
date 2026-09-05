/**
 * runner.js — turns one job request into one result, inside an analysis worker.
 *
 * WHY THIS FILE EXISTS
 *
 * The server accepts six `analysis` values (PLAN.md 3.5: `analyze`, the product's one action that
 * runs everything, and the per-pillar `meme`, `busted`, `epistasis`, `dms`, `evaluate`) and has
 * two engines to run them with:
 *
 *   - `@veg/hyphaeon-mcp/engine` (mcp/src/engine.js): the in-process engine the MCP already
 *     built for its native pillars. It memoises one ONNX session per variant, maps the CLI-shaped
 *     options, fits branch lengths with the runtime's HyPhy WASM driver, writes the document
 *     `hyphaeon <cmd> -o` writes and stamps a PLAN.md 3.5 provenance block. The server runs the
 *     per-pillar analyses through it so `POST /api/v1/jobs {analysis:"meme"}` and the MCP tool
 *     `hyphaeon_meme` are the same code and the same bytes, only `provenance.surface` differs
 *     ("node-server" here).
 *   - `runEverything` from `@veg/hyphaeon-runtime` (runtime/src/analyze.js, the orchestrator
 *     contract of this phase): diagnostics -> sites -> gene -> epistasis + sectors -> attribution
 *     -> filter -> DMS, streaming sections through `onSection`, returning the ReportRecord the
 *     report page renders (PLAN.md 4.0, D21). `analyze` jobs run through it.
 *
 * Two seams are documented as app-side rather than reference behaviour:
 *
 *   1. While the runtime does not export `runEverything` (the runtime agent lands it in this
 *      phase), `analyze` degrades to `composeReportFallback`: the same ReportRecord shape with
 *      `sites` and `gene` computed through the engine and the other sections `null`, each absence
 *      recorded as a `SECTION_UNAVAILABLE` warning in the provenance. The report page shows the
 *      sections it has; nothing is invented.
 *   2. A per-pillar `epistasis` or `dms` request is served by the engine when the MCP has ported
 *      it (`NATIVE_ANALYSES`), otherwise by running `runEverything` and returning that section
 *      alone, with the whole run's provenance. The server never shells to Python
 *      (PLAN.md 3.6's bridge belongs to the stdio MCP on the user's machine).
 *
 * Errors are classified into the two classes the MCP established (mcp/src/bridge.js,
 * engine.js `classifyEngineError`): `kind: "input"` (the alignment has a problem; the job fails
 * with a hint) and `kind: "server"` (the model or the process is broken). `EngineError`
 * instances pass through; anything else is a server error.
 */

import { createEngine, EngineError, fastaFromAlignment, newickTextFrom, stripBranchLengths, NATIVE_ANALYSES } from "@veg/hyphaeon-mcp/engine";

export const SURFACE = "node-server";
/** Surfaces a task may claim (PLAN.md 3.5); anything else is recorded as the server's own. */
const TASK_SURFACES = new Set(["node-server", "mcp-http"]);
const surfaceOf = (task) => (task && TASK_SURFACES.has(task.surface) ? task.surface : SURFACE);
export const ANALYSES = Object.freeze(["analyze", "meme", "busted", "epistasis", "dms", "evaluate"]);
export const REPORT_SECTIONS = Object.freeze(["sites", "gene", "epistasis", "attribution", "filter", "dms", "phenotype"]);
export const REPORT_SCHEMA_VERSION = 2;

/** The analyze-options the orchestrator contract names, with the CLI spellings it also accepts. */
const ANALYZE_OPTION_ALIASES = {
  model_variant: "variant",
  max_species: "maxSpecies",
  reference_sequence: "referenceSequence",
  call_mode: "callMode",
  n_permutations: "permutations"
};

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
  if (err instanceof EngineError) return { kind: err.kind || "server", message: err.message, hint: err.hint, code: err.code };
  if (err && (err.kind === "input" || err.kind === "server")) return { kind: err.kind, message: err.message || String(err), hint: err.hint, code: err.code };
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
 */
export function createRunner(opts) {
  const env = opts.env || process.env;
  const logger = opts.logger || { debug() {}, info() {}, warn() {}, error() {} };
  const engine = opts.engine || createEngine({ env, logger, threads: opts.threads });
  let runtimePromise = opts.runtime ? Promise.resolve(opts.runtime) : null;

  function runtime() {
    if (!runtimePromise) runtimePromise = import("@veg/hyphaeon-runtime");
    return runtimePromise;
  }

  /** `options.estimateTree` for runEverything, through the engine's HyPhy WASM driver. */
  async function estimateTree(alignmentText, treeText, progress) {
    const hy = await engine.hyphy();
    if (!hy) throw new EngineError("server", "The HyPhy WASM driver is not available in this runtime.");
    const newick = treeText ? newickTextFrom(treeText) : newickTextFrom(alignmentText);
    if (!newick) throw new EngineError("input", "No tree topology could be read for branch-length estimation.");
    const r = await hy.estimateBranchLengths(fastaFromAlignment(alignmentText), stripBranchLengths(newick), {
      progress: (phase, done, total, message) => progress && progress("prepare", 1, 2, "HyPhy HKY85: " + message)
    });
    return { treeText: r.result, source: "hyphy-hky85" };
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
    const caps = await engine.capabilities();
    const common = {
      alignmentText: task.alignment,
      treeText: task.tree || null,
      inputs,
      options: Object.assign({}, options, {
        variant,
        estimateTree: caps.hyphy ? (a, t) => estimateTree(a, t, hooks.progress) : undefined
      }),
      session: handle.backbone,
      head: handle.head || (typeof handle.loadHead === "function" ? await handle.loadHead().catch(() => null) : null),
      surface: surfaceOf(task),
      signal: hooks.signal,
      progress: hooks.progress,
      onSection: hooks.onSection
    };
    if (typeof rt.runEverything === "function") {
      const report = await rt.runEverything(common);
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
      options: Object.assign({}, options, { estimateTree: undefined }),
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
    const request = {
      analysis,
      alignment: task.alignment,
      tree: task.tree || undefined,
      prediction: task.prediction,
      meme_result: task.meme_result,
      options: Object.assign({}, task.options || {}),
      names: Object.assign({}, task.names || {}),
      surface: surfaceOf(task),
      signal: hooks.signal,
      progress: hooks.progress
    };
    if (task.seed !== undefined && request.options.seed === undefined) request.options.seed = task.seed;
    if (NATIVE_ANALYSES.includes(analysis)) {
      const out = await engine.run(request);
      return Object.assign({ analysis }, out.result, { provenance: Object.assign({}, out.provenance, { surface: surfaceOf(task) }) });
    }
    // Not ported into the engine yet: take the section out of the full run (header, seam 2).
    const rt = await runtime();
    if (typeof rt.runEverything !== "function") {
      throw new EngineError("server", "Analysis '" + analysis + "' is not served in-process by this server build.", {
        hint: "Run `analyze` (the whole report) once the runtime orchestrator lands, or use the stdio MCP's Python bridge on your own machine.",
        code: "ANALYSIS_UNAVAILABLE"
      });
    }
    const wanted = analysis;
    const report = await analyze(
      Object.assign({}, task, { options: Object.assign({}, task.options || {}, { dms: { enabled: wanted === "dms" } }) }),
      Object.assign({}, hooks, { onSection: (name, payload, meta) => name === wanted && hooks.onSection(name, payload, meta) })
    );
    const section = report.sections ? report.sections[wanted] : null;
    if (!section) {
      throw new EngineError("server", "The run finished without a `" + wanted + "` section.", { code: "SECTION_MISSING" });
    }
    return Object.assign({ analysis }, section, { provenance: report.provenance });
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
