/**
 * engine.js — the in-process HyphAeon engine behind hyphaeon_analyze, hyphaeon_meme,
 * hyphaeon_busted, hyphaeon_epistasis, hyphaeon_dms and hyphaeon_evaluate: runtime/ over
 * onnxruntime-node, no Python.
 *
 * WHY THIS FILE EXISTS
 *
 * PLAN.md 3.6, "Bridge, then port": once a pillar's JavaScript port lands, its tool stops
 * shelling to `hyphaeon <cmd>` and runs `runtime/` in this process, and `provenance.surface`
 * becomes "mcp-stdio" / "mcp-http". Phase 1a ported site selection, the omnibus statistics and
 * the evaluation (veg/HyphAeon js/ at tag phase-1a); Phase 1b's runtime wraps them as
 * `runMeme` (runtime/src/pipeline.js), `runBusted` (runtime/src/busted.js) and `runEvaluate`
 * (runtime/src/evaluate.js) over a session `createSession` (runtime/src/createSession.js) loads
 * from the manifest, and serialises them with runtime/src/results.js. Phase 2a ported the
 * epistasis pillar (js/src/epistasis.js, sectors.js, dms.js at tag phase-2a; PHASE2A.md) and the
 * runtime wraps it as `runEpistasis` (runtime/src/epistasis.js) and `runDms` (runtime/src/dms.js)
 * over a `prepareRun()` load, and orchestrates the whole PLAN.md 4.0 report as `runEverything`
 * (runtime/src/analyze.js, the contract every surface codes against). This module is the MCP's
 * side of all that: it resolves the models directory (src/models.js), loads and memoises one
 * session per variant, maps the tool's CLI-shaped options onto the runtime's, hands the runtime a
 * branch-length estimator built on its HyPhy WASM driver, turns the runtime's result into the
 * document `hyphaeon <cmd> -o` writes (Appendix B of PLAN.md; cli.py:298-311 for meme, :486-505
 * for busted, epistasis.py:717-731 for epistasis, :759-768 for dms, evaluation.py's report for
 * evaluate) with a PLAN.md 3.5 provenance block, and classifies failures into the two classes
 * src/bridge.js established (input | server). The ONE bridged pillar left (phenotype) stays on
 * src/bridge.js until Phase 3.
 *
 * OPTIONS MIRROR THE CLI ONE TO ONE (hyphaeon/cli.py at phase-2a; evaluation.py
 * configure_parser), with these documented seams:
 *   - `max_species` unset means NO cap for meme, epistasis and dms (cli.py `--max-species`
 *     default None; the epistasis and dms parsers have no such flag and their handlers call
 *     `load_alignment_and_tree` without one) and 512 for busted; the runtime spells "no cap" as
 *     `Infinity`.
 *   - `cpu` is accepted and recorded; onnxruntime-node here is CPU-only.
 *   - `use_tn93` / `no_tree` (dataset.py:544-580, TN93 pairwise distances in place of a tree)
 *     need the tn93 binary or package, which neither the library nor the runtime provides;
 *     refused as an input error with a hint. (The runtime's NJ-on-TN93 tree is a different
 *     thing — PLAN.md D5's "no tree -> NJ" — and is not offered under the CLI's flag.)
 *   - `min_patch_consec` is recorded but not forwarded: runMeme fixes the cmd_meme copy of the
 *     OCI screen at its default (3); a non-default value raises a provenance warning
 *     (OPTION_NOT_APPLIED) rather than silently doing something else.
 *   - `mds_sign` (phase-2a `--mds-sign {canonical,lapack}`): the library computes CANONICAL
 *     eigenvector signs only (MDS_SIGN.md; PHASE2A.md gap 9 — `loadAlignmentAndTree` has no
 *     `mdsSign` option), which is also the reference's default. `lapack` would reproduce
 *     pre-convention numbers and is refused as an input error; every native result records
 *     `provenance.mds_sign: "canonical"` as MDS_SIGN.md recommends.
 *   - `seed` (phase-2a `--seed`, epistasis) feeds the sector permutation null. The reference draws
 *     with PCG64 and the library with xoshiro256**, so the same seed gives a DIFFERENT sequence of
 *     K-subsets and `p_perm` agrees statistically, never bit for bit (PLAN.md 5.4).
 *   - `sites` on hyphaeon_dms is APP-SIDE (the CLI sweeps every site): 1-indexed codon sites to
 *     sweep, so a caller can pay for the sites it cares about; `total_mutations` stays 19 x L as
 *     `run_digital_dms_analysis` computes it, and `progress` says how many were swept.
 *
 * BRANCH LENGTHS. dataset.py:601-611 shells out to `hyphy` when a tree has no usable branch
 * lengths: the parsed sequences are written as FASTA, the tree is pruned to those taxa and its
 * lengths stripped (`re.sub(r':[0-9.eE-]+', '', ...)`), and HKY85 is optimised on the fixed
 * topology (dataset.py:224-287). The runtime carries the same HBL script (runtime/src/hyphy,
 * HyPhy 2.5.98 compiled to WebAssembly, run under Node) and `prepareRun` takes the call as
 * `options.estimateTree(alignmentText, treeText)`; `estimateTreeHook` below is that call, with
 * the library's parser for the FASTA and the reference's regex for the topology. What it does
 * NOT do is prune: the library has no Newick writer, and every bundled example's tips match its
 * alignment; a tree with extra tips makes HyPhy fail, which surfaces as an input-class error
 * naming HyPhy's message. Without the driver (assets absent) the runtime takes the reference's
 * "HyPhy not found" branch (1e-3 / 1e-4 defaults) and the provenance carries
 * BRANCH_LENGTHS_MISSING. HyPhy's optimisation blocks the event loop for its duration
 * (camelid, 212 taxa: ~2.8 s measured by the runtime); a stdio server serves one client.
 *
 * THE RUNTIME IS REACHED THROUGH ITS PACKAGE ENTRY, WITH A FILE-PATH FALLBACK. Each name is also
 * resolvable from `runtime/src/<file>.js` by absolute file URL — a file URL is not subject to
 * the package's exports map — so the MCP keeps working across the runtime's index catching up
 * with its modules (the HyPhy driver is not on the exports map at all) and prefers the public
 * name once it exists. The Phase 2 names (`runEpistasis`, `runDms`, `runEverything`, the report
 * writers) are OPTIONAL at load: an older runtime still serves meme/busted/evaluate, and the
 * tools that need the missing name answer with a server-class error saying which file to update.
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
 * PLAN.md 4.0's order, DMS last and budget-capped, phenotype null. The engine's job here is
 * small on purpose — pick the variant when the caller did not (from the diagnostics' tree
 * regime, the same rule the report page uses), load the session and head, pass the HyPhy hook,
 * relay sections and progress, and stamp the MCP's provenance on the finished record. The MCP
 * adds nothing to the arithmetic and the record is the runtime's `ReportRecord` as it stands.
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
import { parseAlignmentSequences, diagnose as libraryDiagnose, extractTree } from "@veg/hyphaeon-js";
import { resolveModels } from "./models.js";
import { JOB_TIMEOUT_MS, NATIVE_ANALYSES } from "./caps.js";

const PKG = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const require = createRequire(import.meta.url);

export { NATIVE_ANALYSES };

/** MDS_SIGN.md: the one convention the library computes. */
export const MDS_SIGN = "canonical";

