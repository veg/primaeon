/**
 * resources.js — the HyphAeon MCP resources.
 *
 * WHY THIS FILE EXISTS
 *
 * PLAN.md 3.6: hyphaeon://models, hyphaeon://methods/requirements, hyphaeon://caveats,
 * hyphaeon://examples/{name}; Phase 1b added hyphaeon://gallery and hyphaeon://gallery/{name};
 * Phase 2 adds hyphaeon://report/{id}. Modelled on datamonkey-js-server lib/mcp/resources.js
 * (static resources plus ResourceTemplates), in ESM.
 *
 *   models        the manifest as the runtime's reader validates it (src/models.js over
 *                 runtime/src/manifest.js `loadManifest`), with per-variant graph paths;
 *   requirements  per-pillar requirements: the tree rule (optional everywhere since D22, with TN93
 *                 as the fallback), options with the CLI defaults from hyphaeon/cli.py
 *                 (veg/HyphAeon phase-3a), the caps from src/caps.js, the warning codes
 *                 hyphaeon_validate can emit, and the fact that every pillar runs in-process — so
 *                 a client can plan a call without trial and error;
 *   caveats       mcp/caveats.json: the model card facts of PLAN.md 2 and the numbers of
 *                 HyphAeon/model_eval/README.md, keyed by model_version;
 *   examples      the bundled example files from HyphAeon/examples (env HYPHAEON_EXAMPLES_DIR),
 *                 listed through the template's list callback and served by bare file name;
 *   gallery       the prebaked site-selection records web/scripts/prebake-gallery.mjs writes under
 *                 web/static/gallery (env HYPHAEON_GALLERY_DIR): the index, and one record per
 *                 example by id (`bat_oas1`, `Smc6`, ...) — the same documents the /gallery page
 *                 opens, so a client can read a result without running anything;
 *   report        a FINISHED hyphaeon_analyze report by job id (the ReportRecord of PLAN.md 4.0,
 *                 `schema_version: 2, kind: "report"`), read from the job store for as long as
 *                 the job lives (TTL 7 days, PLAN.md 3.5). The list callback enumerates the
 *                 completed report jobs; a running or unknown id reads as an error text that says
 *                 which sections are ready, so a client that polls the resource learns the same
 *                 thing job_status would tell it. Per-pillar jobs are not reports and are not
 *                 listed here — get_results is their reader.
 */

import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFile } from "node:fs/promises";
import {
  ANALYZE_INLINE_MAX_BYTES,
  ANALYZE_WAIT_DEFAULT_SEC,
  ANALYZE_WAIT_MAX_SEC,
  DMS_MUTANTS_PER_SITE,
  JOB_TIMEOUT_MS,
  MAX_ALIGNMENT_CHARS,
  MAX_CODONS,
  MAX_PERMULATIONS,
  MAX_PERMUTATIONS,
  MAX_SYNC_CODONS,
  MAX_SYNC_WORK,
  MAX_TAXA,
  MAX_WORK,
  MIN_TAXA,
  TAXON_CAP
} from "./caps.js";
import { CODES, NATIVE_ANALYSES } from "./validate.js";
import { listExamples, listGalleryRecords, readExample, readGalleryIndex, readGalleryRecord, readManifest } from "./models.js";

const CAVEATS_URL = new URL("../caveats.json", import.meta.url);

const TREE_RULE =
  "OPTIONAL (PLAN.md D22). A Newick/NEXUS tree in `tree`, or one embedded in the alignment, is used " +
  "AS IT IS when it carries branch lengths; tips must match sequence names (exact, then " +
  "quote-stripped, then case-insensitive), and max patristic > 10 is rescaled by the codon count. " +
  "With no tree at all, with a tree that has no usable branch lengths, or with use_tn93 / no_tree, " +
  "the run takes pairwise Tamura-Nei 93 distances from the sequences straight into the MDS - the " +
  "reference's own --use-tn93 path (dataset.py:493-571, 598-636), which the manuscript measures at " +
  "rho = 0.9997 against the tree-based one. Nothing estimates branch lengths and nothing infers a " +
  "tree for the model. `provenance.preprocessing.tree_source` is then 'tn93' with " +
  "`tree_free.reason` one of 'requested' | 'no_tree' | 'no_branch_lengths'; hyphaeon_validate says " +
  "the same in advance as TREE_FREE_TN93 (info, never a refusal).";

