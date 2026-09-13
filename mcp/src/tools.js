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
import {
  DATE_MATCH_TIERS,
  DATING_CI_METHODS,
  TEMPORAL_CURVES_MAX_POINTS,
  TEMPORAL_SECTIONS,
  TEMPORAL_SITES_MAX_ROWS,
  DATING_LATENT_NEEDS_MODEL,
  clockReadiness,
  dateGate,
  dateHeadline,
  dateReview,
  datingSummary,
  ingestFor,
  refusalHint as refusalHintFor,
  temporalSection,
  temporalSummary
} from "./time.js";
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
  // Phase 6, in the order a client uses them: review the dates first (no model, milliseconds),
  // then the clock, then temporal selection. `hyphaeon_dates`'s output is what makes the other two
  // safe — it is the only place that says which sequences got a date and by what rule.
  "hyphaeon_dates",
  "hyphaeon_dating",
  "hyphaeon_temporal",
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

/**
 * The date layer, as tool arguments. Shared by hyphaeon_dates, hyphaeon_dating and
 * hyphaeon_temporal so the three can never read a date differently.
 *
 * `dates_file` is the metadata's TEXT and `dates_file_name` its basename — the phenotype_file
 * precedent, and for the same two reasons: this process must never read a caller's disk over HTTP,
 * and an option is copied into the job store and into `provenance.options`, where a caller's
 * Auspice JSON has no business being. The NAME is an option because it is the only source of `-d`
 * on the reproduction line.
 */
const dateSourceSchema = {
  dates_file: z
    .string()
    .max(MAX_ALIGNMENT_CHARS)
    .optional()
    .describe(
      "-d/--dates: the date metadata's TEXT (a `file://` URL over stdio) — a Nextstrain Auspice JSON, a " +
        "name-to-date JSON object, or a CSV/TSV with a name column and a date column. OMIT IT and the dates are " +
        "read from the FASTA headers, which is the reference's own fallback; hyphaeon_dates says which rule read each one. " +
        "BEAST XML is refused (DATES_BEAST_XML_UNSUPPORTED): the reference reads one (dating.py:433-434) and this build does not."
    ),
  dates_file_name: z.string().max(255).optional().describe("The metadata file's basename, recorded and printed as `-d <name>` on the reproduction line."),
  date_source_kind: z
    .enum(["auto", "auspice", "json-map", "table"])
    .optional()
    .describe("How to read dates_file (default auto: the CONTENT is sniffed and the name is only a tie-break, because a metadata export named `.txt` is common and being wrong here costs a whole dataset)."),
  strain_col: z.string().max(256).optional().describe("--strain-col: the metadata column holding sequence names (default: discovered; hyphaeon_dates reports which column and why)."),
  date_col: z.string().max(256).optional().describe("--date-col: the metadata column holding dates (default: discovered)."),
  delimiter: z.string().max(4).optional().describe("The table's column separator (default: sniffed from the file's own content over its first 20 lines)."),
  date_pattern: z
    .string()
    .max(512)
    .optional()
    .describe("--date-regex: a regular expression with ONE capturing group, applied to the sequence names; the date is taken from group 1. Patterns over 512 characters are refused unrun (a ReDoS guard)."),
  date_pattern_flags: z.string().max(8).optional().describe("Flags for date_pattern (e.g. \"i\")."),
  time_units: z
    .enum(["years", "generations", "days", "arbitrary"])
    .optional()
    .describe(
      "--time-units: the time coordinate. DEFAULT IS TO INFER IT, and inferring is safer than naming it: the units " +
        "probe requires a CALENDAR MAJORITY before it calls the axis calendar, and passing this explicitly BYPASSES that " +
        "check. Measured on the bundled H1N1 set: inferred, 95 of 100 sequences date over 2009.25-2009.91; forced to " +
        "`generations`, 100 of 100 date and the axis runs from 1 to 46,241,654, every number nonsense, with no error " +
        "anywhere. If you pass a non-calendar unit, read `date_review.by_rule` before believing the span."
    ),
  archival_1959: z.boolean().optional().describe("Apply the archival-1959 offset to names that carry it (hyphaeon_dates reports DATES_ARCHIVAL_1959_AVAILABLE when any candidate exists)."),
  header_fallback: z
    .boolean()
    .optional()
    .describe(
      "Read dates from the sequence headers for taxa the supplied dates_file did not name (default true, the reference's own behaviour). " +
        "Set false to refuse rather than fill in: with it on, a table that matched nothing still produces a dated run, from DIFFERENT dates than you supplied."
    )
};

/** The two confirmation gates the browser puts to a human. src/time.js, decisions 1 and 2. */
const dateGateSchema = {
  accept_bare_numbers: z
    .boolean()
    .optional()
    .describe(
      "Confirm that dates read as a BARE NUMBER in the sequence name are the time coordinate you mean. That rule claims any " +
        "number it finds — an accession or an isolate index reads as a generation just as well — so when it accounts for " +
        "half or more of the dated set the run is REFUSED (DATES_BARE_NUMBER_MAJORITY) until you say otherwise here. " +
        "The browser asks a human this question; a tool call has nobody to ask, so it refuses rather than pick the " +
        "interpretation that produces the prettier answer. Recorded in provenance."
    ),
  drop_undated: z
    .boolean()
    .optional()
    .describe(
      "Run on the dated sequences and drop the rest. Undated sequences are dropped SILENTLY by the pillars, so a run that " +
        "did not say so answers about a different dataset than you submitted (measured: the bundled H1N1 set dates 95 of 100 " +
        "from headers, korber 142 of 143). Refused as DATES_UNDATED_PRESENT until set. Recorded in provenance."
    )
};

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
  .enum([...new Set([...REPORT_SECTIONS, ...TEMPORAL_SECTIONS])])
  .optional()
  .describe(
    "One section of a job's result. For a hyphaeon_analyze REPORT: diagnostics, sites, gene, epistasis, attribution, " +
      "filter, dms, phenotype, provenance or timings, with fields / top / summary_only applied to it; while the job is " +
      "still running, a section that is already final is served with status \"running\". For a hyphaeon_temporal run — " +
      "whose record is never returned whole, because its trajectory store alone is megabytes — one of " +
      TEMPORAL_SECTIONS.join(", ") + "; `sites` and `curves` also take `sites` (1-indexed codons) and `top`."
  );

const runAsyncSchema = z
  .boolean()
  .optional()
  .describe("Force the run into a background job and return a job id even under the synchronous caps.");

/**
 * THE NOT-YET-FINISHED REPLY IS A SHAPE OF ITS OWN, and it says so in `shape`.
 *
 * `hyphaeon_temporal` with `wait_seconds: 1` used to answer with the job store's public view plus
 * a `next` that named `get_results job_id=... section=summary` — a call that cannot succeed on a
 * job that is still running, because the temporal record has no section until the run ends (the
 * calls, the counts and the wave modes are all computed after the null). A client following it
 * got an input error telling it to poll, which is what the reply should have said in the first
 * place. So a reply that is NOT the analysis carries:
 *
 *   - `shape: "pending"`, so a client can switch on one key instead of sniffing for `summary`;
 *   - `analysis`, `job_id`, `status` (queued | running), `queue_position` / `progress` /
 *     `elapsed_sec` from the store, and `reason`;
 *   - `sections`, the vocabulary the record WILL be read through, and `sections_ready: []`, which
 *     for this pillar is empty until the run completes and is not a placeholder for an empty list
 *     that might fill in;
 *   - `next`, naming the ONLY call that works now (`job_status`), then the one that works after.
 *
 * `hyphaeon_analyze`'s own still-running reply is not this shape: its report streams, so `next`
 * naming `get_results section=` is true there the moment a section is final.
 */