/** cli.py `--max-species` defaults per subcommand: None (no cap) except busted's 512. */
const MAX_SPECIES_DEFAULT = Object.freeze({ meme: Infinity, busted: undefined, epistasis: Infinity, dms: Infinity });

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
 * Phase 1 names are required; Phase 2 names (`runEpistasis`, `runDms`, `runEverything`,
 * `prepareRun`, `diagnoseWarnings`, `provenanceBlock`, `toReportRecord`) resolve to null when
 * the runtime checkout predates them, and the tools that need them say so.
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
    let hyphy = null;
    try {
      hyphy = (await importRuntimeSubpath("@veg/hyphaeon-runtime/hyphy", "hyphy/index.js")) || null;
    } catch {
      hyphy = null;
    }
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
      hyphy,
      version
    };
  })();
  runtimePromise.catch(() => {
    runtimePromise = null;
  });
  return runtimePromise;
}

/** Are the HyPhy WASM assets the runtime's driver needs on disk? */
function hyphyAssetsPresent(hyphyMod) {
  if (!hyphyMod || typeof hyphyMod.createHyPhy !== "function") return false;
  const version = hyphyMod.HYPHY_WASM_VERSION;
  if (!version) return true; // the driver locates its own assets; let it decide
  const dir = path.join(runtimeDir(), "vendor", "hyphy", String(version));
  return (hyphyMod.HYPHY_ASSETS || ["hyphy.js", "hyphy.wasm", "hyphy.data"]).every((f) => existsSync(path.join(dir, f)));
}

