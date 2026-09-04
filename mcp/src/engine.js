/**
 * engine.js — the in-process HyphAeon engine behind hyphaeon_meme, hyphaeon_busted and
 * hyphaeon_evaluate: runtime/ over onnxruntime-node, no Python.
 *
 * WHY THIS FILE EXISTS
 *
 * PLAN.md 3.6, "Bridge, then port": once a pillar's JavaScript port lands, its tool stops
 * shelling to `hyphaeon <cmd>` and runs `runtime/` in this process, and `provenance.surface`
 * becomes "mcp-stdio" / "mcp-http". Phase 1a ported site selection, the omnibus statistics and
 * the evaluation (veg/HyphAeon js/ at tag phase-1a); Phase 1b's runtime wraps them as
 * `runMeme` (runtime/src/pipeline.js), `runBusted` (runtime/src/busted.js) and `runEvaluate`
 * (runtime/src/evaluate.js) over a session `createSession` (runtime/src/createSession.js) loads
 * from the manifest, and serialises them with runtime/src/results.js. This module is the MCP's
 * side of that: it resolves the models directory (src/models.js), loads and memoises one session
 * per variant, maps the tool's CLI-shaped options onto the runtime's, hands the runtime a
 * branch-length estimator built on its HyPhy WASM driver, turns the runtime's result into the
 * document `hyphaeon <cmd> -o` writes (Appendix B of PLAN.md; cli.py:298-311 for meme, :486-505
 * for busted, evaluation.py's report for evaluate) with a PLAN.md 3.5 provenance block, and
 * classifies failures into the two classes src/bridge.js established (input | server). The three
 * bridged pillars (epistasis, dms, phenotype) stay on src/bridge.js until their ports land
 * (PLAN.md 8, phases 2 and 3).
 *
 * OPTIONS MIRROR THE CLI ONE TO ONE (hyphaeon/cli.py:1017-1035, :1097-1112; evaluation.py
 * configure_parser), with these documented seams:
 *   - `max_species` unset means NO cap for meme (cli.py:1025 default None) and 512 for busted
 *     (cli.py:1108); the runtime spells "no cap" as `Infinity`.
 *   - `cpu` is accepted and recorded; onnxruntime-node here is CPU-only.
 *   - `use_tn93` / `no_tree` (dataset.py:544-580, TN93 pairwise distances in place of a tree)
 *     need the tn93 binary or package, which neither the library nor the runtime provides;
 *     refused as an input error with a hint. (The runtime's NJ-on-TN93 tree is a different
 *     thing — PLAN.md D5's "no tree -> NJ" — and is not offered under the CLI's flag.)
 *   - `min_patch_consec` is recorded but not forwarded: runMeme fixes the cmd_meme copy of the
 *     OCI screen at its default (3); a non-default value raises a provenance warning
 *     (OPTION_NOT_APPLIED) rather than silently doing something else.
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
 * THE RUNTIME IS REACHED THROUGH ITS PACKAGE ENTRY, WITH A FILE-PATH FALLBACK. Everything this
 * file needs is on the entry today; each name is also resolvable from `runtime/src/<file>.js` by
 * absolute file URL — a file URL is not subject to the package's exports map — so the MCP keeps
 * working across the runtime's index catching up with its modules (the HyPhy driver is not on the
 * exports map at all) and prefers the public name once it exists.
 *
 * SESSIONS ARE LOADED ON FIRST USE AND MEMOISED PER VARIANT. onnxruntime-node dlopens ~100 MB of
 * native code and the graph is 8 MB and hash-verified (runtime/src/session-node.js); the stdio
 * server is spawned once per client session, so list_models / job_status / hyphaeon_validate
 * must never pay that (measured: 146 ms for the general graph, then 0.6 s for bat_oas1 end to
 * end). A failed load is not memoised (a transient read error must not disable the tool for the
 * life of the process), and the busted head is loaded lazily, only for hyphaeon_busted on a
 * variant that ships one (general does; viral does not, manifest.json).
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
import { parseAlignmentSequences } from "@veg/hyphaeon-js";
import { resolveModels } from "./models.js";
import { JOB_TIMEOUT_MS } from "./caps.js";

const PKG = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const require = createRequire(import.meta.url);

/** The pillars this engine serves; everything else is src/bridge.js's. */
export const NATIVE_ANALYSES = Object.freeze(["meme", "busted", "evaluate"]);