const MDS_SIGN_OPTION = {
  cli: "--mds-sign",
  default: "canonical",
  values: ["canonical", "lapack"],
  note: "In-process the library computes canonical signs only (MDS_SIGN.md); `lapack` is refused with an input error. Recorded as provenance.mds_sign."
};

/** The report's sections, in the order PLAN.md 4.0 computes them; `get_results section=` and hyphaeon://report/{id} use these names. */
export const REPORT_SECTIONS = Object.freeze(["diagnostics", "sites", "gene", "epistasis", "attribution", "filter", "dms", "phenotype", "provenance", "timings"]);

export const METHOD_REQUIREMENTS = {
  analyze: {
    name: "The whole report (one action: upload, everything runs)",
    tool: "hyphaeon_analyze",
    engine: "in-process",
    cli: "(app-side: runs `hyphaeon meme --attribute --filter`, `hyphaeon busted`, `hyphaeon epistasis`, `hyphaeon dms` over ONE forward pass and one loaded alignment)",
    requires_codon_alignment: true,
    /** D22: no pillar requires a tree; without a usable one the run uses TN93 distances. */
    requires_tree: false,
    tree: TREE_RULE,
    model_outputs: ["lrt", "mean_root_attns", "root_repr"],
    surrogate_for: "MEME (sites), BUSTED (gene); the network, DMS and attribution have no HyPhy counterpart",
    sections_in_order: ["diagnostics", "sites", "gene", "epistasis", "attribution", "filter", "dms", "phenotype (only with a trait block; null otherwise)"],
    options: {
      variant: { default: "chosen from tree depth by diagnostics (general | viral)", values: ["general", "viral"] },
      max_species: { default: "the manifest's default_taxon_cap (256)", range: [MIN_TAXA, TAXON_CAP] },
      reference_sequence: { default: "the first matched taxon", note: "whose codons the site table shows as refCodon" },
      call_mode: { default: "percentile", values: ["percentile", "zscore", "pvalue"] },
      seed: { default: 42, note: "the sector permutation null" },
      permutations: { default: 1000, max: MAX_PERMUTATIONS, note: "the report's B; the CLI's default is 10,000 — p_perm at B = 1,000 carries about +/-0.03 (PHASE2A.md)" },
      dms: { default: true, note: "the digital DMS section, last, progressive, capped by dms_work_budget" },
      use_tn93: { cli: "--use-tn93 / --no-tree", default: false, note: "force the tree-free TN93 path even when a usable tree was given" },
      phenotype: {
        default: null,
        note:
          "the trait block (preset | foreground | phenotype_file, plus trait_col, species_col, continuous, " +
          "permulations, n_permutations, alpha, min_taxa, max_perm_p, seed). Given one, the report fills " +
          "sections.phenotype from its OWN forward pass (provenance.phenotype_source \"report-pass\"); " +
          "without one the section stays null, because a trait cannot be guessed."
      },
      phenotype_file: { cli: "--phenotype-file", default: null, note: "the CSV/TSV text for the phenotype section" },
      dms_work_budget: { default: "the runtime's default", note: "forward passes the DMS section may spend (19 per site); above it the report says the scan is partial" },
      wait_seconds: { default: ANALYZE_WAIT_DEFAULT_SEC, max: ANALYZE_WAIT_MAX_SEC, note: "app-side: how long the call waits for the report before returning the job id with the sections that are ready" },
      section: { values: REPORT_SECTIONS, note: "get_results / the tool: return one section of the report" }
    },
    result_keys: ["schema_version (2)", "kind (report)", "id", "createdAt", "inputs", "options", "diagnostics", "sections{sites, gene, epistasis, attribution, filter, dms, phenotype}", "provenance", "timings{phase: seconds}"],
    inline_limit_bytes: ANALYZE_INLINE_MAX_BYTES,
    paging: "Above inline_limit_bytes the tool returns {job_id, summary, sections_ready}; get_results section=<name> [top, fields, summary_only] pages one section; hyphaeon://report/{id} serves the finished record."
  },
  meme: {
    name: "Site selection (MEME surrogate)",
    tool: "hyphaeon_meme",
    engine: "in-process",
    cli: "hyphaeon meme (aliases predict, site-selection)",
    requires_codon_alignment: true,
    /** D22: no pillar requires a tree; without a usable one the run uses TN93 distances. */
    requires_tree: false,
    tree: TREE_RULE,
    model_outputs: ["lrt"],
    surrogate_for: "MEME",
    options: {
      model_variant: { cli: "--model-variant", default: "general", values: ["general", "viral"] },
      max_species: { cli: "--max-species", default: null, range: [2, TAXON_CAP] },
      use_tn93: { cli: "--use-tn93 / --no-tree", default: false, note: "force the tree-free TN93 path even when a usable tree was given (D22)" },
      filter: { cli: "--filter", default: false },
      filter_p_thresh: { cli: "--filter-p-thresh", default: 0.01 },
      min_patch_consec: { cli: "--min-patch-consec", default: 3, note: "recorded; only the default is applied in-process" },
      attribute: { cli: "--attribute", default: false },
      attribution_min_lrt: { cli: "--attribution-min-lrt", default: 3.84 },
      no_prune_duplicates: { cli: "--no-prune-duplicates", default: false },
      batch_size: { cli: "--batch-size", default: "adaptive" },
      mds_sign: MDS_SIGN_OPTION,
      cpu: { cli: "--cpu", default: false, note: "always CPU in-process" }
    },
    result_keys: ["alignment", "tree", "taxa_count", "codon_count", "runtime_sec", "filter_enabled", "artifacts_masked", "attribution_enabled", "attributions", "sites[]", "summary"],
    site_keys: ["site", "hyphaeon_lrt", "p_value", "q_value", "is_invariable", "evolutionary_epoch?", "adaptation_mode?", "top_driver?", "top_mutation?", "attribution_details?", "refCodon", "refAa", "isVariable", "logLrt", "zScore", "percentile", "call"]
  },
  busted: {
    name: "Gene-level omnibus (BUSTED surrogate)",
    tool: "hyphaeon_busted",
    engine: "in-process",
    cli: "hyphaeon busted (aliases omnibus, gene-selection)",
    requires_codon_alignment: true,
    /** D22: no pillar requires a tree; without a usable one the run uses TN93 distances. */
    requires_tree: false,
    tree: TREE_RULE,
    model_outputs: ["lrt", "root_repr -> busted_head.onnx"],
    surrogate_for: "BUSTED",
    options: {
      model_variant: { cli: "--model-variant", default: "general", values: ["general", "viral"], note: "the busted head ships for general only; viral gives the statistical fields with null neural fields" },
      max_species: { cli: "--max-species", default: 512, range: [2, TAXON_CAP] },
      use_tn93: { cli: "--use-tn93 / --no-tree", default: false, note: "force the tree-free TN93 path even when a usable tree was given (D22)" },
      batch_size: { cli: "--batch-size", default: "adaptive" },
      gene: { default: "the alignment file's stem" },
      mds_sign: MDS_SIGN_OPTION,
      cpu: { cli: "--cpu", default: false }
    },
    result_keys: ["alignment", "gene", "taxa", "sites", "p_value_acat", "p_value_simes", "omnibus_lrt", "predicted_gene_lrt", "selection_probability", "synonymous_rate_variation", "total_selection_energy", "sig_sites_p05", "sig_sites_p10", "rate_distributions{omega_k, proportion_k}", "positive_selection_detected", "elapsed_seconds", "sites_detail[]", "statistics", "summary"],
    reproducible_fields: ["p_value_acat", "p_value_simes", "omnibus_lrt", "total_selection_energy", "sig_sites_p05", "sig_sites_p10"],
    neural_fields_note: "predicted_gene_lrt, selection_probability, synonymous_rate_variation, omega_3 and proportion_* come from one seeded draw of a head the reference loads unseeded (provenance.neural_head.deterministic_upstream false)."
  },
  epistasis: {
    name: "Co-selection network and epistatic sectors",
    tool: "hyphaeon_epistasis",
    engine: "in-process",
    cli: "hyphaeon epistasis (aliases coselection, sector, network)",
    requires_codon_alignment: true,
    /** D22: no pillar requires a tree; without a usable one the run uses TN93 distances. */
    requires_tree: false,
    tree: TREE_RULE,
    model_outputs: ["lrt", "mean_root_attns"],
    surrogate_for: "MEME (site signal) — the network itself has no HyPhy counterpart",
    options: {
      use_tn93: { cli: "--use-tn93 / --no-tree", default: false, note: "force the tree-free TN93 path even when a usable tree was given (D22)" },
      focal_taxon: { cli: "--focal-taxon", default: "consensus (taxon 0)" },
      min_sim: { cli: "--min-sim", default: 0.3, note: "the CLI's default; the underlying function's is 0.35" },
      min_shared: { cli: "--min-shared", default: 2 },
      max_fdr: { cli: "--max-fdr", default: 0.05 },
      min_lrt: { cli: "--min-lrt", default: 1.0 },
      min_clique_size: { cli: "--min-clique-size", default: 3 },
      max_overlap: { cli: "--max-overlap", default: 0.5, note: "accepted and never used by the reference" },
      min_coherence: { cli: "--min-coherence", default: 0.5 },
      n_permutations: { cli: "--n-permutations", default: 10000, max: MAX_PERMUTATIONS, note: "p_perm is Monte Carlo: +/-0.03 at B = 1,000" },
      max_perm_p: { cli: "--max-perm-p", default: null },
      seed: { cli: "--seed", default: 42, note: "the sector permutation null (xoshiro256** here, PCG64 in the reference: statistical parity)" },
      no_dms: { cli: "--no-dms", default: false },
      mds_sign: MDS_SIGN_OPTION,
      cpu: { cli: "--cpu", default: false },
      model_variant: { cli: "(not available on this subcommand)", default: "general (HYPHAEON_VARIANT)" }
    },
    result_keys: ["alignment", "tree", "taxa_count", "codon_count", "evaluated_taxa", "coselection_edges_count", "discovered_sectors_count", "edges[]", "sectors[]", "plasticity[]", "coselection_edges[]", "epistatic_sectors[]", "selection_dms_plasticity[]", "graph (app)", "permutations (app)", "dms_sites (app)"],
    edge_keys: ["site_u", "site_v", "ref_u", "ref_v", "lrt_u", "lrt_v", "similarity", "shared_taxa", "shared_branches", "p_val", "hyper_p", "fdr_q", "cesi"],
    sector_keys: ["sector_id", "size", "sites[]", "spectral_coherence", "p_perm", "null_coherence_mean", "null_coherence_std", "null_coherence_95", "isotropic_baseline", "shared_taxa", "shared_branches", "mean_lrt", "pars_signature", "consensus_signature", "focal_taxon?", "focal_signature?", "focal_mutations?"],
    parity: "edges exact (order, ints, strings; floats at 1e-6), sector membership exact, spectral_coherence 1e-6, p_perm within 3*sqrt(p(1-p)/B), plasticity 1e-5 (HyphAeon/PHASE2A.md)"
  },
  dms: {
    name: "Digital deep mutational scan",
    tool: "hyphaeon_dms",
    engine: "in-process",
    cli: "hyphaeon dms (aliases essm, digital-dms)",
    requires_codon_alignment: true,
    /** D22: no pillar requires a tree; without a usable one the run uses TN93 distances. */
    requires_tree: false,
    tree: TREE_RULE,
    model_outputs: ["lrt (19 x L passes)"],
    surrogate_for: "no HyPhy counterpart; delta-LRT of the MEME surrogate under substitution",
    options: {
      use_tn93: { cli: "--use-tn93 / --no-tree", default: false, note: "force the tree-free TN93 path even when a usable tree was given (D22)" },
      focal_taxon: { cli: "--focal-taxon", default: "consensus (taxon 0)" },
      sites: { cli: "(app-side; the CLI sweeps every site)", default: "all", note: "1-indexed codon sites to sweep; total_mutations stays 19 x codon_count as the reference computes it" },
      mds_sign: MDS_SIGN_OPTION,
      cpu: { cli: "--cpu", default: false },
      model_variant: { cli: "(not available on this subcommand)", default: "general (HYPHAEON_VARIANT)" }
    },
    result_keys: ["alignment", "tree", "taxa_count", "codon_count", "focal_taxon", "total_mutations", "plasticity[]", "selection_dms_plasticity[]", "progress (app)"],
    plasticity_keys: ["site", "wt_aa", "baseline_lrt", "p_value", "intrinsic_plasticity", "mean_delta_lrt", "max_delta_lrt", "min_delta_lrt", "mutant_deltas{AA: dLRT}"],
    parity: "every record at 1e-5 relative to max(1, |x|), keys and strings exact (fixtures/dms)"
  },
  phenotype: {
    name: "Phenotype association (PhyloWAS)",
    tool: "hyphaeon_phenotype",
    engine: "in-process",
    cli: "hyphaeon phenotype (aliases phylowas, trait)",
    requires_codon_alignment: true,
    /** D22: no pillar requires a tree; without a usable one the run uses TN93 distances. */
    requires_tree: false,
    tree: TREE_RULE,
    model_outputs: ["lrt", "mean_root_attns"],
    surrogate_for: "no HyPhy counterpart; attention-based trait association",
    trait: "One of preset, foreground (comma list or regex), or phenotype_file (CSV/TSV TEXT) is required; `background` is accepted and never read, as upstream.",
    permulations_need_a_tree:
      "Brownian-motion permulations (--permulations) need a phylogeny with branch lengths. A tree-free run " +
      "skips them and records `permulations: {requested, ran: 0, reason: \"tree-free\", detail}`; the " +
      "association p-values are then the parametric t-test ones, exactly as `--use-tn93` gives upstream. " +
      "The display-only neighbour-joining tree is deliberately NOT substituted as a null.",
    options: {
      model_variant: { cli: "--model-variant", default: "general", values: ["general", "viral"] },
      preset: { cli: "--preset", values: ["echolocation", "marine", "fossorial", "hibernation", "longevity", "high_altitude", "cardenolide", "dim_light"] },
      foreground: { cli: "--foreground" },
      background: { cli: "--background" },
      phenotype_file: { cli: "--phenotype-file" },
      trait_col: { cli: "--trait-col" },
      species_col: { cli: "--species-col" },
      continuous: { cli: "--continuous", default: false },
      permulations: { cli: "--permulations", default: 0, max: MAX_PERMULATIONS },
      min_taxa: { cli: "--min-taxa", default: 4 },
      alpha: { cli: "--alpha", default: 0.05 },
      n_permutations: { cli: "--n-permutations", default: 10000, max: MAX_PERMUTATIONS },
      max_perm_p: { cli: "--max-perm-p", default: null },
      seed: { cli: "--seed", default: 42, note: "permulations and the trait-sector null" },
      mds_sign: MDS_SIGN_OPTION,
      max_species: { cli: "(not on this subcommand)", default: null, range: [2, TAXON_CAP] },
      use_tn93: { cli: "--use-tn93 / --no-tree", default: false, note: "force the tree-free TN93 path even when a usable tree was given (D22)" },
      cpu: { cli: "--cpu", default: false }
    },
    result_keys: ["alignment", "tree", "taxa_count", "codon_count", "phenotype_meta", "spectral_energy", "norm_spectral_ratio", "max_assoc", "p_evd_length_adjusted", "score_track_a", "score_track_b", "dual_track_composite", "compact_pars_signature", "permulations_count", "gene_p_value_perm", "significant_sites_count", "coselection_pairs_count", "trait_sectors_count", "coselection_pairs[]", "trait_sectors[]", "sites[]", "trait (app)", "permulations (app)", "sector_permutations (app)", "attention_source (app)"],
    parity: "the 21 top-level keys in phenotype.py:624-646's order; site statistics at the graph class through the model, the p / score tracks at 1e-9 given identical inputs, sector membership exact, p_perm statistical (PLAN.md 5.4)",
    site_keys: ["site", "ref_aa", "derived_aa", "hyphaeon_lrt", "p_lrt", "association_rho", "p_value", "p_assoc", "p_assoc_parametric", "p_assoc_perm", "score", "foreground_freq_pct", "background_freq_pct", "q_value", "fg_mean_attn", "bg_mean_attn"]
  },
  evaluate: {
    name: "Concordance with HyPhy MEME",
    tool: "hyphaeon_evaluate",
    engine: "in-process",
    cli: "hyphaeon evaluate --prediction --meme-result",
    requires_codon_alignment: false,
    requires_tree: false,
    tree: "none",
    model_outputs: [],
    surrogate_for: null,
    options: {
      gene: { default: "gene" },
      variable_only: { cli: "--variable-only", default: false },
      allow_site_mismatch: { cli: "--allow-site-mismatch", default: false }
    },
    result_keys: ["input_mode", "prediction_file", "meme_result_file", "matched_genes", "genes", "total_sites", "evaluated_sites", "variable_sites", "invariable_sites", "evaluation_scope", "pearson_r", "spearman_rho", "thresholds{\"0.05\",\"0.10\" -> roc_auc, ppv, fpr, confusion}", "per_gene[]", "warnings[]"]
  }
};