function pendingBody(job, analysis, config, extra = {}) {
  const sections = config.sections || [];
  const vocab = sections.length ? " section=<" + sections.join("|") + ">" : "";
  // WHY NOTHING CAN BE SERVED YET is the pillar's own fact, not a generic one, so it comes from
  // the registration; a pillar that streams sections would say something different here and must
  // not inherit temporal's sentence.
  const why =
    config.pendingBecause ||
    "this run has produced nothing a client can read yet";
  return Object.assign({}, job, {
    shape: "pending",
    analysis,
    engine: "in-process",
    result_available: false,
    sections: [...sections],
    sections_ready: [],
    next:
      "job_status job_id=" + job.job_id + " until status is completed — " + why + ". Then get_results job_id=" +
      job.job_id + vocab + " (fields / top / summary_only / sites apply). The record is never returned inline: its " +
      "trajectory store alone is megabytes. cancel_job stops it, and what the runtime has finished by then is KEPT " +
      "and served as a partial run."
  }, extra);
}

/** The hint on a cancel that kept nothing: never "poll until completed", which can never happen. */
const CANCELLED_HINT =
  "This job was cancelled and can never reach `completed`, so polling job_status will not change the answer. The " +
  "runtime kept nothing from it: the cancel arrived before the first permutation chunk finished, and everything " +
  "downstream of the null is computed at the end. Submit the run again — with a smaller n_permutations or a coarser " +
  "time_points if it was stopped for taking too long.";

/**
 * A cancelled-but-kept run's envelope: the analysis body the shaper built, re-labelled so it can
 * never be read as a full run, with the achieved count on it. See src/jobs.js's header and
 * src/time.js `temporalPartialNote` for what the runtime actually kept.
 */
function partialBody(shaped, stored, jobId, next) {
  const out = Object.assign({}, shaped, {
    job_id: jobId,
    status: "cancelled",
    partial_result: true,
    next
  });
  const honesty = (stored && stored.result && stored.result.honesty) || out.honesty || null;
  const truncated = honesty && honesty.null_truncated ? honesty.null_truncated : null;
  out.partial = truncated
    ? Object.assign({ cancelled: true }, truncated, {
        reason: "cancel_job was called while this run was in flight. The runtime caught its own abort, classified at " +
          "the draws it had finished and returned a complete record; this surface keeps it rather than throwing the " +
          "work away, and labels it."
      })
    : {
        cancelled: true,
        completed: null,
        requested: null,
        reason: "cancel_job was called while this run was in flight and the runtime returned what it had. Read " +
          "`honesty` for what is final and what is not.",
        note: "The run did not do what it was asked; nothing here may be quoted as a full run."
      };
  return out;
}

// ── result shaping ─────────────────────────────────────────────────────────

/** Ranked collections per analysis and the key they are ranked by (PLAN.md Appendix B). */
const RANKED = {
  meme: { sites: "hyphaeon_lrt" },
  busted: { sites_detail: "hyphaeon_lrt" },
  epistasis: { edges: "cesi", sectors: "spectral_coherence", plasticity: "intrinsic_plasticity" },
  dms: { plasticity: "intrinsic_plasticity" },
  phenotype: { sites: "score", trait_sectors: "spectral_coherence", coselection_pairs: "cesi" },
  evaluate: { per_gene: null },
  // The clock's one collection is the per-taxon table, and its rank key is DELIBERATELY null so
  // `top` slices it in ALIGNMENT order. The reader's order is outlier-first then |z| descending
  // (runtime `rankTaxonRows`), which no single descending numeric key expresses — ranking by
  // `z_score` would put the most positive residual first and bury the most negative, which is the
  // same outlier. The record stays in the reference's own order so a download diffs against a CLI
  // run, and the summary carries `top_outliers` for the rows a reader looks at first.
  dating: { taxa_summary: null },
  // TEMPORAL HAS NO ENTRY HERE ON PURPOSE. Its site columns are TYPED ARRAYS in a column store,
  // not arrays of records, so `topBy` would slice one and drop the ranking silently — a plausible
  // object that is not the analysis. Its record is paged through `get_results section=` instead
  // (src/time.js TEMPORAL_SECTIONS), which is also why it is never answered inline.
  temporal: {}
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
    case "dating": {
      const summary = datingSummary({ record: result.record, rows: result.taxa_summary, warnings: result.warnings });
      // The honesty block travels with the numbers even in a summary: `t_mrca` is meaningless
      // without the distance mode it came from (measured twelve years apart on the same file).
      return Object.assign(summary, {
        date_review: result.date_review ? pick(result.date_review, ["source", "time_units", "time_units_source", "coverage", "by_rule", "span"]) : null,
        honesty: result.honesty || null
      });
    }
    case "temporal":
      // The record is never inline (src/time.js, decision 6), so a temporal "summary" is the
      // reference's own eighteen summary keys plus the honesty block, and the sections are reached
      // with get_results section=<summary|sites|curves|waves|permutations|dates|candidates|warnings|honesty|provenance>.
      return Object.assign({ summary: temporalSummary(result.record), honesty: result.honesty || null }, result.date_review ? { date_review: pick(result.date_review, ["source", "time_units", "time_units_source", "coverage", "by_rule", "span"]) } : {});
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
    // `ok` AND `honesty` SURVIVE SHAPING. Measured before this change: hyphaeon_dating with
    // summary_only came back as [analysis, summary, collections, provenance] — 16,356 B against
    // 85,899 — so a client that reads `body.ok` to decide whether the run happened found nothing,
    // and one that reads `body.honesty` for the distance mode found it only if it knew to look
    // inside `summary`. Both are at the same path in both envelopes now; `summary.honesty` stays
    // where it was so a summary block is still readable on its own.
    const out = { analysis, summary: summarise(analysis, result), collections, provenance };
    if (result && typeof result === "object") {
      if (result.ok !== undefined) out.ok = result.ok;
      if (result.honesty !== undefined) out.honesty = result.honesty;
    }
    return out;
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
  if (analysis === "dating") boundDatingBody(out);
  return out;
}

/**
 * THE CLOCK'S INLINE BOUND, MEASURED. `hyphaeon_dating` had none: every other pillar either fits
 * (meme, busted, evaluate), is ranked and truncated by `top` (epistasis, dms, phenotype) or is
 * always a job (analyze, temporal), and the clock fell between the two — its result is O(taxa) and
 * the taxon ceiling is MAX_TAXA = 1,000.
 *
 * MEASURED in this session, model-free, on synthetic dated sets of 300 codons (the table's width
 * does not depend on the codon count):
 *
 *   taxa    whole body    top-level taxa_summary    record.taxa_summary    everything else
 *   250     192,603 B     89,120 B (356 B a row)    the same 89,120 B      ~14,400 B
 *   500     371,019 B     178,332 B (357 B)         the same               ~14,400 B
 *   1000    750,846 B     366,524 B (367 B)         the same               ~17,800 B
 *
 * Two facts fall out of that table. THE TABLE IS IN THE BODY TWICE — `taxa_summary` at the top
 * level is `record.taxa_summary`, the same rows — so `top`, which ranks and slices the top-level
 * copy only, bounded nothing: measured, `top: 50` on the 1,000-taxon run still returned 402,728 B.
 * And a row is 356-367 B, so the envelope decides the row count rather than the other way round.
 *
 * The bound is ANALYZE_INLINE_MAX_BYTES, the same 262,144-byte envelope every other tool result
 * answers inside, and it is applied in two steps, each of them SAID rather than done quietly:
 * the duplicate inside `record` is replaced by a marker naming where the rows are, and then the
 * remaining table is cut to the rows that fit, in the reference's own alignment order, with
 * `truncated.taxa_summary` naming the calls that get the rest. `summary.top_outliers` already
 * carries the ten rows a reader looks at first (flagged, held out, then |z| descending), so the
 * rows that matter most are never the ones the cut removes.
 */