// ── branch lengths (dataset.py:224-287) ─────────────────────────────────────

/** `re.sub(r'\{[^}]*\}', '', s)` then `re.sub(r'\[[^\]]*\]', '', s)`: HyPhy tags, NEXUS comments. */
function cleanNewick(s) {
  return s.replace(/\{[^}]*\}/g, "").replace(/\[[^\]]*\]/g, "");
}

/**
 * The Newick TEXT the reference would take from a tree file or an alignment with an embedded
 * tree (dataset.py:161-206: a `TREE name = (...)` command, else a line starting with '(' that
 * holds at least two '(', else the whole text). The library's `extractTree` returns a parsed
 * tree; HyPhy wants the string.
 */
export function newickTextFrom(text) {
  const s = String(text ?? "");
  const cmd = /tree\s+[^=]+=\s*(\([^;]+;)/i.exec(s);
  if (cmd) return cleanNewick(cmd[1]);
  for (const raw of s.split(/\r?\n/)) {
    let line = raw.trim();
    if (line.startsWith("(") && (line.match(/\(/g) || []).length >= 2) {
      if (!line.endsWith(";")) line += ";";
      return cleanNewick(line);
    }
  }
  let all = s.trim();
  if (all.startsWith("(") && (all.match(/\(/g) || []).length >= 2) {
    if (!all.endsWith(";")) all += ";";
    return cleanNewick(all);
  }
  return null;
}

/** dataset.py:245: `re.sub(r':[0-9.eE-]+', '', raw_tree_str)`. */
export function stripBranchLengths(newick) {
  return String(newick).replace(/:[0-9.eE-]+/g, "");
}

/** dataset.py:252-254: the parsed sequences written as FASTA, one record per taxon. */
export function fastaFromAlignment(alignmentText) {
  const seqs = parseAlignmentSequences(alignmentText);
  let out = "";
  for (const [name, seq] of seqs) out += ">" + name + "\n" + seq + "\n";
  return out;
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
 * @param {"meme"|"busted"|"epistasis"|"dms"} analysis
 * @param {object} options
 * @param {{defaultVariant?: string, alignmentName?: string, treeName?: string|null, estimateTree?: Function|null}} [extra]
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
  if (extra.alignmentName) out.alignmentName = extra.alignmentName;
  if (extra.treeName !== undefined) out.treeName = extra.treeName;
  if (typeof extra.estimateTree === "function") out.estimateTree = extra.estimateTree;
  if (extra.treeSource) out.treeSource = extra.treeSource;
  return { runtime: out, variant, notApplied };
}

/**
 * The `hyphaeon <cmd> ...` line that reproduces a native run through the Python reference
 * (the "reproduce this with the CLI" snippet of PLAN.md 3.6). `--mds-sign canonical` is spelled
 * out because it is what this surface computed; the CLI default is the same today.
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
  argv.push("--mds-sign", MDS_SIGN);
  argv.push("-o", "<out.json>");
  return argv;
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
  const epi = {};
  if (options.permutations !== undefined && options.permutations !== null) epi.n_permutations = options.permutations;
  if (options.seed !== undefined && options.seed !== null) epi.seed = options.seed;
  return {
    sites: referenceCommand("meme", Object.assign({ attribute: true, filter: true }, common), names),
    gene: referenceCommand("busted", common, names),
    epistasis: referenceCommand("epistasis", Object.assign({ no_dms: true }, epi), names),
    dms: referenceCommand("dms", {}, names)
  };
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

// ── error classification ────────────────────────────────────────────────────

const INPUT_PATTERNS = [
  /No sequence data available/i,
  /No sequences found/i,
  /Could not parse any sequences/i,
  /needs at least \d+ sequences/i,
  /needs a phylogenetic tree/i,
  /needs a tree with branch lengths/i,
  /No tree specified/i,
  /Could not parse phylogenetic tree/i,
  /No matching taxa/i,
  /shorter than one codon|shorter than/i,
  /Alignment too short/i,
  /input check failed/i,
  /Unknown callMode/i,
  /estimateTree returned no tree/i,
  /estimateBranchLengths:/i,
  /HyPhy could not fit/i,
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
  if (name === "EvaluationError" || name === "HyPhyError" || INPUT_PATTERNS.some((re) => re.test(message))) {
    return new EngineError("input", "HyphAeon could not process this input: " + message, {
      cause: err,
      hint:
        "Check that the alignment is an in-frame codon alignment (FASTA, NEXUS or PHYLIP), that the " +
        "sequence names match the tree tips exactly, and that a tree is supplied. Run hyphaeon_validate " +
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
  let hyphyPromise = null;

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

  /** The HyPhy WASM driver, instantiated once (assets fetched and compiled) on first use. */
  async function hyphy() {
    const rt = await runtime();
    if (!hyphyAssetsPresent(rt.hyphy)) return null;
    if (!hyphyPromise) {
      hyphyPromise = rt.hyphy.createHyPhy({ progress: (phase, done, total, message) => logger.debug("hyphy " + phase + ": " + message) });
      hyphyPromise.catch(() => {
        hyphyPromise = null;
      });
    }
    return hyphyPromise;
  }

  /**
   * `options.estimateTree` for the runtime's prepareRun: dataset.py:224-287 through the
   * runtime's HyPhy driver. Returns `{treeText, source: 'hyphy-hky85'}`.
   */
  async function estimateTreeHook(alignmentText, treeText, progress) {
    const hy = await hyphy();
    if (!hy) throw new EngineError("server", "The HyPhy WASM driver is not available in this runtime.");
    const newick = treeText ? newickTextFrom(treeText) : newickTextFrom(alignmentText);
    if (!newick) throw new EngineError("input", "No tree topology could be read for branch-length estimation.");
    const topology = stripBranchLengths(newick);
    const fasta = fastaFromAlignment(alignmentText);
    const t0 = Date.now();
    let r;
    try {
      r = await hy.estimateBranchLengths(fasta, topology, {
        progress: (phase, done, total, message) => {
          if (typeof progress === "function") progress("prepare", 1, 2, "HyPhy HKY85: " + message);
        }
      });
    } catch (err) {
      throw new EngineError("input", "HyPhy could not fit HKY85 branch lengths to the tree: " + ((err && err.message) || err), {
        cause: err,
        hint: "Supply a tree with branch lengths, or make sure every tree tip has a sequence of the same name (the reference prunes extra tips; this server does not)."
      });
    }
    logger.info("engine estimated branch lengths with HyPhy HKY85 in " + (Date.now() - t0) + " ms");
    return { treeText: r.result, source: "hyphy-hky85" };
  }

  /**
   * PLAN.md 4.0 row 1, "an NJ tree built when there is no tree at all": the report's answer to an
   * alignment that carries no tree, through the runtime's HyPhy driver (DM3's NJ.bf, the same
   * call the browser's tree worker makes). Per-pillar tools refuse instead — they mirror a CLI
   * that requires a tree — so this is used by `analyze` only.
   */
  async function njTreeHook(alignmentText, progress) {
    const hy = await hyphy();
    if (!hy) {
      throw new EngineError("input", "HyphAeon needs a phylogenetic tree and none was supplied or embedded in the alignment; this runtime has no HyPhy driver to build one.", {
        hint: "Pass `tree` (Newick with branch lengths)."
      });
    }
    const t0 = Date.now();
    if (typeof progress === "function") progress("prepare", 0, 2, "Building a neighbour-joining tree (HyPhy)...");
    let r;
    try {
      r = await hy.njTree(alignmentText, {
        progress: (phase, done, total, message) => {
          if (typeof progress === "function") progress("prepare", 0, 2, "HyPhy NJ: " + message);
        }
      });
    } catch (err) {
      throw new EngineError("input", "HyPhy could not build a neighbour-joining tree from this alignment: " + ((err && err.message) || err), {
        cause: err,
        hint: "Pass `tree` (Newick with branch lengths), or check that the alignment parses as an in-frame codon alignment."
      });
    }
    const text = String(r.result || "").trim();
    if (!text) throw new EngineError("input", "HyPhy returned no neighbour-joining tree for this alignment.");
    logger.info("engine built an NJ tree with HyPhy in " + (Date.now() - t0) + " ms");
    return text.endsWith(";") ? text : text + ";";
  }

  /** What this process can do about recoverable tree problems (src/validate.js reads it). */
  async function capabilities() {
    try {
      const rt = await runtime();
      return { hyphy: hyphyAssetsPresent(rt.hyphy), tn93: false };
    } catch {
      return { hyphy: false, tn93: false };
    }
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
      const caps = await capabilities();
      out.branch_length_estimator = caps.hyphy ? "hyphy-hky85" : null;
      out.hyphy_wasm_version = caps.hyphy ? rt.hyphy.HYPHY_WASM_VERSION || null : null;
      out.tn93 = caps.tn93;
      out.mds_sign = MDS_SIGN;
      // Which Phase 2 entry points this runtime checkout provides.
      out.runtime_provides = {
        runEpistasis: typeof rt.runEpistasis === "function",
        runDms: typeof rt.runDms === "function",
        runEverything: typeof rt.runEverything === "function"
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
  function requireRuntime(rt, name, rel) {
    if (typeof rt[name] === "function") return rt[name];
    throw new EngineError("server", "The HyphAeon runtime does not provide " + name + " (expected in runtime/src/" + rel + ").", {
      hint: "The @veg/hyphaeon-runtime workspace is older than this MCP; update the checkout.",
      code: "RUNTIME_OUTDATED"
    });
  }

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
        hint: analysis === "analyze" ? "Use engine.analyze." : "It runs through the Python bridge."
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
      if (options.use_tn93 || options.no_tree) {
        throw new EngineError(
          "input",
          "use_tn93 / no_tree asks for TN93 pairwise distances instead of a tree (dataset.py:544-580); " +
            "hyphaeon_" + analysis + " runs in-process here and has no TN93 implementation.",
          { hint: "Supply a tree (Newick with branch lengths, or a topology for HyPhy to fit)." }
        );
      }
      checkMdsSign(options, analysis);
      const caps = await capabilities();
      const alignmentName = names.alignment || "alignment.fasta";
      const treeGiven = typeof req.tree === "string" && req.tree.trim().length > 0;
      const treeName = treeGiven ? names.tree || "tree.nwk" : null;
      const mapped = mapOptions(analysis, options, {
        defaultVariant: env.HYPHAEON_VARIANT,
        alignmentName,
        treeName,
        estimateTree: caps.hyphy ? (alignmentText, treeText) => estimateTreeHook(alignmentText, treeText, progress) : null
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
      const warnings = [];

      if (analysis === "meme") {
        const out = await rt.runMeme(common);
        // cli.py:298-311 through the runtime's serialiser; the site rows keep the Python keys
        // first and carry the app's DM3-derived columns (zScore, percentile, call) after them.
        result = rt.jsonSafe(rt.memeDocument(out, { alignment: alignmentName, tree: treeName, provenance: false }));
        result.sites = rt.jsonSafe(out.sites);
        result.summary = rt.jsonSafe(out.summary);
        baseProvenance = out.provenance;
      } else if (analysis === "busted") {
        const out = await rt.runBusted(Object.assign(common, { head: handle.head || null }));
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
        // epistasis | dms: the front half is prepareRun (parse, load, branch lengths), then the
        // pillar over the loaded alignment and the session — run_epistatic_analysis /
        // run_digital_dms_analysis steps 2-5.
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
        const inputs = { alignment: alignmentName, tree: treeName ?? (prep.treeArg === null ? "embedded_in_alignment" : null) };
        let out;
        if (analysis === "epistasis") {
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
          surrogateFor: "MEME",
          seed: analysis === "epistasis" ? (out.permutations && out.permutations.seed) ?? mapped.runtime.seed ?? null : null,
          elapsedSec: (Date.now() - t0) / 1000,
          options: mapped.runtime,
          preprocessing: prep.preprocessing,
          warnings: diagnosed,
          inputs
        });
        if (analysis === "epistasis" && out.permutations) baseProvenance.permutations = out.permutations;
        if (analysis === "dms") {
          baseProvenance.focal_index = out.focal_index;
          baseProvenance.focal_name = out.focal_name;
          if (out.progress) baseProvenance.dms_progress = out.progress;
        }
      }

      const provenance = mcpProvenance(rt, baseProvenance, { surface, analysis, options, names: { alignment: alignmentName, tree: treeName }, t0 });
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
   *   seed, permutations, dms (bool), dms_work_budget
   * @param {{alignment?: string, tree?: string}} [req.names]
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
      const caps = await capabilities();
      const alignmentName = names.alignment || "alignment.fasta";
      let treeText = typeof req.tree === "string" && req.tree.trim().length > 0 ? req.tree : null;
      let treeName = treeText ? names.tree || "tree.nwk" : null;
      let treeSource;

      // No tree at all: build one (PLAN.md 4.0 row 1), the only tree-less path any tool offers.
      let embedded = false;
      if (!treeText) {
        try {
          embedded = extractTree(req.alignment) !== null;
        } catch {
          embedded = false;
        }
        if (!embedded) {
          treeText = await njTreeHook(req.alignment, progress);
          treeName = "nj.nwk";
          treeSource = "nj";
        }
      }

      // The variant: the caller's, else the operator's default, else the tree regime (PLAN.md 4.0).
      let variant = options.variant || env.HYPHAEON_VARIANT || null;
      const variantSource = options.variant ? "caller" : env.HYPHAEON_VARIANT ? "HYPHAEON_VARIANT" : "diagnostics";
      if (!variant) {
        let warnings = [];
        try {
          warnings = libraryDiagnose({ alignmentText: req.alignment, treeText }).warnings;
        } catch {
          warnings = [];
        }
        variant = variantFromDiagnostics(warnings);
      }
      const handle = await session(variant, { bustedHead: true });

      const runtimeOptions = {
        variant,
        maxSpecies: options.max_species ?? undefined,
        referenceSequence: options.reference_sequence ?? undefined,
        callMode: options.call_mode ?? undefined,
        seed: options.seed ?? undefined,
        permutations: options.permutations ?? undefined,
        dms: { enabled: options.dms !== false, workBudget: options.dms_work_budget ?? undefined },
        treeSource,
        estimateTree: caps.hyphy ? (alignmentText, treeTxt) => estimateTreeHook(alignmentText, treeTxt, progress) : undefined
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
        reference_commands: referenceCommandsForReport(Object.assign({}, runtimeOptions, { variant }), { alignment: alignmentName, tree: treeName }),
        elapsed_sec: (Date.now() - t0) / 1000,
        options: Object.assign({}, options)
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

  return { run, analyze, status, capabilities, session, models, hyphy, threads, close };
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