export const CAPS = {
  alignment_chars_max: MAX_ALIGNMENT_CHARS,
  taxa: { min: MIN_TAXA, max: MAX_TAXA, model_cap: TAXON_CAP },
  codons_max: MAX_CODONS,
  work: {
    definition: "codon sites x sequences^2 (x " + DMS_MUTANTS_PER_SITE + " for dms; analyze is sized like meme and caps its DMS section by its own budget), measured on the file as submitted",
    sync_max: MAX_SYNC_WORK,
    hard_max: MAX_WORK,
    sync_codons_max: MAX_SYNC_CODONS
  },
  permutations_max: MAX_PERMUTATIONS,
  permulations_max: MAX_PERMULATIONS,
  job_timeout_sec: JOB_TIMEOUT_MS / 1000,
  analyze: { wait_default_sec: ANALYZE_WAIT_DEFAULT_SEC, wait_max_sec: ANALYZE_WAIT_MAX_SEC, inline_limit_bytes: ANALYZE_INLINE_MAX_BYTES }
};

/** The completed hyphaeon_analyze jobs in a job store, newest first. */
export function listReports(jobs) {
  if (!jobs || typeof jobs.list !== "function") return [];
  return jobs
    .list()
    .filter((j) => j.analysis === "analyze" && j.status === "completed")
    .sort((a, b) => String(b.finished_at || "").localeCompare(String(a.finished_at || "")));
}

