/**
 * options.js — the option vocabulary `POST /api/v1/jobs` accepts, and the refusal for a key that
 * is not in it.
 *
 * WHY THIS FILE EXISTS
 *
 * `JobRequest` (src/app.js) is a `.strict()` zod object, so a misspelled TOP-LEVEL field is a 400
 * before anything runs. `options` was the one hole in that: `z.record(z.string(), z.unknown())`
 * accepts every key, the job store copies it verbatim into `provenance.options`, and the engine's
 * `mapOptions` reads the keys it knows and silently drops the rest. MEASURED on this server before
 * this file existed: `POST /jobs {analysis:"temporal", options:{n_permutation: 50}}` — one letter
 * short of `n_permutations` — answered 202, echoed the option back in the job view, ran the
 * reference's 1,000-draw default, and said nothing anywhere. The caller gets a result that is
 * correct for a run they did not ask for, under the name of the run they did.
 *
 * THE RULE: AN OPTION THIS SURFACE CANNOT NAME IS REFUSED, NOT IGNORED. 422 with
 * `code: "UNKNOWN_OPTION"`, `kind: "input"`, the offending key(s) in `details`, and a hint that
 * names the nearest key this analysis does know (edit distance 1-2) when there is one. It is the
 * same judgement `classifyRun` already makes about `use_model` above DATING_MODEL_MAX_TAXA and the
 * one `mapOptions` makes about `clock_model: "power"`: a run that answers a question other than the
 * one asked, under the asked question's name, is worse than a refusal a caller can read and fix.
 *
 * FORWARD COMPATIBILITY IS A DERIVATION, NOT A PROMISE TO BE LENIENT. The vocabulary is not typed
 * out here. `optionVocabulary()` REGISTERS the MCP's own tools against a recording stub and reads
 * each tool's `inputSchema` keys — so `hyphaeon_temporal`'s thirty-odd option names ARE this
 * route's option names, and an option the runtime gains reaches this surface in the same change
 * that gives the MCP tool its schema entry, with no edit here. What is typed out is only the part
 * the MCP schema cannot supply:
 *
 *   - the keys that are REST BODY FIELDS on this surface and tool arguments on that one
 *     (`alignment`, `tree`, `dates_file`, ...), which must not be accepted inside `options`;
 *   - the MCP's own DELIVERY knobs (`run_async`, `wait_seconds`, `section`, `fields`, `top`,
 *     `summary_only`, `cpu`), which are query parameters or configuration here and never job
 *     options;
 *   - the `analyze` orchestrator's own switches, which have no MCP tool schema entry because
 *     `hyphaeon_analyze` does not expose them: `epistasis`, `attribute`, `filter` and the rest of
 *     `runtime/src/analyze.js`'s `args.options` (its docblock at lines 306-320 is the list), in
 *     both the CLI snake_case and the camelCase spelling the orchestrator contract uses, because
 *     `normaliseAnalyzeOptions` (src/runner.js) accepts both;
 *   - `variant` and `model_variant`, which `POST /jobs` writes into `options` itself from the
 *     request's `variant` field.
 *
 * A test pins the derived half against the tool list, so a tool that loses its schema entry fails
 * loudly here rather than quietly refusing a caller's legitimate option.
 */

import { registerTools } from "@veg/hyphaeon-mcp/tools";

/**
 * Tool-argument names that are NOT job options on this surface. Everything here is either a
 * request body field (`POST /jobs {alignment, tree, dates_file, ...}`), a result-shaping query
 * parameter (`GET /jobs/:id/result?fields=&top=&section=&summary_only=`), or an MCP delivery knob
 * with no meaning for a job that is always asynchronous here.
 */
const NOT_JOB_OPTIONS = Object.freeze([
  "alignment",
  "tree",
  "prediction",
  "meme_result",
  "phenotype_file",
  "dates_file",
  "job_id",
  "analysis",
  "section",
  "fields",
  "top",
  "summary_only",
  "run_async",
  "wait_seconds",
  "cpu"
]);

/**
 * `runtime/src/analyze.js`'s own `args.options` keys (its docblock, lines 306-320, plus the
 * `options.` reads the file makes), which `hyphaeon_analyze` does not put in its tool schema. The
 * report's section switches live here: a caller turning the epistasis section off is passing
 * `options.epistasis = false`, and nothing in the MCP schema names it.
 */
