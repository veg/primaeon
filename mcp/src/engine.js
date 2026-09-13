/**
 * engine.js — the in-process HyphAeon engine behind every tool: runtime/ over onnxruntime-node,
 * no Python, no HyPhy.
 *
 * WHY THIS FILE EXISTS
 *
 * PLAN.md 3.6, "port pillar by pillar": once a pillar's JavaScript port lands, its tool stops
 * shelling to `hyphaeon <cmd>` and runs `runtime/` in this process, and `provenance.surface`
 * becomes "mcp-stdio" / "mcp-http". Phase 1a ported site selection, the omnibus statistics and
 * the evaluation (veg/HyphAeon js/ at tag phase-1a); Phase 1b's runtime wraps them as
 * `runMeme` (runtime/src/pipeline.js), `runBusted` (runtime/src/busted.js) and `runEvaluate`
 * (runtime/src/evaluate.js) over a session `createSession` (runtime/src/createSession.js) loads
 * from the manifest, and serialises them with runtime/src/results.js. Phase 2a ported the
 * epistasis pillar (js/src/epistasis.js, sectors.js, dms.js at tag phase-2a) and the runtime
 * wraps it as `runEpistasis` (runtime/src/epistasis.js) and `runDms` (runtime/src/dms.js) over a
 * `prepareRun()` load, and orchestrates the whole PLAN.md 4.0 report as `runEverything`
 * (runtime/src/analyze.js, the contract every surface codes against). **Phase 3a ported the last
 * pillar, phenotype** (js/src/phenotype.js + permulations.js at tag phase-3a; HyphAeon/PHASE3A.md),
 * the runtime wraps it as `runPhenotype` (runtime/src/phenotype.js) — and with that the last
 * subprocess in the product went away. Nothing in this process spawns anything: there is no
 * Python at runtime anywhere (PLAN.md 8 phase 3, D16).
 *
 * This module is the MCP's side of all that: it resolves the models directory (src/models.js),
 * loads and memoises one session per variant, maps the tool's CLI-shaped options onto the
 * runtime's, turns the runtime's result into the document `hyphaeon <cmd> -o` writes (Appendix B
 * of PLAN.md; cli.py:298-311 for meme, :486-505 for busted, epistasis.py:717-731 for epistasis,
 * :759-768 for dms, phenotype.py:624-646 for phenotype, evaluation.py's report for evaluate) with
 * a PLAN.md 3.5 provenance block, and classifies failures into two classes (input | server).
 *
 * OPTIONS MIRROR THE CLI ONE TO ONE (hyphaeon/cli.py at phase-3a; evaluation.py
 * configure_parser), with these documented seams:
 *   - `max_species` unset means NO cap for meme, epistasis, dms and phenotype (cli.py
 *     `--max-species` default None; those parsers either have no such flag or default to None)
 *     and 512 for busted; the runtime spells "no cap" as `Infinity`.
 *   - `cpu` is accepted and recorded; onnxruntime-node here is CPU-only.
 *   - `min_patch_consec` is recorded but not forwarded: runMeme fixes the cmd_meme copy of the
 *     OCI screen at its default (3); a non-default value raises a provenance warning
 *     (OPTION_NOT_APPLIED) rather than silently doing something else.
 *   - `mds_sign` (`--mds-sign {canonical,lapack}`): the library computes CANONICAL eigenvector
 *     signs only (MDS_SIGN.md), which is also the reference's default. `lapack` would reproduce
 *     pre-convention numbers and is refused as an input error; every result records
 *     `provenance.mds_sign: "canonical"` as MDS_SIGN.md recommends.
 *   - `seed` feeds the sector permutation null (epistasis, phenotype) and the phenotype
 *     permulations. The reference draws with PCG64 and the library with xoshiro256**, so the same
 *     seed gives a DIFFERENT sequence and `p_perm` / `p_assoc_perm` / `gene_p_value_perm` agree
 *     statistically, never bit for bit (PLAN.md 5.4).
 *   - `sites` on hyphaeon_dms is APP-SIDE (the CLI sweeps every site): 1-indexed codon sites to
 *     sweep, so a caller can pay for the sites it cares about; `total_mutations` stays 19 x L as
 *     `run_digital_dms_analysis` computes it, and `progress` says how many were swept.
 *   - `phenotype_file` is the CSV/TSV TEXT, not a path: the library does no I/O and this process
 *     must not read a caller's disk over HTTP. `phenotype_file_name` (default `phenotype.csv`)
 *     carries the basename the reference derives the separator and the description from.
 *
 * THE TREE, AFTER D22. A tree WITH branch lengths is used as it is. No tree, a tree without
 * usable branch lengths, or `use_tn93` / `no_tree`: the library's tree-free path takes pairwise
 * TN93 distances straight into the MDS (dataset.py:493-571 and 598-636, the reference's own
 * `--use-tn93`) and says so in `loaded.notices.treeFree.reason`
 * ('requested' | 'no_tree' | 'no_branch_lengths'). Nothing here estimates branch lengths and
 * nothing builds a tree: the WebAssembly tree tool, its vendored build and its HBL scripts are
 * gone from the product (PLAN.md D22, phase 3). `treeSourceFor` below turns the library's notice into the
 * `preprocessing.tree_source` every result records — 'user', 'embedded' or 'tn93' — so a reader
 * can always tell which of the two paths produced the distance matrix the model saw. A tree TEXT
 * that will not parse is still an error on both sides: a bad tree is not a missing one.
 *
 * THE RUNTIME IS REACHED THROUGH ITS PACKAGE ENTRY, WITH A FILE-PATH FALLBACK. Each name is also
 * resolvable from `runtime/src/<file>.js` by absolute file URL — a file URL is not subject to
 * the package's exports map — so the MCP keeps working across the runtime's index catching up
 * with its modules, and prefers the public name once it exists. The Phase 2 and Phase 3 names
 * (`runEpistasis`, `runDms`, `runEverything`, `runPhenotype`, the report writers) are OPTIONAL at
 * load: an older runtime still serves meme/busted/evaluate, and the tools that need the missing
 * name answer with a server-class error saying which file to update.
 *
 * SESSIONS ARE LOADED ON FIRST USE AND MEMOISED PER VARIANT. onnxruntime-node dlopens ~100 MB of
 * native code and the graph is 8 MB and hash-verified (runtime/src/session-node.js); the stdio
 * server is spawned once per client session, so list_models / job_status / hyphaeon_validate
 * must never pay that (measured: 146 ms for the general graph, then 0.6 s for bat_oas1 end to
 * end). A failed load is not memoised (a transient read error must not disable the tool for the
 * life of the process), and the busted head is loaded lazily, only for hyphaeon_busted and
 * hyphaeon_analyze on a variant that ships one (general does; viral does not, manifest.json).
 *
 * THE REPORT (`analyze`). `runEverything` is the orchestrator every surface shares: one loaded
 * alignment, one forward pass, sections fired through `onSection(name, payload, {final})` in
 * PLAN.md 4.0's order, DMS last and budget-capped. The engine's job here is small on purpose —
 * pick the variant when the caller did not (from the diagnostics' tree regime, the same rule the
 * report page uses), load the session and head, relay sections and progress, and stamp the MCP's
 * provenance on the finished record. The MCP adds nothing to the arithmetic and the record is the
 * runtime's `ReportRecord` as it stands.
 *
 * PHENOTYPE IN THE REPORT. `sections.phenotype` stays null unless the caller supplies a trait
 * (PLAN.md 4.0 row 8: it "cannot run unasked"), which is why `runEverything` never fills it.
 * With `options.phenotype` the engine fills it after the orchestrator returns and BEFORE the
 * record is serialised, out of the report's own pass: `runMeme` already requested
 * `mean_root_attns` for the epistasis section, and those attentions plus the site LRTs are
 * exactly what `runPhenotype` takes, so the section costs graph maths and NO inference. That is
 * recorded as `provenance.phenotype_source: "report-pass"`. A report run with `epistasis: false`
 * has no attention to reuse; the same call then takes the reference's all-sites loop through the
 * session, a real second pass, and says so as "second-pass".
 *
 * The neural BUSTED head is one seeded draw of a head the reference loads unseeded (PHASE0.md
 * gap 10, PHASE1A.md item 4): its fields are returned as the runtime returns them, with the
 * runtime's `provenance.neural_head.deterministic_upstream: false` left in place, and the tool
 * description says which fields are reproducible.
 */

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { diagnose as libraryDiagnose, extractTree } from "@veg/hyphaeon-js";
import { resolveModels } from "./models.js";
import { JOB_TIMEOUT_MS, NATIVE_ANALYSES } from "./caps.js";
import { DATING_LATENT_NEEDS_MODEL, dateGate, dateReview, datingHonesty, refusalHint, refusalOf, temporalHonesty, TIME_REFUSAL_CODES } from "./time.js";

const PKG = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const require = createRequire(import.meta.url);

export { NATIVE_ANALYSES };

/** MDS_SIGN.md: the one convention the library computes. */
export const MDS_SIGN = "canonical";

/** cli.py `--max-species` defaults per subcommand: None (no cap) except busted's 512. */
const MAX_SPECIES_DEFAULT = Object.freeze({
  meme: Infinity,
  busted: undefined,
  epistasis: Infinity,
  dms: Infinity,
  phenotype: Infinity,
  // cli.py:1850 / :1922 — `-s/--max-species` defaults to None on both time subcommands.
  //
  // TEMPORAL'S CAP IS TIME-BLIND AND RAISING IT IS NOT A FREE WIN (D27). Above the cap the library
  // reduces by Faith's phylogenetic diversity after a stride prefilter, which knows nothing about
  // sampling date and can remove the early part of an epidemic — exactly the part a sweep is
  // measured against. So this surface does what the reference does, keeps every taxon, and leaves
  // MAX_TAXA (1,000, src/caps.js) as the submission refusal; a caller who wants the cap asks for
  // it with `max_species` and the record stamps `primaeon.taxon_cap: "applied"`, the reproduction
  // line gains `-s <taxa_total>` and `temporalReferenceCommand` adds its own caveat.
  temporal: Infinity,
  // `dating` never reaches prepareRun at all: runDating parses the alignment itself, over every
  // sequence, because the reference's dating pass runs with max_species=None.
  dating: Infinity
});

export class EngineError extends Error {
  /**
   * @param {"server"|"input"} kind
   * @param {string} message
   * @param {{hint?: string, cause?: unknown, code?: string}} [extra]
   */
  constructor(kind, message, extra = {}) {
    super(message, extra.cause ? { cause: extra.cause } : undefined);
    this.name = "EngineError";
    this.kind = kind;
    this.hint = extra.hint;
    this.code = extra.code;
  }
}

// ── runtime modules ─────────────────────────────────────────────────────────

let runtimeDirCache = null;
export function runtimeDir() {
  if (!runtimeDirCache) runtimeDirCache = path.dirname(require.resolve("@veg/hyphaeon-runtime/package.json"));
  return runtimeDirCache;
}

/** Does an import failure mean "not there / not exported" rather than a broken module? */
function isResolutionFailure(err) {
  const code = err && err.code;
  if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND" || code === "ERR_PACKAGE_PATH_NOT_EXPORTED") return true;
  const m = String((err && err.message) || err);
  return /Missing ".*" specifier|not exported|Cannot find (module|package)|Failed to (load|resolve)/i.test(m);
}

async function importRuntimeFile(rel) {
  const p = path.join(runtimeDir(), "src", rel);
  if (!existsSync(p)) return null;
  return import(pathToFileURL(p).href);
}

