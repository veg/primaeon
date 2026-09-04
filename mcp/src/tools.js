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
 * Python CLI's options one-to-one (hyphaeon/cli.py, veg/HyphAeon@3cb9cc6; the flag tables are
 * in src/bridge.js).
 *
 * Every analysis tool follows the same path:
 *   1. resolve `file://` inputs (stdio only — a remote server must never read its own disk on a
 *      caller's behalf);
 *   2. parse the alignment ONCE, with the same sniff as the reference (src/validate.js), and
 *      size the run on the LONGEST sequence (src/caps.js) — the probe is not the parse that
 *      feeds the model, exactly as in tools.js:590-629, so it must parse the same text;
 *   3. refuse over the hard caps, answer inside the call under the synchronous caps, otherwise
 *      create a job and return its id;
 *   4. run the Phase 0 bridge (src/bridge.js) and return the CLI's JSON with a `provenance`
 *      block whose `surface` is "python-reference".
 *
 * Output shaping (`fields`, `top`, `summary_only`) is accepted by every analysis tool and by
 * get_results, because an epistasis result for HIV1_RT is 4 MB of JSON and no client wants that
 * in a tool result by default. The ranking keys per collection are in RANKED below and follow
 * Appendix B of PLAN.md.
 *
 * Bridge-then-port: when a pillar's port lands in @veg/hyphaeon-js, its tool switches from
 * `bridge` to `runtime/` and its provenance.surface becomes "mcp-stdio" / "mcp-http". Nothing
 * else in this file changes; that is the point of keeping the schemas identical now.
 */

import { z } from "zod";
import { readFile, stat } from "node:fs/promises";
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
import { diagnose, extractNewick, parseAlignment } from "./validate.js";
import { BridgeError, pythonBin, referenceVersion, runBridge } from "./bridge.js";
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

function bridgeFailure(err) {
  if (err instanceof BridgeError) {
    const extra = {};
    if (err.stderr) extra.stderr_tail = err.stderr;
    if (err.exitCode !== undefined && err.exitCode !== null) extra.exit_code = err.exitCode;
    if (err.command) extra.command = err.command;
    return fail(err.kind, err.message, err.hint, extra);
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
      "embeds a tree or when use_tn93 is set. Tips must match sequence names exactly. A tree " +
      "without branch lengths gets HKY85 lengths from HyPhy if it is on PATH, else 1e-3 everywhere."
  );

const tn93Schema = {
  use_tn93: z
    .boolean()
    .optional()
    .describe("--use-tn93: skip the tree and estimate pairwise distances from the sequences with TN93."),
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

const cpuSchema = z.boolean().optional().describe("--cpu: force CPU inference in the reference.");

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
  busted: {},
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
          pick(s, ["site", "hyphaeon_lrt", "p_value", "q_value", "is_invariable", "top_driver", "top_mutation", "evolutionary_epoch"])
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

async function resolveText(value, label, allowFilePaths) {
  if (typeof value !== "string" || !value.startsWith("file://")) return value;
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
  return readFile(p, "utf8");
}

const NON_OPTION_KEYS = new Set([
  "alignment", "tree", "phenotype_file", "prediction", "meme_result",
  "fields", "top", "summary_only", "run_async"
]);

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
 * @param {(req: object) => Promise<{result: object, provenance: object}>} [deps.bridge]  defaults to runBridge
 * @param {boolean} [deps.allowFilePaths]  accept file:// inputs (stdio only)
 * @param {object} [deps.env]
 * @param {{info: Function, warn: Function, error: Function, debug: Function}} [deps.logger]
 */
export function registerTools(server, deps) {
  const jobs = deps.jobs;
  const env = deps.env || process.env;
  const allowFilePaths = !!deps.allowFilePaths;
  const logger = deps.logger || { info() {}, warn() {}, error() {}, debug() {} };
  const bridge = deps.bridge || ((req) => runBridge(Object.assign({ env }, req)));

  // ── hyphaeon_validate ───────────────────────────────────────────────────
  server.registerTool(
    "hyphaeon_validate",
    {
      title: "Validate an alignment before running HyphAeon",
      description:
        "Pre-flight diagnostics without running the model: format sniff (FASTA/NEXUS/PHYLIP), " +
        "sequence count, unequal lengths, reading frame, internal stops, unknown-codon fraction, " +
        "tree/alignment name matching (exact), branch-length regime (absent, negative, saturated, " +
        "max patristic > 10), depth regime (deep+large, shallow, star-like) and a cost estimate. " +
        "Returns {ok, warnings:[{code, severity, message}], summary}; severity is info | warn | " +
        "refuse, and ok is false when anything refuses. Codes are stable across surfaces.",
      inputSchema: Object.assign(
        {
          alignment: alignmentSchema,
          tree: treeSchema,
          analysis: z
            .enum(["meme", "busted", "epistasis", "dms", "phenotype"])
            .optional()
            .describe("Which analysis the cost estimate and caps are for (default meme).")
        },
        { use_tn93: tn93Schema.use_tn93 }
      ),
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async (args) => {
      try {
        const alignment = await resolveText(args.alignment, "alignment", allowFilePaths);
        const tree = await resolveText(args.tree, "tree", allowFilePaths);
        const out = diagnose({ alignment, tree, analysis: args.analysis || "meme", use_tn93: !!args.use_tn93 });
        logger.info("hyphaeon_validate ok=" + out.ok + " sequences=" + out.summary.sequence_count + " codons=" + out.summary.codons);
        return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }], isError: !out.ok };
      } catch (err) {
        return err instanceof ToolInputError ? fail("input", err.message, err.hint) : fail("server", "Validation failed: " + err.message);
      }
    }
  );

  // ── analysis tools ──────────────────────────────────────────────────────
  function registerAnalysis(name, analysis, config) {
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
          for (const k of ["alignment", "tree", "phenotype_file", "prediction", "meme_result"]) {
            if (args[k] !== undefined) inputs[k] = await resolveText(args[k], k, allowFilePaths);
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
            if (!wantsTn93 && !(inputs.tree && inputs.tree.trim()) && !extractNewick(inputs.alignment)) {
              return fail(
                "input",
                "HyphAeon needs a phylogenetic tree and none was supplied or embedded in the alignment.",
                "Pass `tree` (Newick with branch lengths), or set `use_tn93: true` to estimate distances " +
                  "from the sequences."
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
            name + " mode=" + mode + (size ? " sequences=" + size.sequences + " codons=" + size.codons + " work=" + size.work.toExponential(2) : "")
          );

          const request = Object.assign({ analysis, options }, inputs);

          if (mode === "job") {
            const job = jobs.create({
              analysis,
              options,
              run: (signal) => bridge(Object.assign({ signal }, request))
            });
            logger.info(name + " queued job_id=" + job.job_id);
            return ok(
              Object.assign(job, {
                reason: args.run_async
                  ? "run_async requested."
                  : "Above the synchronous caps (" + MAX_SYNC_CODONS + " codon sites, work " + MAX_SYNC_WORK.toExponential(1) + ").",
                next: "Poll job_status with this job_id; fetch the result with get_results (fields/top/summary_only apply)."
              })
            );
          }

          const { result, provenance } = await bridge(request);
          provenance.surface = "python-reference";
          const shaped = shapeResult(analysis, result, provenance, args);
          logger.info(name + " done in " + provenance.elapsed_sec + "s");
          return ok(shaped);
        } catch (err) {
          if (err instanceof ToolInputError) return fail("input", err.message, err.hint);
          logger.error(name + " failed: " + ((err && err.message) || err));
          return bridgeFailure(err);
        }
      }
    );
  }

  registerAnalysis("hyphaeon_meme", "meme", {
    title: "HyphAeon site selection (MEME surrogate)",
    description:
      "Per-site episodic positive selection: a predicted MEME-style LRT per codon site, the MEME " +
      "mixture p-value, Benjamini-Hochberg q, and an invariable flag (\"not scored\", not zero). " +
      "This is a neural SURROGATE for MEME evaluated against MEME, not against truth: rank is " +
      "strong (rho ~0.5 on HIV-1 RT), scale is compressed (slope 0.16), and calibration depends " +
      "on regime (FPR 5-7% at 20-50 taxa, ~36% at 100 taxa on deep trees). Sort by LRT and report " +
      "rank/percentile; show p and q but never alone; confirm anything you will act on with real " +
      "MEME on Datamonkey. Answers inside the call under " + MAX_SYNC_CODONS + " codon sites and " +
      "work sites x taxa^2 <= " + MAX_SYNC_WORK.toExponential(1) + ", otherwise returns a job id. " +
      "Options mirror `hyphaeon meme`.",
    inputSchema: Object.assign(
      { alignment: alignmentSchema, tree: treeSchema },
      tn93Schema,
      {
        model_variant: variantSchema,
        max_species: maxSpeciesSchema,
        filter: z.boolean().optional().describe("--filter: hypergeometric patch scan + counterfactual outlier masking, then re-score."),
        filter_p_thresh: z.number().min(0).max(1).optional().describe("--filter-p-thresh: local patch p-value threshold (default 0.01)."),
        min_patch_consec: z.number().int().min(1).optional().describe("--min-patch-consec: consecutive radical mutations in one taxon to call an artifact (default 3)."),
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
      "p-values, the omnibus LRT, the neural BUSTED head's selection probability and predicted " +
      "gene LRT, a 3-class omega mixture, and synonymous rate variation. `positive_selection_detected` " +
      "is p_ACAT < 0.05 OR selection_probability > 0.5 — report both numbers, not the flag alone. " +
      "A surrogate for BUSTED with the same regime caveats as hyphaeon_meme. Options mirror " +
      "`hyphaeon busted` in single-alignment mode.",
    inputSchema: Object.assign(
      { alignment: alignmentSchema, tree: treeSchema },
      tn93Schema,
      {
        model_variant: variantSchema,
        max_species: maxSpeciesSchema,
        batch_size: z.number().int().min(1).optional().describe("--batch-size: sites per chunk (default adaptive)."),
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
      "Options mirror `hyphaeon epistasis` (which has no --model-variant).",
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
      "site cap is 3,000. Options mirror `hyphaeon dms` (no --model-variant).",
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
      "Options mirror `hyphaeon phenotype`.",
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
      "0.10, per-gene site counts and warnings. Runs no model. Options mirror `hyphaeon evaluate` " +
      "in direct-file mode.",
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
      description: "Status of a job returned by an analysis tool: queued | running | completed | failed | cancelled, with timestamps and any error.",
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
        "analysis tools accept. Results carry a provenance block with surface \"python-reference\" " +
        "while the Phase 0 bridge is in place.",
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
      const provenance = Object.assign({}, stored.provenance, { surface: "python-reference", job_id: job.job_id });
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
      title: "Available HyphAeon model variants",
      description:
        "The weights manifest (model_version, variants with training regime and artifact hashes, " +
        "taxon caps, ONNX contract, PRNG) when models/manifest.json is present, otherwise the " +
        "variants the Python reference knows about; plus whether the Python bridge is reachable.",
      inputSchema: {},
      annotations: { readOnlyHint: true }
    },
    async () => {
      const manifest = await readManifest(env);
      const bin = pythonBin(env);
      const reference_version = await referenceVersion(env);
      return ok(
        Object.assign(manifest, {
          bridge: {
            surface: "python-reference",
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