/**
 * @param {import("@modelcontextprotocol/sdk/server/mcp.js").McpServer} server
 * @param {{env?: object, logger?: object, jobs?: ReturnType<import("./jobs.js").createJobStore>}} [deps]
 */
export function registerResources(server, deps = {}) {
  const env = deps.env || process.env;
  const jobs = deps.jobs || null;

  server.registerResource(
    "models",
    "hyphaeon://models",
    {
      title: "HyphAeon model manifest",
      description: "Model variants, training regime, artifact hashes, graph paths and caps from models/manifest.json as the runtime validates it (or the reference's known variants when the manifest is absent).",
      mimeType: "application/json"
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(await readManifest(env), null, 2) }]
    })
  );

  server.registerResource(
    "methods-requirements",
    "hyphaeon://methods/requirements",
    {
      title: "HyphAeon method requirements",
      description: "Per-pillar inputs, options with CLI defaults, result keys, size caps, which pillars run in-process, the report's sections, and the warning codes hyphaeon_validate emits.",
      mimeType: "application/json"
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(
            {
              pillars: METHOD_REQUIREMENTS,
              report_sections: REPORT_SECTIONS,
              caps: CAPS,
              validation_codes: CODES,
              provenance: {
                native: { surfaces: ["mcp-stdio", "mcp-http"], analyses: [...NATIVE_ANALYSES], note: "Computed in the MCP process by @veg/hyphaeon-js through @veg/hyphaeon-runtime over onnxruntime-node." },
                bridged: { surface: null, analyses: [], note: "None. Every pillar runs in this process since Phase 3; no Python and no subprocess anywhere (PLAN.md 8, phase 3's exit criterion; D16)." }
              }
            },
            null,
            2
          )
        }
      ]
    })
  );

  server.registerResource(
    "caveats",
    "hyphaeon://caveats",
    {
      title: "HyphAeon model caveats",
      description: "Model card facts and model_eval numbers (calibration, concordance, invariance gates, known issues) keyed by model_version.",
      mimeType: "application/json"
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "application/json", text: await readFile(CAVEATS_URL, "utf8") }]
    })
  );

  server.registerResource(
    "examples",
    new ResourceTemplate("hyphaeon://examples/{name}", {
      list: async () => {
        const { files } = await listExamples(env);
        return {
          resources: files
            .filter((f) => f.servable)
            .map((f) => ({
              uri: "hyphaeon://examples/" + f.name,
              name: f.name,
              description: f.kind + ", " + f.bytes + " bytes",
              mimeType: mimeFor(f.name)
            }))
        };
      },
      complete: {
        name: async (value) => {
          const { files } = await listExamples(env);
          return files.filter((f) => f.servable && f.name.startsWith(value || "")).map((f) => f.name);
        }
      }
    }),
    {
      title: "Bundled example inputs",
      description: "Alignments, trees and reference outputs from HyphAeon/examples, by file name (e.g. Smc6.fasta, Smc6.nwk, bat_oas1.fasta).",
      mimeType: "text/plain"
    },
    async (uri, variables) => {
      const name = Array.isArray(variables.name) ? variables.name[0] : variables.name;
      try {
        const ex = await readExample(name, env);
        return { contents: [{ uri: uri.href, mimeType: mimeFor(ex.name), text: ex.text }] };
      } catch (err) {
        return { contents: [{ uri: uri.href, mimeType: "text/plain", text: "Error: " + err.message }] };
      }
    }
  );

  server.registerResource(
    "gallery-index",
    "hyphaeon://gallery",
    {
      title: "Prebaked gallery index",
      description: "The gallery index (web/static/gallery/index.json, schema 3): one prebaked full report per bundled example (sites, gene, epistasis, attribution, filter, DMS), with the summary numbers and which entries have a record.",
      mimeType: "application/json"
    },
    async (uri) => {
      try {
        const found = await readGalleryIndex(env);
        if (!found) {
          return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify({ available: false, note: "No gallery found; web/scripts/prebake-gallery.mjs writes it at build (set HYPHAEON_GALLERY_DIR to point at one)." }, null, 2) }] };
        }
        const { entries } = await listGalleryRecords(env);
        const index = Object.assign({}, found.index, {
          records: entries.map((e) => ({ id: e.id, name: e.name, status: e.status, uri: e.result ? "hyphaeon://gallery/" + e.id : null, bytes: e.bytes }))
        });
        return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(index, null, 2) }] };
      } catch (err) {
        return { contents: [{ uri: uri.href, mimeType: "text/plain", text: "Error: " + err.message }] };
      }
    }
  );

  server.registerResource(
    "gallery",
    new ResourceTemplate("hyphaeon://gallery/{name}", {
      list: async () => {
        let entries = [];
        try {
          entries = (await listGalleryRecords(env)).entries;
        } catch {
          entries = [];
        }
        return {
          resources: entries
            .filter((e) => e.servable)
            .map((e) => ({
              uri: "hyphaeon://gallery/" + e.id,
              name: e.name,
              description: "prebaked site-selection record for " + e.id + ", " + e.bytes + " bytes",
              mimeType: "application/json"
            }))
        };
      },
      complete: {
        name: async (value) => {
          try {
            const { entries } = await listGalleryRecords(env);
            return entries.filter((e) => e.servable && e.id.startsWith(value || "")).map((e) => e.id);
          } catch {
            return [];
          }
        }
      }
    }),
    {
      title: "Prebaked gallery records",
      description: "The prebaked ReportRecord (schema_version 2) for a bundled example, by gallery id (e.g. bat_oas1, Smc6); the same document /report/gallery/<id>/ renders.",
      mimeType: "application/json"
    },
    async (uri, variables) => {
      const name = Array.isArray(variables.name) ? variables.name[0] : variables.name;
      try {
        const rec = await readGalleryRecord(name, env);
        return { contents: [{ uri: uri.href, mimeType: "application/json", text: rec.text }] };
      } catch (err) {
        return { contents: [{ uri: uri.href, mimeType: "text/plain", text: "Error: " + err.message }] };
      }
    }
  );

  server.registerResource(
    "report",
    new ResourceTemplate("hyphaeon://report/{id}", {
      list: async () => ({
        resources: listReports(jobs).map((j) => ({
          uri: "hyphaeon://report/" + j.job_id,
          name: "report " + j.job_id.slice(0, 8),
          description: "hyphaeon_analyze report finished " + j.finished_at + " (" + j.elapsed_sec + " s)",
          mimeType: "application/json"
        }))
      }),
      complete: {
        id: async (value) => listReports(jobs).map((j) => j.job_id).filter((id) => id.startsWith(value || ""))
      }
    }),
    {
      title: "Finished HyphAeon reports",
      description:
        "The ReportRecord of a completed hyphaeon_analyze job by its id (schema_version 2, kind \"report\": inputs, options, " +
        "diagnostics, sections{sites, gene, epistasis, attribution, filter, dms, phenotype}, provenance, timings), for as long " +
        "as the job lives. A running job reads as an error naming the sections that are ready.",
      mimeType: "application/json"
    },
    async (uri, variables) => {
      const id = Array.isArray(variables.id) ? variables.id[0] : variables.id;
      const text = reportText(jobs, id);
      return { contents: [{ uri: uri.href, mimeType: text.startsWith("Error") ? "text/plain" : "application/json", text }] };
    }
  );
}