async function importRuntimeSubpath(specifier, rel) {
  try {
    return await import(specifier);
  } catch (err) {
    if (isResolutionFailure(err)) return importRuntimeFile(rel);
    throw err;
  }
}

let runtimePromise = null;

/**
 * The runtime's functions, resolved once: the package entry first, the module files second.
 * Phase 1 names are required; the Phase 2 and Phase 3 names (`runEpistasis`, `runDms`,
 * `runEverything`, `runPhenotype`, `prepareRun`, `diagnoseWarnings`, `provenanceBlock`,
 * `toReportRecord`) resolve to null when the runtime checkout predates them, and the tools that
 * need them say so.
 *
 * @returns {Promise<object>}
 */
export function loadRuntime() {
  if (runtimePromise) return runtimePromise;
  runtimePromise = (async () => {
    const entry = await import("@veg/hyphaeon-runtime");
    const optional = async (name, rel) => {
      if (typeof entry[name] === "function") return entry[name];
      const mod = await importRuntimeFile(rel);
      return mod && typeof mod[name] === "function" ? mod[name] : null;
    };
    const need = async (name, rel) => {
      const fn = await optional(name, rel);
      if (fn) return fn;
      throw new EngineError("server", "The HyphAeon runtime does not provide " + name + " (expected in runtime/src/" + rel + ").", {
        hint: "The @veg/hyphaeon-runtime workspace is older than this MCP; update the checkout."
      });
    };
    let version = null;
    try {
      version = JSON.parse(readFileSync(path.join(runtimeDir(), "package.json"), "utf8")).version || null;
    } catch {
      version = null;
    }
    return {
      // Phase 1
      createSession: await need("createSession", "createSession.js"),
      runMeme: await need("runMeme", "pipeline.js"),
      runBusted: await need("runBusted", "busted.js"),
      runEvaluate: await need("runEvaluate", "evaluate.js"),
      memeDocument: await need("memeDocument", "results.js"),
      bustedDocument: await need("bustedDocument", "results.js"),
      jsonSafe: await need("jsonSafe", "results.js"),
      // Phase 2 (optional at load)
      prepareRun: await optional("prepareRun", "pipeline.js"),
      diagnoseWarnings: await optional("diagnoseWarnings", "pipeline.js"),
      provenanceBlock: await optional("provenanceBlock", "pipeline.js"),
      runEpistasis: await optional("runEpistasis", "epistasis.js"),
      runDms: await optional("runDms", "dms.js"),
      runEverything: await optional("runEverything", "analyze.js"),
      toReportRecord: await optional("toReportRecord", "report.js"),
      // Phase 3 (optional at load)
      runPhenotype: await optional("runPhenotype", "phenotype.js"),
      // Phase 6 (optional at load): the date layer, the clock and temporal selection. Resolved the
      // same way as every Phase 2/3 name so a runtime checkout that predates them yields the named
      // RUNTIME_OUTDATED server error from `requireRuntimeFn` instead of a TypeError inside a run.
      //
      // `ingestDates` / `taxaForDates` ARE ALSO resolved here, even though src/time.js imports them
      // statically from the `./dates` subpath: a tool that only reviews dates must not pay for the
      // runtime's main entry, and the two pillars that DO load a model should still fail with a
      // named error rather than an import crash on an old checkout.
      ingestDates: await optional("ingestDates", "dates/ingest.js"),
      taxaForDates: await optional("taxaForDates", "dates/ingest.js"),
      alignDatesToRun: await optional("alignDatesToRun", "dates/ingest.js"),
      runDating: await optional("runDating", "dating/run.js"),
      datingDownloads: await optional("datingDownloads", "dating/results.js"),
      runDatingModelPass: await optional("runDatingModelPass", "datingNeural.js"),
      runTemporal: await optional("runTemporal", "temporal/run.js"),
      temporalReferenceCommand: await optional("temporalReferenceCommand", "temporal/results.js"),
      temporalDownloadNotes: await optional("temporalDownloadNotes", "temporal/results.js"),
      temporalPPermNote: await optional("temporalPPermNote", "temporal/results.js"),
      temporalDownloads: await optional("temporalDownloads", "temporal/results.js"),
      temporalNullBudget: await optional("temporalNullBudget", "temporal/null.js"),
      siteRow: await optional("siteRow", "temporal/record.js"),
      candidateSiteIndices: await optional("candidateSiteIndices", "temporal/record.js"),
      version
    };
  })();
  runtimePromise.catch(() => {
    runtimePromise = null;
  });
  return runtimePromise;
}

// ── the tree, after D22 ─────────────────────────────────────────────────────

/**
 * Does the alignment carry a tree the reference would find (dataset.py:161-212)?
 * @param {string} alignmentText
 */
export function hasEmbeddedTree(alignmentText) {
  try {
    return extractTree(alignmentText) !== null;
  } catch {
    return false;
  }
}

/**
 * The `preprocessing.tree_source` a finished run records (PLAN.md 3.5): 'tn93' whenever the
 * library took the tree-free path (`loaded.notices.treeFree`, D22 — no tree, no usable branch
 * lengths, or `use_tn93`), else 'user' for a supplied tree and 'embedded' for one found inside
 * the alignment. The old 'hyphy-hky85' and 'nj' values are gone: nothing estimates branch lengths and nothing
 * builds a tree for the model any more.
 *
 * The library's notice is the authority — it is the object the MDS was actually built from — so
 * this RECONCILES whatever the runtime recorded rather than trusting it, and a mismatch is a
 * reconciliation, not an error (the runtime may legitimately spell a tree-free load 'embedded'
 * because that is where it looked for the tree).
 *
 * @param {object|null} loaded the library's LoadedAlignment, when the run has one
 * @param {{treeGiven?: boolean, alignmentText?: string, recorded?: string|null}} facts
 * @returns {"user"|"embedded"|"tn93"}
 */
export function treeSourceFor(loaded, { treeGiven = false, alignmentText = "", recorded = null } = {}) {
  const treeFree = loaded && loaded.notices ? loaded.notices.treeFree : undefined;
  if (treeFree) return "tn93";
  if (treeFree === null) return treeGiven ? "user" : "embedded";
  // No loaded alignment to ask (an early failure, or a runtime that returns none).
  if (recorded === "tn93" || recorded === "user" || recorded === "embedded") return recorded;
  if (treeGiven) return "user";
  return hasEmbeddedTree(alignmentText) ? "embedded" : "tn93";
}

/**
 * Stamp `tree_source` (and the tree-free reason) on a provenance block's `preprocessing`.
 *
 * The runtime's `prepareRun` already records all three fields, and in the same vocabulary; this
 * RECONCILES rather than overwrites, so a runtime that reports them keeps its own values and one
 * that does not still produces a complete block. `tree_free` is the runtime's
 * `{reason, taxa_order}` object, and is only synthesised when it is absent.
 */
export function stampTreeSource(provenance, loaded, facts) {
  if (!provenance || typeof provenance !== "object") return provenance;
  const pre = (provenance.preprocessing = Object.assign({}, provenance.preprocessing));
  pre.tree_source = treeSourceFor(loaded, Object.assign({ recorded: pre.tree_source ?? null }, facts));
  const notices = loaded && loaded.notices ? loaded.notices : null;
  if (pre.tree_free === undefined) {
    const treeFree = notices ? notices.treeFree : null;
    pre.tree_free = treeFree ? { reason: treeFree.reason, taxa_order: treeFree.taxaOrder } : null;
  }
  if (pre.tn93_saturated_pairs === undefined) pre.tn93_saturated_pairs = notices ? notices.tn93SaturatedPairs ?? null : null;
  // Nothing estimates branch lengths any more (D22): the field stays for schema stability.
  pre.branch_lengths_estimated = false;
  return provenance;
}

// ── option mapping ──────────────────────────────────────────────────────────

/**
 * Tool options (the CLI's names) -> runtime options. Exported so a test can check the mapping
 * without loading a model.
 *
 * For epistasis and dms the returned `runtime` object is what `runEpistasis` / `runDms` take as
 * `options` (camelCase, the CLI's defaults left to the runtime's `EPISTASIS_CLI_DEFAULTS`);
 * `runtime.maxSpecies` etc. are consumed by `prepareRun` first and are harmless to the pillar.
 *
 * @param {"meme"|"busted"|"epistasis"|"dms"|"phenotype"} analysis
 * @param {object} options
 * @param {{defaultVariant?: string, alignmentName?: string, treeName?: string|null}} [extra]
 * @returns {{runtime: object, variant: string, notApplied: string[]}}
 */
