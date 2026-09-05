/**
 * tools.js — the twelve HyphAeon MCP tools.
 *
 * WHY THIS FILE EXISTS
 *
 * PLAN.md 3.6 names the tool set: hyphaeon_validate, hyphaeon_meme, hyphaeon_busted,
 * hyphaeon_epistasis, hyphaeon_dms, hyphaeon_phenotype, hyphaeon_evaluate, job_status,
 * get_results, cancel_job, list_models; PLAN.md 4.1 (D21) adds hyphaeon_analyze, "a tool that
 * runs everything and returns the report, alongside the per-pillar tools". The shape is
 * datamonkey-js-server lib/mcp/tools.js (register-on-a-McpServer, JSON text results, {error, hint}
 * envelopes with isError, a two-class error taxonomy), rewritten as ESM for Node 22 and with the
 * per-pillar analysis inputs mirroring the Python CLI's options one-to-one (hyphaeon/cli.py at
 * veg/HyphAeon phase-3a; the runtime mapping is in src/engine.js).
 *
 * Every per-pillar analysis tool follows the same path:
 *   1. resolve `file://` inputs (stdio only — a remote server must never read its own disk on a
 *      caller's behalf);
 *   2. parse the alignment ONCE with the library's dataset.py mirror (src/validate.js) and size
 *      the run on the LONGEST sequence (src/caps.js) — the probe is not the parse that feeds
 *      the model, exactly as in tools.js:590-629, so it must parse the same text;
 *   3. refuse over the hard caps, answer inside the call under the synchronous caps, otherwise
 *      create a job and return its id;
 *   4. run the pillar IN THIS PROCESS through src/engine.js (runtime/ over onnxruntime-node;
 *      `provenance.surface` is "mcp-stdio" or "mcp-http"). EVERY pillar, phenotype included since
 *      Phase 3: nothing is shelled out and no Python is involved (PLAN.md 8 phase 3, D16).
 *
 * A TREE IS OPTIONAL EVERYWHERE (PLAN.md D22). No tool refuses an alignment for want of a tree
 * any more. A tree with branch lengths is used as it is; no tree, a tree without usable branch
 * lengths, or `use_tn93` / `no_tree` takes the library's tree-free path (pairwise TN93 distances
 * into the MDS, the reference's own `--use-tn93`). Every result records which happened in
 * `provenance.preprocessing.tree_source` ('user' | 'embedded' | 'tn93') with the reason beside it,
 * and hyphaeon_validate says so in advance as `TREE_FREE_TN93` (info, not refuse).
 *
 * hyphaeon_analyze is the product (PLAN.md 4.0, D21): the only input is the dataset, and one
 * report fills in — diagnostics, sites, gene, epistasis + sectors, attribution, filter, DMS
 * last (progressive, cancellable, capped), and phenotype when — and only when — the call carries
 * a `phenotype` trait block, because a trait cannot be guessed. It ALWAYS runs as a job so the
 * report has an id (`hyphaeon://report/{id}`, `get_results section=`), waits inside the call for
 * up to `wait_seconds` (app-side semantics: the report streams, DMS may be minutes), and answers
 * with the whole ReportRecord when it is small enough to inline, else with its summary plus the
 * id; while the job runs, `get_results section=<name>` serves the sections already final and
 * `job_status` lists them.
 *
 * Output shaping (`fields`, `top`, `summary_only`, and `section` for reports) is accepted by every
 * analysis tool and by get_results, because an epistasis result for HIV1_RT is 4 MB of JSON and
 * no client wants that in a tool result by default. The ranking keys per collection are in
 * RANKED below and follow Appendix B of PLAN.md.
 *
 * The tool schemas did not change as the pillars moved in-process; that was the point of keeping
 * them identical from Phase 0. What changed is who runs, and the provenance says so.
 */

import { z } from "zod";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ANALYZE_INLINE_MAX_BYTES,
  ANALYZE_WAIT_DEFAULT_SEC,
  ANALYZE_WAIT_MAX_SEC,
  MAX_ALIGNMENT_CHARS,
  MAX_PERMULATIONS,
  MAX_PERMUTATIONS,
  MAX_SYNC_CODONS,
  MAX_SYNC_WORK,
  TAXON_CAP,
  classifyRun,
  probeSequences
} from "./caps.js";
import { diagnose, parseAlignment, treeSourceFrom, hasEmbeddedTree, NATIVE_ANALYSES } from "./validate.js";
import { EngineError, createEngine } from "./engine.js";
import { readManifest } from "./models.js";
import { REPORT_SECTIONS } from "./resources.js";