/** cli.py:1025 / :1108 — the `--max-species` defaults per subcommand. */
const MAX_SPECIES_DEFAULT = Object.freeze({ meme: Infinity, busted: undefined });

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
 * @returns {Promise<{createSession: Function, runMeme: Function, runBusted: Function, runEvaluate: Function,
 *   memeDocument: Function, bustedDocument: Function, jsonSafe: Function, hyphy: object|null, version: string|null}>}
 */
export function loadRuntime() {
  if (runtimePromise) return runtimePromise;
  runtimePromise = (async () => {
    const entry = await import("@veg/hyphaeon-runtime");
    const need = async (name, rel) => {
      if (typeof entry[name] === "function") return entry[name];
      const mod = await importRuntimeFile(rel);
      if (mod && typeof mod[name] === "function") return mod[name];
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
      createSession: await need("createSession", "createSession.js"),
      runMeme: await need("runMeme", "pipeline.js"),
      runBusted: await need("runBusted", "busted.js"),
      runEvaluate: await need("runEvaluate", "evaluate.js"),
      memeDocument: await need("memeDocument", "results.js"),
      bustedDocument: await need("bustedDocument", "results.js"),
      jsonSafe: await need("jsonSafe", "results.js"),
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
 * @param {"meme"|"busted"} analysis
 * @param {object} options
 * @param {{defaultVariant?: string, alignmentName?: string, treeName?: string|null, estimateTree?: Function|null}} [extra]
 * @returns {{runtime: object, variant: string, notApplied: string[]}}
 */
export function mapOptions(analysis, options = {}, extra = {}) {
  const out = {};
  const notApplied = [];
  const variant = options.model_variant || extra.defaultVariant || "general";
  if (options.max_species !== undefined && options.max_species !== null) out.maxSpecies = options.max_species;
  else if (MAX_SPECIES_DEFAULT[analysis] !== undefined) out.maxSpecies = MAX_SPECIES_DEFAULT[analysis];
  if (options.no_prune_duplicates === true) out.pruneDuplicates = false;
  if (options.batch_size !== undefined && options.batch_size !== null) out.batchSize = options.batch_size;
  if (analysis === "meme") {
    if (options.filter === true) out.filter = true;
    if (options.filter_p_thresh !== undefined && options.filter_p_thresh !== null) out.filterPThresh = options.filter_p_thresh;
    if (options.min_patch_consec !== undefined && options.min_patch_consec !== null && options.min_patch_consec !== 3) {
      notApplied.push("min_patch_consec");
    }
    if (options.attribute === true) out.attribute = true;
    if (options.attribution_min_lrt !== undefined && options.attribution_min_lrt !== null) out.attributionMinLrt = options.attribution_min_lrt;
  }
  if (analysis === "busted") {
    if (options.gene) out.gene = options.gene;
  }
  if (extra.alignmentName) out.alignmentName = extra.alignmentName;
  if (extra.treeName !== undefined) out.treeName = extra.treeName;
  if (typeof extra.estimateTree === "function") out.estimateTree = extra.estimateTree;
  if (extra.treeSource) out.treeSource = extra.treeSource;
  return { runtime: out, variant, notApplied };
}

/**
 * The `hyphaeon <cmd> ...` line that reproduces a native run through the Python reference
 * (the "reproduce this with the CLI" snippet of PLAN.md 3.6).
 */
export function referenceCommand(analysis, options = {}, names = {}) {
  const argv = ["hyphaeon", analysis];
  if (analysis === "evaluate") {
    argv.push("--prediction", names.prediction || "gene.csv", "--meme-result", names.meme_result || "gene.MEME.json");
    if (options.variable_only) argv.push("--variable-only");
    if (options.allow_site_mismatch) argv.push("--allow-site-mismatch");
    argv.push("-o", "<out.json>", "--format", "json");
    return argv;
  }
  argv.push("-a", names.alignment || "alignment.fasta");
  if (names.tree) argv.push("-t", names.tree);
  if (options.model_variant) argv.push("--model-variant", options.model_variant);
  if (options.max_species !== undefined && options.max_species !== null) argv.push("--max-species", String(options.max_species));
  if (options.batch_size !== undefined && options.batch_size !== null) argv.push("--batch-size", String(options.batch_size));
  if (options.no_prune_duplicates) argv.push("--no-prune-duplicates");
  argv.push("--cpu");
  if (analysis === "meme") {
    if (options.filter) argv.push("--filter");
    if (options.filter_p_thresh !== undefined && options.filter_p_thresh !== null) argv.push("--filter-p-thresh", String(options.filter_p_thresh));
    if (options.min_patch_consec !== undefined && options.min_patch_consec !== null) argv.push("--min-patch-consec", String(options.min_patch_consec));
    if (options.attribute) argv.push("--attribute");
    if (options.attribution_min_lrt !== undefined && options.attribution_min_lrt !== null) argv.push("--attribution-min-lrt", String(options.attribution_min_lrt));
  }
  argv.push("-o", "<out.json>");
  return argv;
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

  /**
   * Run one native analysis.
   *
   * @param {object} req
   * @param {"meme"|"busted"|"evaluate"} req.analysis
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
    if (!NATIVE_ANALYSES.includes(analysis)) {
      throw new EngineError("input", "Analysis '" + analysis + "' is not served in-process.", { hint: "It runs through the Python bridge." });
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
      let out;
      let result;
      if (analysis === "meme") {
        out = await rt.runMeme(common);
        // cli.py:298-311 through the runtime's serialiser; the site rows keep the Python keys
        // first and carry the app's DM3-derived columns (zScore, percentile, call) after them.
        result = rt.jsonSafe(rt.memeDocument(out, { alignment: alignmentName, tree: treeName, provenance: false }));
        result.sites = rt.jsonSafe(out.sites);
        result.summary = rt.jsonSafe(out.summary);
      } else {
        out = await rt.runBusted(Object.assign(common, { head: handle.head || null }));
        result = rt.bustedDocument(out, { alignment: alignmentName, gene: options.gene || out.record.gene || alignmentName.replace(/\.[^.]*$/, ""), provenance: false });
        result.sites_detail = rt.jsonSafe(out.sites);
        result.statistics = rt.jsonSafe(out.statistics);
        result.summary = rt.jsonSafe(out.summary);
      }
      const provenance = Object.assign({}, rt.jsonSafe(out.provenance), {
        surface,
        engine: "in-process",
        hyphaeon_mcp_version: PKG.version,
        hyphaeon_runtime_version: rt.version,
        threads,
        reference_command: referenceCommand(analysis, options, { alignment: alignmentName, tree: treeName }),
        elapsed_sec: (Date.now() - t0) / 1000,
        options: Object.assign({}, options)
      });
      provenance.warnings = Array.isArray(provenance.warnings) ? [...provenance.warnings] : [];
      for (const key of mapped.notApplied) {
        provenance.warnings.push({
          code: "OPTION_NOT_APPLIED",
          severity: "warn",
          message: "Option `" + key + "` was recorded but not applied: the in-process runtime fixes it at the CLI default.",
          data: { option: key, value: options[key] }
        });
      }
      if (analysis === "busted" && handle.headError) {
        provenance.warnings.push({
          code: "BUSTED_HEAD_UNAVAILABLE",
          severity: "warn",
          message: "The neural BUSTED head could not be loaded; the statistical fields are complete, the neural fields are null: " + handle.headError,
          data: {}
        });
      }
      return { result, provenance };
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

  return { run, status, capabilities, session, models, hyphy, threads, close };
}

function safeStem(s) {
  const clean = String(s).replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 64);
  return clean || "gene";
}