export function mapOptions(analysis, options = {}, extra = {}) {
  const out = {};
  const notApplied = [];
  const variant = options.model_variant || extra.defaultVariant || "general";
  const has = (k) => options[k] !== undefined && options[k] !== null;
  if (has("max_species")) out.maxSpecies = options.max_species;
  else if (MAX_SPECIES_DEFAULT[analysis] !== undefined) out.maxSpecies = MAX_SPECIES_DEFAULT[analysis];
  if (options.no_prune_duplicates === true) out.pruneDuplicates = false;
  if (has("batch_size")) out.batchSize = options.batch_size;
  // D22: `--use-tn93` / `--no-tree` force the tree-free path even when a usable tree was given.
  if (options.use_tn93 === true || options.no_tree === true) out.useTn93 = true;
  if (analysis === "meme") {
    if (options.filter === true) out.filter = true;
    if (has("filter_p_thresh")) out.filterPThresh = options.filter_p_thresh;
    if (has("min_patch_consec") && options.min_patch_consec !== 3) notApplied.push("min_patch_consec");
    if (options.attribute === true) out.attribute = true;
    if (has("attribution_min_lrt")) out.attributionMinLrt = options.attribution_min_lrt;
  }
  if (analysis === "busted") {
    if (options.gene) out.gene = options.gene;
  }
  if (analysis === "epistasis") {
    // cli.py cmd_epistasis -> run_epistatic_analysis keyword for keyword.
    if (has("focal_taxon")) out.focalTaxon = options.focal_taxon;
    if (has("min_sim")) out.minSim = options.min_sim;
    if (has("min_shared")) out.minShared = options.min_shared;
    if (has("max_fdr")) out.maxFdr = options.max_fdr;
    if (has("min_lrt")) out.minLrt = options.min_lrt;
    if (has("min_clique_size")) out.minCliqueSize = options.min_clique_size;
    if (has("max_overlap")) out.maxOverlap = options.max_overlap;
    if (has("min_coherence")) out.minCoherence = options.min_coherence;
    if (has("n_permutations")) out.nPermutations = options.n_permutations;
    if (has("max_perm_p")) out.maxPermP = options.max_perm_p;
    if (has("seed")) out.seed = options.seed;
    out.dms = options.no_dms !== true; // `run_dms=not args.no_dms`
    out.graph = true;
  }
  if (analysis === "dms") {
    if (has("focal_taxon")) out.focalTaxon = options.focal_taxon;
    if (Array.isArray(options.sites) && options.sites.length) out.siteSubset = options.sites.map((s) => s - 1);
  }
  if (analysis === "phenotype") {
    // cli.py cmd_phenotype -> resolve_phenotype_vector + run_phenotype_association, keyword for
    // keyword (phenotype.py:121-274, 347-646). The trait is a nested object because the library's
    // `resolvePhenotypeVector` takes one; `phenotypeCsv` is the file's TEXT and `phenotypeFile`
    // its basename, which is what the reference derives the separator and the description from.
    const trait = {};
    if (has("preset")) trait.preset = options.preset;
    if (has("foreground")) trait.foreground = options.foreground;
    if (has("background")) trait.background = options.background; // accepted and never read, as upstream
    if (has("phenotype_file")) {
      trait.phenotypeCsv = options.phenotype_file;
      trait.phenotypeFile = options.phenotype_file_name || "phenotype.csv";
    }
    if (has("trait_col")) trait.traitCol = options.trait_col;
    if (has("species_col")) trait.speciesCol = options.species_col;
    if (options.continuous === true) trait.continuous = true;
    out.phenotype = trait;
    if (options.continuous === true) out.continuous = true;
    if (has("permulations")) out.permulations = options.permulations;
    if (has("n_permutations")) out.nPermutations = options.n_permutations;
    if (has("alpha")) out.alpha = options.alpha;
    if (has("min_taxa")) out.minTaxaPerSite = options.min_taxa;
    if (has("max_perm_p")) out.maxPermP = options.max_perm_p;
    if (has("seed")) out.seed = options.seed;
  }
  if (analysis === "dating") {
    // cli.py:1895-1926 -> runDating's keywords. `--no-optimize-root`, `--ridge`, `--tune-ridge`,
    // `--bootstrap`, `--loocv`, `--plot*`, `--alluvial*` and `--color-by` have no port and are not
    // in the schema, so nothing can be recorded-and-dropped here. `--beast` is refused by the date
    // layer (DATES_BEAST_XML_UNSUPPORTED) rather than accepted and ignored.
    if (has("root_taxon")) out.rootTaxon = options.root_taxon;
    if (has("decay_gamma")) out.decayGamma = options.decay_gamma;
    if (has("clock_model")) out.clockModel = options.clock_model;
    if (has("ci_method")) out.ciMethod = options.ci_method;
    if (has("distance_mode")) out.distanceMode = options.distance_mode;
    if (Array.isArray(options.excluded_taxa) && options.excluded_taxa.length) out.excludedTaxa = options.excluded_taxa;
    if (options.allow_stop_codons === false) out.allowStopCodons = false;
    if (options.no_auto_trim === true) out.autoTrimTrailing = false;
    // `--clock-model power` is in the CLI's `choices` and is NOT ported (PLAN-TEMPORAL D33). It is
    // kept out of the tool's enum so the schema refuses it before a run starts; if one arrives
    // anyway it is recorded and not applied rather than silently answered with `auto`.
    if (options.clock_model === "power") {
      notApplied.push("clock_model");
      delete out.clockModel;
    }
  }
  if (analysis === "temporal") {
    // cli.py:1823-1850 -> runTemporal's `options`, keyword for keyword.
    if (has("time_units")) out.timeUnits = options.time_units;
    if (has("sweep_mode")) out.sweepMode = options.sweep_mode;
    if (options.keep_duplicates === true) out.keepDuplicates = true;
    if (has("time_points")) out.numTimePoints = options.time_points;
    if (has("bandwidth")) out.bandwidth = options.bandwidth;
    if (has("n_permutations")) out.permutations = options.n_permutations;
    if (has("perm_alpha")) out.permAlpha = options.perm_alpha;
    if (has("min_r2")) out.minR2Fpca = options.min_r2;
    if (has("tau_peak")) out.tauPeak = options.tau_peak;
    if (has("tau_auc")) out.tauAuc = options.tau_auc;
    if (has("root_taxon")) out.rootTaxon = options.root_taxon;
    if (has("seed")) out.seed = options.seed;
    // D28 and WAVE_SIGN.md. The reference has NO convention and writes its solver's raw singular
    // vectors; this build fixes one. `lapack` is refused in the schema for the same reason
    // `mds_sign: "lapack"` is: a tool that accepted it would promise numbers this build does not
    // compute. Recorded on the record as `waves.sign` either way.
    if (has("wave_sign")) out.waveSign = options.wave_sign;
    if (options.score_invariable_sites === false) out.scoreInvariableSites = false;
    // The null's own budget vocabulary is the runtime's (TEMPORAL_PERM_BUDGET_DEFAULT 5.0e10,
    // runtime/src/temporal/null.js). This surface has already sized the run against its own caps,
    // so a caller may lift it; the default is left to the runtime.
    if (has("perm_work_budget")) out.workBudget = options.perm_work_budget;
    if (has("batch_size")) out.batchSize = options.batch_size;
  }
  if (extra.alignmentName) out.alignmentName = extra.alignmentName;
  if (extra.treeName !== undefined) out.treeName = extra.treeName;
  return { runtime: out, variant, notApplied };
}

/**
 * The `hyphaeon <cmd> ...` line that reproduces a native run through the Python reference
 * (the "reproduce this with the CLI" snippet of PLAN.md 3.6). `--mds-sign canonical` is spelled
 * out because it is what this surface computed; the CLI default is the same today.
 *
 * `--use-tn93` is spelled out whenever the run WAS tree-free, not only when the caller asked for
 * it: the reference REFUSES an alignment with no tree (dataset.py:647-651) and silently
 * substitutes 1e-3 defaults for a tree with no branch lengths, so `--use-tn93` is the only
 * invocation that reproduces what this surface did (`cliOptionsFor` below adds it).
 */
export function referenceCommand(analysis, options = {}, names = {}) {
  if (analysis === "dating" || analysis === "temporal") {
    // THESE TWO DO NOT GET AN ARGV ARRAY. Their reproduction line is a
    // `{command, reproduces, caveats}` OBJECT — the runtime's `temporalReferenceCommand` and, since
    // phase 6's review moved it there too, the runtime's `datingReferenceCommand` — because a bare string makes
    // a reproducibility promise neither pillar can keep: temporal's null draws from a different
    // generator than the reference's on EVERY run that draws at all, and dating's date set is read
    // by a wider parser than the reference has. See src/time.js, decision 5. Throwing here rather
    // than returning a plausible array is deliberate: a second builder that could disagree with
    // the first is exactly the failure this split avoids.
    throw new EngineError("server", "referenceCommand does not build a line for hyphaeon_" + analysis + "; use the {command, reproduces, caveats} builder.", {
      hint: "Both are the runtime's: temporalReferenceCommand(record) and datingReferenceCommand(run, options, names, ingest), re-exported from src/time.js.",
      code: "RUNTIME_OUTDATED"
    });
  }
  const argv = ["hyphaeon", analysis];
  const has = (k) => options[k] !== undefined && options[k] !== null;
  if (analysis === "evaluate") {
    argv.push("--prediction", names.prediction || "gene.csv", "--meme-result", names.meme_result || "gene.MEME.json");
    if (options.variable_only) argv.push("--variable-only");
    if (options.allow_site_mismatch) argv.push("--allow-site-mismatch");
    argv.push("-o", "<out.json>", "--format", "json");
    return argv;
  }
  argv.push("-a", names.alignment || "alignment.fasta");
  if (names.tree) argv.push("-t", names.tree);
  if (options.use_tn93 || options.no_tree) argv.push("--use-tn93");
  if (analysis === "meme" || analysis === "busted") {
    if (options.model_variant) argv.push("--model-variant", options.model_variant);
    if (has("max_species")) argv.push("--max-species", String(options.max_species));
    if (has("batch_size")) argv.push("--batch-size", String(options.batch_size));
    if (options.no_prune_duplicates) argv.push("--no-prune-duplicates");
  }
  argv.push("--cpu");
  if (analysis === "meme") {
    if (options.filter) argv.push("--filter");
    if (has("filter_p_thresh")) argv.push("--filter-p-thresh", String(options.filter_p_thresh));
    if (has("min_patch_consec")) argv.push("--min-patch-consec", String(options.min_patch_consec));
    if (options.attribute) argv.push("--attribute");
    if (has("attribution_min_lrt")) argv.push("--attribution-min-lrt", String(options.attribution_min_lrt));
  }
  if (analysis === "epistasis") {
    for (const [key, flag] of [
      ["focal_taxon", "--focal-taxon"],
      ["min_sim", "--min-sim"],
      ["min_shared", "--min-shared"],
      ["max_fdr", "--max-fdr"],
      ["min_lrt", "--min-lrt"],
      ["min_clique_size", "--min-clique-size"],
      ["max_overlap", "--max-overlap"],
      ["min_coherence", "--min-coherence"],
      ["n_permutations", "--n-permutations"],
      ["max_perm_p", "--max-perm-p"],
      ["seed", "--seed"]
    ]) {
      if (has(key)) argv.push(flag, String(options[key]));
    }
    if (options.no_dms) argv.push("--no-dms");
  }
  if (analysis === "dms") {
    if (has("focal_taxon")) argv.push("--focal-taxon", String(options.focal_taxon));
  }
  if (analysis === "phenotype") {
    // cli.py:1038-1094's parser, in its own order; `--phenotype-file` names the basename this
    // surface was given, since the CLI takes a path and this tool takes the text.
    if (names.phenotype_file) argv.push("--phenotype-file", names.phenotype_file);
    for (const [key, flag] of [
      ["model_variant", "--model-variant"],
      ["preset", "--preset"],
      ["foreground", "--foreground"],
      ["background", "--background"],
      ["trait_col", "--trait-col"],
      ["species_col", "--species-col"],
      ["permulations", "--permulations"],
      ["min_taxa", "--min-taxa"],
      ["alpha", "--alpha"],
      ["n_permutations", "--n-permutations"],
      ["max_perm_p", "--max-perm-p"],
      ["seed", "--seed"]
    ]) {
      if (has(key)) argv.push(flag, String(options[key]));
    }
    if (options.continuous) argv.push("--continuous");
  }
  argv.push("--mds-sign", MDS_SIGN);
  argv.push("-o", "<out.json>");
  return argv;
}

/**
 * The options a reproducing CLI line needs: the caller's, plus `use_tn93` when the load actually
 * went tree-free (see `referenceCommand`).
 *
 * @param {object} options the tool's options as submitted
 * @param {object|null} loaded the library's LoadedAlignment, when the run has one
 */
export function cliOptionsFor(options, loaded) {
  const treeFree = loaded && loaded.notices ? loaded.notices.treeFree : null;
  return treeFree ? Object.assign({}, options, { use_tn93: true }) : options;
}

/**
 * The `hyphaeon <cmd>` lines that reproduce a report's sections with the Python reference: the
 * report is four CLI runs over one alignment (PLAN.md 4.0), each recorded with the options the
 * report used. App-side settings without a CLI flag (`callMode`, the DMS budget) are not spelled;
 * `permutations` becomes `--n-permutations`.
 */
export function referenceCommandsForReport(options = {}, names = {}) {
  const common = {};
  if (options.variant) common.model_variant = options.variant;
  if (options.maxSpecies !== undefined && options.maxSpecies !== null && Number.isFinite(options.maxSpecies)) common.max_species = options.maxSpecies;
  if (options.useTn93) common.use_tn93 = true;
  const epi = {};
  if (options.permutations !== undefined && options.permutations !== null) epi.n_permutations = options.permutations;
  if (options.seed !== undefined && options.seed !== null) epi.seed = options.seed;
  const out = {
    sites: referenceCommand("meme", Object.assign({ attribute: true, filter: true }, common), names),
    gene: referenceCommand("busted", common, names),
    epistasis: referenceCommand("epistasis", Object.assign({ no_dms: true }, epi), names),
    dms: referenceCommand("dms", Object.assign({}, options.useTn93 ? { use_tn93: true } : {}), names)
  };
  // The report runs phenotype only when the caller supplied a trait (PLAN.md 4.0 row 8).
  if (options.phenotypeCli) out.phenotype = referenceCommand("phenotype", Object.assign({}, options.phenotypeCli, common.use_tn93 ? { use_tn93: true } : {}), names);
  return out;
}