export const TOOL_NAMES = Object.freeze([
  "hyphaeon_validate",
  "hyphaeon_analyze",
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

export { NATIVE_ANALYSES };

/** The report's analysis sections (what runEverything fires through onSection). */
const REPORT_ANALYSIS_SECTIONS = Object.freeze(["sites", "gene", "epistasis", "attribution", "filter", "dms", "phenotype"]);

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
    "OPTIONAL Newick or NEXUS tree text (or a `file://` URL over stdio); a tree embedded in the " +
      "alignment is found automatically. Tips must match sequence names exactly. A tree WITH branch " +
      "lengths is used as it is. With no tree, or a tree without usable branch lengths, HyphAeon " +
      "uses pairwise TN93 distances instead (the reference's own --use-tn93 path, PLAN.md D22); " +
      "provenance.preprocessing.tree_source then reads \"tn93\" with the reason."
  );

const tn93Schema = {
  use_tn93: z
    .boolean()
    .optional()
    .describe("--use-tn93: ignore the tree and take pairwise TN93 distances from the sequences, even when a usable tree was supplied."),
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

const mdsSignSchema = z
  .enum(["canonical", "lapack"])
  .optional()
  .describe(
    "--mds-sign: MDS eigenvector sign convention (default canonical, the reference's default since phase-2a). " +
      "In-process only `canonical` can run; `lapack` (the pre-convention numbers) is refused with an input error."
  );

const seedSchema = z.number().int().min(0).max(2 ** 53 - 1).optional().describe("--seed: seed of the Monte Carlo permutation null (default 42).");

/** The trait, as `hyphaeon phenotype` defines it and as hyphaeon_analyze's `phenotype` block takes it. */
const phenotypeTraitSchema = {
  preset: z
    .enum(["echolocation", "marine", "fossorial", "hibernation", "longevity", "high_altitude", "cardenolide", "dim_light"])
    .optional()
    .describe("--preset: a curated foreground set keyed to TOGA-style species codes."),
  foreground: z
    .string()
    .max(65536)
    .optional()
    .describe(
      "--foreground: comma-separated taxon names, or a regex. Note the reference's own quirk: each " +
        "pattern is tried as a REGEX first and only then as a glob, so `pan*` matches `papAnu`."
    ),
  background: z.string().max(65536).optional().describe("--background: accepted for CLI parity and never read (phenotype.py:125); everything unmatched is background."),
  trait_col: z.string().max(256).optional().describe("--trait-col: trait column name in phenotype_file (default: the first column that is not the species column)."),
  species_col: z.string().max(256).optional().describe("--species-col: species column name in phenotype_file (default: the first species-like column, else column 0)."),
  continuous: z.boolean().optional().describe("--continuous: treat trait values as continuous (z-scored over all taxa)."),
  permulations: z
    .number()
    .int()
    .min(0)
    .max(MAX_PERMULATIONS)
    .optional()
    .describe(
      "--permulations: Brownian-motion permulations of the TRAIT for the gene-level empirical p " +
        "(default 0, cap " + MAX_PERMULATIONS + "). They need a phylogeny: a tree-free run skips them and says so in `permulations.reason`."
    ),
  n_permutations: z.number().int().min(0).max(MAX_PERMUTATIONS).optional().describe("--n-permutations: random K-site subset permutations for TRAIT SECTOR significance (default 10000)."),
  alpha: z.number().min(0).max(1).optional().describe("--alpha: FDR threshold for significant sites (default 0.05)."),
  min_taxa: z.number().int().min(1).optional().describe("--min-taxa: minimum sequenced taxa per site (default 4)."),
  max_perm_p: z.number().min(0).max(1).optional().describe("--max-perm-p: keep only trait sectors with p_perm at or below this."),
  seed: seedSchema
};

const shapingSchema = {
  fields: z
    .array(z.string())
    .optional()
    .describe("Return only these top-level keys of the result (provenance is always included). For a report, a section name keeps that section."),
  top: z
    .number()
    .int()
    .min(1)
    .max(100000)
    .optional()
    .describe(
      "Keep only the top N records of each ranked collection (sites by LRT, edges by CESI, sectors by " +
        "coherence, plasticity by intrinsic plasticity, phenotype sites by score)."
    ),
  summary_only: z
    .boolean()
    .optional()
    .describe("Return the per-pillar summary and collection counts instead of the full collections.")
};

const sectionSchema = z
  .enum(REPORT_SECTIONS)
  .optional()
  .describe(
    "Reports only (hyphaeon_analyze jobs): return one section — diagnostics, sites, gene, epistasis, attribution, " +
      "filter, dms, phenotype, provenance or timings — with fields / top / summary_only applied to it. While the job " +
      "is still running, a section that is already final is served with status \"running\"."
  );

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

/** Ranked collections inside each report section. */
const RANKED_SECTIONS = {
  sites: { sites: "hyphaeon_lrt" },
  gene: {},
  epistasis: { edges: "cesi", sectors: "spectral_coherence", plasticity: "intrinsic_plasticity" },
  attribution: {},
  filter: { artifacts_masked: null },
  dms: { plasticity: "intrinsic_plasticity" },
  phenotype: { sites: "score", trait_sectors: "spectral_coherence", coselection_pairs: "cesi" },
  diagnostics: { warnings: null },
  provenance: {},
  timings: {}
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
  if (!obj || typeof obj !== "object") return out;
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
      const called = sites.filter((s) => typeof s.call === "string" && s.call !== "Neutral").length;
      return Object.assign(pick(result, ["taxa_count", "codon_count", "runtime_sec", "filter_enabled", "attribution_enabled"]), {
        sites: sites.length,
        invariable_sites: invariable,
        variable_sites: sites.length - invariable,
        called_sites: called,
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
      return Object.assign(pick(result, ["taxa_count", "codon_count", "evaluated_taxa", "focal_taxon", "permutations", "dms_sites", "dms_enabled"]), {
        edges: edges.length,
        sectors: sectors.length,
        plasticity: count(result.plasticity),
        sector_summary: sectors.map((s) =>
          pick(s, ["sector_id", "size", "sites", "spectral_coherence", "p_perm", "null_coherence_95", "mean_lrt", "pars_signature"])
        ),
        top_edges: topBy(edges, "cesi", 10).map((e) =>
          pick(e, ["site_u", "site_v", "ref_u", "ref_v", "lrt_u", "lrt_v", "similarity", "shared_branches", "cesi", "fdr_q"])
        )
      });
    }
    case "dms": {
      const pl = Array.isArray(result.plasticity) ? result.plasticity : [];
      const strip = (r) => pick(r, ["site", "wt_aa", "baseline_lrt", "p_value", "intrinsic_plasticity", "max_delta_lrt", "min_delta_lrt"]);
      return Object.assign(pick(result, ["taxa_count", "codon_count", "total_mutations", "focal_taxon", "focal_name", "progress", "cancelled", "skipped", "capped", "reason"]), {
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
    case "analyze":
      return summariseReport(result);
    default:
      return {};
  }
}

/** The report's summary: the overview strip of PLAN.md 4.1 plus one line per section. */
export function summariseReport(report) {
  if (!report || typeof report !== "object") return {};
  const s = report.sections || {};
  const prov = report.provenance || {};
  const pre = prov.preprocessing || {};
  const diag = report.diagnostics || null;
  const diagWarnings = diag && Array.isArray(diag.warnings) ? diag.warnings : Array.isArray(prov.warnings) ? prov.warnings : [];
  const gene = s.gene && s.gene.record ? s.gene.record : s.gene || null;
  const out = {
    id: report.id,
    kind: report.kind,
    schema_version: report.schema_version,
    created_at: report.createdAt,
    inputs: report.inputs,
    surface: prov.surface,
    model_variant: prov.model_variant,
    taxa_used: pre.taxa_used ?? (s.sites && s.sites.taxa_count),
    taxa_in_alignment: pre.taxa_in_alignment,
    codon_count: s.sites && s.sites.codon_count,
    tree_source: pre.tree_source,
    sections_present: REPORT_ANALYSIS_SECTIONS.filter((n) => s[n] != null),
    sections_absent: REPORT_ANALYSIS_SECTIONS.filter((n) => s[n] == null),
    diagnostics: {
      ok: diag ? diag.ok : undefined,
      warnings: diagWarnings.length,
      refuse: diagWarnings.filter((w) => w.severity === "refuse").length,
      warn: diagWarnings.filter((w) => w.severity === "warn").length,
      codes: [...new Set(diagWarnings.map((w) => w.code))]
    },
    timings: report.timings
  };
  if (s.sites) out.sites = summarise("meme", s.sites);
  if (gene) {
    out.gene = pick(gene, ["p_value_acat", "p_value_simes", "omnibus_lrt", "total_selection_energy", "sig_sites_p05", "sig_sites_p10", "selection_probability", "predicted_gene_lrt", "positive_selection_detected"]);
  }
  if (s.epistasis) out.epistasis = summarise("epistasis", s.epistasis);
  if (s.attribution) out.attribution = { attribution_enabled: s.attribution.attribution_enabled, attributed_sites: count(s.attribution.attributions) };
  if (s.filter) out.filter = { filter_enabled: s.filter.filter_enabled, artifacts_masked: count(s.filter.artifacts_masked), cleaned: s.filter.cleaned != null };
  if (s.dms) out.dms = summarise("dms", s.dms);
  out.phenotype =
    s.phenotype == null
      ? "on demand: re-run hyphaeon_analyze with a `phenotype` trait block, or call hyphaeon_phenotype (preset, foreground or phenotype_file)"
      : summarise("phenotype", s.phenotype);
  return out;
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

/** `top` over one section's ranked collections; returns the shaped copy and what was cut. */
function truncateSection(name, payload, top) {
  const ranked = RANKED_SECTIONS[name] || {};
  const out = Object.assign({}, payload);
  const truncated = {};
  for (const [k, key] of Object.entries(ranked)) {
    if (Array.isArray(payload[k]) && payload[k].length > top) {
      out[k] = topBy(payload[k], key, top);
      truncated[k] = { returned: top, total: payload[k].length, ranked_by: key || "input order" };
    }
  }
  return { out, truncated };
}

function sectionPayload(report, name) {
  if (name === "diagnostics") return report.diagnostics;
  if (name === "provenance") return report.provenance;
  if (name === "timings") return report.timings;
  return report.sections ? report.sections[name] : undefined;
}

function sectionSummary(name, payload) {
  switch (name) {
    case "sites":
      return summarise("meme", payload);
    case "gene":
      return summarise("busted", payload && payload.record ? payload.record : payload);
    case "epistasis":
      return summarise("epistasis", payload);
    case "dms":
      return summarise("dms", payload);
    case "phenotype":
      return summarise("phenotype", payload);
    case "attribution":
      return { attribution_enabled: payload && payload.attribution_enabled, attributed_sites: count(payload && payload.attributions) };
    case "filter":
      return { filter_enabled: payload && payload.filter_enabled, artifacts_masked: count(payload && payload.artifacts_masked), cleaned: !!(payload && payload.cleaned) };
    case "diagnostics":
      return payload ? { ok: payload.ok, warnings: count(payload.warnings), summary: payload.summary } : {};
    default:
      return payload && typeof payload === "object" ? Object.fromEntries(Object.entries(payload).map(([k, v]) => [k, Array.isArray(v) ? v.length : v])) : payload;
  }
}

/**
 * Shape a ReportRecord for a tool result: one `section` of it, or the whole record, with
 * `fields`, `top` and `summary_only` applied. `status` says whether the report is complete or
 * still running (a partial record from the job store); `sections_ready` lists the final ones.
 *
 * @param {object} report
 * @param {{section?: string, fields?: string[], top?: number, summary_only?: boolean}} args
 * @param {{status?: string, sections_ready?: string[], job_id?: string}} [meta]
 */
export function shapeReport(report, { section, fields, top, summary_only } = {}, meta = {}) {
  const head = { analysis: "analyze", report_id: report.id, status: meta.status || "completed" };
  if (meta.job_id) head.job_id = meta.job_id;
  if (meta.sections_ready) head.sections_ready = meta.sections_ready;
  const provenance = report.provenance;

  if (section) {
    const payload = sectionPayload(report, section);
    if (payload === undefined || payload === null) {
      return Object.assign(head, {
        section,
        available: false,
        note:
          section === "phenotype"
            ? "Phenotype association needs a trait, so this report did not run it. Re-run hyphaeon_analyze with a `phenotype` block, or call hyphaeon_phenotype with preset, foreground or phenotype_file."
            : "This section is not in the report" + (meta.status === "running" ? " yet" : "") + ".",
        provenance
      });
    }
    if (summary_only) return Object.assign(head, { section, summary: sectionSummary(section, payload), provenance });
    let out;
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      const t = top !== undefined ? truncateSection(section, payload, top) : { out: Object.assign({}, payload), truncated: {} };
      out = t.out;
      if (Object.keys(t.truncated).length) out.truncated = t.truncated;
      if (Array.isArray(fields) && fields.length) {
        const keep = new Set(fields);
        const unknown = fields.filter((f) => !(f in out));
        const filtered = {};
        for (const k of Object.keys(out)) if (keep.has(k) || k === "truncated") filtered[k] = out[k];
        if (unknown.length) filtered.unknown_fields = unknown;
        out = filtered;
      }
      return Object.assign(head, { section }, out, { provenance });
    }
    return Object.assign(head, { section, value: payload, provenance });
  }

  if (summary_only) {
    const collections = {};
    for (const name of REPORT_ANALYSIS_SECTIONS) {
      const payload = report.sections ? report.sections[name] : null;
      if (payload == null) {
        collections[name] = null;
        continue;
      }
      const c = {};
      for (const k of Object.keys(RANKED_SECTIONS[name] || {})) c[k] = count(payload[k]);
      collections[name] = c;
    }
    return Object.assign(head, { summary: summariseReport(report), collections, provenance });
  }

  const out = Object.assign({}, report);
  if (top !== undefined && report.sections) {
    const sections = {};
    const truncated = {};
    for (const [name, payload] of Object.entries(report.sections)) {
      if (payload && typeof payload === "object") {
        const t = truncateSection(name, payload, top);
        sections[name] = t.out;
        if (Object.keys(t.truncated).length) truncated[name] = t.truncated;
      } else {
        sections[name] = payload;
      }
    }
    out.sections = sections;
    if (Object.keys(truncated).length) out.truncated = truncated;
  }
  let shaped = out;
  if (Array.isArray(fields) && fields.length) {
    const keep = new Set(fields);
    const filtered = {};
    const unknown = [];
    for (const f of fields) {
      if (f === "provenance") continue;
      if (f in out) continue;
      if (REPORT_ANALYSIS_SECTIONS.includes(f)) continue;
      unknown.push(f);
    }
    for (const k of Object.keys(out)) if (keep.has(k) || k === "truncated") filtered[k] = out[k];
    const wantedSections = fields.filter((f) => REPORT_ANALYSIS_SECTIONS.includes(f));
    if (wantedSections.length && out.sections) {
      filtered.sections = {};
      for (const name of wantedSections) filtered.sections[name] = out.sections[name];
    }
    if (unknown.length) filtered.unknown_fields = unknown;
    shaped = filtered;
  }
  return Object.assign(head, shaped, { provenance });
}

// ── input resolution ────────────────────────────────────────────────────────

/**
 * Inline text as given, or the contents of a `file://` URL over stdio, with the file's basename
 * (the document's `alignment` / `tree` label).
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
const NON_OPTION_KEYS = new Set([...INPUT_KEYS, "fields", "top", "summary_only", "section", "run_async", "wait_seconds"]);

function optionsOf(args) {
  const out = {};
  for (const [k, v] of Object.entries(args)) if (!NON_OPTION_KEYS.has(k) && v !== undefined) out[k] = v;
  return out;
}

/** The pre-run sizing every analysis tool shares: parse once, probe, classify; null when refused. */
function sizeRun(analysis, inputs, args) {
  const parsed = parseAlignment(inputs.alignment);
  if (!parsed.sequences.length) {
    return {
      error: fail(
        "input",
        "Could not read the alignment: no sequences found.",
        "hyphaeon accepts FASTA (headers starting with '>'), NEXUS (a MATRIX block) or PHYLIP " +
          "(a 'ntaxa nsites' header). Run hyphaeon_validate for details."
      )
    };
  }
  const probe = probeSequences(parsed.sequences);
  const size = { codons: probe.codons, sequences: parsed.sequences.length, format: parsed.format };
  const cls = classifyRun(analysis, { codons: probe.codons, taxa: parsed.sequences.length });
  if (!cls.ok) return { error: fail("input", cls.reason, cls.hint, size) };
  size.work = cls.work;
  return { size, mode: args.run_async ? "job" : cls.mode };
}

// ── registration ────────────────────────────────────────────────────────────

/**
 * @param {import("@modelcontextprotocol/sdk/server/mcp.js").McpServer} server
 * @param {object} deps
 * @param {ReturnType<import("./jobs.js").createJobStore>} deps.jobs
 * @param {ReturnType<typeof createEngine>} [deps.engine]  defaults to createEngine({env, logger}) (every pillar + analyze)
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
        "the tree decision (a tree with branch lengths is used as it is; otherwise TREE_FREE_TN93 " +
        "at INFO level with the reason — a missing tree is NOT a refusal), negative lengths, the " +
        "max patristic > 10 rescale, TN93 saturation, depth regime (shallow, deep+large, " +
        "star-like), a cost estimate, and this server's caps and run mode. " +
        "Returns {ok, warnings:[{code, severity, message, data}], summary}; severity is info | " +
        "warn | refuse, and ok is false when anything refuses. Codes are stable across surfaces. " +
        "hyphaeon_analyze runs these same checks itself and records them in the report.",
      inputSchema: Object.assign(
        {
          alignment: alignmentSchema,
          tree: treeSchema,
          analysis: z
            .enum(["analyze", "meme", "busted", "epistasis", "dms", "phenotype"])
            .optional()
            .describe("Which analysis the cost estimate and caps are for (default meme; `analyze` is the whole report)."),
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
        const out = diagnose({
          alignment,
          tree,
          analysis: args.analysis || "meme",
          use_tn93: !!args.use_tn93,
          max_species: args.max_species
        });
        logger.info("hyphaeon_validate ok=" + out.ok + " sequences=" + out.summary.sequence_count + " codons=" + out.summary.codons);
        return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }], isError: !out.ok };
      } catch (err) {
        return err instanceof ToolInputError ? fail("input", err.message, err.hint) : fail("server", "Validation failed: " + err.message);
      }
    }
  );

  // ── hyphaeon_analyze ────────────────────────────────────────────────────
  server.registerTool(
    "hyphaeon_analyze",
    {
      title: "HyphAeon: the whole report from one alignment",
      description:
        "THE PRODUCT'S ONE ACTION (PLAN.md 4.0): give it an in-frame codon alignment, with or without a " +
        "tree, and everything that needs no further input runs IN THIS PROCESS over one loaded alignment " +
        "and one forward pass, into one report whose sections arrive in order: diagnostics with automatic " +
        "repairs (U->T, trailing-codon trim, duplicate collapse, Faith's-PD taxon cap, variant from tree " +
        "depth, and the D22 tree decision: a tree with branch lengths is used as it is, otherwise pairwise " +
        "TN93 distances) -> sites (MEME surrogate) -> gene (BUSTED surrogate) -> epistasis network + " +
        "sectors -> attribution on called sites -> alignment-artifact filter -> digital DMS last " +
        "(progressive, cancellable, capped by work; when partial the report says so) -> phenotype, which " +
        "runs ONLY when you pass a `phenotype` trait block (preset, foreground or phenotype_file) and is " +
        "otherwise null, because a trait cannot be guessed; with one it costs no extra forward pass. " +
        "Returns a ReportRecord {schema_version: 2, kind: \"report\", id, inputs, options, diagnostics, " +
        "sections{sites, gene, epistasis, attribution, filter, dms, phenotype}, provenance, timings}. The run " +
        "is always a job: the call waits up to wait_seconds (default " + ANALYZE_WAIT_DEFAULT_SEC + ") and " +
        "inlines the record when it is at most " + Math.round(ANALYZE_INLINE_MAX_BYTES / 1024) + " KB, else " +
        "returns {job_id, summary, sections_ready}; get_results section=<name> pages one section (fields, top, " +
        "summary_only apply), also while still running; job_status lists sections_ready; the finished record " +
        "is hyphaeon://report/{id}. Advanced settings (variant, max_species, reference_sequence, call_mode, " +
        "seed, permutations, dms, dms_work_budget) are the report's \"Re-run with...\" disclosure, not a " +
        "prerequisite: defaults come from diagnostics. Read the interpret-report prompt before summarising a " +
        "report; everything in it is a neural SURROGATE for MEME/BUSTED to be confirmed with HyPhy.",
      inputSchema: Object.assign(
        {
          alignment: alignmentSchema,
          tree: treeSchema,
          variant: z.enum(["general", "viral"]).optional().describe("Model variant; default chosen from tree depth (SHALLOW_TREE -> viral)."),
          max_species: maxSpeciesSchema,
          reference_sequence: z.string().max(256).optional().describe("The taxon whose codons the site table shows as refCodon (default: the first matched taxon)."),
          call_mode: z.enum(["percentile", "zscore", "pvalue"]).optional().describe("How the site table's `call` tier is decided (default percentile: top 5% of variable sites)."),
          seed: seedSchema,
          permutations: z
            .number()
            .int()
            .min(0)
            .max(MAX_PERMUTATIONS)
            .optional()
            .describe("Monte Carlo permutations for sector p_perm (the report's default is 1,000 for latency; the CLI's is 10,000 — p_perm at 1,000 carries about +/-0.03)."),
          dms: z.boolean().optional().describe("Run the digital DMS section (default true; it runs last and is capped by dms_work_budget)."),
          dms_work_budget: z
            .number()
            .positive()
            .optional()
            .describe("Forward-pass budget for the DMS section as 19 x sites x taxa^2 (default the runtime's 2.5e9); above it the section is skipped and says so."),
          mds_sign: mdsSignSchema,
          use_tn93: tn93Schema.use_tn93,
          no_tree: tn93Schema.no_tree,
          phenotype: z
            .object(phenotypeTraitSchema)
            .optional()
            .describe(
              "The trait, if you have one: give `preset`, `foreground` (a comma list or a regex) or a " +
                "`phenotype_file` and the report's phenotype section runs from the SAME forward pass the " +
                "other sections used. Omit it and the section stays null and the report offers it."
            ),
          phenotype_file: z
            .string()
            .max(MAX_ALIGNMENT_CHARS)
            .optional()
            .describe("--phenotype-file: CSV/TSV TEXT mapping taxa to trait values (a `file://` URL over stdio), for the phenotype section."),
          wait_seconds: z
            .number()
            .min(0)
            .max(ANALYZE_WAIT_MAX_SEC)
            .optional()
            .describe("How long to wait inside the call for the report (default " + ANALYZE_WAIT_DEFAULT_SEC + ", max " + ANALYZE_WAIT_MAX_SEC + "); 0 returns the job id at once."),
          section: sectionSchema
        },
        shapingSchema,
        { run_async: runAsyncSchema }
      ),
      annotations: { readOnlyHint: false, openWorldHint: false, idempotentHint: true }
    },
    async (args) => {
      try {
        const inputs = {};
        const names = {};
        for (const k of ["alignment", "tree", "phenotype_file"]) {
          if (args[k] !== undefined) {
            const r = await resolveText(args[k], k, allowFilePaths);
            inputs[k] = r.text;
            if (r.name) names[k] = r.name;
          }
        }
        const options = optionsOf(args);
        const sized = sizeRun("analyze", inputs, args);
        if (sized.error) return sized.error;
        const { size, mode } = sized;
        if (options.mds_sign && options.mds_sign !== "canonical") {
          return fail(
            "input",
            "mds_sign '" + options.mds_sign + "' asks for the eigensolver's own MDS signs; the report runs in-process and computes the canonical convention only (MDS_SIGN.md).",
            "Omit mds_sign, or use the Python CLI with --mds-sign lapack for the pre-convention numbers."
          );
        }
        logger.info("hyphaeon_analyze mode=" + mode + " sequences=" + size.sequences + " codons=" + size.codons + " work=" + size.work.toExponential(2));

        // Always a job, so the report has an id from the first second (see the header).
        let created = null;
        const partial = { schema_version: 2, kind: "report", id: null, partial: true, sections: {}, provenance: null };
        const ready = [];
        created = jobs.create({
          analysis: "analyze",
          options,
          run: (signal, report, publish) => {
            partial.id = created.job_id;
            return engine.analyze({
              alignment: inputs.alignment,
              tree: inputs.tree,
              phenotype_file: inputs.phenotype_file,
              options,
              names,
              signal,
              surface,
              progress: report,
              id: created.job_id,
              onSection: (name, payload, meta) => {
                partial.sections[name] = payload;
                if (meta && meta.final && !ready.includes(name)) ready.push(name);
                if (typeof publish === "function") publish({ value: partial, sections_ready: [...ready] });
              }
            });
          }
        });
        const jobId = created.job_id;
        const waitSec = mode === "job" ? 0 : args.wait_seconds !== undefined ? args.wait_seconds : ANALYZE_WAIT_DEFAULT_SEC;
        const shaping = { section: args.section, fields: args.fields, top: args.top, summary_only: args.summary_only };
        const next =
          "Poll job_status for sections_ready; get_results with this job_id and section=<sites|gene|epistasis|attribution|filter|dms|diagnostics> " +
          "(fields/top/summary_only apply) serves sections as they become final; the finished report is hyphaeon://report/" + jobId + ".";

        if (waitSec <= 0) {
          logger.info("hyphaeon_analyze queued job_id=" + jobId);
          return ok(
            Object.assign(jobs.get(jobId), {
              engine: "in-process",
              report_uri: "hyphaeon://report/" + jobId,
              reason: mode === "job" ? "Above the synchronous caps (" + MAX_SYNC_CODONS + " codon sites, work " + MAX_SYNC_WORK.toExponential(1) + ")." : args.run_async ? "run_async requested." : "wait_seconds is 0.",
              next
            })
          );
        }

        const done = await jobs.wait(jobId, waitSec * 1000);
        if (done && done.status === "completed") {
          const report = jobs.result(jobId);
          const wantsShape = shaping.section || shaping.summary_only || shaping.top !== undefined || (Array.isArray(shaping.fields) && shaping.fields.length);
          let shaped = shapeReport(report, shaping, { job_id: jobId });
          if (!wantsShape && JSON.stringify(shaped).length > ANALYZE_INLINE_MAX_BYTES) {
            shaped = shapeReport(report, { summary_only: true }, { job_id: jobId });
            shaped.note = "The report is " + Math.round(JSON.stringify(report).length / 1024) + " KB, above the " + Math.round(ANALYZE_INLINE_MAX_BYTES / 1024) + " KB inline limit: this is its summary. " + next;
          }
          shaped.report_uri = "hyphaeon://report/" + jobId;
          logger.info("hyphaeon_analyze done job_id=" + jobId + " in " + done.elapsed_sec + "s");
          return ok(shaped);
        }
        if (done && done.status === "failed") {
          return fail((done.error && done.error.kind) || "server", "The report failed: " + (done.error && done.error.message), done.error && done.error.hint, { job_id: jobId, status: "failed" });
        }
        if (done && done.status === "cancelled") return fail("input", "The report was cancelled.", undefined, { job_id: jobId, status: "cancelled" });
        // Still running: hand back the id and what is ready.
        const running = jobs.get(jobId) || done;
        const part = jobs.partial(jobId);
        const body = Object.assign({}, running, {
          engine: "in-process",
          report_uri: "hyphaeon://report/" + jobId,
          reason: "The report did not finish within wait_seconds (" + waitSec + " s); its sections are still arriving.",
          next
        });
        if (part && part.value) {
          const readyNames = part.sections_ready || [];
          body.ready_summary = {};
          for (const name of readyNames) body.ready_summary[name] = sectionSummary(name, part.value.sections[name]);
        }
        logger.info("hyphaeon_analyze still running job_id=" + jobId + " ready=" + ((part && part.sections_ready) || []).join(","));
        return ok(body);
      } catch (err) {
        if (err instanceof ToolInputError) return fail("input", err.message, err.hint);
        logger.error("hyphaeon_analyze failed: " + ((err && err.message) || err));
        return runFailure(err);
      }
    }
  );

  // ── per-pillar analysis tools ───────────────────────────────────────────
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

          let treeSource = null;
          if (analysis !== "evaluate") {
            const sized = sizeRun(analysis, inputs, args);
            if (sized.error) return sized.error;
            size = sized.size;
            mode = sized.mode;

            // D22: no tool refuses for want of a tree. What is decided here is only what to SAY
            // the run will do; the library makes the decision again on the real load.
            const treeGiven = !!(inputs.tree && inputs.tree.trim());
            treeSource = treeSourceFrom({
              treeGiven,
              embedded: !treeGiven && hasEmbeddedTree(inputs.alignment),
              treeFree: !!(options.use_tn93 || options.no_tree)
            });

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
            name + " engine=in-process mode=" + mode + (treeSource ? " tree=" + treeSource : "") +
              (size ? " sequences=" + size.sequences + " codons=" + size.codons + " work=" + size.work.toExponential(2) : "")
          );

          const request = Object.assign({ analysis, options, names }, inputs);
          const execute = (signal, report) => engine.run(Object.assign({ signal, surface, progress: report }, request));

          if (mode === "job") {
            const job = jobs.create({
              analysis,
              options,
              run: (signal, report) => execute(signal, report)
            });
            logger.info(name + " queued job_id=" + job.job_id);
            return ok(
              Object.assign(job, {
                engine: "in-process",
                tree_source: treeSource,
                reason: args.run_async
                  ? "run_async requested."
                  : "Above the synchronous caps (" + MAX_SYNC_CODONS + " codon sites, work " + MAX_SYNC_WORK.toExponential(1) + ").",
                next: "Poll job_status with this job_id; fetch the result with get_results (fields/top/summary_only apply)."
              })
            );
          }

          const { result, provenance } = await execute(undefined, undefined);
          const shaped = shapeResult(analysis, result, provenance, args);
          logger.info(
            name + " done in " + provenance.elapsed_sec + "s (surface " + provenance.surface +
              ", tree_source " + ((provenance.preprocessing && provenance.preprocessing.tree_source) || "n/a") + ")"
          );
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
      "that match `hyphaeon meme` (LRT within 1e-5, p/q float32-identical; MDS signs canonical on " +
      "both sides). This is a neural SURROGATE for MEME evaluated against MEME, not against truth: " +
      "rank is strong (rho ~0.5 on HIV-1 RT), scale is compressed (slope 0.16), and calibration " +
      "depends on regime (FPR 5-7% at 20-50 taxa, ~36% at 100 taxa on deep trees). Sort by LRT and " +
      "report rank/percentile; show p and q but never alone; confirm anything you will act on with " +
      "real MEME on Datamonkey. Answers inside the call under " + MAX_SYNC_CODONS + " codon sites and " +
      "work sites x taxa^2 <= " + MAX_SYNC_WORK.toExponential(1) + ", otherwise returns a job id. " +
      "Options mirror `hyphaeon meme`. For the whole report use hyphaeon_analyze.",
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
        mds_sign: mdsSignSchema,
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
      "selection_probability > 0.5 — report both numbers, not the flag alone. Runs IN THIS " +
      "PROCESS. A surrogate for BUSTED with the same regime caveats as hyphaeon_meme. Options " +
      "mirror `hyphaeon busted` in single-alignment mode.",
    inputSchema: Object.assign(
      { alignment: alignmentSchema, tree: treeSchema },
      tn93Schema,
      {
        model_variant: variantSchema,
        max_species: maxSpeciesSchema,
        batch_size: z.number().int().min(1).optional().describe("--batch-size: sites per chunk (default adaptive)."),
        gene: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/).optional().describe("Gene name recorded in the record (default: the alignment file's stem)."),
        mds_sign: mdsSignSchema,
        cpu: cpuSchema
      }
    )
  });

  registerAnalysis("hyphaeon_epistasis", "epistasis", {
    title: "HyphAeon co-selection network and epistatic sectors",
    description:
      "Per-taxon attribution vectors per site (attention x non-consensus indicator) -> cosine " +
      "co-selection network (Student-t p, BH q, CESI), sectors by modularity communities with " +
      "spectral coherence and a seeded Monte Carlo permutation null (p_perm), and a 19-amino-acid " +
      "digital DMS on the sector sites unless no_dms. Edges are pairs of sites whose selection signal " +
      "falls on the same taxa; sectors are groups of such sites. Runs IN THIS PROCESS (the library's " +
      "port of epistasis.py, PHASE2A.md; provenance.surface mcp-stdio / mcp-http): edges and sector " +
      "membership are EXACT against `hyphaeon epistasis`, coherence at 1e-6, plasticity at 1e-5; " +
      "p_perm agrees only statistically (each side draws its own permutations: PCG64 there, " +
      "xoshiro256** here) and at n_permutations = 1,000 carries about +/-0.03 — use 10,000 (the CLI " +
      "default) before quoting it. Costly on large trees (permutations x sectors, plus the sector DMS); " +
      "set no_dms and lower n_permutations first. Options mirror `hyphaeon epistasis` (which has no " +
      "--model-variant; HYPHAEON_VARIANT applies). For the whole report use hyphaeon_analyze.",
    inputSchema: Object.assign(
      { alignment: alignmentSchema, tree: treeSchema },
      tn93Schema,
      {
        n_permutations: z.number().int().min(0).max(MAX_PERMUTATIONS).optional().describe("--n-permutations: Monte Carlo permutations for sector significance (default 10000, cap " + MAX_PERMUTATIONS + ")."),
        max_perm_p: z.number().min(0).max(1).optional().describe("--max-perm-p: keep only sectors with p_perm at or below this (default: keep all above min_coherence)."),
        min_coherence: z.number().min(0).max(1).optional().describe("--min-coherence: minimum spectral coherence C(S) for a sector (default 0.50)."),
        min_clique_size: z.number().int().min(2).optional().describe("--min-clique-size: minimum seed size for a sector (default 3)."),
        max_overlap: z.number().min(0).max(1).optional().describe("--max-overlap: maximum Jaccard overlap between sectors (default 0.50; accepted and unused by the reference)."),
        no_dms: z.boolean().optional().describe("--no-dms: skip the 19-amino-acid digital DMS sweep of the sector sites."),
        focal_taxon: z.string().max(256).optional().describe("--focal-taxon: taxon for the DMS sweep and the focal signature (default consensus / taxon 0; matched as a lower-cased substring)."),
        min_sim: z.number().min(-1).max(1).optional().describe("--min-sim: cosine similarity threshold for an edge (default 0.30)."),
        min_shared: z.number().int().min(0).optional().describe("--min-shared: minimum shared mutated taxa (default 2)."),
        max_fdr: z.number().min(0).max(1).optional().describe("--max-fdr: BH q threshold for edges (default 0.05)."),
        min_lrt: z.number().min(0).optional().describe("--min-lrt: minimum site LRT to enter the network (default 1.0)."),
        seed: seedSchema,
        mds_sign: mdsSignSchema,
        cpu: cpuSchema
      }
    )
  });

  registerAnalysis("hyphaeon_dms", "dms", {
    title: "HyphAeon digital deep mutational scan",
    description:
      "In silico selection DMS: every site is mutated to each of the 19 alternative amino acids " +
      "(one canonical codon each) in the focal taxon (default the first taxon), the model is re-run, " +
      "and the change in LRT per mutant is reported with an intrinsic plasticity score per site (high " +
      "= permissive, low = rigid). Costs 19 x sites forward passes, so the work cap is 19 x sites x " +
      "taxa^2 and the site cap is 3,000; `sites` (app-side, 1-indexed) sweeps a subset. Runs IN THIS " +
      "PROCESS (the library's port, PHASE2A.md; provenance.surface mcp-stdio / mcp-http) with every " +
      "record within 1e-5 of `hyphaeon dms`. Options mirror `hyphaeon dms` (no --model-variant; " +
      "HYPHAEON_VARIANT applies). The report (hyphaeon_analyze) runs this section last and capped.",
    inputSchema: Object.assign(
      { alignment: alignmentSchema, tree: treeSchema },
      tn93Schema,
      {
        focal_taxon: z.string().max(256).optional().describe("--focal-taxon: taxon whose sequence is mutated (default the first taxon; matched as a lower-cased substring, a miss silently means taxon 0 — see provenance.focal_name)."),
        sites: z
          .array(z.number().int().min(1))
          .max(3000)
          .optional()
          .describe("App-side: 1-indexed codon sites to sweep instead of every site (the CLI sweeps all). total_mutations stays 19 x codon_count as the reference computes it; progress says how many were swept."),
        mds_sign: mdsSignSchema,
        cpu: cpuSchema
      }
    )
  });

  registerAnalysis("hyphaeon_phenotype", "phenotype", {
    title: "HyphAeon phenotype association (PhyloWAS)",
    description:
      "Directional trait association per site from the model's root-to-leaf attention: " +
      "foreground vs background attention, association rho, a t-test p, ACAT against the site LRT, " +
      "BH q, a PARS signature, trait co-selection pairs, trait sectors with a permutation p, and — " +
      "with `permulations` > 0 and a real tree — a gene-level Brownian-motion permulation p. Define " +
      "the trait with `preset`, a `foreground` list/regex, or a `phenotype_file` CSV; check " +
      "`phenotype_meta.foreground_count` before believing anything (a preset that matched two taxa " +
      "is not a test). Runs IN THIS PROCESS since Phase 3 (the library's port of phenotype.py, " +
      "HyphAeon/PHASE3A.md; provenance.surface mcp-stdio / mcp-http) — there is no Python anywhere " +
      "any more. A tree is OPTIONAL: without one the run uses TN93 distances, and permulations are " +
      "then skipped with a reason (`permulations.reason: \"tree-free\"`) because a Brownian null " +
      "needs a phylogeny. This is a confounded, convergence-style test on a SURROGATE's attention: " +
      "report the foreground/background frequencies beside rho, never q alone. Options mirror " +
      "`hyphaeon phenotype`. hyphaeon_analyze takes the same trait as its `phenotype` block and " +
      "computes the section from the report's own forward pass.",
    inputSchema: Object.assign(
      { alignment: alignmentSchema, tree: treeSchema },
      tn93Schema,
      { model_variant: variantSchema },
      phenotypeTraitSchema,
      {
        phenotype_file: z.string().max(MAX_ALIGNMENT_CHARS).optional().describe("--phenotype-file: CSV/TSV TEXT mapping taxa to trait values (a `file://` URL over stdio); the text, never a server-side path."),
        max_species: maxSpeciesSchema,
        mds_sign: mdsSignSchema,
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
      description:
        "Status of a job returned by an analysis tool: queued | running | completed | failed | cancelled, with " +
        "timestamps, the latest progress phase, any error, and for a running hyphaeon_analyze report the " +
        "sections_ready (final sections get_results section=<name> can already serve).",
      inputSchema: { job_id: z.string().regex(/^[0-9a-f]{32}$/).describe("The job_id an analysis tool returned.") },
      annotations: { readOnlyHint: true }
    },
    async ({ job_id }) => {
      const job = jobs.get(job_id);
      if (!job) return ok({ job_id, status: "not_found" });
      if (job.analysis === "analyze") job.report_uri = "hyphaeon://report/" + job_id;
      return ok(job);
    }
  );

  // ── get_results ─────────────────────────────────────────────────────────
  server.registerTool(
    "get_results",
    {
      title: "Results of a HyphAeon job",
      description:
        "Fetch a completed job's result with the same fields / top / summary_only shaping the " +
        "analysis tools accept. For a hyphaeon_analyze report, `section` returns one section of the " +
        "ReportRecord (diagnostics, sites, gene, epistasis, attribution, filter, dms, phenotype, " +
        "provenance, timings) — also while the report is still running, once that section is final. " +
        "Results carry a provenance block whose `surface` (mcp-stdio / mcp-http) names the process " +
        "that computed them and whose `preprocessing.tree_source` says whether the distances came " +
        "from the tree or from TN93.",
      inputSchema: Object.assign({ job_id: z.string().regex(/^[0-9a-f]{32}$/).describe("The job_id to fetch.") }, shapingSchema, { section: sectionSchema }),
      annotations: { readOnlyHint: true }
    },
    async (args) => {
      const job = jobs.get(args.job_id);
      if (!job) return fail("input", "Job not found.", "Check the job_id; jobs expire after their TTL.", { job_id: args.job_id });

      if (job.analysis === "analyze") {
        if (job.status === "completed") {
          const report = jobs.result(args.job_id);
          const shaped = shapeReport(report, args, { job_id: job.job_id });
          shaped.report_uri = "hyphaeon://report/" + job.job_id;
          return ok(shaped);
        }
        if (job.status === "running" && args.section) {
          const part = jobs.partial(args.job_id);
          const ready = (part && part.sections_ready) || [];
          if (part && part.value && (ready.includes(args.section) || (args.section === "diagnostics" && part.value.diagnostics))) {
            const shaped = shapeReport(part.value, args, { job_id: job.job_id, status: "running", sections_ready: ready });
            shaped.partial = true;
            shaped.progress = job.progress;
            return ok(shaped);
          }
          return fail("input", "Section '" + args.section + "' is not final yet.", "Poll job_status; sections_ready lists what get_results can serve now.", {
            job_id: job.job_id,
            status: job.status,
            sections_ready: ready,
            progress: job.progress
          });
        }
        return fail(
          job.status === "failed" ? (job.error && job.error.kind) || "server" : "input",
          job.status === "failed" ? "The report failed: " + (job.error && job.error.message) : "Report not completed yet.",
          job.status === "failed" ? job.error && job.error.hint : "Poll job_status until status is completed, or ask for a section listed in sections_ready.",
          { job_id: job.job_id, status: job.status, sections_ready: job.sections_ready || [] }
        );
      }

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
        surface: storedSurface || surface,
        job_id: job.job_id
      });
      const shaped = shapeResult(job.analysis, stored.result, provenance, args);
      if (args.section) shaped.note = "`section` applies to hyphaeon_analyze reports only; this is a hyphaeon_" + job.analysis + " result.";
      return ok(shaped);
    }
  );

  // ── cancel_job ──────────────────────────────────────────────────────────
  server.registerTool(
    "cancel_job",
    {
      title: "Cancel a queued or running HyphAeon job",
      description: "Cancel a job. A completed job cannot be cancelled; the call reports its final status instead. Cancelling a report keeps nothing: read finished sections with get_results section=... BEFORE cancelling.",
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
        "taxon caps, ONNX contract, PRNG) read through the runtime's manifest reader, and the " +
        "engine's status: the models directory, onnxruntime-node, the MDS sign convention, how " +
        "distances are obtained without a usable tree (TN93 in the library), and which runtime " +
        "entry points this build provides. Every pillar runs in this process; nothing is shelled " +
        "out and no Python is involved.",
      inputSchema: {},
      annotations: { readOnlyHint: true }
    },
    async () => {
      const manifest = await readManifest(env);
      const native = await engine.status();
      return ok(
        Object.assign(manifest, {
          native: Object.assign({ surface, analyses: [...NATIVE_ANALYSES] }, native)
        })
      );
    }
  );
}
