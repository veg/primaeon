/**
 * tools.js — the eleven HyphAeon MCP tools.
 *
 * WHY THIS FILE EXISTS
 *
 * PLAN.md 3.6 names the tool set: hyphaeon_validate, hyphaeon_meme, hyphaeon_busted,
 * hyphaeon_epistasis, hyphaeon_dms, hyphaeon_phenotype, hyphaeon_evaluate, job_status,
 * get_results, cancel_job, list_models. The shape is datamonkey-js-server lib/mcp/tools.js
 * (register-on-a-McpServer, JSON text results, {error, hint} envelopes with isError, a two-class
 * error taxonomy), rewritten as ESM for Node 22 and with the analysis inputs mirroring the
 * Python CLI's options one-to-one (hyphaeon/cli.py at veg/HyphAeon phase-1a; the flag tables
 * are in src/bridge.js and the runtime mapping in src/engine.js).
 *
 * Every analysis tool follows the same path:
 *   1. resolve `file://` inputs (stdio only — a remote server must never read its own disk on a
 *      caller's behalf);
 *   2. parse the alignment ONCE with the library's dataset.py mirror (src/validate.js) and size
 *      the run on the LONGEST sequence (src/caps.js) — the probe is not the parse that feeds
 *      the model, exactly as in tools.js:590-629, so it must parse the same text;
 *   3. refuse over the hard caps, answer inside the call under the synchronous caps, otherwise
 *      create a job and return its id;
 *   4. run the pillar: hyphaeon_meme, hyphaeon_busted and hyphaeon_evaluate IN THIS PROCESS
 *      through src/engine.js (runtime/ over onnxruntime-node; `provenance.surface` is
 *      "mcp-stdio" or "mcp-http"), hyphaeon_epistasis, hyphaeon_dms and hyphaeon_phenotype
 *      through the Phase 0 Python bridge (src/bridge.js; `provenance.surface` is
 *      "python-reference") until their ports land (PLAN.md 8, phases 2-3).
 *
 * Output shaping (`fields`, `top`, `summary_only`) is accepted by every analysis tool and by
 * get_results, because an epistasis result for HIV1_RT is 4 MB of JSON and no client wants that
 * in a tool result by default. The ranking keys per collection are in RANKED below and follow
 * Appendix B of PLAN.md.
 *
 * The tool schemas did not change between the bridge and the engine; that was the point of
 * keeping them identical in Phase 0. What changed is who runs, and the provenance says which.
 */

import { z } from "zod";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MAX_ALIGNMENT_CHARS,
  MAX_PERMULATIONS,
  MAX_PERMUTATIONS,
  MAX_SYNC_CODONS,
  MAX_SYNC_WORK,
  TAXON_CAP,
  classifyRun,
  probeSequences
} from "./caps.js";
import { diagnose, hasEmbeddedTree, parseAlignment, NATIVE_ANALYSES, BRIDGED_ANALYSES } from "./validate.js";
import { BridgeError, pythonBin, referenceVersion, runBridge } from "./bridge.js";
import { EngineError, createEngine } from "./engine.js";
import { readManifest } from "./models.js";

export const TOOL_NAMES = Object.freeze([
  "hyphaeon_validate",
  "hyphaeon_meme",
  "hyphaeon_busted",
  "hyphaeon_epistasis",
  "hyphaeon_dms",
  "hyphaeon_phenotype",
  "hyphaeon_evaluate",
  "job_status",
  "get_results",
  "cancel_job",
  "list_models"
]);

export { NATIVE_ANALYSES, BRIDGED_ANALYSES };

const PRETTY_LIMIT = 20 * 1024;

function ok(obj) {
  const compact = JSON.stringify(obj);
  const text = compact.length <= PRETTY_LIMIT ? JSON.stringify(obj, null, 2) : compact;
  return { content: [{ type: "text", text }] };
}

/**
 * Error envelope, the same {error, hint?} JSON body axomeme_scan builds (tools.js:33-45), plus
 * `kind` so a client can tell "the server is broken" from "your data has a problem" without
 * parsing prose.
 */
function fail(kind, error, hint, extra) {
  const body = Object.assign({ error, kind }, hint ? { hint } : {}, extra || {});
  return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }], isError: true };
}

function runFailure(err) {
  if (err instanceof BridgeError) {
    const extra = {};
    if (err.stderr) extra.stderr_tail = err.stderr;
    if (err.exitCode !== undefined && err.exitCode !== null) extra.exit_code = err.exitCode;
    if (err.command) extra.command = err.command;
    return fail(err.kind, err.message, err.hint, extra);
  }
  if (err instanceof EngineError) {
    return fail(err.kind, err.message, err.hint, err.code ? { code: err.code } : undefined);
  }
  const message = (err && err.message) || String(err);
  return fail("server", "Unexpected failure while running the analysis: " + message);
}

class ToolInputError extends Error {
  constructor(message, hint) {
    super(message);
    this.hint = hint;
  }
}

// ── shared schema fragments ─────────────────────────────────────────────────