/** The JSON text of a finished report, or an "Error: ..." line that says why there is none. */
export function reportText(jobs, id) {
  if (!jobs) return "Error: this server keeps no job store, so no reports are available.";
  if (typeof id !== "string" || !/^[0-9a-f]{32}$/.test(id)) return "Error: a report id is the 32-hex job_id hyphaeon_analyze returned.";
  const job = jobs.get(id);
  if (!job) return "Error: no job " + id + " (jobs expire after their TTL).";
  if (job.analysis !== "analyze") return "Error: job " + id + " is a hyphaeon_" + job.analysis + " run, not a report; read it with get_results.";
  if (job.status !== "completed") {
    const ready = Array.isArray(job.sections_ready) ? job.sections_ready : [];
    return (
      "Error: report " + id + " is " + job.status +
      (job.status === "running" ? " (sections ready: " + (ready.length ? ready.join(", ") : "none yet") + "; get_results section=<name> serves them now)" : "") +
      (job.status === "failed" && job.error ? ": " + job.error.message : "") +
      "."
    );
  }
  const result = jobs.result(id);
  return JSON.stringify(result && result.result ? result.result : result, null, 2);
}

function mimeFor(name) {
  if (name.endsWith(".json")) return "application/json";
  if (name.endsWith(".csv")) return "text/csv";
  return "text/plain";
}