/**
 * The variant the report runs when the caller named none: the tree regime rule of PLAN.md 4.0
 * ("variant chosen from tree depth") over the library's diagnostics — SHALLOW_TREE means the
 * viral model's regime. Exported for the test and for a UI that wants to show the choice.
 *
 * @param {Array<{code: string}>} warnings the library's diagnose() warnings
 * @returns {"general"|"viral"}
 */
export function variantFromDiagnostics(warnings) {
  return Array.isArray(warnings) && warnings.some((w) => w && w.code === "SHALLOW_TREE") ? "viral" : "general";
}

/** A runtime function that must exist for a call, or a server error naming the file to update. */
export function requireRuntimeFn(rt, name, rel) {
  if (rt && typeof rt[name] === "function") return rt[name];
  throw new EngineError("server", "The HyphAeon runtime does not provide " + name + " (expected in runtime/src/" + rel + ").", {
    hint: "The @veg/hyphaeon-runtime workspace is older than this build; update the checkout.",
    code: "RUNTIME_OUTDATED"
  });
}

/**
 * Fill a finished report's `phenotype` section from the pass it already ran.
 *
 * `runEverything` leaves `sections.phenotype` null by design — a trait cannot be guessed
 * (PLAN.md 4.0 row 8) — and filling it needs no second forward pass: the meme pass requested
 * `mean_root_attns` for the epistasis section, and those attentions plus the site LRTs are
 * exactly what `compute_transformer_attributions` wants, so the runtime's `runPhenotype` takes
 * them as `attention` + `lrt` and the section costs graph maths and NO inference. Call this on
 * the LIVE report object, before `toReportRecord` strips the pass off it.
 *
 * A report run with `epistasis: false` has no attention to reuse; the same call then falls back
 * to the reference's own all-sites loop through the session, which IS a second pass, and the
 * returned `source` says so.
 *
 * Both the MCP's `hyphaeon_analyze` and the Node server's `analysis: "analyze"` job go through
 * here, so the report's phenotype section cannot differ between the two surfaces.
 *
 * @param {object} rt the resolved runtime module bag (loadRuntime()'s shape, or the module itself)
 * @param {object} report the live ReportRecord from `runEverything`
 * @param {{trait: object, options?: object, session: object, inputs?: object, progress?: Function, signal?: AbortSignal}} args
 * @returns {Promise<{section: object, source: "report-pass"|"second-pass"}>}
 */
export async function runPhenotypeSection(rt, report, { trait, options = {}, session, inputs = {}, progress, signal }) {
  const runPhenotype = requireRuntimeFn(rt, "runPhenotype", "phenotype.js");
  const sites = report && report.sections ? report.sections.sites : null;
  const pass = sites ? sites.inference : null;
  const loaded = sites ? sites.loaded : null;
  const shared = Boolean(pass && pass.mean_root_attns && pass.lrt && loaded);
  const section = await runPhenotype({
    loaded: loaded || undefined,
    attention: shared ? pass.mean_root_attns : null,
    lrt: shared ? pass.lrt : null,
    session,
    phenotype: trait,
    options,
    inputs,
    progress,
    signal
  });
  return { section, source: shared ? "report-pass" : "second-pass" };
}

// ── error classification ────────────────────────────────────────────────────

const INPUT_PATTERNS = [
  /No sequence data available/i,
  /No sequences found/i,
  /Could not parse any sequences/i,
  /needs at least \d+ sequences/i,
  /Could not parse phylogenetic tree/i,
  /No matching taxa/i,
  /shorter than one codon|shorter than/i,
  /Alignment too short/i,
  /input check failed/i,
  /Unknown callMode/i,
  // runtime/src/pipeline.js prepareRun: the tn93 package raised on a saturated or non-overlapping
  // pair (PHASE3A.md quirks); that is the alignment's property, not the engine's. Classified with
  // its own message and code by `tn93Refusal` below; the pattern stays here as the backstop.
  /TN93 distances could not be computed/i,
  // phenotype.py's own refusals (phenotype.py:274, 231-236, :404-406) through the library.
  /Insufficient foreground taxa/i,
  /Unknown preset/i,
  /Provide one of|no trait/i,
  /y has \d+ entries/i,
  /Single-gene files do not match/i,
  /mismatched sites/i,
  /Missing required|missing column|No rows|No sites|Unable to parse|is not a valid|could not be read/i,
  /EvaluationError/i,
  /nPermutations must be|seed must be/i,
  /site\(s\) out of range|sites? .* out of range/i,
  /cancelled/i,
  // Phase 6. The two time pillars RETURN their refusals (handled by `timeRefusal` below), but they
  // THROW a RangeError for a bad OPTION — `ciMethod` (dating/run.js:226), `distanceMode`
  // (dating/run.js:126), `distanceMode: 'latent'` with no model pass (:284) — and an Error for a
  // date vector whose length does not match the run (temporal/run.js:187) or an unknown `inputs`
  // key (temporal/run.js:745). Every one of those is the CALLER's, and without these patterns they
  // fall through to the server class and tell a caller with a typo to "report it to the operator",
  // which is precisely the mistake Phase 3 made for TN93 and Phase 4 fixed.
  /is not one of|is not implemented|distanceMode|ciMethod/i,
  /date vector has \d+ entries/i,
  /unknown `inputs` key/i,
  /pass a `session` handle|pass the library LoadedAlignment/i,
  /the dating graph|taxa\.onnx|BACKBONE, not/i
];

/**
 * A refusal RETURNED by `ingestDates`, `runDating` or `runTemporal` as an EngineError.
 *
 * EVERY ONE OF THESE IS `kind: "input"`. Each is a property of the caller's metadata or alignment
 * and none of them changes if the operator restarts the server, so the generic server hint
 * ("nothing about the submitted data will change this") would be exactly backwards — the Phase 3
 * TN93 mistake, repeated across thirty more codes. The hint comes from src/time.js's own table so
 * it names the METADATA fix (a date column, a pattern, more sampling spread) rather than the
 * alignment fix the generic input hint gives.
 *
 * @param {{code: string, message: string, data?: object}} refusal from `refusalOf`
 * @returns {EngineError}
 */
export function timeRefusal(refusal) {
  return new EngineError("input", refusal.message, { code: refusal.code, hint: refusalHint(refusal.code) });
}

/** `EngineError.code` when `use_model` was asked for and this build declares no dating graph. */
export const DATING_GRAPH_UNAVAILABLE = "DATING_GRAPH_UNAVAILABLE";

/** `EngineError.code` for the one tree-free refusal an alignment can earn. */
export const TN93_UNCOMPUTABLE = "TN93_UNCOMPUTABLE";

/**
 * The runtime's tree-free refusal (runtime/src/pipeline.js `prepareRun`), as an INPUT error with
 * a message for the person who uploaded the alignment, or null when `message` is something else.
 *
 * The runtime's sentence begins "TN93 distances could not be computed for this alignment:" and
 * then quotes the tn93 package's own exception (`tn93: ValueError: math domain error`, or a
 * ZeroDivisionError for a pair with no overlapping unambiguous position — PHASE3A.md, "Python
 * quirks replicated") before explaining it. The quoted exception is a package name and a Python
 * error class the caller never invoked, so it is dropped here and the explanation kept; what is
 * left says what is true of the DATA — a saturated pair, or two sequences that share no readable
 * position — and what to do about it. Before Phase 3 integration this message fell through to the
 * server class ("report it to the operator"), which was wrong: nothing about the engine changes
 * it, and `hyphaeon_validate` reports the same pairs as TN93_SATURATED_PAIRS.
 *
 * @param {string} message
 * @param {unknown} [cause]
 * @returns {EngineError|null}
 */
export function tn93Refusal(message, cause) {
  const text = String(message || "");
  if (!/TN93 distances could not be computed/i.test(text)) return null;
  // The runtime's explanation names both conditions every time; only the quoted exception class
  // says which one this alignment hit (ValueError: saturated; ZeroDivisionError: no overlap).
  const noOverlap = /ZeroDivisionError|division by zero/i.test(text);
  return new EngineError(
    "input",
    "HyphAeon could not compute TN93 distances for this alignment, so a tree-free run is not possible: " +
      (noOverlap
        ? "at least one pair of sequences shares no overlapping unambiguous position, so their distance is undefined. "
        : "at least one pair of sequences is saturated (too many differences for the TN93 correction to read any shared history). ") +
      "This is a property of the sequences, not of the server.",
    {
      cause,
      code: TN93_UNCOMPUTABLE,
      hint:
        "Supply a tree with branch lengths (the model then uses its patristic distances and TN93 is not needed), " +
        "or run hyphaeon_validate and drop the sequences its TN93_SATURATED_PAIRS warning names."
    }
  );
}

/** Turn any failure inside a native run into an EngineError with a class. */
export function classifyEngineError(err) {
  if (err instanceof EngineError) return err;
  const message = (err && err.message) || String(err);
  const name = err && err.name;
  if (name === "AbortError" || /cancelled/i.test(message)) {
    return new EngineError("input", "The run was cancelled.", { cause: err });
  }
  const tn93 = tn93Refusal(message, err);
  if (tn93) return tn93;
  // THE ONE RUNTIME MESSAGE THAT NAMES ITS OWN ARGUMENT. `runDating` throws a RangeError for
  // `distanceMode: 'latent'` with no model pass that says "pass `neural`, the object
  // runDatingModelPass returns" (runtime/src/dating/run.js:282) — a function and an argument no
  // tool caller has, with no code on it. src/tools.js refuses the pair before the pillar runs;
  // this is the backstop for any other path that reaches it, so the caller still gets a code and
  // a hint naming the two arguments that exist.
  if (/needs the dating graph/i.test(message)) {
    return new EngineError(
      "input",
      "`distance_mode: \"latent\"` needs the model pass: the latent root is a position in the model's own representation space, and this run made none (use_model is false).",
      { cause: err, code: DATING_LATENT_NEEDS_MODEL, hint: refusalHint(DATING_LATENT_NEEDS_MODEL) }
    );
  }
  // A refusal code that reached here inside a thrown message (a runtime that raises rather than
  // returns, or a wrapper that rethrew) is still the caller's data, not the engine's.
  const timeCode = TIME_REFUSAL_CODES.find((c) => message.includes(c));
  if (timeCode) return new EngineError("input", message, { cause: err, code: timeCode, hint: refusalHint(timeCode) });
  if (name === "EvaluationError" || INPUT_PATTERNS.some((re) => re.test(message))) {
    return new EngineError("input", "HyphAeon could not process this input: " + message, {
      cause: err,
      hint:
        "Check that the alignment is an in-frame codon alignment (FASTA, NEXUS or PHYLIP) and that, if " +
        "you supplied a tree, its tip names match the sequence names exactly. A tree is optional: without " +
        "one (or without branch lengths) HyphAeon uses pairwise TN93 distances. Run hyphaeon_validate " +
        "first for a full diagnosis."
    });
  }
  return new EngineError(
    "server",
    "The HyphAeon engine could not run in this process (model files, onnxruntime-node, or the runtime), " +
      "not a problem with your alignment or tree: " + message,
    { cause: err, hint: "Nothing about the submitted data will change this; report it to the operator." }
  );
}

