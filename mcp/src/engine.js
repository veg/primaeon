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

const PKG = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const require = createRequire(import.meta.url);

export { NATIVE_ANALYSES };

/** MDS_SIGN.md: the one convention the library computes. */
export const MDS_SIGN = "canonical";

/** cli.py `--max-species` defaults per subcommand: None (no cap) except busted's 512. */
const MAX_SPECIES_DEFAULT = Object.freeze({ meme: Infinity, busted: undefined, epistasis: Infinity, dms: Infinity, phenotype: Infinity });

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
  // phenotype.py's own refusals (phenotype.py:274, 231-236, :404-406) through the library.
  // runtime/src/pipeline.js prepareRun: the tn93 package raised on a saturated or non-overlapping
  // pair (PHASE3A.md quirks); that is the alignment's property, not the engine's.
  /TN93 distances could not be computed/i,
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
  /cancelled/i
];

/** Turn any failure inside a native run into an EngineError with a class. */
export function classifyEngineError(err) {
  if (err instanceof EngineError) return err;
  const message = (err && err.message) || String(err);
  const name = err && err.name;
  if (name === "AbortError" || /cancelled/i.test(message)) {
    return new EngineError("input", "The run was cancelled.", { cause: err });
  }
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
        runPhenotype: typeof rt.runPhenotype === "function"
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
   * Run one native pillar.
   *
   * @param {object} req
   * @param {"meme"|"busted"|"epistasis"|"dms"|"evaluate"} req.analysis
   * @param {string} [req.alignment]
   * @param {string} [req.tree]
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
    if (!NATIVE_ANALYSES.includes(analysis) || analysis === "analyze") {
      throw new EngineError("input", "Analysis '" + analysis + "' is not served by engine.run.", {
        hint: analysis === "analyze" ? "Use engine.analyze." : "Known analyses: " + NATIVE_ANALYSES.filter((a) => a !== "analyze").join(", ") + "."
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
      const mapped = mapOptions(analysis, toolOptions, {
        defaultVariant: env.HYPHAEON_VARIANT,
        alignmentName,
        treeName
      });
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

  return { run, analyze, status, session, models, threads, close };
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