const ANALYZE_ORCHESTRATOR_OPTIONS = Object.freeze([
  "attribute",
  "attributionMinLrt",
  "batchBudgetBytes",
  "batchSize",
  "callMode",
  "displayTree",
  "dms",
  "epistasis",
  "epistasisDms",
  "filter",
  "filterPThresh",
  "focalTaxon",
  "gene",
  "maxSpecies",
  "permutations",
  "pruneDuplicates",
  "referenceSequence",
  "requireBranchLengths",
  "seed",
  "useTn93",
  "variant"
]);

/** Written into `options` by `POST /jobs` itself, from the request's `variant` field. */
const SERVER_OPTIONS = Object.freeze(["variant", "model_variant", "seed"]);

/**
 * Per-analysis extras this surface accepts that no tool schema names.
 * `row_limit` is `datesBody`'s own bound on the per-taxon review table (src/time.js); the MCP
 * tool spells the same idea `top`, which is a query parameter here.
 */
const REST_EXTRAS = Object.freeze({
  dates: ["row_limit", "dates_file_name"],
  dating: ["dates_file_name", "phenotype_file_name"],
  temporal: ["dates_file_name"],
  // The trait is NESTED on this surface — `options.phenotype: {...}` — so that one `analyze`
  // request can carry it beside the report's own settings (src/runner.js `pillar` flattens it for
  // the engine, which takes the CLI's flat names as the MCP tool does). Both spellings are
  // accepted, and the nested block's own keys are checked against the same vocabulary below.
  phenotype: ["phenotype", "phenotype_file_name"],
  analyze: ["phenotype", "phenotype_file_name", "dms_work_budget", "n_permutations", "use_tn93", "no_tree", "max_species", "reference_sequence", "call_mode", "mds_sign"]
});

/**
 * Option blocks that are OBJECTS, and the vocabulary each one's keys are checked against.
 *
 * They need naming because they are silent-drop paths of exactly the kind this file exists for:
 * `phenotypeRequestFor` (src/runner.js) copies a FIXED LIST of keys out of `options.phenotype` and
 * drops the rest, and `runEverything` spreads `options.dms` over `REPORT_DEFAULTS.dms` and reads
 * four names from it. A typo inside either block is as invisible as a typo outside one was.
 *
 * `phenotype` is checked against the `phenotype` analysis's own vocabulary, so the nested block and
 * the flat `hyphaeon_phenotype` call name the same things. `dms`'s keys are `runtime/src/analyze.js`'s
 * own (`args.options.dms`, its docblock at line 312), in both spellings.
 */
const NESTED_BLOCKS = Object.freeze({
  phenotype: { vocabulary: "phenotype" },
  dms: { keys: ["enabled", "workBudget", "work_budget", "siteSubset", "site_subset", "batchSize", "batch_size", "focalTaxon", "focal_taxon"] }
});

/** snake_case -> camelCase, the one transform `normaliseAnalyzeOptions` applies. */
function camel(key) {
  return key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

let cached = null;

/**
 * `{analysis: Set<string>}` — every option key `POST /api/v1/jobs` accepts, per analysis.
 *
 * The MCP's tools are registered against a stub that records nothing but each tool's
 * `inputSchema` keys; `registerTools` builds its schemas eagerly and touches no model, no file and
 * no network doing it (the engine it constructs is lazy — `createEngine` resolves a session only
 * when one is asked for). MEASURED on this machine: the build is 4.1 ms the first time and 0.075 ms
 * cached, with ZERO onnxruntime modules in `process.moduleLoadList` afterwards, so this runs on the
 * HTTP thread without dragging a graph onto it. The 244 ms of `@veg/hyphaeon-mcp/tools` import it
 * pays for is not new: src/formats.js already imports the same module at server start for
 * `shapeResult`.
 */
export function optionVocabulary() {
  if (cached) return cached;
  const byTool = {};
  const stub = {
    registerTool(name, def) {
      byTool[name] = Object.keys((def && def.inputSchema) || {});
    },
    registerResource() {},
    registerPrompt() {}
  };
  registerTools(stub, {
    jobs: { create() {}, get() {}, list: () => [] },
    env: process.env,
    logger: { info() {}, warn() {}, error() {}, debug() {} }
  });

  const out = {};
  for (const [tool, keys] of Object.entries(byTool)) {
    if (!tool.startsWith("hyphaeon_")) continue;
    const analysis = tool.slice("hyphaeon_".length);
    const set = new Set(SERVER_OPTIONS);
    for (const k of keys) if (!NOT_JOB_OPTIONS.includes(k)) set.add(k);
    for (const k of REST_EXTRAS[analysis] || []) set.add(k);
    out[analysis] = set;
  }
  // `analyze` additionally takes the orchestrator's own switches, in both spellings.
  const analyze = out.analyze || new Set(SERVER_OPTIONS);
  for (const k of ANALYZE_ORCHESTRATOR_OPTIONS) {
    analyze.add(k);
    analyze.add(k.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase()));
  }
  for (const k of [...analyze]) analyze.add(camel(k));
  out.analyze = analyze;
  // `evaluate` is registered as a tool; `validate` is not an analysis.
  delete out.validate;
  cached = out;
  return out;
}