function timeoutSignal(ms, signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("The run exceeded the " + Math.round(ms / 60000) + "-minute limit and was cancelled.")), ms);
  if (timer.unref) timer.unref();
  const onAbort = () => controller.abort(signal.reason);
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    clear() {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    }
  };
}

/** `mds_sign` is accepted for CLI parity; only the library's convention can run here. */
function checkMdsSign(options, analysis) {
  if (options.mds_sign === undefined || options.mds_sign === null || options.mds_sign === MDS_SIGN) return;
  throw new EngineError(
    "input",
    "mds_sign '" + options.mds_sign + "' asks for the eigensolver's own MDS signs (`--mds-sign lapack`, the pre-phase-2a numbers); " +
      "hyphaeon_" + analysis + " runs in-process here and the library computes the canonical convention only (MDS_SIGN.md).",
    { hint: "Omit mds_sign (canonical is the reference's default too), or run `hyphaeon " + analysis + " --mds-sign lapack` with the Python CLI." }
  );
}

// ── the engine ──────────────────────────────────────────────────────────────

/**
 * @param {object} [opts]
 * @param {object} [opts.env]        defaults to process.env
 * @param {object} [opts.logger]
 * @param {number} [opts.threads]    intra-op threads for onnxruntime-node (env HYPHAEON_MCP_THREADS, default 1)
 * @param {object} [opts.runtime]    test seam: an object with the functions loadRuntime() resolves
 * @param {number} [opts.timeoutMs]  default JOB_TIMEOUT_MS
 */