const alignmentSchema = z
  .string()
  .min(1)
  .max(MAX_ALIGNMENT_CHARS, "Alignment is too large (limit " + MAX_ALIGNMENT_CHARS + " characters)")
  .describe(
    "In-frame codon alignment as FASTA, NEXUS or PHYLIP text. Over stdio a `file://` URL to a " +
      "local file is also accepted. U is read as T; gaps must keep every sequence in column register."
  );

const treeSchema = z
  .string()
  .max(MAX_ALIGNMENT_CHARS)
  .optional()
  .describe(
    "Newick or NEXUS tree text (or a `file://` URL over stdio). Optional when the alignment " +
      "embeds a tree. Tips must match sequence names exactly. A tree without branch lengths gets " +
      "HKY85 lengths from HyPhy when this server has an estimator (see list_models), else 1e-3 everywhere."
  );

const tn93Schema = {
  use_tn93: z
    .boolean()
    .optional()
    .describe("--use-tn93: skip the tree and estimate pairwise distances from the sequences with TN93 (bridged pillars only; refused in-process)."),
  no_tree: z.boolean().optional().describe("--no-tree: same as use_tn93 (the CLI offers both spellings).")
};

const variantSchema = z
  .string()
  .regex(/^[A-Za-z0-9_.-]{1,64}$/)
  .optional()
  .describe(
    "--model-variant: `general` (default; mammalian, deep trees) or `viral` (shallow trees; " +
      "rho ~0.43 vs ~0.10 on unseen viral families). hyphaeon_validate suggests one from tree depth."
  );

const maxSpeciesSchema = z
  .number()
  .int()
  .min(2)
  .max(TAXON_CAP)
  .optional()
  .describe("--max-species: cap on taxa fed to the model (2-" + TAXON_CAP + "); above it, Faith's-PD subsampling.");

const cpuSchema = z.boolean().optional().describe("--cpu: force CPU inference (always the case in-process; recorded).");

const shapingSchema = {
  fields: z
    .array(z.string())
    .optional()
    .describe("Return only these top-level keys of the result (provenance is always included)."),
  top: z
    .number()
    .int()
    .min(1)
    .max(100000)
    .optional()
    .describe(
      "Keep only the top N records of each ranked collection (sites by LRT, edges by CESI, " +
        "plasticity by intrinsic plasticity, phenotype sites by score)."
    ),
  summary_only: z
    .boolean()
    .optional()
    .describe("Return the per-pillar summary and collection counts instead of the full collections.")
};

const runAsyncSchema = z
  .boolean()
  .optional()
  .describe("Force the run into a background job and return a job id even under the synchronous caps.");

// ── result shaping ─────────────────────────────────────────────────────────

/** Ranked collections per analysis and the key they are ranked by (PLAN.md Appendix B). */
const RANKED = {
  meme: { sites: "hyphaeon_lrt" },
  busted: { sites_detail: "hyphaeon_lrt" },
  epistasis: { edges: "cesi", sectors: "spectral_coherence", plasticity: "intrinsic_plasticity" },
  dms: { plasticity: "intrinsic_plasticity" },
  phenotype: { sites: "score", trait_sectors: "spectral_coherence", coselection_pairs: "cesi" },
  evaluate: { per_gene: null }
};

function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : -Infinity;
}

function topBy(arr, key, n) {
  if (!Array.isArray(arr)) return arr;
  if (!key) return arr.slice(0, n);
  return arr
    .map((r, i) => [r, i])
    .sort((a, b) => num(b[0][key]) - num(a[0][key]) || a[1] - b[1])
    .slice(0, n)
    .map(([r]) => r);
}