/** Levenshtein distance, bounded: used only to say "did you mean". */
function distance(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const prev = new Array(b.length + 1);
  const cur = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
  }
  return prev[b.length];
}

/** The known key nearest `key`, within edit distance 2, or null. */
export function nearestOption(key, known) {
  let best = null;
  let bestD = 3;
  for (const k of known) {
    const d = distance(key, k);
    if (d < bestD) {
      bestD = d;
      best = k;
    }
  }
  return bestD <= 2 ? best : null;
}

/**
 * Refuse an option key this analysis cannot name.
 *
 * @param {string} analysis
 * @param {object} options  the job request's `options` after `POST /jobs` merged `variant` in
 * @returns {{ok: true} | {ok: false, code: string, message: string, hint: string, details: object}}
 */
export function optionCheck(analysis, options = {}) {
  const all = optionVocabulary();
  const vocab = all[analysis];
  // An analysis with no tool of its own (none today) is not second-guessed here.
  if (!vocab) return { ok: true };
  const unknown = [];
  for (const key of Object.keys(options)) if (!vocab.has(key)) unknown.push(key);
  if (!unknown.length) {
    // The nested blocks, whose keys are dropped just as silently as a top-level key was.
    for (const [block, spec] of Object.entries(NESTED_BLOCKS)) {
      const value = options[block];
      if (!value || typeof value !== "object" || Array.isArray(value) || !vocab.has(block)) continue;
      const inner = spec.vocabulary ? all[spec.vocabulary] : new Set(spec.keys);
      if (!inner) continue;
      const bad = Object.keys(value).filter((k) => !inner.has(k));
      if (!bad.length) continue;
      const sug = {};
      for (const k of bad) {
        const near = nearestOption(k, inner);
        if (near) sug[k] = near;
      }
      const did = Object.entries(sug).map(([k, v]) => "`" + k + "` -> `" + v + "`");
      return {
        ok: false,
        code: "UNKNOWN_OPTION",
        message:
          (bad.length === 1 ? "Option " : "Options ") + bad.map((k) => "`options." + block + "." + k + "`").join(", ") + " " +
          (bad.length === 1 ? "is" : "are") + " not read by the `" + block + "` block. The block's keys are copied by name " +
          "and anything else is dropped, so this is refused rather than run.",
        hint: (did.length ? "Did you mean " + did.join(", ") + "? " : "") + "`options." + block + "` accepts: " + [...inner].sort().join(", ") + ".",
        details: { analysis, block, unknown: bad, suggestions: sug }
      };
    }
    return { ok: true };
  }
  const suggestions = {};
  for (const key of unknown) {
    const near = nearestOption(key, vocab);
    if (near) suggestions[key] = near;
  }
  const named = unknown.map((k) => "`" + k + "`").join(", ");
  const did = Object.entries(suggestions).map(([k, v]) => "`" + k + "` -> `" + v + "`");
  return {
    ok: false,
    code: "UNKNOWN_OPTION",
    message:
      (unknown.length === 1 ? "Option " : "Options ") + named + " " + (unknown.length === 1 ? "is" : "are") +
      " not an option of `" + analysis + "`. This run is refused rather than started: an option this " +
      "server cannot name is an option it would silently drop, and a run that answers a different " +
      "question under the asked question's name is worse than a refusal.",
    hint:
      (did.length ? "Did you mean " + did.join(", ") + "? " : "") +
      "The options `" + analysis + "` accepts are: " + [...vocab].sort().join(", ") + ".",
    details: { analysis, unknown, suggestions }
  };
}