export function createEngine(opts = {}) {
  const env = opts.env || process.env;
  const logger = opts.logger || { info() {}, warn() {}, error() {}, debug() {} };
  const threadsEnv = parseInt(env.HYPHAEON_MCP_THREADS || "", 10);
  const threads = Number.isInteger(opts.threads) && opts.threads >= 1 ? opts.threads : Number.isInteger(threadsEnv) && threadsEnv >= 1 ? threadsEnv : 1;
  const timeoutMs = opts.timeoutMs ?? JOB_TIMEOUT_MS;
  const sessions = new Map();

  const runtime = () => (opts.runtime ? Promise.resolve(opts.runtime) : loadRuntime());

  async function models() {
    const resolved = await resolveModels(env);
    if (!resolved.available) {
      throw new EngineError(
        "server",
        resolved.error || "No models/manifest.json was found; the native tools cannot load a graph.",
        {
          hint:
            "Set HYPHAEON_MODELS_DIR to a directory holding manifest.json and the .onnx graphs " +
            "(`hyphaeon export-onnx` writes them). Searched: " + resolved.searched.join(", "),
          code: "MODELS_MISSING"
        }
      );
    }
    return resolved;
  }

  /**
   * The loaded session for a variant (memoised; a failure is dropped so the next call retries).
   * @param {string} variant
   * @param {{bustedHead?: boolean}} [o]
   */
  async function session(variant, o = {}) {
    // MEMOISED ON variant + threads, and the taxa graph is loaded onto the SAME handle rather than
    // under a second key: `createSession`'s handle owns `loadTaxaGraph()` and keeps its own `taxa`
    // memo, so a second key here would load the backbone twice. What must never happen is handing
    // `runDatingModelPass` the BACKBONE — its `mean_root_attns` is the root token's attention ROW
    // and its `root_repr` the root token's VECTOR, where the dating pillar needs the taxon-by-taxon
    // block and the per-taxon states, and neither is derivable from the other. The runtime checks
    // the loaded graph's declared output names and throws if it was given the wrong one
    // (runtime/src/datingNeural.js:113-121); this branch returns the taxa handle explicitly so that
    // check is a backstop and not the only guard.
    const key = variant + "|" + threads;
    let p = sessions.get(key);
    if (!p) {
      p = (async () => {
        const rt = await runtime();
        const m = await models();
        const t0 = Date.now();
        const handle = await rt.createSession({ modelsBase: m.dir, variant, runtime: "node", threads });
        logger.info("engine loaded " + variant + " from " + m.dir + " in " + (Date.now() - t0) + " ms (sha256 " + String(handle.backbone.sha256).slice(0, 12) + ", threads " + threads + ")");
        return handle;
      })();
      sessions.set(key, p);
      p.catch(() => {
        if (sessions.get(key) === p) sessions.delete(key);
      });
    }
    const handle = await p;
    if (o.taxaGraph) {
      // A manifest that declares no `taxa_onnx_sha256` is a fact about the BUILD, not a run
      // failure: `loadTaxaGraph()` returns null and the caller says so in its own words. A FAILED
      // load is different and is not memoised on the handle by the runtime, so the next call retries.
      const taxa = await handle.loadTaxaGraph();
      if (!taxa) {
        throw new EngineError(
          "server",
          "This build declares no dating graph for the `" + variant + "` variant: models/manifest.json carries no " +
            "taxa_onnx_sha256, so `" + variant + "_taxa.onnx` was never exported and the model-based clock estimators " +
            "(attention PGLS, latent root search) cannot run here.",
          {
            code: DATING_GRAPH_UNAVAILABLE,
            hint:
              "Re-run hyphaeon_dating with use_model: false for the model-free (TN93 root-to-tip) estimate, which is this " +
              "tool's default and a different answer rather than a degraded one. To get the model-based estimators, the " +
              "operator must export the graph (`hyphaeon export-onnx` writes <variant>_taxa.onnx and its hash); " +
              "list_models reports `dating_graph` per variant so a client can check before asking."
          }
        );
      }
    }
    if (o.bustedHead && !handle.head && !handle.headError) {
      try {
        await handle.loadHead();
      } catch (err) {
        // The head is optional: statistics still come out; the failure is reported in provenance.
        logger.warn("busted head for " + variant + " could not be loaded: " + ((err && err.message) || err));
        handle.headError = (err && err.message) || String(err);
      }
    }
    return handle;
  }

  /**
   * Whether the engine can score: models present, onnxruntime-node loadable. Never loads a
   * graph (list_models must stay cheap); says why when it cannot.
   */
  async function status() {
    const out = { engine: "onnxruntime-node", threads, native_analyses: [...NATIVE_ANALYSES], available: false };
    const resolved = await resolveModels(env);
    out.models_dir = resolved.dir || null;
    out.manifest_path = resolved.path || null;
    if (!resolved.available) {
      out.reason = resolved.error || "No models/manifest.json found (searched: " + resolved.searched.join(", ") + ").";
      return out;
    }
    try {
      const rt = await runtime();
      out.runtime_version = rt.version;
      out.mds_sign = MDS_SIGN;
      // D22: distances come from the tree when it has branch lengths, otherwise from TN93 in the
      // library. Nothing estimates branch lengths and nothing builds a tree for the model.
      out.tree_free = "tn93 (library)";
      out.branch_length_estimator = null;
      // Which Phase 2 / Phase 3 entry points this runtime checkout provides.
      out.runtime_provides = {
        runEpistasis: typeof rt.runEpistasis === "function",
        runDms: typeof rt.runDms === "function",
        runEverything: typeof rt.runEverything === "function",
        runPhenotype: typeof rt.runPhenotype === "function",
        ingestDates: typeof rt.ingestDates === "function",
        runDating: typeof rt.runDating === "function",
        runDatingModelPass: typeof rt.runDatingModelPass === "function",
        runTemporal: typeof rt.runTemporal === "function",
        temporalReferenceCommand: typeof rt.temporalReferenceCommand === "function"
      };
      // WHETHER THE MODEL-BASED CLOCK CAN RUN AT ALL, per variant, read from the manifest and
      // WITHOUT loading a graph. `hyphaeon_dating use_model: true` needs <variant>_taxa.onnx, and a
      // build exported before that graph existed (or with --skip-taxa-graph) declares no hash for
      // it. Saying so here means a client can tell in advance instead of discovering it inside a run.
      try {
        const m = JSON.parse(readFileSync(resolved.path, "utf8"));
        out.dating_graph = Object.fromEntries(
          Object.entries((m && m.variants) || {}).map(([name, v]) => [name, v && v.taxa_onnx_sha256 ? "declared" : "absent"])
        );
      } catch {
        out.dating_graph = null;
      }
      out.date_layer = {
        engine: "in-process (runtime/src/dates), no model",
        sources: ["fasta headers", "nextstrain auspice json", "name-to-date json map", "csv/tsv table", "caller regex"],
        beast_xml: "refused (DATES_BEAST_XML_UNSUPPORTED): the reference reads one, this build does not"
      };
    } catch (err) {
      out.reason = "The HyphAeon runtime could not be loaded: " + ((err && err.message) || err);
      return out;
    }
    try {
      out.onnxruntime_node = JSON.parse(readFileSync(require.resolve("onnxruntime-node/package.json"), "utf8")).version;
    } catch (err) {
      out.reason = "onnxruntime-node is not installed: " + ((err && err.message) || err);
      return out;
    }
    out.available = true;
    out.sessions_loaded = [...sessions.keys()].map((k) => k.split("|")[0]);
    return out;
  }

  /** A runtime function that must exist for this call, or a server error naming the file. */
  const requireRuntime = requireRuntimeFn;

  /** The MCP's own provenance fields, stamped on every native result. */
  function mcpProvenance(rt, base, { surface, analysis, options, names, t0, reference }) {
    return Object.assign({}, rt.jsonSafe(base || {}), {
      surface,
      engine: "in-process",
      hyphaeon_mcp_version: PKG.version,
      hyphaeon_runtime_version: rt.version,
      threads,
      mds_sign: MDS_SIGN,
      reference_command: reference || referenceCommand(analysis, options, names),
      elapsed_sec: (Date.now() - t0) / 1000,
      options: Object.assign({}, options)
    });
  }


  /**
   * The two Phase-6 time pillars, behind one function because they share everything that is hard:
   * the date layer, the returned-not-thrown refusal, and a reproduction line that is an object.
   *
   * WHAT IS DIFFERENT FROM EVERY OTHER BRANCH IN `run`:
   *
   *  - THE DATES ARE INGESTED HERE, ONCE, and the `DateIngest` object — not a taxon->value map —
   *    is what reaches the pillar. `resolveTemporalDates` accepts a map and returns `byRule: null`
   *    for one on purpose, so a run fed a map prints `beyond_reference: {count: 0}`, a claim the
   *    input cannot support, and D31's whole rule table is lost. src/time.js, decision 3.
   *  - A REFUSAL IS RETURNED, NOT THROWN. `{ok: false, refusal, warnings}` handed to
   *    `rt.jsonSafe` would become a SUCCESSFUL tool result whose body says nothing ran, with a full
   *    provenance block and no isError. `refusalOf` + `timeRefusal` convert it to an input-class
   *    EngineError with the refusal's own code.
   *  - `runDating` PARSES THE ALIGNMENT ITSELF and never sees a `loaded`: the reference's dating
   *    pass runs over every sequence with `max_species=None` and `prune_duplicates=False`, because
   *    the covariance is centred over everything and only then sliced. Feeding it the report's
   *    capped, duplicate-collapsed `loaded` would give a different estimate, not an approximation
   *    of the same one (runtime/src/datingNeural.js, notes 2 and 3).
   *  - `runTemporal` DOES need `prepareRun` and a session, and its `inputs` keys are whitelisted:
   *    `alignment | tree | dates` and a typo THROWS (temporal/run.js `assertInputNames`), because
   *    `??` used to turn one into a summary file that could not say what it analysed.
   */
  async function runTimePillar({ analysis, rt, req, options, toolOptions, mapped, names, treeGiven, surface, progress, onProgress, signal, session: sessionFor, t0 }) {
    const alignmentName = names.alignment;
    const treeName = names.tree;
    const datesName = names.dates_file || null;

    // --- the date layer, once ----------------------------------------------------------------
    const ingestDatesFn = requireRuntime(rt, "ingestDates", "dates/ingest.js");
    const taxaForDatesFn = requireRuntime(rt, "taxaForDates", "dates/ingest.js");
    const ingest = ingestDatesFn({
      taxa: taxaForDatesFn(req.alignment),
      source: typeof req.dates_file === "string" && req.dates_file.length ? req.dates_file : null,
      sourceName: datesName,
      sourceKind: toolOptions.date_source_kind || "auto",
      timeUnits: toolOptions.time_units ?? null,
      strainCol: toolOptions.strain_col ?? null,
      dateCol: toolOptions.date_col ?? null,
      delimiter: toolOptions.delimiter ?? null,
      dateRegex: toolOptions.date_pattern ?? null,
      regexFlags: toolOptions.date_pattern_flags ?? "",
      archival1959: toolOptions.archival_1959 === true,
      headerFallback: toolOptions.header_fallback !== false
    });
    if (!ingest.ok) {
      const refuse = ingest.warnings.find((w) => w.severity === "refuse");
      throw timeRefusal({
        code: (refuse && refuse.code) || "DATES_NONE",
        message: (refuse && refuse.message) || "No sequence could be dated.",
        data: (refuse && refuse.data) || {}
      });
    }
    // The two questions the browser puts to a human and a tool call cannot ask. src/time.js,
    // decisions 1 and 2. The gate is applied HERE, before any graph is loaded and before the
    // pillar runs, and its overrides are recorded in provenance.
    const gate = dateGate(ingest, toolOptions);
    if (!gate.ok) {
      const first = gate.blocking[0];
      throw new EngineError("input", first.message, { code: first.code, hint: first.hint });
    }
    const dateReviewBlock = dateReview(ingest, { rows: false });

    let result;
    let baseProvenance;
    let loaded = null;
    let reference;
    const warnings = [];

    if (analysis === "dating") {
      const runDating = requireRuntime(rt, "runDating", "dating/run.js");
      let neural = null;
      let modelUnavailableReason = null;
      if (toolOptions.use_model === true) {
        // `use_model` is a REQUEST, never an availability accident: `resolveDistanceMode('auto',
        // hasModel)` answers `latent` with a model pass and `tn93` without, and the two are
        // different answers on the same data (measured upstream on korber: t_mrca 1938.77 against
        // 1926.81, twelve years apart, with the whole warning set changing). A build with no dating
        // graph throws DATING_GRAPH_UNAVAILABLE from `session()` rather than quietly answering with
        // the other estimator. src/time.js, decision 4.
        const runPass = requireRuntime(rt, "runDatingModelPass", "datingNeural.js");
        const handle = await sessionFor(mapped.variant, { taxaGraph: true });
        const taxaHandle = await handle.loadTaxaGraph();
        neural = await runPass({ alignmentText: req.alignment, session: taxaHandle, manifest: handle.manifest, progress, signal });
      } else {
        modelUnavailableReason = "use_model was not requested; this run is the model-free (root-to-tip over TN93 distances) estimate.";
      }
      const out = runDating(
        Object.assign({}, mapped.runtime, {
          alignmentText: req.alignment,
          alignmentName,
          dates: ingest,
          neural,
          modelUnavailableReason,
          timeUnits: ingest.time_units,
          progress,
          signal
        })
      );
      const refusal = refusalOf(out);
      if (refusal) throw timeRefusal(refusal);
      const honesty = datingHonesty(out, toolOptions, { alignment: alignmentName, dates: datesName }, ingest);
      reference = honesty.reference_command;
      result = rt.jsonSafe({
        analysis: "dating",
        ok: true,
        record: out.record,
        taxa_summary: out.rows,
        date_review: dateReviewBlock,
        honesty,
        warnings: out.warnings
      });
      baseProvenance = {
        is_surrogate: false,
        surrogate_for: null,
        model_variant: neural ? mapped.variant : null,
        artifact_sha256: null,
        seed: null,
        preprocessing: {
          // D34: this pillar takes no tree on any surface, and `runDating` never calls
          // `prepareRun`, so there is no LoadedAlignment to reconcile against. Recorded rather than
          // inferred, so `stampTreeSource`'s reconciliation is never asked a question it cannot
          // answer from a load that did not happen.
          tree_source: "tn93",
          tree_free: { reason: "pillar-is-tree-free", taxa_order: null },
          tree_provided: treeGiven,
          taxa_in_alignment: out.record.taxa_count,
          taxa_used: Array.isArray(out.rows) ? out.rows.length : null,
          branch_lengths_estimated: false,
          tn93_saturated_pairs: null,
          date_source: ingest.source,
          date_units: ingest.time_units,
          date_coverage: ingest.coverage,
          date_gate: gate
        },
        warnings: out.warnings
      };
      if (treeGiven) {
        warnings.push({
          code: "OPTION_NOT_APPLIED",
          severity: "warn",
          message:
            "A tree was supplied and the clock pillar does not take one: PLAN-TEMPORAL D34 declines the reference's " +
            "`--distance-mode tree`, so this run used " + (out.distanceMode || "tn93") + " distances as it would have without it.",
          data: { option: "tree" }
        });
      }
    } else {
      const runTemporal = requireRuntime(rt, "runTemporal", "temporal/run.js");
      const prepareRun = requireRuntime(rt, "prepareRun", "pipeline.js");
      const provenanceBlock = requireRuntime(rt, "provenanceBlock", "pipeline.js");
      const handle = await sessionFor(mapped.variant, {});
      const prep = await prepareRun({
        alignmentText: req.alignment,
        treeText: treeGiven ? req.tree : null,
        options: mapped.runtime,
        progress,
        signal,
        defaultMaxSpecies: Infinity
      });
      loaded = prep.loaded;
      const out = await runTemporal({
        loaded: prep.loaded,
        dates: ingest,
        session: handle.backbone,
        options: mapped.runtime,
        // ONLY these three keys exist and a typo is fatal upstream (assertInputNames). `dates` is
        // the sole source of `-d` on the reproduction line, which is why the tool carries the
        // metadata file's NAME as an option even though its text is an input.
        inputs: { alignment: alignmentName, tree: treeName, dates: datesName },
        provenance: { surface },
        progress,
        onProgress,
        signal
      });
      const refusal = refusalOf(out);
      if (refusal) throw timeRefusal(refusal);
      const record = rt.jsonSafe(out);
      const honesty = temporalHonesty(record, rt);
      reference = honesty.reference_command;
      result = { analysis: "temporal", ok: true, record, date_review: dateReviewBlock, honesty };
      const diagnosed =
        typeof rt.diagnoseWarnings === "function"
          ? rt.diagnoseWarnings({ alignmentText: req.alignment, treeArg: prep.treeArg, loaded: prep.loaded, speciesCap: prep.speciesCap, runtimeWarnings: prep.warnings, enabled: true })
          : prep.warnings;
      baseProvenance = provenanceBlock({
        surface,
        session: handle.backbone,
        surrogateFor: "no HyPhy counterpart (per-site selection trajectories through calendar time)",
        seed: record.primaeon ? record.primaeon.seed : null,
        elapsedSec: (Date.now() - t0) / 1000,
        options: mapped.runtime,
        preprocessing: prep.preprocessing,
        warnings: diagnosed,
        inputs: { alignment: alignmentName, tree: treeName, dates: datesName }
      });
      baseProvenance.preprocessing = Object.assign({}, baseProvenance.preprocessing, {
        date_source: ingest.source,
        date_units: ingest.time_units,
        date_coverage: ingest.coverage,
        date_gate: gate
      });
      baseProvenance.permutations = record.permutations;
      baseProvenance.temporal_stage = record.stage;
      baseProvenance.null_state = honesty.null_state;
    }

    const provenance = Object.assign({}, rt.jsonSafe(baseProvenance || {}), {
      surface,
      engine: "in-process",
      hyphaeon_mcp_version: PKG.version,
      hyphaeon_runtime_version: rt.version,
      threads,
      mds_sign: MDS_SIGN,
      // AN OBJECT, NOT AN ARGV ARRAY, and deliberately so: see src/time.js decision 5 and
      // `referenceCommand`'s own guard. `reproduces` is false on every temporal run whose null drew
      // at all (a different generator, D17) and on every dating run whose dates came from headers
      // (a wider parser than the reference's), and `caveats` names which.
      reference_command: reference,
      elapsed_sec: (Date.now() - t0) / 1000,
      options: Object.assign({}, options)
    });
    if (analysis === "temporal") stampTreeSource(provenance, loaded, { treeGiven, alignmentText: req.alignment });
    provenance.warnings = Array.isArray(provenance.warnings) ? [...provenance.warnings] : [];
    for (const key of mapped.notApplied) {
      provenance.warnings.push({
        code: "OPTION_NOT_APPLIED",
        severity: "warn",
        message: "Option `" + key + "` was recorded but not applied: the in-process runtime does not implement it (see the tool's description).",
        data: { option: key, value: options[key] }
      });
    }
    provenance.warnings.push(...warnings);
    return { result, provenance };
  }

  /**
   * Run one native pillar.
   *
   * @param {object} req
   * @param {"meme"|"busted"|"epistasis"|"dms"|"phenotype"|"evaluate"|"dating"|"temporal"} req.analysis
   * @param {string} [req.alignment]
   * @param {string} [req.tree]
   * @param {string} [req.dates_file]    date metadata TEXT (Auspice JSON, JSON map or CSV/TSV) for the time pillars
   * @param {string} [req.prediction]
   * @param {string} [req.meme_result]
   * @param {object} [req.options]         the tool's options (CLI names)
   * @param {{alignment?: string, tree?: string, prediction?: string, meme_result?: string}} [req.names]
   * @param {AbortSignal} [req.signal]
   * @param {string} [req.surface]         'mcp-stdio' | 'mcp-http'
   * @param {(phase: string, done: number, total: number, message: string) => void} [req.progress]
   * @returns {Promise<{result: object, provenance: object}>}
   */
  async function run(req) {
    const { analysis, options = {}, surface = "mcp-stdio", progress } = req;
    if (!NATIVE_ANALYSES.includes(analysis) || analysis === "analyze" || analysis === "dates") {
      throw new EngineError("input", "Analysis '" + analysis + "' is not served by engine.run.", {
        hint:
          analysis === "analyze"
            ? "Use engine.analyze."
            : analysis === "dates"
              ? // The date layer runs no model and must not pay for one: hyphaeon_dates goes
                // straight to src/time.js's `ingestFor` over the runtime's `./dates` subpath and
                // never reaches this engine, so a checkout with no models/ still serves it.
                "hyphaeon_dates runs the date layer directly (src/time.js), with no engine and no graph."
              : "Known analyses: " + NATIVE_ANALYSES.filter((a) => a !== "analyze" && a !== "dates").join(", ") + "."
      });
    }
    const t0 = Date.now();
    const names = Object.assign({}, req.names || {});
    const rt = await runtime();
    const guard = timeoutSignal(timeoutMs, req.signal);
    try {
      if (analysis === "evaluate") {
        if (typeof req.prediction !== "string" || typeof req.meme_result !== "string") {
          throw new EngineError("input", "evaluate needs both `prediction` (hyphaeon meme CSV) and `meme_result` (HyPhy MEME JSON).");
        }
        const stem = safeStem(options.gene || "gene");
        const predictionName = stem + ".csv";
        const memeName = stem + ".MEME.json";
        const out = rt.runEvaluate({
          predictionCsv: { name: predictionName, text: req.prediction },
          memeJson: { name: memeName, text: req.meme_result },
          options: { allowSiteMismatch: Boolean(options.allow_site_mismatch), variableOnly: Boolean(options.variable_only) },
          surface
        });
        const provenance = Object.assign({}, out.provenance, {
          surface,
          engine: "in-process",
          hyphaeon_mcp_version: PKG.version,
          hyphaeon_runtime_version: rt.version,
          reference_command: referenceCommand("evaluate", options, { prediction: predictionName, meme_result: memeName }),
          is_surrogate: false,
          surrogate_for: null,
          model_variant: null,
          elapsed_sec: (Date.now() - t0) / 1000,
          options: Object.assign({}, options)
        });
        return { result: out.result, provenance };
      }

      if (typeof req.alignment !== "string" || !req.alignment.trim()) {
        throw new EngineError("input", "An alignment is required.");
      }
      checkMdsSign(options, analysis);
      const alignmentName = names.alignment || "alignment.fasta";
      const treeGiven = typeof req.tree === "string" && req.tree.trim().length > 0;
      const treeName = treeGiven ? names.tree || "tree.nwk" : null;
      // The phenotype table arrives as an INPUT (its text), not an option, so that neither the
      // job store nor `provenance.options` ends up holding a copy of the caller's CSV; the
      // mapper needs it beside the flags, and only there.
      let toolOptions = options;
      if (analysis === "phenotype" && typeof req.phenotype_file === "string" && req.phenotype_file.trim()) {
        names.phenotype_file = names.phenotype_file || options.phenotype_file_name || "phenotype.csv";
        toolOptions = Object.assign({}, options, { phenotype_file: req.phenotype_file, phenotype_file_name: names.phenotype_file });
      }
      // Same rule for the date layer's metadata document (the phenotype_file precedent, and the
      // reason it is a precedent): a caller's Auspice JSON can be megabytes, and an option is
      // copied into the job store and into `provenance.options`. Only its NAME is an option — and
      // the name is load-bearing rather than decoration, because it is the only source of `-d` on
      // the reproduction line.
      if (typeof req.dates_file === "string" && req.dates_file.trim()) {
        names.dates_file = names.dates_file || options.dates_file_name || "metadata.csv";
      }
      const mapped = mapOptions(analysis, toolOptions, {
        defaultVariant: env.HYPHAEON_VARIANT,
        alignmentName,
        treeName
      });
      // BEFORE ANY GRAPH IS LOADED. `hyphaeon_dating` is model-free by default and the whole point
      // of that default is that it costs no model byte: the runtime's `./dating` subtree imports no
      // manifest, no session and no predict.js (measured: 93 ms of import, zero onnxruntime modules
      // loaded). A dispatch placed after `session()` would have loaded a 7 MB graph to run an 85 ms
      // regression, which is a different tool from the one advertised.
      if (analysis === "dating" || analysis === "temporal") {
        return await runTimePillar({
          analysis,
          rt,
          req,
          options,
          toolOptions,
          mapped,
          names: Object.assign({}, names, { alignment: alignmentName, tree: treeName }),
          treeGiven,
          surface,
          progress,
          onProgress: req.onProgress,
          signal: guard.signal,
          session,
          t0
        });
      }
      const handle = await session(mapped.variant, { bustedHead: analysis === "busted" });
      const common = {
        alignmentText: req.alignment,
        treeText: treeGiven ? req.tree : null,
        options: mapped.runtime,
        session: handle.backbone,
        progress,
        surface,
        signal: guard.signal
      };
      let result;
      let baseProvenance;
      let loaded = null;
      const warnings = [];

      if (analysis === "meme") {
        const out = await rt.runMeme(common);
        // cli.py:298-311 through the runtime's serialiser; the site rows keep the Python keys
        // first and carry the app's DM3-derived columns (zScore, percentile, call) after them.
        result = rt.jsonSafe(rt.memeDocument(out, { alignment: alignmentName, tree: treeName, provenance: false }));
        result.sites = rt.jsonSafe(out.sites);
        result.summary = rt.jsonSafe(out.summary);
        baseProvenance = out.provenance;
        loaded = out.loaded || null;
      } else if (analysis === "busted") {
        const out = await rt.runBusted(Object.assign(common, { head: handle.head || null }));
        loaded = out.loaded || null;
        result = rt.bustedDocument(out, { alignment: alignmentName, gene: options.gene || out.record.gene || alignmentName.replace(/\.[^.]*$/, ""), provenance: false });
        result.sites_detail = rt.jsonSafe(out.sites);
        result.statistics = rt.jsonSafe(out.statistics);
        result.summary = rt.jsonSafe(out.summary);
        baseProvenance = out.provenance;
        if (handle.headError) {
          warnings.push({
            code: "BUSTED_HEAD_UNAVAILABLE",
            severity: "warn",
            message: "The neural BUSTED head could not be loaded; the statistical fields are complete, the neural fields are null: " + handle.headError,
            data: {}
          });
        }
      } else {
        // epistasis | dms | phenotype: the front half is prepareRun (parse, tree or TN93, MDS,
        // tokens), then the pillar over the loaded alignment and the session —
        // run_epistatic_analysis / run_digital_dms_analysis / run_phenotype_association steps 2-5.
        const prepareRun = requireRuntime(rt, "prepareRun", "pipeline.js");
        const provenanceBlock = requireRuntime(rt, "provenanceBlock", "pipeline.js");
        const prep = await prepareRun({
          alignmentText: req.alignment,
          treeText: common.treeText,
          options: mapped.runtime,
          progress,
          signal: guard.signal,
          defaultMaxSpecies: Infinity
        });
        loaded = prep.loaded;
        const inputs = { alignment: alignmentName, tree: treeName ?? (prep.treeArg === null ? "embedded_in_alignment" : null) };
        let out;
        if (analysis === "phenotype") {
          const runPhenotype = requireRuntime(rt, "runPhenotype", "phenotype.js");
          out = await runPhenotype({
            prepared: prep,
            loaded: prep.loaded,
            session: handle.backbone,
            // The trait is its own argument (the shape `resolvePhenotypeVector` takes); the rest
            // of `mapped.runtime` is what `resolvePhenotypeOptions` reads. The permulation tree
            // comes from `prepared` and is null in tree-free mode, where the library records a
            // reason instead of raising (D22).
            phenotype: mapped.runtime.phenotype,
            options: mapped.runtime,
            inputs: { alignment: alignmentName, tree: treeName },
            progress,
            signal: guard.signal
          });
          result = rt.jsonSafe(out);
        } else if (analysis === "epistasis") {
          const runEpistasis = requireRuntime(rt, "runEpistasis", "epistasis.js");
          out = await runEpistasis({
            loaded: prep.loaded,
            session: handle.backbone,
            options: mapped.runtime,
            inputs: { alignment: alignmentName, tree: treeName },
            progress,
            signal: guard.signal
          });
          result = rt.jsonSafe(out);
        } else {
          const runDms = requireRuntime(rt, "runDms", "dms.js");
          if (mapped.runtime.siteSubset) {
            const bad = mapped.runtime.siteSubset.filter((s) => !Number.isInteger(s) || s < 0 || s >= prep.loaded.L);
            if (bad.length) {
              throw new EngineError("input", "sites: " + bad.length + " site(s) out of range 1.." + prep.loaded.L + " (" + bad.slice(0, 5).map((s) => s + 1).join(", ") + (bad.length > 5 ? ", ..." : "") + ").", {
                hint: "Codon sites are 1-indexed and at most codon_count (" + prep.loaded.L + ")."
              });
            }
          }
          out = await runDms({
            loaded: prep.loaded,
            session: handle.backbone,
            // The MCP already sized this run on the file as submitted (src/caps.js, 19 x L x N^2
            // against the same 2.5e9); the runtime's own budget is lifted so an admitted run is
            // never refused twice on N_used instead of N.
            options: Object.assign({}, mapped.runtime, { workBudget: Infinity }),
            inputs: { alignment: alignmentName, tree: treeName },
            progress,
            signal: guard.signal
          });
          result = rt.jsonSafe(out);
        }
        const diagnosed =
          typeof rt.diagnoseWarnings === "function"
            ? rt.diagnoseWarnings({ alignmentText: req.alignment, treeArg: prep.treeArg, loaded: prep.loaded, speciesCap: prep.speciesCap, runtimeWarnings: prep.warnings, enabled: true })
            : prep.warnings;
        baseProvenance = provenanceBlock({
          surface,
          session: handle.backbone,
          surrogateFor: analysis === "phenotype" ? "no HyPhy counterpart (attention-based trait association)" : "MEME",
          seed: analysis === "meme" ? null : (out.permutations && out.permutations.seed) ?? mapped.runtime.seed ?? null,
          elapsedSec: (Date.now() - t0) / 1000,
          options: mapped.runtime,
          preprocessing: prep.preprocessing,
          warnings: diagnosed,
          inputs
        });
        if (out.permutations) baseProvenance.permutations = out.permutations;
        if (analysis === "dms") {
          baseProvenance.focal_index = out.focal_index;
          baseProvenance.focal_name = out.focal_name;
          if (out.progress) baseProvenance.dms_progress = out.progress;
        }
        if (analysis === "phenotype") {
          baseProvenance.phenotype_meta = out.phenotype_meta ?? null;
          baseProvenance.trait = out.trait ?? null;
          if (out.permulations) baseProvenance.permulations = out.permulations;
          if (out.sector_permutations) baseProvenance.permutations = out.sector_permutations;
        }
      }

      // D22: if `use_tn93` was asked for, the load must actually have taken the tree-free path —
      // a runtime that dropped the option would silently score against a tree instead.
      if (mapped.runtime.useTn93 && loaded && loaded.notices && !loaded.notices.treeFree) {
        throw new EngineError("server", "use_tn93 was requested but the load kept a tree; this runtime does not forward the option to the library.", {
          hint: "The @veg/hyphaeon-runtime workspace is older than this MCP; update the checkout.",
          code: "RUNTIME_OUTDATED"
        });
      }

      const provenance = mcpProvenance(rt, baseProvenance, {
        surface,
        analysis,
        options,
        names: { alignment: alignmentName, tree: treeName, phenotype_file: names.phenotype_file },
        t0,
        reference: referenceCommand(analysis, cliOptionsFor(options, loaded), { alignment: alignmentName, tree: treeName, phenotype_file: names.phenotype_file })
      });
      stampTreeSource(provenance, loaded, { treeGiven, alignmentText: req.alignment });
      provenance.warnings = Array.isArray(provenance.warnings) ? [...provenance.warnings] : [];
      for (const key of mapped.notApplied) {
        provenance.warnings.push({
          code: "OPTION_NOT_APPLIED",
          severity: "warn",
          message: "Option `" + key + "` was recorded but not applied: the in-process runtime fixes it at the CLI default.",
          data: { option: key, value: options[key] }
        });
      }
      provenance.warnings.push(...warnings);
      return { result, provenance };
    } catch (err) {
      throw classifyEngineError(err);
    } finally {
      guard.clear();
    }
  }

  /**
   * Run the whole report (hyphaeon_analyze): the runtime's `runEverything` over one session, with
   * sections relayed as they land.
   *
   * @param {object} req
   * @param {string} req.alignment
   * @param {string} [req.tree]
   * @param {object} [req.options]  app-side: variant, max_species, reference_sequence, call_mode,
   *   seed, permutations, dms (bool), dms_work_budget, use_tn93, phenotype (the trait block)
   * @param {string} [req.phenotype_file]  CSV/TSV TEXT for the phenotype section, when asked for
   * @param {{alignment?: string, tree?: string, phenotype_file?: string}} [req.names]
   * @param {AbortSignal} [req.signal]
   * @param {string} [req.surface]
   * @param {Function} [req.progress]
   * @param {(name: string, payload: object, meta: {final: boolean}) => void} [req.onSection]
   * @param {string} [req.id]  the job id, stamped as the report's id so one handle names it everywhere
   * @returns {Promise<object>} the ReportRecord (JSON-safe) with the MCP's provenance fields added
   */
  async function analyze(req) {
    const { options = {}, surface = "mcp-stdio", progress, onSection } = req;
    const t0 = Date.now();
    const names = Object.assign({}, req.names || {});
    const rt = await runtime();
    const guard = timeoutSignal(timeoutMs, req.signal);
    try {
      const runEverything = requireRuntime(rt, "runEverything", "analyze.js");
      if (typeof req.alignment !== "string" || !req.alignment.trim()) throw new EngineError("input", "An alignment is required.");
      checkMdsSign(options, "analyze");
      const alignmentName = names.alignment || "alignment.fasta";
      const treeGiven = typeof req.tree === "string" && req.tree.trim().length > 0;
      const treeText = treeGiven ? req.tree : null;
      const treeName = treeText ? names.tree || "tree.nwk" : null;
      const useTn93 = options.use_tn93 === true || options.no_tree === true;

      // D22: no tree, no usable branch lengths, or use_tn93 -> the library's tree-free TN93 path
      // inside loadAlignmentAndTree. There is nothing to build and nothing to estimate here.

      // The variant: the caller's, else the operator's default, else the tree regime (PLAN.md 4.0).
      let variant = options.variant || env.HYPHAEON_VARIANT || null;
      const variantSource = options.variant ? "caller" : env.HYPHAEON_VARIANT ? "HYPHAEON_VARIANT" : "diagnostics";
      if (!variant) {
        let warnings = [];
        try {
          warnings = libraryDiagnose({ alignmentText: req.alignment, treeText, useTn93 }).warnings;
        } catch {
          warnings = [];
        }
        variant = variantFromDiagnostics(warnings);
      }
      const handle = await session(variant, { bustedHead: true });

      // The trait, when the caller gave one (PLAN.md 4.0 row 8: phenotype "cannot run unasked").
      // The report's own `seed` and `permutations` are the section's defaults, so one "Re-run
      // with..." setting does not mean two different nulls in one report.
      const traitOptions = phenotypeOptionsFor(options.phenotype, req.phenotype_file, names);
      if (traitOptions) {
        if (traitOptions.seed === undefined && options.seed !== undefined) traitOptions.seed = options.seed;
        if (traitOptions.n_permutations === undefined && options.permutations !== undefined) traitOptions.n_permutations = options.permutations;
      }
      const phenotypeMapped = traitOptions ? mapOptions("phenotype", traitOptions, { defaultVariant: variant }) : null;

      const runtimeOptions = {
        variant,
        maxSpecies: options.max_species ?? undefined,
        referenceSequence: options.reference_sequence ?? undefined,
        callMode: options.call_mode ?? undefined,
        seed: options.seed ?? undefined,
        permutations: options.permutations ?? undefined,
        dms: { enabled: options.dms !== false, workBudget: options.dms_work_budget ?? undefined },
        useTn93: useTn93 || undefined
      };
      for (const k of Object.keys(runtimeOptions)) if (runtimeOptions[k] === undefined) delete runtimeOptions[k];
      if (runtimeOptions.dms.workBudget === undefined) delete runtimeOptions.dms.workBudget;

      const report = await runEverything({
        alignmentText: req.alignment,
        treeText,
        inputs: { alignmentName, treeName },
        options: runtimeOptions,
        session: handle.backbone,
        head: handle.head || null,
        surface,
        signal: guard.signal,
        progress,
        onSection: (name, payload, meta) => {
          if (typeof onSection !== "function") return;
          try {
            onSection(name, sectionForRelay(rt, name, payload), meta || { final: true });
          } catch {
            // section relays are advisory, like progress
          }
        }
      });

      // ── 8. phenotype, when the caller answered the report's offer ──────────────────────────
      // `runEverything` leaves `sections.phenotype` null by design (PLAN.md 4.0 row 8). Filling
      // it needs no second forward pass: the meme pass the report already ran holds the two
      // things `compute_transformer_attributions` wants, `mean_root_attns` and the site LRTs, and
      // that is exactly what the epistasis section consumed. The runtime's `runPhenotype` takes
      // them as `attention` + `lrt` (runtime/src/phenotype.js), so the section costs graph maths
      // and no inference. Without the attention (a report run with `epistasis: false`) the same
      // call falls back to the reference's own all-sites loop through the session, which is a
      // real second pass and is recorded as one.
      let phenotypeSource = null;
      if (phenotypeMapped) {
        const filled = await runPhenotypeSection(rt, report, {
          trait: phenotypeMapped.runtime.phenotype,
          options: phenotypeMapped.runtime,
          session: handle.backbone,
          inputs: { alignment: alignmentName, tree: treeName },
          progress,
          signal: guard.signal
        });
        phenotypeSource = filled.source;
        report.sections.phenotype = filled.section;
        if (typeof onSection === "function") {
          try {
            onSection("phenotype", sectionForRelay(rt, "phenotype", report.sections.phenotype), { final: true });
          } catch {
            // section relays are advisory, like progress
          }
        }
      }

      const record = typeof rt.toReportRecord === "function" ? rt.toReportRecord(report, { includeArrays: false }) : rt.jsonSafe(report);
      if (req.id) record.id = req.id;

      record.provenance = Object.assign({}, record.provenance || {}, {
        surface,
        engine: "in-process",
        hyphaeon_mcp_version: PKG.version,
        hyphaeon_runtime_version: rt.version,
        threads,
        mds_sign: MDS_SIGN,
        variant_source: variantSource,
        reference_commands: referenceCommandsForReport(
          Object.assign({}, runtimeOptions, {
            variant,
            phenotypeCli: traitOptions || undefined,
            // The reference cannot reproduce a tree-free run without the flag; see referenceCommand.
            useTn93: record.provenance && record.provenance.preprocessing && record.provenance.preprocessing.tree_source === "tn93"
          }),
          { alignment: alignmentName, tree: treeName, phenotype_file: names.phenotype_file }
        ),
        elapsed_sec: (Date.now() - t0) / 1000,
        options: Object.assign({}, options, req.phenotype_file ? { phenotype_file: "<" + (names.phenotype_file || "phenotype.csv") + ">" } : {})
      });
      if (phenotypeSource) record.provenance.phenotype_source = phenotypeSource;
      stampTreeSource(record.provenance, (report.sections && report.sections.sites && report.sections.sites.loaded) || null, {
        treeGiven,
        alignmentText: req.alignment
      });
      record.provenance.warnings = Array.isArray(record.provenance.warnings) ? [...record.provenance.warnings] : [];
      if (handle.headError) {
        record.provenance.warnings.push({
          code: "BUSTED_HEAD_UNAVAILABLE",
          severity: "warn",
          message: "The neural BUSTED head could not be loaded; the gene section's statistical fields are complete, its neural fields are null: " + handle.headError,
          data: {}
        });
      }
      return record;
    } catch (err) {
      throw classifyEngineError(err);
    } finally {
      guard.clear();
    }
  }

  /**
   * Forget this engine's session handles and release every ONNX session the runtime memoises.
   * onnxruntime-node 1.23.2 aborts the process at exit ("mutex lock failed: Invalid argument",
   * SIGABRT) when a session is still alive on its thread pool — measured in Phase 1b on this MCP
   * over stdio at 1 and 4 threads — so shutdown must release the sessions and then let the event
   * loop drain (`process.exitCode`, never a bare `process.exit()`). The release goes through the
   * runtime's `releaseSessions` (session-node.js) rather than the handles here, because the
   * runtime memoises verified sessions module-wide: releasing a handle without dropping it from
   * that memo hands the next engine a disposed session.
   */
  async function close() {
    sessions.clear();
    try {
      const node = await import("@veg/hyphaeon-runtime/node");
      if (typeof node.releaseSessions === "function") await node.releaseSessions();
    } catch (err) {
      logger.warn("engine: session release failed: " + ((err && err.message) || err));
    }
  }

  /**
   * The resolved runtime function bag. Exposed so `get_results section=` can page a stored
   * TemporalRecord with the runtime's OWN `siteRow`, `candidateSiteIndices`,
   * `temporalReferenceCommand` and `temporalDownloadNotes` rather than a second implementation in
   * the tool layer: a record is paged long after the run that produced it, and two builders of the
   * same reproduction line are exactly the disagreement src/time.js decision 5 avoids.
   */
  const runtimeBag = () => runtime();

  return { run, analyze, status, session, models, threads, close, runtimeBag };
}