function count(v) {
  return Array.isArray(v) ? v.length : v && typeof v === "object" ? Object.keys(v).length : 0;
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

/**
 * Per-pillar summary: the numbers a reader needs before deciding to pull the collections.
 */
export function summarise(analysis, result) {
  if (!result || typeof result !== "object") return {};
  switch (analysis) {
    case "meme": {
      const sites = Array.isArray(result.sites) ? result.sites : [];
      const invariable = sites.filter((s) => s.is_invariable).length;
      const p05 = sites.filter((s) => s.p_value <= 0.05).length;
      const p10 = sites.filter((s) => s.p_value <= 0.1).length;
      const q05 = sites.filter((s) => s.q_value <= 0.05).length;
      const q10 = sites.filter((s) => s.q_value <= 0.1).length;
      return Object.assign(pick(result, ["taxa_count", "codon_count", "runtime_sec", "filter_enabled", "attribution_enabled"]), {
        sites: sites.length,
        invariable_sites: invariable,
        variable_sites: sites.length - invariable,
        significant_p05: p05,
        significant_p10: p10,
        significant_q05: q05,
        significant_q10: q10,
        artifacts_masked: count(result.artifacts_masked),
        attributed_sites: count(result.attributions),
        top_sites: topBy(sites, "hyphaeon_lrt", 10).map((s) =>
          pick(s, ["site", "hyphaeon_lrt", "p_value", "q_value", "is_invariable", "call", "percentile", "top_driver", "top_mutation", "evolutionary_epoch"])
        )
      });
    }
    case "busted":
      return pick(result, [
        "gene", "taxa", "sites", "p_value_acat", "p_value_simes", "omnibus_lrt", "predicted_gene_lrt",
        "selection_probability", "synonymous_rate_variation", "total_selection_energy", "sig_sites_p05",
        "sig_sites_p10", "rate_distributions", "positive_selection_detected", "elapsed_seconds"
      ]);
    case "epistasis": {
      const edges = Array.isArray(result.edges) ? result.edges : [];
      const sectors = Array.isArray(result.sectors) ? result.sectors : [];
      return Object.assign(pick(result, ["taxa_count", "codon_count", "branch_count", "evaluated_branches", "focal_taxon"]), {
        edges: edges.length,
        sectors: sectors.length,
        plasticity: count(result.plasticity),
        sector_summary: sectors.map((s) =>
          pick(s, ["sector_id", "size", "sites", "spectral_coherence", "p_perm", "mean_lrt", "pars_signature"])
        ),
        top_edges: topBy(edges, "cesi", 10).map((e) =>
          pick(e, ["site_u", "site_v", "ref_u", "ref_v", "lrt_u", "lrt_v", "similarity", "shared_branches", "cesi", "fdr_q"])
        )
      });
    }
    case "dms": {
      const pl = Array.isArray(result.plasticity) ? result.plasticity : [];
      const strip = (r) => pick(r, ["site", "wt_aa", "baseline_lrt", "p_value", "intrinsic_plasticity", "max_delta_lrt", "min_delta_lrt"]);
      return Object.assign(pick(result, ["taxa_count", "codon_count", "total_mutations", "focal_taxon"]), {
        plasticity: pl.length,
        most_plastic: topBy(pl, "intrinsic_plasticity", 10).map(strip),
        most_rigid: [...pl].sort((a, b) => num(a.intrinsic_plasticity) - num(b.intrinsic_plasticity)).slice(0, 10).map(strip)
      });
    }
    case "phenotype": {
      const sites = Array.isArray(result.sites) ? result.sites : [];
      return Object.assign(
        pick(result, [
          "phenotype_meta", "taxa_count", "codon_count", "significant_sites_count", "spectral_energy",
          "norm_spectral_ratio", "max_assoc", "p_evd_length_adjusted", "compact_pars_signature",
          "permulations_count", "gene_p_value_perm"
        ]),
        {
          sites: sites.length,
          trait_sectors: count(result.trait_sectors),
          coselection_pairs: count(result.coselection_pairs),
          top_sites: topBy(sites, "score", 10).map((s) =>
            pick(s, ["site", "ref_aa", "derived_aa", "hyphaeon_lrt", "association_rho", "score", "p_value", "q_value", "foreground_freq_pct", "background_freq_pct"])
          )
        }
      );
    }
    case "evaluate":
      return Object.assign(
        pick(result, ["matched_genes", "total_sites", "evaluated_sites", "evaluation_scope", "pearson_r", "spearman_rho", "thresholds", "warnings"]),
        { per_gene: count(result.per_gene) }
      );
    default:
      return {};
  }
}

/**
 * Apply fields / top / summary_only to a {result, provenance} pair.
 */
export function shapeResult(analysis, result, provenance, { fields, top, summary_only } = {}) {
  const ranked = RANKED[analysis] || {};
  if (summary_only) {
    const collections = {};
    for (const k of Object.keys(ranked)) collections[k] = count(result[k]);
    return { analysis, summary: summarise(analysis, result), collections, provenance };
  }
  let out = Object.assign({ analysis }, result);
  if (top !== undefined) {
    const truncated = {};
    for (const [k, key] of Object.entries(ranked)) {
      if (Array.isArray(result[k]) && result[k].length > top) {
        out[k] = topBy(result[k], key, top);
        truncated[k] = { returned: top, total: result[k].length, ranked_by: key || "input order" };
      }
    }
    if (Object.keys(truncated).length) out.truncated = truncated;
  }
  if (Array.isArray(fields) && fields.length) {
    const keep = new Set(fields);
    const unknown = fields.filter((f) => !(f in out) && f !== "provenance");
    const filtered = { analysis };
    for (const k of Object.keys(out)) if (keep.has(k) || k === "truncated") filtered[k] = out[k];
    if (unknown.length) filtered.unknown_fields = unknown;
    out = filtered;
  }
  out.provenance = provenance;
  return out;
}

// ── input resolution ────────────────────────────────────────────────────────

/**
 * Inline text as given, or the contents of a `file://` URL over stdio, with the file's basename
 * (the document's `alignment` / `tree` label; the bridge scrubbed temp paths to the same).
 *
 * @returns {Promise<{text: string|undefined, name: string|null}>}
 */
async function resolveText(value, label, allowFilePaths) {
  if (typeof value !== "string" || !value.startsWith("file://")) return { text: value, name: null };
  if (!allowFilePaths) {
    throw new ToolInputError(
      label + " is a file:// URL, which is only accepted by the stdio server running on your own machine.",
      "Paste the file's contents inline instead."
    );
  }
  let p;
  try {
    p = fileURLToPath(value);
  } catch (e) {
    throw new ToolInputError(label + " is not a valid file:// URL: " + e.message);
  }
  let st;
  try {
    st = await stat(p);
  } catch (e) {
    throw new ToolInputError(label + " could not be read: " + e.message);
  }
  if (!st.isFile()) throw new ToolInputError(label + " is not a regular file: " + p);
  if (st.size > MAX_ALIGNMENT_CHARS) {
    throw new ToolInputError(
      label + " is " + st.size + " bytes, above the " + MAX_ALIGNMENT_CHARS + "-byte cap.",
      "Trim the alignment or submit fewer sequences."
    );
  }
  return { text: await readFile(p, "utf8"), name: path.basename(p) };
}

const INPUT_KEYS = ["alignment", "tree", "phenotype_file", "prediction", "meme_result"];
const NON_OPTION_KEYS = new Set([...INPUT_KEYS, "fields", "top", "summary_only", "run_async"]);

function optionsOf(args) {
  const out = {};
  for (const [k, v] of Object.entries(args)) if (!NON_OPTION_KEYS.has(k) && v !== undefined) out[k] = v;
  return out;
}

// ── registration ────────────────────────────────────────────────────────────

/**
 * @param {import("@modelcontextprotocol/sdk/server/mcp.js").McpServer} server
 * @param {object} deps
 * @param {ReturnType<import("./jobs.js").createJobStore>} deps.jobs
 * @param {(req: object) => Promise<{result: object, provenance: object}>} [deps.bridge]  defaults to runBridge (bridged pillars)
 * @param {ReturnType<typeof createEngine>} [deps.engine]  defaults to createEngine({env, logger}) (native pillars)
 * @param {"mcp-stdio"|"mcp-http"} [deps.surface]  what native results claim; default "mcp-stdio"
 * @param {boolean} [deps.allowFilePaths]  accept file:// inputs (stdio only)
 * @param {object} [deps.env]
 * @param {{info: Function, warn: Function, error: Function, debug: Function}} [deps.logger]
 */
export function registerTools(server, deps) {
  const jobs = deps.jobs;
  const env = deps.env || process.env;
  const allowFilePaths = !!deps.allowFilePaths;
  const surface = deps.surface || "mcp-stdio";
  const logger = deps.logger || { info() {}, warn() {}, error() {}, debug() {} };
  const bridge = deps.bridge || ((req) => runBridge(Object.assign({ env }, req)));
  const engine = deps.engine || createEngine({ env, logger });

  // ── hyphaeon_validate ───────────────────────────────────────────────────
  server.registerTool(
    "hyphaeon_validate",
    {
      title: "Validate an alignment before running HyphAeon",
      description:
        "Pre-flight diagnostics without running the model, from the same library the analyses " +
        "use: format sniff (FASTA/NEXUS/PHYLIP), alphabet, reading frame, internal stops, " +
        "unknown-codon fraction, duplicate haplotypes, tree/alignment name matching (three tiers), " +
        "branch-length regime (missing, negative, max patristic > 10 rescaled), depth regime " +
        "(shallow, deep+large, star-like), a cost estimate, and this server's caps and run mode. " +
        "Returns {ok, warnings:[{code, severity, message, data}], summary}; severity is info | " +
        "warn | refuse, and ok is false when anything refuses. Codes are stable across surfaces.",
      inputSchema: Object.assign(
        {
          alignment: alignmentSchema,
          tree: treeSchema,
          analysis: z
            .enum(["meme", "busted", "epistasis", "dms", "phenotype"])
            .optional()
            .describe("Which analysis the cost estimate and caps are for (default meme)."),
          max_species: maxSpeciesSchema
        },
        { use_tn93: tn93Schema.use_tn93 }
      ),
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async (args) => {
      try {
        const alignment = (await resolveText(args.alignment, "alignment", allowFilePaths)).text;
        const tree = (await resolveText(args.tree, "tree", allowFilePaths)).text;
        const capabilities = await engine.capabilities();
        const out = diagnose({
          alignment,
          tree,
          analysis: args.analysis || "meme",
          use_tn93: !!args.use_tn93,
          max_species: args.max_species,
          capabilities
        });
        logger.info("hyphaeon_validate ok=" + out.ok + " sequences=" + out.summary.sequence_count + " codons=" + out.summary.codons);
        return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }], isError: !out.ok };
      } catch (err) {
        return err instanceof ToolInputError ? fail("input", err.message, err.hint) : fail("server", "Validation failed: " + err.message);
      }
    }
  );

  // ── analysis tools ──────────────────────────────────────────────────────
  function registerAnalysis(name, analysis, config) {
    const native = NATIVE_ANALYSES.includes(analysis);
    server.registerTool(
      name,
      {
        title: config.title,
        description: config.description,
        inputSchema: Object.assign({}, config.inputSchema, shapingSchema, { run_async: runAsyncSchema }),
        annotations: { readOnlyHint: false, openWorldHint: false, idempotentHint: true }
      },
      async (args) => {
        try {
          const inputs = {};
          const names = {};
          for (const k of INPUT_KEYS) {
            if (args[k] !== undefined) {
              const r = await resolveText(args[k], k, allowFilePaths);
              inputs[k] = r.text;
              if (r.name) names[k] = r.name;
            }
          }
          const options = optionsOf(args);
          let mode = args.run_async ? "job" : "sync";
          let size = null;

          if (analysis !== "evaluate") {
            const parsed = parseAlignment(inputs.alignment);
            if (!parsed.sequences.length) {
              return fail(
                "input",
                "Could not read the alignment: no sequences found.",
                "hyphaeon accepts FASTA (headers starting with '>'), NEXUS (a MATRIX block) or PHYLIP " +
                  "(a 'ntaxa nsites' header). Run hyphaeon_validate for details."
              );
            }
            const probe = probeSequences(parsed.sequences);
            size = { codons: probe.codons, sequences: parsed.sequences.length, format: parsed.format };
            const cls = classifyRun(analysis, { codons: probe.codons, taxa: parsed.sequences.length });
            if (!cls.ok) return fail("input", cls.reason, cls.hint, size);
            if (!args.run_async) mode = cls.mode;
            size.work = cls.work;

            const wantsTn93 = !!(options.use_tn93 || options.no_tree);
            if (wantsTn93 && native) {
              const caps = await engine.capabilities();
              if (!caps.tn93) {
                return fail(
                  "input",
                  "use_tn93 / no_tree asks for TN93 pairwise distances instead of a tree; " + name +
                    " runs in-process here and has no TN93 implementation.",
                  "Supply `tree` (Newick with branch lengths, or a topology for HyPhy to fit)."
                );
              }
            }
            if (!wantsTn93 && !(inputs.tree && inputs.tree.trim()) && !hasEmbeddedTree(inputs.alignment)) {
              return fail(
                "input",
                "HyphAeon needs a phylogenetic tree and none was supplied or embedded in the alignment.",
                "Pass `tree` (Newick with branch lengths)" +
                  (native ? "." : ", or set `use_tn93: true` to estimate distances from the sequences.")
              );
            }
            if (analysis === "phenotype") {
              const hasTrait = !!(options.preset || options.foreground || inputs.phenotype_file);
              if (!hasTrait) {
                return fail(
                  "input",
                  "hyphaeon_phenotype needs a trait definition: preset, foreground, or phenotype_file.",
                  "Pass preset (e.g. \"marine\"), a comma-separated foreground list / regex, or a CSV mapping taxa to trait values."
                );
              }
            }
          }

          logger.info(
            name + " engine=" + (native ? "in-process" : "python-reference") + " mode=" + mode +
              (size ? " sequences=" + size.sequences + " codons=" + size.codons + " work=" + size.work.toExponential(2) : "")
          );

          const request = Object.assign({ analysis, options, names }, inputs);
          const execute = (signal, report) =>
            native
              ? engine.run(Object.assign({ signal, surface, progress: report }, request))
              : bridge(Object.assign({ signal }, request));

          if (mode === "job") {
            const job = jobs.create({
              analysis,
              options,
              run: (signal, report) => execute(signal, report)
            });
            logger.info(name + " queued job_id=" + job.job_id);
            return ok(
              Object.assign(job, {
                engine: native ? "in-process" : "python-reference",
                reason: args.run_async
                  ? "run_async requested."
                  : "Above the synchronous caps (" + MAX_SYNC_CODONS + " codon sites, work " + MAX_SYNC_WORK.toExponential(1) + ").",
                next: "Poll job_status with this job_id; fetch the result with get_results (fields/top/summary_only apply)."
              })
            );
          }

          const { result, provenance } = await execute(undefined, undefined);
          if (!native) provenance.surface = "python-reference";
          const shaped = shapeResult(analysis, result, provenance, args);
          logger.info(name + " done in " + provenance.elapsed_sec + "s (surface " + provenance.surface + ")");
          return ok(shaped);
        } catch (err) {
          if (err instanceof ToolInputError) return fail("input", err.message, err.hint);
          logger.error(name + " failed: " + ((err && err.message) || err));
          return runFailure(err);
        }
      }
    );
  }

  registerAnalysis("hyphaeon_meme", "meme", {
    title: "HyphAeon site selection (MEME surrogate)",
    description:
      "Per-site episodic positive selection: a predicted MEME-style LRT per codon site, the MEME " +
      "mixture p-value, Benjamini-Hochberg q, and an invariable flag (\"not scored\", not zero); " +
      "plus this app's rank columns (zScore, percentile and a tier `call` over the variable sites). " +
      "Runs IN THIS PROCESS (ONNX Runtime; provenance.surface mcp-stdio / mcp-http) with numbers " +
      "that match `hyphaeon meme` (LRT within 1e-5, p/q float32-identical). This is a neural " +
      "SURROGATE for MEME evaluated against MEME, not against truth: rank is strong (rho ~0.5 on " +
      "HIV-1 RT), scale is compressed (slope 0.16), and calibration depends on regime (FPR 5-7% at " +
      "20-50 taxa, ~36% at 100 taxa on deep trees). Sort by LRT and report rank/percentile; show p " +
      "and q but never alone; confirm anything you will act on with real MEME on Datamonkey. " +
      "Answers inside the call under " + MAX_SYNC_CODONS + " codon sites and work sites x taxa^2 <= " +
      MAX_SYNC_WORK.toExponential(1) + ", otherwise returns a job id. Options mirror `hyphaeon meme`.",
    inputSchema: Object.assign(
      { alignment: alignmentSchema, tree: treeSchema },
      tn93Schema,
      {
        model_variant: variantSchema,
        max_species: maxSpeciesSchema,
        filter: z.boolean().optional().describe("--filter: hypergeometric patch scan + counterfactual outlier masking, then re-score."),
        filter_p_thresh: z.number().min(0).max(1).optional().describe("--filter-p-thresh: local patch p-value threshold (default 0.01)."),
        min_patch_consec: z.number().int().min(1).optional().describe("--min-patch-consec: consecutive radical mutations in one taxon to call an artifact (default 3; in-process only the default is applied, see provenance)."),
        attribute: z.boolean().optional().describe("--attribute: per-taxon counterfactual delta-LRT, driver taxon, evolutionary epoch, adaptation mode."),
        attribution_min_lrt: z.number().min(0).optional().describe("--attribution-min-lrt: only attribute sites at or above this LRT (default 3.84)."),
        no_prune_duplicates: z.boolean().optional().describe("--no-prune-duplicates: keep identical sequences instead of collapsing them."),
        batch_size: z.number().int().min(1).optional().describe("--batch-size: site batch size (default adaptive)."),
        cpu: cpuSchema
      }
    )
  });

  registerAnalysis("hyphaeon_busted", "busted", {
    title: "HyphAeon gene-level omnibus test (BUSTED surrogate)",
    description:
      "Alignment-wide episodic selection: Cauchy (ACAT) and Simes combinations of the per-site " +
      "p-values, the omnibus LRT and total selection energy (exact functions of the site LRTs, " +
      "reproducible against `hyphaeon busted`), and the neural BUSTED head's selection " +
      "probability, predicted gene LRT, 3-class omega mixture and synonymous rate variation " +
      "(one seeded draw of a head the reference loads unseeded: NOT reproducible upstream, see " +
      "provenance.neural_head). `positive_selection_detected` is p_ACAT < 0.05 OR " +
      "selection_probability > 0.5 — report both numbers, not the flag alone. Runs in this " +
      "process. A surrogate for BUSTED with the same regime caveats as hyphaeon_meme. Options " +
      "mirror `hyphaeon busted` in single-alignment mode.",
    inputSchema: Object.assign(
      { alignment: alignmentSchema, tree: treeSchema },
      tn93Schema,
      {
        model_variant: variantSchema,
        max_species: maxSpeciesSchema,
        batch_size: z.number().int().min(1).optional().describe("--batch-size: sites per chunk (default adaptive)."),
        gene: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/).optional().describe("Gene name recorded in the record (default: the alignment file's stem)."),
        cpu: cpuSchema
      }
    )
  });

  registerAnalysis("hyphaeon_epistasis", "epistasis", {
    title: "HyphAeon co-selection network and epistatic sectors",
    description:
      "Branch-attribution vectors per site -> cosine co-selection network (t-test p, BH q, CESI), " +
      "sectors by modularity with spectral coherence and a Monte Carlo permutation null (p_perm), " +
      "and a 19-amino-acid digital DMS per sector node unless no_dms. Edges are pairs of sites " +
      "whose selection signal falls on the same branches; sectors are groups of such sites. " +
      "p_perm is a permutation p-value (statistical parity only across surfaces). Costly on large " +
      "trees (HIV1_RT at 1k permutations ~20 s); set no_dms and lower n_permutations first. " +
      "Runs through the Python reference bridge (provenance.surface python-reference) until its " +
      "port lands. Options mirror `hyphaeon epistasis` (which has no --model-variant).",
    inputSchema: Object.assign(
      { alignment: alignmentSchema, tree: treeSchema },
      tn93Schema,
      {
        n_permutations: z.number().int().min(0).max(MAX_PERMUTATIONS).optional().describe("--n-permutations: Monte Carlo permutations for sector significance (default 10000, cap " + MAX_PERMUTATIONS + ")."),
        max_perm_p: z.number().min(0).max(1).optional().describe("--max-perm-p: keep only sectors with p_perm at or below this (default: keep all above min_coherence)."),
        min_coherence: z.number().min(0).max(1).optional().describe("--min-coherence: minimum spectral coherence C(S) for a sector (default 0.50)."),
        min_clique_size: z.number().int().min(2).optional().describe("--min-clique-size: minimum seed size for a sector (default 3)."),
        max_overlap: z.number().min(0).max(1).optional().describe("--max-overlap: maximum Jaccard overlap between sectors (default 0.50)."),
        no_dms: z.boolean().optional().describe("--no-dms: skip the 19-amino-acid digital DMS sweep."),
        focal_taxon: z.string().max(256).optional().describe("--focal-taxon: taxon for the DMS sweep (default consensus)."),
        min_sim: z.number().min(-1).max(1).optional().describe("--min-sim: cosine similarity threshold for an edge (default 0.30)."),
        min_shared: z.number().int().min(0).optional().describe("--min-shared: minimum shared mutated branches (default 2)."),
        max_fdr: z.number().min(0).max(1).optional().describe("--max-fdr: BH q threshold for edges (default 0.05)."),
        min_lrt: z.number().min(0).optional().describe("--min-lrt: minimum site LRT to enter the network (default 1.0)."),
        cpu: cpuSchema
      }
    )
  });

  registerAnalysis("hyphaeon_dms", "dms", {
    title: "HyphAeon digital deep mutational scan",
    description:
      "In silico selection DMS: every site is mutated to each of the 19 alternative amino acids " +
      "in the focal taxon (default consensus), the model is re-run, and the change in LRT per " +
      "mutant is reported with an intrinsic plasticity score per site (high = permissive, low = " +
      "rigid). Costs 19 x sites forward passes, so the work cap is 19 x sites x taxa^2 and the " +
      "site cap is 3,000. Runs through the Python reference bridge until its port lands. " +
      "Options mirror `hyphaeon dms` (no --model-variant).",
    inputSchema: Object.assign(
      { alignment: alignmentSchema, tree: treeSchema },
      tn93Schema,
      {
        focal_taxon: z.string().max(256).optional().describe("--focal-taxon: taxon whose sequence is mutated (default consensus)."),
        cpu: cpuSchema
      }
    )
  });

  registerAnalysis("hyphaeon_phenotype", "phenotype", {
    title: "HyphAeon phenotype association (PhyloWAS)",
    description:
      "Directional trait association per site from the model's root-to-leaf attention: " +
      "foreground vs background attention, association rho, t-test p, BH q, a PARS signature, " +
      "trait sectors with permutation p, and an optional gene-level Brownian-motion permulation " +
      "p (permulations > 0). Define the trait with preset, a foreground list/regex, or a CSV. " +
      "Runs through the Python reference bridge until its port lands. Options mirror " +
      "`hyphaeon phenotype`.",
    inputSchema: Object.assign(
      { alignment: alignmentSchema, tree: treeSchema },
      tn93Schema,
      {
        model_variant: variantSchema,
        preset: z
          .enum(["echolocation", "marine", "fossorial", "hibernation", "longevity", "high_altitude", "cardenolide", "dim_light"])
          .optional()
          .describe("--preset: a curated foreground set keyed to TOGA-style species codes."),
        foreground: z.string().max(65536).optional().describe("--foreground: comma-separated taxon names or a regex for the foreground."),
        background: z.string().max(65536).optional().describe("--background: explicit background/control taxa (default: everything else)."),
        phenotype_file: z.string().max(MAX_ALIGNMENT_CHARS).optional().describe("--phenotype-file: CSV/TSV text mapping taxa to trait values (file:// over stdio)."),
        trait_col: z.string().max(256).optional().describe("--trait-col: trait column name in phenotype_file."),
        species_col: z.string().max(256).optional().describe("--species-col: species column name in phenotype_file."),
        continuous: z.boolean().optional().describe("--continuous: treat trait values as continuous."),
        permulations: z.number().int().min(0).max(MAX_PERMULATIONS).optional().describe("--permulations: Brownian-motion permulations for the gene-level empirical p (default 0, cap " + MAX_PERMULATIONS + ")."),
        n_permutations: z.number().int().min(0).max(MAX_PERMUTATIONS).optional().describe("--n-permutations: permutations for trait-sector significance (default 10000)."),
        alpha: z.number().min(0).max(1).optional().describe("--alpha: FDR threshold for significant sites (default 0.05)."),
        min_taxa: z.number().int().min(1).optional().describe("--min-taxa: minimum sequenced taxa per site (default 4)."),
        max_perm_p: z.number().min(0).max(1).optional().describe("--max-perm-p: keep only trait sectors with p_perm at or below this."),
        cpu: cpuSchema
      }
    )
  });

  registerAnalysis("hyphaeon_evaluate", "evaluate", {
    title: "Evaluate HyphAeon predictions against HyPhy MEME",
    description:
      "Concordance of a `hyphaeon meme` CSV against the matching HyPhy MEME JSON for one gene: " +
      "Pearson and Spearman on LRT, ROC-AUC / PPV / FPR and confusion matrices at p <= 0.05 and " +
      "0.10, per-gene site counts and warnings. Runs no model; runs in this process with the " +
      "library's port of evaluation.py (numbers match `hyphaeon evaluate` to 1e-9). Options " +
      "mirror `hyphaeon evaluate` in direct-file mode.",
    inputSchema: {
      prediction: z.string().min(1).max(MAX_ALIGNMENT_CHARS).describe("CSV text written by hyphaeon meme (site, hyphaeon_lrt, p_value, q_value, is_invariable); file:// over stdio."),
      meme_result: z.string().min(1).max(MAX_ALIGNMENT_CHARS).describe("HyPhy MEME result JSON text; file:// over stdio."),
      gene: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/).optional().describe("Gene name recorded in the report (default \"gene\")."),
      variable_only: z.boolean().optional().describe("--variable-only: exclude rows marked is_invariable from the metrics."),
      allow_site_mismatch: z.boolean().optional().describe("--allow-site-mismatch: use the site intersection instead of failing on unequal site sets.")
    }
  });

  // ── job_status ───────────────────────────────────────────────────────────
  server.registerTool(
    "job_status",
    {
      title: "Status of a queued HyphAeon job",
      description: "Status of a job returned by an analysis tool: queued | running | completed | failed | cancelled, with timestamps, the latest progress phase, and any error.",
      inputSchema: { job_id: z.string().regex(/^[0-9a-f]{32}$/).describe("The job_id an analysis tool returned.") },
      annotations: { readOnlyHint: true }
    },
    async ({ job_id }) => {
      const job = jobs.get(job_id);
      if (!job) return ok({ job_id, status: "not_found" });
      return ok(job);
    }
  );

  // ── get_results ─────────────────────────────────────────────────────────
  server.registerTool(
    "get_results",
    {
      title: "Results of a completed HyphAeon job",
      description:
        "Fetch a completed job's result with the same fields / top / summary_only shaping the " +
        "analysis tools accept. Results carry a provenance block whose `surface` says whether " +
        "the numbers came from this process (mcp-stdio / mcp-http) or the Python reference bridge.",
      inputSchema: Object.assign({ job_id: z.string().regex(/^[0-9a-f]{32}$/).describe("The job_id to fetch.") }, shapingSchema),
      annotations: { readOnlyHint: true }
    },
    async (args) => {
      const job = jobs.get(args.job_id);
      if (!job) return fail("input", "Job not found.", "Check the job_id; jobs expire after their TTL.", { job_id: args.job_id });
      if (job.status !== "completed") {
        return fail(
          job.status === "failed" ? (job.error && job.error.kind) || "server" : "input",
          job.status === "failed" ? "The job failed: " + (job.error && job.error.message) : "Job not completed yet.",
          job.status === "failed" ? job.error && job.error.hint : "Poll job_status until status is completed.",
          { job_id: job.job_id, status: job.status }
        );
      }
      const stored = jobs.result(args.job_id);
      const storedSurface = stored.provenance && stored.provenance.surface;
      const provenance = Object.assign({}, stored.provenance, {
        surface: NATIVE_ANALYSES.includes(job.analysis) ? storedSurface || surface : "python-reference",
        job_id: job.job_id
      });
      return ok(shapeResult(job.analysis, stored.result, provenance, args));
    }
  );

  // ── cancel_job ──────────────────────────────────────────────────────────
  server.registerTool(
    "cancel_job",
    {
      title: "Cancel a queued or running HyphAeon job",
      description: "Cancel a job. A completed job cannot be cancelled; the call reports its final status instead.",
      inputSchema: { job_id: z.string().regex(/^[0-9a-f]{32}$/).describe("The job_id to cancel.") },
      annotations: { destructiveHint: true }
    },
    async ({ job_id }) => {
      const job = jobs.cancel(job_id);
      if (!job) return fail("input", "Job not found.", undefined, { success: false, job_id });
      if (job.status === "completed") return ok({ success: true, message: "Job already completed", job_id });
      if (job.status === "failed") return ok({ success: true, message: "Job had already failed", job_id });
      return ok({ success: true, job_id, status: job.status });
    }
  );

  // ── list_models ─────────────────────────────────────────────────────────
  server.registerTool(
    "list_models",
    {
      title: "Available HyphAeon model variants and engines",
      description:
        "The weights manifest (model_version, variants with training regime and artifact hashes, " +
        "taxon caps, ONNX contract, PRNG) read through the runtime's manifest reader, which " +
        "pillars run in this process (`native`: models directory, onnxruntime-node, branch-length " +
        "estimator) and which run through the Python reference bridge (`bridge`: executable, " +
        "version, reachability).",
      inputSchema: {},
      annotations: { readOnlyHint: true }
    },
    async () => {
      const manifest = await readManifest(env);
      const bin = pythonBin(env);
      const reference_version = await referenceVersion(env);
      const native = await engine.status();
      return ok(
        Object.assign(manifest, {
          native: Object.assign({ surface, analyses: [...NATIVE_ANALYSES] }, native),
          bridge: {
            surface: "python-reference",
            analyses: [...BRIDGED_ANALYSES],
            executable: bin,
            reference_version,
            reachable: reference_version !== "unknown",
            weights: env.HYPHAEON_WEIGHTS ? "HYPHAEON_WEIGHTS (local file)" : "package default or Hugging Face cache"
          }
        })
      );
    }
  );
}