function boundDatingBody(out) {
  if (!out || typeof out !== "object") return;
  const bytes = () => Buffer.byteLength(JSON.stringify(out));
  const before = bytes();
  if (before <= ANALYZE_INLINE_MAX_BYTES) return;
  const notes = {};

  const rec = out.record;
  const dup = rec && Array.isArray(rec.taxa_summary) ? rec.taxa_summary : null;
  if (dup && Array.isArray(out.taxa_summary)) {
    // A COPY, NEVER THE STORED RECORD. `out` is a shallow copy of the engine's result, so
    // `out.record` is the stored object itself and writing through it would edit the job store's
    // own record — the next get_results on the same job would find the marker instead of the rows.
    out.record = Object.assign({}, rec);
    out.record.taxa_summary = {
      omitted: true,
      rows: dup.length,
      reason:
        "The per-taxon table is in this body twice (`taxa_summary` at the top level is `record.taxa_summary`, the same " +
        "rows), which alone was " + Math.round((Buffer.byteLength(JSON.stringify(dup)) / 1024)) + " KB of a result over the " +
        Math.round(ANALYZE_INLINE_MAX_BYTES / 1024) + " KB a tool result may carry. Read the top-level `taxa_summary`."
    };
    notes.record_taxa_summary = "omitted (duplicated at the top level)";
  }

  if (bytes() > ANALYZE_INLINE_MAX_BYTES && Array.isArray(out.taxa_summary) && out.taxa_summary.length) {
    const rows = out.taxa_summary;
    const total = rows.length;
    const rowBytes = Math.max(1, Math.round(Buffer.byteLength(JSON.stringify(rows)) / total));
    const overhead = bytes() - Buffer.byteLength(JSON.stringify(rows));
    let fits = Math.max(1, Math.floor((ANALYZE_INLINE_MAX_BYTES - overhead) / rowBytes));
    if (fits < total) {
      // MEASURE, THEN CUT AGAIN IF THE MARKERS PUSHED IT BACK OVER. The `truncated` block and the
      // `inline_bound` note are themselves ~600 B that the first estimate does not contain, and a
      // row is not exactly the average row, so the count is checked against the real serialisation
      // rather than trusted: measured, the first estimate landed at 262,460 B on the 1,000-taxon
      // set, 316 B over, and the second pass at 261,720 B with 663 of the 1,000 rows.
      const apply = (n) => {
        out.taxa_summary = rows.slice(0, n);
        out.truncated = Object.assign({}, out.truncated, {
          taxa_summary: {
            returned: n,
            total,
            ranked_by: "alignment order (the reference's own; `top` uses the same order)",
            note:
              "The whole result was " + before + " B, above the " + ANALYZE_INLINE_MAX_BYTES + " B a tool result may carry, and a " +
              "row is about " + rowBytes + " B. The rows a reader looks at first are not in this cut's way: summary_only: true " +
              "returns the headline plus `top_outliers` (flagged, then held out, then |z| descending), `fields` drops the table " +
              "entirely, and `top: n` asks for n rows in this same order."
          }
        });
        notes.taxa_summary = n + " of " + total + " rows";
        out.inline_bound = { limit_bytes: ANALYZE_INLINE_MAX_BYTES, was_bytes: before, applied: Object.assign({}, notes) };
      };
      apply(fits);
      for (let guard = 0; guard < 8 && bytes() > ANALYZE_INLINE_MAX_BYTES && fits > 1; guard++) {
        fits = Math.max(1, fits - Math.ceil((bytes() - ANALYZE_INLINE_MAX_BYTES) / rowBytes) - 1);
        apply(fits);
      }
    }
  }
  if (Object.keys(notes).length) out.inline_bound = { limit_bytes: ANALYZE_INLINE_MAX_BYTES, was_bytes: before, applied: notes };
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

const INPUT_KEYS = ["alignment", "tree", "phenotype_file", "dates_file", "prediction", "meme_result"];
const NON_OPTION_KEYS = new Set([...INPUT_KEYS, "fields", "top", "summary_only", "section", "run_async", "wait_seconds"]);

/**
 * The tool's options: everything that is not an input document and not a shaping argument.
 *
 * `extra` exists for one case and is worth the parameter: `sites` is a real RUN option on
 * hyphaeon_dms (which codons to sweep) and a pure SHAPING argument on hyphaeon_temporal (which
 * codons a `sites` / `curves` section is about). Left in the generic set it would vanish from the
 * DMS request; left out of it, a temporal run would record `options.sites` in provenance and claim
 * the run had been restricted to those codons, which it was not.
 */
function optionsOf(args, extra = null) {
  const out = {};
  for (const [k, v] of Object.entries(args)) if (!NON_OPTION_KEYS.has(k) && !(extra && extra.has(k)) && v !== undefined) out[k] = v;
  return out;
}

/** The pre-run sizing every analysis tool shares: parse once, probe, classify; null when refused. */
function sizeRun(analysis, inputs, args, capOptions = {}) {
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
  const cls = classifyRun(analysis, { codons: probe.codons, taxa: parsed.sequences.length }, capOptions);
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
        "FOR `dates`, `dating` AND `temporal` IT ALSO READS THE DATES — the date layer's own refusals " +
        "(DATES_NONE, DATES_TOO_FEW, DATE_REGEX_*, ...), the two override gates a tool call has nobody to ask " +
        "(DATES_BARE_NUMBER_MAJORITY, DATES_UNDATED_PRESENT; INFO for `dates`, whose job is to report them, refuse " +
        "for the two analyses), and whether the dated set carries a clock at that pillar's own threshold (three " +
        "sequences to regress, five to survey, temporal.py:474) — with `summary.dates` saying what was read, by " +
        "which rule, over what span. Pass the same date arguments you mean to run with. No model is loaded either way. " +
        "Returns {ok, warnings:[{code, severity, message, data}], summary}; severity is info | " +
        "warn | refuse, and ok is false when anything refuses. Codes are stable across surfaces. " +
        "hyphaeon_analyze runs these same checks itself and records them in the report.",
      inputSchema: Object.assign(
        {
          alignment: alignmentSchema,
          tree: treeSchema,
          analysis: z
            .enum(["analyze", "meme", "busted", "epistasis", "dms", "phenotype", "dates", "dating", "temporal"])
            .optional()
            .describe(
              "Which analysis the cost estimate and caps are for (default meme; `analyze` is the whole report). " +
                "`dates` reads sequence NAMES and no codon, so its work term is 0 and its cost is milliseconds; " +
                "`dating`'s default path is model-free (O(taxa x codons), not a per-site forward pass) and is sized as such. " +
                "`dates`, `dating` and `temporal` additionally run the DATE LAYER — pass the same date arguments you mean to " +
                "run with, or this check answers about a different date set than the run will see."
            ),
          max_species: maxSpeciesSchema
        },
        { use_tn93: tn93Schema.use_tn93 },
        // The date arguments, so a client can validate with the exact arguments it will run with.
        // They are read only for the three analyses that have a date layer.
        dateSourceSchema,
        dateGateSchema
      ),
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async (args) => {
      try {
        const alignment = (await resolveText(args.alignment, "alignment", allowFilePaths)).text;
        const tree = (await resolveText(args.tree, "tree", allowFilePaths)).text;
        const datesFile = await resolveText(args.dates_file, "dates_file", allowFilePaths);
        const out = diagnose({
          alignment,
          tree,
          analysis: args.analysis || "meme",
          use_tn93: !!args.use_tn93,
          max_species: args.max_species,
          dates: Object.assign(optionsOf(args, new Set(["alignment", "tree", "analysis", "use_tn93", "max_species"])), {
            dates_file: datesFile.text,
            dates_file_name: args.dates_file_name || datesFile.name || null
          })
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

  // ── hyphaeon_dates ──────────────────────────────────────────────────────
  //
  // THE CHEAPEST TOOL IN THE SERVER, AND THE ONE A CLIENT CALLS FIRST. It runs no model, loads no
  // graph and never reaches src/engine.js: `ingestFor` (src/time.js) goes straight to the runtime's
  // `./dates` subpath, which imports no manifest, no session and no predict.js — measured at 93 ms
  // of module import with ZERO onnxruntime modules loaded, and 3-24 ms of work on the bundled
  // examples. So it answers on a checkout with no models/ at all, which is the point: its output is
  // what makes the other two safe.
  server.registerTool(
    "hyphaeon_dates",
    {
      title: "Read the dates off an alignment, and say how",
      description:
        "THE DATE REVIEW STAGE, as data. Reads a sampling date for every sequence — from the FASTA headers, a " +
        "Nextstrain Auspice JSON, a name-to-date JSON object, a CSV/TSV table, or a pattern you supply — and reports " +
        "WHICH RULE dated each sequence, which did not match, what was imputed (a missing month or day), which " +
        "metadata rows named no sequence, and whether the set carries a clock at all. Runs NO MODEL and loads no " +
        "graph: milliseconds, on any checkout. " +
        "Returns {ok, headline, clock, date_review{coverage, by_rule, span, match_tiers, unmatched_metadata, " +
        "unmatched_taxa, table, auspice, regex, rows[], warnings[]}, gate}. `rows[]` is one entry per sequence with " +
        "its raw string, parsed value, rule, source, match tier and imputation flags — never a subset that hides an " +
        "undated sequence. Warning codes are the date layer's own (DATES_* / DATE_*), stable across surfaces. " +
        "`gate` is what hyphaeon_dating and hyphaeon_temporal will REFUSE on unless you override it: dates read " +
        "mostly as bare numbers in the sequence name (DATES_BARE_NUMBER_MAJORITY -> accept_bare_numbers) and " +
        "undated sequences that would be dropped silently (DATES_UNDATED_PRESENT -> drop_undated). This tool " +
        "itself never refuses for either: reporting them is its job. " +
        "Note the time units: they are INFERRED by default from a calendar-majority rule, and passing time_units " +
        "explicitly bypasses that check — measured on the bundled H1N1 set, forcing `generations` dates 100 of 100 " +
        "sequences on an axis running from 1 to 46,241,654 with no error anywhere.",
      inputSchema: Object.assign(
        {
          alignment: alignmentSchema,
          rows: z.boolean().optional().describe("Return the per-sequence rows (default true). With false, only the counts, the rule table and the warnings."),
          top: z.number().int().min(1).max(100000).optional().describe("Cap the rows returned; undated, imputed and fuzzily matched sequences are kept first and the counts always cover every sequence.")
        },
        dateSourceSchema,
        dateGateSchema
      ),
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async (args) => {
      try {
        const inputs = {};
        const names = {};
        for (const k of ["alignment", "dates_file"]) {
          if (args[k] !== undefined) {
            const r = await resolveText(args[k], k, allowFilePaths);
            inputs[k] = r.text;
            if (r.name) names[k] = r.name;
          }
        }
        const options = optionsOf(args);
        const ingest = ingestFor({
          alignment: inputs.alignment,
          dates_file: inputs.dates_file,
          dates_file_name: names.dates_file || options.dates_file_name || null,
          options
        });
        const review = dateReview(ingest, { rows: args.rows !== false, rowsMax: args.top });
        const gate = dateGate(ingest, options);
        const clock = clockReadiness(ingest);
        const body = {
          analysis: "dates",
          ok: ingest.ok,
          headline: dateHeadline(ingest),
          clock,
          gate,
          date_review: review,
          match_tiers_available: DATE_MATCH_TIERS,
          next: ingest.ok
            ? (gate.ok
                ? "hyphaeon_dating (the molecular clock; model-free by default) and, with 5+ dated sequences, hyphaeon_temporal (per-site selection through calendar time). Pass the same date arguments you passed here."
                : "Read `gate.blocking`: hyphaeon_dating and hyphaeon_temporal refuse this date set until you pass the named override, or supply better metadata.")
            : "Fix the refusal in date_review.warnings (severity `refuse`) before calling hyphaeon_dating or hyphaeon_temporal.",
          engine: "in-process (no model, no graph)"
        };
        logger.info("hyphaeon_dates ok=" + ingest.ok + " dated=" + ingest.coverage.dated + "/" + ingest.coverage.taxa_total + " source=" + ingest.source + " units=" + ingest.time_units);
        return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }], isError: !ingest.ok };
      } catch (err) {
        if (err instanceof ToolInputError) return fail("input", err.message, err.hint);
        logger.error("hyphaeon_dates failed: " + ((err && err.message) || err));
        return fail("server", "The date layer could not run: " + ((err && err.message) || err));
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
          const options = optionsOf(args, config.nonOptionKeys);
          let mode = args.run_async ? "job" : "sync";
          let size = null;

          let treeSource = null;
          if (analysis !== "evaluate") {
            // `dating` is sized differently with and without the model pass (src/caps.js workFor):
            // model-free is O(taxa x codons), the taxa-graph pass is the ordinary per-site term.
            const sized = sizeRun(analysis, inputs, args, { useModel: args.use_model === true });
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

            // M5 / decision 4: `distance_mode: "latent"` is the MODEL'S space, so without
            // `use_model` there is no graph to take it from. The runtime throws a RangeError
            // naming its own argument ("pass `neural`, the object runDatingModelPass returns",
            // runtime/src/dating/run.js:282) — an internal API this caller cannot pass and a
            // message with no code on it. Refused here instead, in the vocabulary the tool speaks.
            if (analysis === "dating" && args.distance_mode === "latent" && args.use_model !== true) {
              return fail(
                "input",
                "`distance_mode: \"latent\"` needs the model pass: the latent root is a position in the model's own representation space, and this run was not asked to make one (use_model is false).",
                refusalHintFor(DATING_LATENT_NEEDS_MODEL),
                { code: DATING_LATENT_NEEDS_MODEL, distance_mode: "latent", use_model: false }
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

            // THE DATE GATE, BEFORE A MODEL LOADS (the phenotype trait gate's own place in this
            // dispatcher, for the same reason). The engine applies it again on the real ingest —
            // this is the cheap pass that keeps a refusable run from reaching a 7 MB graph, and it
            // is also what puts the review block in the REFUSAL, so a client that got it wrong is
            // handed the rule table rather than told to go and ask for it.
            if (analysis === "dating" || analysis === "temporal") {
              let ingest;
              try {
                ingest = ingestFor({ alignment: inputs.alignment, dates_file: inputs.dates_file, dates_file_name: names.dates_file || options.dates_file_name || null, options });
              } catch (e) {
                return fail("server", "The date layer could not run: " + ((e && e.message) || e));
              }
              if (!ingest.ok) {
                const refuse = ingest.warnings.find((w) => w.severity === "refuse");
                return fail("input", (refuse && refuse.message) || "No sequence could be dated.", refuse ? refusalHintFor(refuse.code) : undefined, {
                  code: (refuse && refuse.code) || "DATES_NONE",
                  date_review: dateReview(ingest, { rows: false })
                });
              }
              const gate = dateGate(ingest, options);
              if (!gate.ok) {
                const first = gate.blocking[0];
                return fail("input", first.message, first.hint, {
                  code: first.code,
                  blocking: gate.blocking,
                  date_headline: dateHeadline(ingest),
                  date_review: dateReview(ingest, { rows: false })
                });
              }
              const clock = clockReadiness(ingest);
              const reasons = analysis === "temporal" ? clock.temporal_reasons : clock.reasons;
              if (reasons.length) {
                // THE HINT IS THE CODE'S OWN, NOT A NEIGHBOUR'S. This branch used to hand every
                // refusal `DATES_TOO_FEW`'s hint — "At least 3 sequences must carry a date" —
                // under the code TEMPORAL_TOO_FEW_DATED, whose message says five (temporal.py:474
                // raises at N < 5, verified in the reference). A caller who added a fourth date on
                // that advice would be refused again.
                const code = analysis === "temporal" ? "TEMPORAL_TOO_FEW_DATED" : "DATING_TOO_FEW_DATED";
                return fail("input", "This date set carries no usable clock for hyphaeon_" + analysis + ": " + reasons.join("; ") + ".", refusalHintFor(code), {
                  code,
                  date_headline: dateHeadline(ingest),
                  date_review: dateReview(ingest, { rows: false })
                });
              }
            }
          }

          logger.info(
            name + " engine=in-process mode=" + mode + (treeSource ? " tree=" + treeSource : "") +
              (size ? " sequences=" + size.sequences + " codons=" + size.codons + " work=" + size.work.toExponential(2) : "")
          );

          const request = Object.assign({ analysis, options, names }, inputs);
          const execute = (signal, report) => engine.run(Object.assign({ signal, surface, progress: report }, request));

          // A pillar whose RESULT is never small enough to inline runs as a job whatever the caps
          // said, and then WAITS inside the call so the common case still answers in one turn.
          // Today that is temporal only: measured, its record is 2.1 MB on the smallest bundled
          // example and 7.2 MB on the engine's own acceptance run, 8x and 27x the inline limit.
          if (config.alwaysJob && mode !== "job") mode = "job";
          if (mode === "job" && config.alwaysJob) {
            const job = jobs.create({ analysis, options, run: (signal, report) => execute(signal, report) });
            const jobId = job.job_id;
            const waitSec = args.run_async ? 0 : args.wait_seconds !== undefined ? args.wait_seconds : ANALYZE_WAIT_DEFAULT_SEC;
            const next =
              "Poll job_status with this job_id; get_results job_id=... section=<" + (config.sections || []).join("|") +
              "> pages the record (fields / top / summary_only / sites apply). The whole record is never returned inline: " +
              "its trajectory store alone is megabytes.";
            if (waitSec <= 0) {
              logger.info(name + " queued job_id=" + jobId);
              return ok(pendingBody(jobs.get(jobId) || job, analysis, config, { reason: args.run_async ? "run_async requested." : "wait_seconds is 0.", tree_source: treeSource }));
            }
            const done = await jobs.wait(jobId, waitSec * 1000);
            if (done && done.status === "completed") {
              const stored = jobs.result(jobId);
              const shaped = await config.shape(stored.result, stored.provenance, args, { job_id: jobId, next });
              logger.info(name + " done job_id=" + jobId + " in " + done.elapsed_sec + "s");
              return ok(shaped);
            }
            if (done && done.status === "failed") {
              return fail((done.error && done.error.kind) || "server", "The run failed: " + (done.error && done.error.message), done.error && done.error.hint, {
                job_id: jobId,
                status: "failed",
                code: done.error && done.error.code
              });
            }
            if (done && done.status === "cancelled") {
              // THE CANCEL DID NOT NECESSARILY THROW THE ANSWER AWAY (src/jobs.js header): a
              // temporal run stopped mid-null resolves with a complete record at the achieved draw
              // count. `wait` waits for the runner to unwind, so by here the store knows which
              // happened. Never a "completed" status and never without the count.
              const kept = jobs.kept(jobId);
              if (kept) {
                const shaped = await config.shape(kept.value.result, kept.value.provenance, args, { job_id: jobId, next });
                logger.info(name + " cancelled with a partial record job_id=" + jobId);
                return ok(partialBody(shaped, kept.value, jobId, next));
              }
              return fail("input", "The run was cancelled before it produced anything.", CANCELLED_HINT, {
                job_id: jobId,
                status: "cancelled",
                partial_result: false,
                result_available: false
              });
            }
            return ok(
              pendingBody(jobs.get(jobId) || done, analysis, config, {
                reason: "The run did not finish within wait_seconds (" + waitSec + " s).",
                waited_seconds: waitSec
              })
            );
          }

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


  registerAnalysis("hyphaeon_dating", "dating", {
    title: "HyphAeon molecular clock and MRCA dating (ChronAeon)",
    description:
      "Heterochronous molecular clock from dated sequences: a root-to-tip regression against sampling time, the " +
      "substitution rate mu with its interval, the MRCA date t_mrca with a Fieller / delta / linear confidence " +
      "interval, a restricted-cubic-spline alternative adjudicated against the line, an ensemble, and a per-taxon " +
      "table with each sequence's divergence, predicted date, temporal residual, z-score and outlier flag. " +
      "MODEL-FREE BY DEFAULT and that is a scientific choice, not a performance one: with `use_model: true` the " +
      "run first makes one forward pass over every codon through a SECOND graph (<variant>_taxa.onnx) and the " +
      "estimator becomes the latent-root one, which is a DIFFERENT ANSWER on the same data — measured upstream on " +
      "the korber example, t_mrca 1938.77 model-free against 1926.81 with the graph, twelve years apart, with the " +
      "whole warning set changing. `distance_mode` and `distance_mode_reason` are on every result; quote the mode " +
      "with the date. If this build declares no dating graph, use_model: true fails with DATING_GRAPH_UNAVAILABLE " +
      "naming that fact rather than quietly answering with the other estimator (list_models reports `dating_graph` " +
      "per variant). " +
      "TAKES NO TREE, on any surface (PLAN-TEMPORAL D34 declines the reference's --distance-mode tree), so the " +
      "reproduction line always carries --no-tree. " +
      "DATES: pass dates_file (an Auspice JSON or a CSV/TSV) or let the FASTA headers be read; call hyphaeon_dates " +
      "FIRST to see which rule dated each sequence. The run REFUSES a date set whose dates are mostly bare numbers " +
      "in the sequence name (accept_bare_numbers) or that leaves sequences undated (drop_undated), because both " +
      "would otherwise change the answer silently. " +
      "`provenance.reference_command` is a {command, reproduces, caveats} OBJECT, not the argv array the other " +
      "pillars carry: `reproduces` is false whenever the dates came from headers, because this build's date layer " +
      "is the union of all three upstream parsers and reads names `hyphaeon dating` cannot (measured on korber: 142 " +
      "of 143 by a rule the reference does not have). `record.primaeon.estimators_not_built` names what this build " +
      "does not estimate (the power-law clock, LOOCV/jackknife, and without the graph the attention PGLS and the " +
      "latent root search) so no flag for them is ever printed. " +
      "Answers inside the call: measured at 85 ms on the 143-sequence korber example model-free; with use_model the " +
      "graph pass dominates (about 9 s on the same file).",
    inputSchema: Object.assign(
      { alignment: alignmentSchema },
      dateSourceSchema,
      dateGateSchema,
      {
        use_model: z
          .boolean()
          .optional()
          .describe(
            "Run the model-based estimators (attention PGLS and the latent-root search) as well, which needs the " +
              "second ONNX artifact <variant>_taxa.onnx and one forward pass over EVERY codon. Default false. This is " +
              "a different estimator, not a better-quality version of the same one: see the description."
          ),
        distance_mode: z
          .enum(["auto", "tn93", "latent"])
          .optional()
          .describe(
            "--distance-mode: `auto` (default) is `latent` when use_model is set and `tn93` when it is not; naming " +
              "`latent` without use_model is refused rather than silently downgraded. The reference's `tree` mode is " +
              "declined (D34: this pillar takes no tree)."
          ),
        clock_model: z.enum(["auto", "linear", "spline"]).optional().describe("--clock-model: `auto` (F-test/AIC against a 2-DF restricted natural cubic spline), `linear`, or `spline`. The reference's `power` is not ported (PLAN-TEMPORAL D33) and is refused by this enum rather than silently answered with `auto`."),
        ci_method: z
          .enum([...DATING_CI_METHODS])
          .optional()
          .describe(
            "--ci-method for t_mrca: " + DATING_CI_METHODS.join(", ") + " (default fieller, exact analytical ratio-test inversion). " +
              "The reference's poisson, residual-boot, site-boot and jackknife intervals each need a bit-compatible mirror of numpy's " +
              "PCG64 and are refused here rather than silently substituted with Fieller, which is what the reference does for an " +
              "unrecognised value (dating.py:1244-1258)."
          ),
        root_taxon: z
          .string()
          .max(256)
          .optional()
          .describe("--root-taxon: a sequence name, or one of the reference's magic strings (unweighted_consensus, flat_consensus, modal_consensus, earliest, earliest_taxon, earliest_cohort). Default: the time-decay weighted consensus."),
        decay_gamma: z.number().optional().describe("--decay-gamma: exponential decay rate for the time-decay weighted consensus root (default 0.05 or auto-scaled)."),
        excluded_taxa: z.array(z.string().max(256)).max(10000).optional().describe("App-side: sequences to leave out of the fit. Never silent — they are reported as DATING_TAXA_EXCLUDED."),
        allow_stop_codons: z.boolean().optional().describe("Tolerate internal stop codons (default true, as upstream); false refuses the alignment instead."),
        no_auto_trim: z.boolean().optional().describe("Do not trim a trailing partial codon (default: trim, and say so as DATING_ALIGNMENT_TRIMMED)."),
        model_variant: variantSchema,
        cpu: cpuSchema
      }
    )
  });

  registerAnalysis("hyphaeon_temporal", "temporal", {
    title: "HyphAeon temporal selection surveillance",
    description:
      "Per-site selection through CALENDAR TIME: a smoothed prevalence trajectory and a sweep velocity per codon " +
      "over a dense time grid, peak date and intensity, half-rise and half-fall times, FWHM and area, a two-stage " +
      "filter (an energy floor, then a date-shuffling permutation null with BH q), an fPCA decomposition into four " +
      "dynamic wave modes, and a four-way classification of each codon against the static MEME-surrogate call. " +
      "ALWAYS RUNS AS A JOB and is NEVER returned inline: measured, the record is 2.1 MB on the smallest bundled " +
      "example (98 taxa x 566 codons at the reference's own --time-points 250) and 7.2 MB on the engine's " +
      "4,384-codon acceptance run, 8x and 27x the inline limit, of which the trajectory store alone is 92%. The " +
      "call waits up to wait_seconds and answers with the SUMMARY plus the job id; get_results job_id=... " +
      "section=<" + TEMPORAL_SECTIONS.join("|") + "> pages the rest (`sites` and `curves` take a `sites` list, " +
      "default the stage-one candidates strongest first; `curves` is budgeted at " + TEMPORAL_CURVES_MAX_POINTS +
      " numbers a call — 75 codons at time_points 60, 18 at 250, measured at 13.5 to 22.6 bytes a number depending on " +
      "the trajectory — and `sites` at " + TEMPORAL_SITES_MAX_ROWS + " rows). " +
      "A call that has not finished inside wait_seconds answers with a shape of its own — `shape: \"pending\"`, the job " +
      "id, the status and a `next` naming job_status, which is the only call that works before the run ends, since " +
      "every call, count and wave mode is computed after the null. cancel_job STOPS THE NULL WITHOUT THROWING THE " +
      "RUN AWAY: the runtime classifies at the draws it finished and returns a complete record, which this server " +
      "keeps and get_results then serves with `status: \"cancelled\"`, `partial_result: true` and the achieved count. " +
      "HONESTY, on every result and every section, in `honesty`: `null_state` is one of not-started | running | " +
      "finished | stopped and is the ONLY thing that says whether a negative finding is a result — " +
      "`permutations.tested` flips true after the first chunk while the calls are still zeros, so reading it alone " +
      "prints \"nothing is under selection\" a second into every run. `p_perm` and `q_perm` are 1.0 at every codon " +
      "that never reached stage two, which is the reference's own fill (temporal.py:620-621) and NOT a measurement; " +
      "read them only at the candidates `sites.stage1` marks. The wave variance shares are conditioned on the " +
      "confirmed-sweep set, which is thresholded on a permutation p drawn from a different generator than the " +
      "reference's, so they move with the null: measured upstream, 32 confirmed here against 18 there on H1N1 at " +
      "B = 100, shares differing by 5.8 points on the leading mode. `escape_hatch_used` is the reference's silent " +
      "fallback selection, recorded in no upstream file. " +
      "`provenance.reference_command` is a {command, reproduces, caveats} OBJECT, not the argv array the other " +
      "pillars carry, and `reproduces` is FALSE on every run whose null drew at all. " +
      "DATES: pass dates_file or let the headers be read; call hyphaeon_dates first. The run refuses on the same " +
      "two gates hyphaeon_dating does, and needs at least 5 dated sequences AFTER duplicate collapse and the " +
      "taxon cap. A tree is optional (D22). No taxon cap is applied unless you ask for one: Faith's-PD subsampling " +
      "is TIME-BLIND (D27) and can delete the early part of an epidemic, which is the part a sweep is measured " +
      "against.",
    alwaysJob: true,
    sections: TEMPORAL_SECTIONS,
    pendingBecause:
      "nothing of a temporal run can be served before it ends, because the calls, the three sweep counts and the wave " +
      "modes are all computed after the date-shuffling null finishes",
    // `sites` shapes a SECTION here; it does not restrict the run (see optionsOf).
    nonOptionKeys: new Set(["sites"]),
    shape: async (result, provenance, args, meta) => {
      const record = result.record;
      const head = {
        analysis: "temporal",
        job_id: meta.job_id,
        status: "completed",
        stage: record.stage,
        sections: TEMPORAL_SECTIONS,
        next: meta.next
      };
      if (args.section) {
        const rt = typeof engine.runtimeBag === "function" ? await engine.runtimeBag() : {};
        return Object.assign(head, temporalSection(record, args.section, args, rt), { provenance });
      }
      return Object.assign(head, {
        summary: temporalSummary(record),
        honesty: result.honesty,
        date_review: result.date_review,
        provenance
      });
    },
    inputSchema: Object.assign(
      { alignment: alignmentSchema, tree: treeSchema },
      tn93Schema,
      dateSourceSchema,
      dateGateSchema,
      {
        model_variant: variantSchema,
        max_species: maxSpeciesSchema,
        time_points: z.number().int().min(2).max(2000).optional().describe("--time-points: continuous temporal grid points (default 250, the reference's own). The trajectory store is [codons x time_points], so this is the single biggest term in the record's size."),
        bandwidth: z.number().positive().optional().describe("-bw/--bandwidth: Gaussian kernel smoothing bandwidth in years (default: auto, about 5% of the timespan)."),
        n_permutations: z
          .number()
          .int()
          .min(0)
          .max(MAX_PERMUTATIONS)
          .optional()
          .describe("-B/--n-permutations: date-shuffling permutations for the stage-two empirical p (default 1,000, the reference's own; cap " + MAX_PERMUTATIONS + "). Fewer draws do not bias p, they coarsen its grid to 1/(B+1) — and every q then sits at a floor of C/(B+1) the count cannot reach."),
        perm_alpha: z.number().min(0).max(1).optional().describe("--perm-alpha: FDR cutoff for the stage-two permutation test (default 0.05)."),
        min_r2: z.number().min(0).max(1).optional().describe("--min-r2: minimum dynamic-wave alignment R^2 for a confirmed sweep (default 0.35)."),
        tau_peak: z.number().min(0).optional().describe("--tau-peak: stage-one peak sweep-intensity energy floor (default 1e-4). Note the upstream quirk this build replicates: the override tests the VALUE rather than whether a caller supplied one, and the record flags it as TEMPORAL_TAU_PEAK_OVERRIDDEN."),
        tau_auc: z.number().min(0).optional().describe("--tau-auc: stage-one cumulative-area energy floor (default: derived from the timespan)."),
        sweep_mode: z.enum(["auto", "episodic", "fixation"]).optional().describe("--sweep-mode: `episodic` (positive velocity; viral turnover), `fixation` (cumulative amplitude shift; experimental evolution), or `auto` (default: fixation when time_units is not years, else episodic)."),
        keep_duplicates: z
          .boolean()
          .optional()
          .describe("--keep-duplicates: do not collapse identical sequences. Worth considering on surveillance data: identical haplotypes sampled on DIFFERENT DAYS collapse to one date, which deletes time points (reported as TEMPORAL_DUPLICATES_COLLAPSED). Auto-enabled when time_units is not years, as upstream."),
        root_taxon: z
          .string()
          .max(256)
          .optional()
          .describe("--root-taxon: the ancestral founder sequence (default: the consensus of the earliest 5% of sampled taxa). Setting it FORCES score_invariable_sites back on, because an explicit root with gaps makes invariable codons acquire nonzero trajectories (upstream bug TEMPORAL Q2)."),
        score_invariable_sites: z
          .boolean()
          .optional()
          .describe("Send every codon to the model, as `hyphaeon temporal` does (default true). False scores only the variable ones — measured at a 93% saving with the same candidate set and a bit-identical peak date under a consensus root — and is REPORTED: `primaeon.score_invariable_sites` false, `lrt` and `p_static` empty rather than scored at those codons, and the reproduction line gains a caveat."),
        wave_sign: z
          .enum(["canonical"])
          .optional()
          .describe("The fPCA wave sign convention (D28, WAVE_SIGN.md). Only `canonical` can run here: the reference has none and writes its solver's raw singular vectors, so accepting `lapack` would promise numbers this build does not compute. Recorded as waves.sign."),
        perm_work_budget: z.number().positive().optional().describe("Lift or lower the null's own work budget (the runtime's default is 5.0e10). Over budget the null is DECLINED and everything else is still computed: trajectories, peaks, widths, areas, candidates and wave modes all exist, and the four-way classification degrades to three."),
        batch_size: z.number().int().min(1).optional().describe("-b/--batch-size: sites per forward call (default adaptive)."),
        seed: seedSchema,
        sites: z.array(z.number().int().min(1)).max(5000).optional().describe("Only meaningful with `section`: the 1-indexed codons a `sites` or `curves` section is about (default: the stage-one candidates)."),
        section: z.enum(TEMPORAL_SECTIONS).optional().describe("Return one section of the record instead of the summary. The whole record is never returned inline."),
        wait_seconds: z
          .number()
          .min(0)
          .max(ANALYZE_WAIT_MAX_SEC)
          .optional()
          .describe("How long to wait inside the call for the run (default " + ANALYZE_WAIT_DEFAULT_SEC + ", max " + ANALYZE_WAIT_MAX_SEC + "); 0 returns the job id at once."),
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
      if (job.analysis === "temporal") {
        job.sections = [...TEMPORAL_SECTIONS];
        job.next = "get_results job_id=" + job_id + " section=<" + TEMPORAL_SECTIONS.join("|") + ">. The record is never returned whole.";
      }
      // A CANCELLED JOB NEVER BECOMES `completed`, so the advice must never be to wait for that.
      // Three endings, and they are not the same: a record was kept (partial, readable now), one
      // is still unwinding (milliseconds), or nothing survived.
      if (job.status === "cancelled") {
        if (job.partial_result) {
          job.next =
            "get_results job_id=" + job_id + (job.analysis === "temporal" ? " section=<" + TEMPORAL_SECTIONS.join("|") + ">" : "") +
            ". This run was STOPPED: what the runtime had finished was kept and is served as a partial run (`partial` " +
            "says at what count). It will never reach `completed`.";
        } else if (job.result_pending) {
          job.next = "Call job_status again in a moment: the runner is unwinding and may yet hand back what it finished before the cancel.";
        } else {
          job.next = CANCELLED_HINT;
        }
      }
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
        "analysis tools accept. For a hyphaeon_temporal run, `section` is not optional shaping but the " +
        "way the record is read at all — it is never returned whole, because its trajectory store alone " +
        "is megabytes: ask for " + TEMPORAL_SECTIONS.join(", ") + " (`sites` and `curves` also take a " +
        "`sites` list of 1-indexed codons), and every one of them carries the `honesty` block. " +
        "For a hyphaeon_analyze report, `section` returns one section of the " +
        "ReportRecord (diagnostics, sites, gene, epistasis, attribution, filter, dms, phenotype, " +
        "provenance, timings) — also while the report is still running, once that section is final. " +
        "Results carry a provenance block whose `surface` (mcp-stdio / mcp-http) names the process " +
        "that computed them and whose `preprocessing.tree_source` says whether the distances came " +
        "from the tree or from TN93.",
      inputSchema: Object.assign({ job_id: z.string().regex(/^[0-9a-f]{32}$/).describe("The job_id to fetch.") }, shapingSchema, {
        section: sectionSchema,
        sites: z
          .array(z.number().int().min(1))
          .max(5000)
          .optional()
          .describe("Temporal jobs, sections `sites` and `curves` only: the 1-indexed codons to return (default: the stage-one candidates, strongest peak intensity first).")
      }),
      annotations: { readOnlyHint: true }
    },
    async (args) => {
      const job = jobs.get(args.job_id);
      if (!job) return fail("input", "Job not found.", "Check the job_id; jobs expire after their TTL.", { job_id: args.job_id });

      // `sites` NAMES CODONS IN A TEMPORAL RECORD AND NOTHING ELSE. Passed to any other job it used
      // to be dropped in silence: measured, `get_results {section: "sites", sites: [1,2,3]}` on an
      // analyze report answered with all 1,097 rows, 253,569 bytes, and said nothing about the
      // three codons the caller had asked for. A refusal is the only reply that cannot be mistaken
      // for the three rows.
      if (Array.isArray(args.sites) && args.sites.length && job.analysis !== "temporal") {
        return fail(
          "input",
          "`sites` selects codons from a hyphaeon_temporal record and this is a hyphaeon_" + job.analysis + " job, so it cannot be applied.",
          job.analysis === "analyze"
            ? "Drop `sites` and shape the section instead: `top` keeps the highest-ranked rows (sites are ranked by hyphaeon_lrt) and `fields` keeps named keys; `summary_only` returns the counts and the top ten."
            : "Drop `sites`; `top`, `fields` and `summary_only` shape this result.",
          { job_id: job.job_id, analysis: job.analysis, sites: args.sites.length }
        );
      }

      // A cancel does not always throw the answer away (src/jobs.js): a temporal run stopped
      // mid-null resolves with a complete record at the achieved draw count, and the store keeps
      // it. `kept` is set only for a CANCELLED job that resolved; it is never a completed result.
      const kept = jobs.kept(args.job_id);

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
        if (job.status === "cancelled" && kept) {
          // The report runner throws on abort today, so this branch is reached only if that ever
          // changes; it is here so a kept report is never dropped the way a kept record was.
          const shaped = shapeReport(kept.value, args, { job_id: job.job_id, status: "cancelled" });
          return ok(Object.assign(shaped, { partial_result: true, partial: { cancelled: true, kept_at: kept.at, reason: "cancel_job was called while this report was running; these are the sections that were final when it stopped." } }));
        }
        return fail(
          job.status === "failed" ? (job.error && job.error.kind) || "server" : "input",
          job.status === "failed"
            ? "The report failed: " + (job.error && job.error.message)
            : job.status === "cancelled"
              ? "The report was cancelled and kept nothing."
              : "Report not completed yet.",
          job.status === "failed"
            ? job.error && job.error.hint
            : job.status === "cancelled"
              ? "This job can never reach `completed`. Sections that were final BEFORE the cancel are gone with it: read them with get_results section=... while a report is still running, and re-submit to get the rest."
              : "Poll job_status until status is completed, or ask for a section listed in sections_ready.",
          { job_id: job.job_id, status: job.status, sections_ready: job.sections_ready || [] }
        );
      }

      if (job.status !== "completed" && !kept) {
        // THREE ENDINGS, THREE ANSWERS. "Poll job_status until status is completed" is false advice
        // on a cancelled job — it can never be completed — and it was what this branch used to say.
        const cancelled = job.status === "cancelled";
        return fail(
          job.status === "failed" ? (job.error && job.error.kind) || "server" : "input",
          job.status === "failed"
            ? "The job failed: " + (job.error && job.error.message)
            : cancelled
              ? job.result_pending
                ? "The job was cancelled and its runner has not finished unwinding; whatever it kept is not readable yet."
                : "The job was cancelled and kept nothing."
              : "Job not completed yet.",
          job.status === "failed"
            ? job.error && job.error.hint
            : cancelled
              ? job.result_pending
                ? "Call get_results again in a moment, or job_status, which says whether a partial record arrived."
                : CANCELLED_HINT
              : "Poll job_status until status is completed.",
          { job_id: job.job_id, status: job.status, code: job.error && job.error.code, partial_result: false, result_pending: !!job.result_pending }
        );
      }

      if (job.analysis === "temporal") {
        // The temporal record is never served whole (measured: 2.1 MB on the smallest bundled
        // example, 7.2 MB on the engine's acceptance run), so `section` is not optional shaping
        // here — it is how the record is read at all. `fields` / `top` / `summary_only` are
        // deliberately NOT applied to the site columns: they are typed arrays in a column store,
        // and `topBy` would slice one and drop the ranking silently.
        const stored = kept ? kept.value : jobs.result(args.job_id);
        const record = stored.result.record;
        const provenance = Object.assign({}, stored.provenance, { job_id: job.job_id });
        const head = { analysis: "temporal", job_id: job.job_id, status: kept ? "cancelled" : "completed", stage: record.stage, sections: TEMPORAL_SECTIONS };
        // A KEPT RECORD SAYS SO IN EVERY SECTION IT SERVES. `honesty.null_truncated` carries the
        // achieved count on the block every section already has; this repeats it at the top level
        // because a client reading `status` must not have to read `honesty` to learn the run was
        // stopped.
        if (kept) {
          head.partial_result = true;
          head.partial = Object.assign(
            { cancelled: true, kept_at: kept.at },
            stored.result.honesty && stored.result.honesty.null_truncated ? stored.result.honesty.null_truncated : { completed: null, requested: null },
            { reason: "cancel_job was called while this run was in flight; the runtime returned the record it had finished and this store kept it." }
          );
        }
        if (!args.section) {
          return ok(
            Object.assign(head, {
              summary: temporalSummary(record),
              honesty: stored.result.honesty,
              date_review: stored.result.date_review,
              note: "The whole record is " + Math.round(JSON.stringify(record).length / 1024) + " KB and is never returned inline; ask for a section.",
              next: "get_results job_id=" + job.job_id + " section=<" + TEMPORAL_SECTIONS.join("|") + ">; `sites` and `curves` take a `sites` list of 1-indexed codons.",
              provenance
            })
          );
        }
        if (!TEMPORAL_SECTIONS.includes(args.section)) {
          return fail("input", "Section '" + args.section + "' is not a temporal section.", "Temporal sections are: " + TEMPORAL_SECTIONS.join(", ") + ".", { job_id: job.job_id, sections: TEMPORAL_SECTIONS });
        }
        const rt = typeof engine.runtimeBag === "function" ? await engine.runtimeBag() : {};
        try {
          return ok(Object.assign(head, temporalSection(record, args.section, args, rt), { provenance }));
        } catch (err) {
          if (err && err.name === "TemporalSiteRangeError") {
            return fail("input", err.message, "Codon sites are 1-indexed and at most codon_count (" + record.codons_total + ").", { job_id: job.job_id });
          }
          throw err;
        }
      }
      const stored = kept ? kept.value : jobs.result(args.job_id);
      const storedSurface = stored.provenance && stored.provenance.surface;
      const provenance = Object.assign({}, stored.provenance, {
        surface: storedSurface || surface,
        job_id: job.job_id
      });
      const shaped = shapeResult(job.analysis, stored.result, provenance, args);
      if (args.section) shaped.note = "`section` applies to hyphaeon_analyze reports only; this is a hyphaeon_" + job.analysis + " result.";
      if (kept) {
        return ok(
          partialBody(shaped, stored, job.job_id, "The run was stopped; nothing more is coming. Re-submit it to get a full one.")
        );
      }
      return ok(shaped);
    }
  );

  // ── cancel_job ──────────────────────────────────────────────────────────
  server.registerTool(
    "cancel_job",
    {
      title: "Cancel a queued or running HyphAeon job",
      description:
        "Cancel a job. A completed job cannot be cancelled; the call reports its final status instead. What survives " +
        "depends on the pillar: a hyphaeon_temporal run KEEPS what it had — the runtime catches its own abort, " +
        "classifies at the draws it finished and returns a complete record, which get_results then serves as a " +
        "PARTIAL run with the achieved count on it — while a hyphaeon_analyze report keeps nothing, so read finished " +
        "sections with get_results section=... BEFORE cancelling one.",
      inputSchema: { job_id: z.string().regex(/^[0-9a-f]{32}$/).describe("The job_id to cancel.") },
      annotations: { destructiveHint: true }
    },
    async ({ job_id }) => {
      const before = jobs.get(job_id);
      const job = jobs.cancel(job_id);
      if (!job) return fail("input", "Job not found.", undefined, { success: false, job_id });
      if (job.status === "completed") return ok({ success: true, message: "Job already completed", job_id });
      if (job.status === "failed") return ok({ success: true, message: "Job had already failed", job_id });
      const wasRunning = !!(before && before.status === "running");
      const keeps = wasRunning && job.analysis === "temporal";
      return ok({
        success: true,
        job_id,
        status: job.status,
        analysis: job.analysis,
        // NOT A PROMISE THAT A RECORD EXISTS — only that the runtime is asked for one and the store
        // will keep it if it arrives. `job_status` says which happened, a few milliseconds later.
        partial_result_expected: keeps,
        next: keeps
          ? "job_status job_id=" + job_id + ": if the runtime got past its first permutation chunk it hands back a complete record at the draw count it reached, and this store keeps it — `partial_result` says so and get_results serves it, labelled. If it did not, nothing was kept."
          : "This job kept nothing; it can never reach `completed`. Submit it again for a full run."
      });
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