/**
 * The report's `phenotype` block as the per-pillar tool's options, or null when the caller asked
 * for no trait. Accepts the same keys `hyphaeon_phenotype` takes (PLAN.md 4.0 row 8's "presets,
 * a foreground list/regex, or a CSV"); an empty block is no trait at all, as Python truthiness
 * makes it upstream (phenotype.py:239, 274).
 *
 * @param {object|undefined} block
 * @param {string|undefined} phenotypeFileText
 * @param {{phenotype_file?: string}} names  mutated with the table's basename when there is one
 * @returns {object|null}
 */
function phenotypeOptionsFor(block, phenotypeFileText, names) {
  const b = block && typeof block === "object" ? block : {};
  const hasText = typeof phenotypeFileText === "string" && phenotypeFileText.trim().length > 0;
  const hasTrait = Boolean(b.preset || b.foreground || hasText);
  if (!hasTrait) return null;
  const out = {};
  for (const k of ["preset", "foreground", "background", "trait_col", "species_col", "continuous", "permulations", "n_permutations", "alpha", "min_taxa", "max_perm_p", "seed"]) {
    if (b[k] !== undefined && b[k] !== null) out[k] = b[k];
  }
  if (hasText) {
    names.phenotype_file = names.phenotype_file || b.phenotype_file_name || "phenotype.csv";
    out.phenotype_file = phenotypeFileText;
    out.phenotype_file_name = names.phenotype_file;
  }
  return out;
}

function safeStem(s) {
  const clean = String(s).replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 64);
  return clean || "gene";
}

/**
 * A section payload as the job store keeps it while the report runs: JSON-safe and without the
 * sites section's [L, N] attention, [L, 384] representation, typed-array block and attribution
 * Map (the site records carry the numbers; `toReportRecord` drops the same four at the end).
 */
function sectionForRelay(rt, name, payload) {
  if (name === "sites" && payload && typeof payload === "object") {
    const copy = Object.assign({}, payload);
    delete copy.attention;
    delete copy.root_repr;
    delete copy.arrays;
    delete copy.attributionRecords;
    return rt.jsonSafe(copy);
  }
  return rt.jsonSafe(payload);
}
