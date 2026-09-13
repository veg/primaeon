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
 *   temporal      a FINISHED hyphaeon_temporal run by job id: the reference's eighteen summary
 *                 keys, the date review and the honesty block — NOT the record, whose trajectory
 *                 store alone is megabytes (measured: 2.1 MB on the 98 x 566 H5N1 example at the
 *                 reference's own 250 time points). The body names the `get_results section=`
 *                 vocabulary, so the resource is a door to the record rather than a dead end;
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
  DATING_MODEL_MAX_TAXA,
  DMS_MUTANTS_PER_SITE,
  TEMPORAL_ALWAYS_JOB,
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
import { TEMPORAL_CURVES_MAX_POINTS, TEMPORAL_SECTIONS, TEMPORAL_SITES_MAX_ROWS, temporalSummary } from "./time.js";
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
  dates: {
    name: "The date layer (review only: which sequence got a date, and by what rule)",
    tool: "hyphaeon_dates",
    engine: "in-process, NO MODEL",
    cli: "(app-side: the ingestion `hyphaeon dating -d` / `hyphaeon temporal -d` perform silently, made visible)",
    requires_codon_alignment: false,
    requires_tree: false,
    tree: "none",
    model_outputs: [],
    surrogate_for: null,
    cost: "3-24 ms on the bundled examples; loads no graph and runs on a checkout with no models/ at all (runtime/src/dates/ imports no manifest, no session and no predict.js)",
    sources: [
      "FASTA headers (the reference's own fallback when -d is omitted)",
      "Nextstrain Auspice JSON",
      "a name-to-date JSON object",
      "a CSV/TSV table with a name column and a date column",
      "a caller-supplied regular expression with one capturing group"
    ],
    beast_xml: "REFUSED (DATES_BEAST_XML_UNSUPPORTED). dating.py:433-434 reads one; this build does not.",
    name_matching: {
      tiers: ["exact", "quote_stripped", "whitespace_collapsed", "case_insensitive", "first_token", "sanitized", "field_containment"],
      note: "Substring matching is deliberately NOT a tier at any strength: `EPI_ISL_4021` must never match `EPI_ISL_402124`, because the failure mode of a fuzzy match here is a plausible WRONG date."
    },
    beyond_reference:
      "This layer is the UNION of all three upstream parsers, so it dates sequences `hyphaeon temporal` cannot — measured on korber, 142 of 143 by the `korber_isolate` rule the reference's header parser does not have. A different dated set is a different time axis, kernel, candidate set and null, so `record.dates.beyond_reference` carries the count and the rules, TEMPORAL_DATES_BEYOND_REFERENCE warns, and the reproduction line sets reproduces: false and tells you to supply the dates as a `-d` table. The rule the repository works to: we must never SILENTLY do better.",
    options: {
      dates_file: { cli: "-d/--dates", default: null, note: "the metadata's TEXT, never a path; omit it and the headers are read" },
      dates_file_name: { default: null, note: "the basename, printed as `-d <name>` on the reproduction line" },
      date_source_kind: { default: "auto", values: ["auto", "auspice", "json-map", "table"], note: "the CONTENT is sniffed and the name is only a tie-break" },
      strain_col: { cli: "--strain-col", default: "discovered" },
      date_col: { cli: "--date-col", default: "discovered" },
      delimiter: { default: "sniffed over the first 20 lines" },
      date_pattern: { cli: "--date-regex", default: null, note: "one capturing group required; over 512 characters is refused unrun (a ReDoS guard)" },
      date_pattern_flags: { default: "" },
      time_units: {
        cli: "--time-units",
        default: "inferred",
        values: ["years", "generations", "days", "arbitrary"],
        note:
          "INFERRING IS SAFER THAN NAMING. The units probe requires a calendar majority (DATE_THRESHOLDS.calendarMajority 0.5) before it calls the axis calendar, and passing this explicitly BYPASSES that check. Measured on the bundled H1N1 set: inferred, 95 of 100 date over 2009.25-2009.91; forced to `generations`, 100 of 100 date on an axis running 1 to 46,241,654, with no error anywhere."
      },
      archival_1959: { default: false },
      header_fallback: { default: true, note: "with it on, a table that matched nothing still produces a dated run, from DIFFERENT dates than you supplied" },
      rows: { default: true, note: "the per-sequence table" },
      top: { default: null, note: "caps the rows; undated, imputed and fuzzily matched sequences are kept FIRST and the counts always cover every sequence" }
    },
    result_keys: ["ok", "headline", "clock{has_clock, dating_possible, temporal_possible, reasons, temporal_reasons}", "gate{ok, blocking[], overrides, applied}", "date_review{coverage, by_rule, span, time_units, time_units_source, time_units_evidence, match_tier, match_tiers, ambiguous, unmatched_metadata, unmatched_taxa, table, auspice, regex, headers, rows[], warnings[]}", "match_tiers_available", "next"],
    gate:
      "The two questions the browser puts to a human and a tool call cannot ask. DATES_BARE_NUMBER_MAJORITY (half or more of the dates read as a bare number in the name) is overridden by accept_bare_numbers; DATES_UNDATED_PRESENT is overridden by drop_undated. hyphaeon_dating and hyphaeon_temporal REFUSE on them; this tool only reports them, because reporting them is its job.",
    parity: "No CLI counterpart: the reference performs this ingestion silently inside `dating` and `temporal` and prints none of it."
  },
  dating: {
    name: "Heterochronous molecular clock and MRCA dating (ChronAeon)",
    tool: "hyphaeon_dating",
    engine: "in-process; NO MODEL unless use_model is set",
    cli: "hyphaeon dating (aliases date, mrca, clock, chronaeon)",
    requires_codon_alignment: true,
    requires_tree: false,
    tree: "NONE, on any surface. PLAN-TEMPORAL D34 declines the reference's --distance-mode tree, so the reproduction line always carries --no-tree and a supplied tree is recorded as OPTION_NOT_APPLIED rather than quietly used.",
    model_outputs: ["(use_model only) cross_attn_sum, taxa_repr_sum from <variant>_taxa.onnx"],
    surrogate_for: null,
    estimator_note:
      "MODEL-FREE BY DEFAULT, AND THAT IS A SCIENTIFIC CHOICE. `--distance-mode auto` resolves to `latent` when a model pass was supplied and to `tn93` when it was not, and the two are DIFFERENT ANSWERS on the same sequences and dates: measured upstream on korber, t_mrca 1938.77 model-free against 1926.81 with the dating graph, twelve years apart, with the whole warning set changing. So the model half is an explicit request (use_model), never an availability accident, and distance_mode / distance_mode_reason are on every result.",
    second_artifact:
      "use_model needs <variant>_taxa.onnx, a SECOND graph over a different tensor: the backbone emits the ROOT token's attention ROW and the ROOT token's VECTOR, where this pillar needs the taxon-by-taxon block and the per-taxon states, and neither is derivable from the other. A build whose manifest declares no taxa_onnx_sha256 answers use_model: true with DATING_GRAPH_UNAVAILABLE naming that fact; list_models reports `dating_graph` per variant so a client can check first.",
    not_built:
      "record.primaeon.estimators_not_built names what this build does not estimate — the power-law clock (D33), leave-one-out / jackknife, and without the graph the attention PGLS and the latent root search — so no flag for them is ever printed on the reproduction line. --ci-method poisson | residual-boot | site-boot | jackknife are refused rather than silently answered with Fieller, which is what the reference does for an unrecognised value (dating.py:1244-1258).",
    options: {
      use_model: { default: false, note: "run the attention PGLS and latent-root estimators as well; one forward pass over EVERY codon" },
      distance_mode: { cli: "--distance-mode", default: "auto", values: ["auto", "tn93", "latent"], note: "the reference's `tree` is declined (D34); `latent` without use_model is refused, not downgraded" },
      clock_model: { cli: "--clock-model", default: "auto", values: ["auto", "linear", "spline"], note: "the reference's `power` is not ported (D33) and is refused by the enum" },
      ci_method: { cli: "--ci-method", default: "fieller", values: ["fieller", "delta", "linear"] },
      root_taxon: { cli: "--root-taxon", default: "the time-decay weighted consensus", note: "a sequence name or one of unweighted_consensus | flat_consensus | modal_consensus | earliest | earliest_taxon | earliest_cohort" },
      decay_gamma: { cli: "--decay-gamma", default: null },
      excluded_taxa: { default: [], note: "app-side; never silent (DATING_TAXA_EXCLUDED)" },
      allow_stop_codons: { default: true },
      no_auto_trim: { default: false },
      model_variant: { cli: "--model-variant", default: "general", note: "only read when use_model is set" }
    },
    date_options: "every key of the `dates` pillar above, plus accept_bare_numbers / drop_undated",
    result_keys: ["analysis", "ok", "record{alignment, tree(null), root_description, distance_mode, latent_root, taxa_count, timespan, elapsed_seconds, active_model, t_mrca, ci_mrca, mu, ols, pgls, spline, power(null), clock_model, ci_method, selected_clock, ensemble, loocv(null), taxa_summary[], primaeon}", "taxa_summary[]", "date_review", "honesty{distance_mode, distance_mode_reason, model_pass, estimators_not_built, reference_command{command, reproduces, caveats}, note}", "warnings[]"],
    taxa_summary_keys: ["taxon", "sampling_date", "root_divergence", "fitted_divergence", "predicted_date", "divergence_residual", "temporal_residual", "z_score", "is_outlier", "is_holdout", "prediction_method (ours; the reference emits no such column and three different models land in one column upstream)"],
    reference_command:
      "A {command, reproduces, caveats} OBJECT, not the argv array the other pillars carry: a bare string would promise a reproduction this pillar cannot give. `reproduces` is false whenever the dates came from the headers rather than a -d table.",
    caps: "Sized as O(taxa x codons) model-free and as codons x taxa^2 with use_model (src/caps.js workFor). The model-based estimators additionally refuse above 1,500 sequences (DATING_MODEL_MAX_TAXA), which is unreachable at today's MAX_TAXA of 1,000.",
    parity: "No comparator in scripts/parity.py yet. The acceptance evidence is runtime/test/dating-port.test.js; measured upstream, dating.json with {includeProvenance: false} has the SAME 1,821 lines in the same key order as a CLI run, worst float delta 4.5e-10 years on a Fieller endpoint and 1.1e-8 on the spline's date."
  },
  temporal: {
    name: "Temporal selection surveillance (per-site trajectories through calendar time)",
    tool: "hyphaeon_temporal",
    engine: "in-process",
    cli: "hyphaeon temporal (aliases surveillance, longitudinal)",
    requires_codon_alignment: true,
    requires_tree: false,
    tree: TREE_RULE,
    model_outputs: ["lrt", "mean_root_attns"],
    surrogate_for: "no HyPhy counterpart (per-site selection trajectories through calendar time)",
    always_a_job:
      "The record is NEVER returned inline. Measured: 2,149,694 bytes on H5N1_HA_geo (98 taxa x 566 codons at the reference's own --time-points 250), 7.18 MB on the engine's 4,384-codon acceptance run — 8.2x and 27x ANALYZE_INLINE_MAX_BYTES, of which the [codons x time] trajectory store alone is 92%. `top` cannot help: the site columns are typed arrays in a column store, not arrays of records. The tool waits inside the call and answers with the summary plus the job id.",
    sections: {
      names: ["summary", "sites", "curves", "waves", "permutations", "dates", "candidates", "warnings", "honesty", "provenance"],
      note: "get_results job_id=... section=<name>. `sites` and `curves` take a `sites` list of 1-indexed codons and default to the stage-one candidates, strongest peak intensity first. `curves` is budgeted at " + TEMPORAL_CURVES_MAX_POINTS + " NUMBERS a call rather than a codon count, because the grid is a caller option: 75 codons at time_points 60, 18 at 250. A number costs 13.5 to 22.6 bytes depending on the trajectory (an invariable codon writes `0,`), so the budget is set from the WORST case and not the mean. `sites` returns " + TEMPORAL_SITES_MAX_ROWS + " rows (measured at 780-783 bytes a row). A run STOPPED by cancel_job is served the same way and labelled: status cancelled, partial_result true, and the draw count it reached.",
      every_section_carries: "the `honesty` block"
    },
    honesty: {
      null_state: "not-started | running | finished | stopped. THE ONLY THING that says whether a negative finding is a result. `permutations.tested` flips true after the FIRST chunk while `classification`, `is_confirmed_sweep` and the three sweep counts are still zeros, so reading it alone prints 'nothing is under selection' a second into every run — and prints it every time, because p at draw k is (1 + exceedances)/(k + 1) and starts near 1 for every codon. A run STOPPED by the caller that kept at least one draw is `finished`: the runtime catches its own abort, classifies at the achieved count and returns a complete record, so those labels are results.",
      p_perm_fill: "`p_perm` and `q_perm` are 1.0 at every codon that never reached stage two (4,138 of 4,384 on the acceptance run), which is the reference's own fill (temporal.py:620-621) and NOT a measurement. A 1.0 does NOT mean untested, and this document said it did until phase 6's review measured the counter-example: on H5N1 at B = 200, 399 of 566 rows read exactly 1.0 against 398 non-candidates, the extra one being a tested candidate that every shuffle beat, which scores (1 + B) / (B + 1) = 1.0 exactly. THE COLUMN THAT TELLS THEM APART IS `classification` — INVARIABLE and FLAT_NO_SIGNAL were never tested, TEMPORAL_NOISE and CONFIRMED_SWEEP were — and on this surface the mask is `get_results section=candidates`. The one case the reference cannot reach: a null DECLINED over the work budget or STOPPED early leaves NaN (JSON `null`) at a candidate it never got to.",
      wave_variance: "The fPCA shares are conditioned on the confirmed-sweep set, which is thresholded on a permutation p drawn from a different generator than the reference's, so they MOVE WITH THE NULL: measured upstream on H1N1 at B = 100, 32 confirmed here against 18 there, shares 33.84/28.26/17.81/11.11 % against 39.67/32.37/13.92/9.31 — 5.8 points on the leading mode, with identical arithmetic. Below four confirmed codons the set falls back to the strongest candidates by peak intensity and `waves.source` says which branch was taken.",
      escape_hatch_used: "temporal.py:692-693's silent fallback selection (p_perm <= 0.10 OR static LRT >= 3.84 when nothing cleared confirmation), which the reference records in no output file.",
      upstream_bugs_replicated: [
        "`_curves.csv` writes selection_intensity and sweep_velocity from the same array (temporal.py:807-808): one quantity, not two",
        "p_perm / q_perm are 1.0 at untested codons (temporal.py:620-621)",
        "tau_peak's override tests the VALUE rather than whether a caller supplied one (temporal.py:605, 610)",
        "an invariable codon reports a peak date of t_min because argmax of a zero row is 0 (`sites.peak_at_first_grid_point` marks it)"
      ]
    },
    options: {
      time_points: { cli: "--time-points", default: 250, note: "the single biggest term in the record's size" },
      bandwidth: { cli: "-bw/--bandwidth", default: "auto, about 5% of the timespan" },
      n_permutations: { cli: "-B/--n-permutations", default: 1000, max: MAX_PERMUTATIONS, note: "fewer draws do not bias p, they coarsen its grid to 1/(B+1), and every q then sits at a floor of C/(B+1)" },
      perm_alpha: { cli: "--perm-alpha", default: 0.05 },
      min_r2: { cli: "--min-r2", default: 0.35 },
      tau_peak: { cli: "--tau-peak", default: 1e-4 },
      tau_auc: { cli: "--tau-auc", default: null },
      sweep_mode: { cli: "--sweep-mode", default: "auto", values: ["auto", "episodic", "fixation"] },
      time_units: { cli: "--time-units", default: "inferred by the date layer", values: ["years", "generations", "days", "arbitrary"] },
      keep_duplicates: { cli: "--keep-duplicates", default: false, note: "identical haplotypes sampled on DIFFERENT DAYS collapse to one date, which deletes time points (TEMPORAL_DUPLICATES_COLLAPSED)" },
      root_taxon: { cli: "--root-taxon", default: "the consensus of the earliest 5% of sampled taxa", note: "setting it FORCES score_invariable_sites back on (upstream bug TEMPORAL Q2)" },
      score_invariable_sites: { default: true, note: "as `hyphaeon temporal` does. False is legitimate and cheap (93% saving, same candidate set, bit-identical peak date) and is REPORTED in primaeon and in the reproduction caveats" },
      wave_sign: { default: "canonical", values: ["canonical"], note: "D28. The reference has NO convention and writes its solver's raw singular vectors; accepting `lapack` would promise numbers this build does not compute" },
      max_species: { cli: "-s/--max-species", default: null, note: "NO cap unless asked for. Faith's-PD subsampling is TIME-BLIND (D27) and can delete the early part of an epidemic, which is the part a sweep is measured against; MAX_TAXA (1,000) stays the submission refusal" },
      perm_work_budget: { default: "the runtime's 5.0e10", note: "over budget the null is DECLINED and everything else is still computed; the four-way classification degrades to three" },
      seed: { cli: "(none upstream: RandomState(42) is hard-coded, temporal.py:651)", default: 42 },
      batch_size: { cli: "-b/--batch-size", default: "adaptive" }
    },
    date_options: "every key of the `dates` pillar above, plus accept_bare_numbers / drop_undated",
    result_keys: ["the reference's eighteen summary keys in its order", "sites{27 typed columns + scored / invariable / stage1 / peak_at_first_grid_point masks}", "curves{T, time, prevalence[L,T], velocity[L,T]}", "waves{data[4,T], var_explained, sigma, gaps, near_degenerate, sign, source, source_sites}", "candidates", "permutations{requested, completed, cancelled, skipped, grid_step, q_min, q_rank1_bound, rounds, work, budget, within, nnz, reason, estimator, rng, seed, chunks, ms_per_draw, tested}", "escape_hatch_used", "solitary_regime", "gate_vacuous", "regime", "grid", "floors", "root", "dates", "warnings", "primaeon"],
    reference_command:
      "A {command, reproduces, caveats} OBJECT (the runtime's own temporalReferenceCommand), not the argv array the other pillars carry. `reproduces` is FALSE on every run whose null drew at all: numpy MT19937 at a hard-coded RandomState(42) upstream against xoshiro256** per-draw substreams here (D17). Caveat zero is emitted on every run, true or false, and says the four files will not diff clean.",
    parity: "No comparator in scripts/parity.py yet. The acceptance evidence is runtime/test/temporal-port.test.js against fixtures/temporal/acceptance/. Measured upstream on H1N1 at -B 100 --time-points 60: the four writers reproduce the reference's FORMAT byte for byte (780,749 / 1,186,202 / 6,083 bytes re-written exactly) and NOT its content — 1 of 4,384 site rows byte-identical, 17 of 27 columns differing somewhere, 0 of 60 waves rows matching. Two causes: ONNX against torch at ~1e-6 upstream of the shuffle, and a different PRNG downstream of it."
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
  taxa: {
    min: MIN_TAXA,
    max: MAX_TAXA,
    model_cap: TAXON_CAP,
    // A DIFFERENT NUMBER FOR A DIFFERENT QUESTION: MAX_TAXA is what this server accepts at all,
    // TAXON_CAP is the model's own ceiling after PD subsampling, and this is what the model-based
    // clock estimators will run — a refusal, never a downsample (dating.py:2745-2747 falls back to
    // OLS silently; this build will not). Unreachable while MAX_TAXA is the smaller of the two.
    dating_model_max: DATING_MODEL_MAX_TAXA
  },
  codons_max: MAX_CODONS,
  temporal: {
    always_a_job: TEMPORAL_ALWAYS_JOB,
    record_never_inline: "measured at 2,149,694 bytes on a 98 x 566 example and 7.18 MB on a 4,384-codon run, 8.2x and 27x inline_limit_bytes",
    sections: TEMPORAL_SECTIONS,
    curves_points_max: TEMPORAL_CURVES_MAX_POINTS,
    sites_rows_max: TEMPORAL_SITES_MAX_ROWS,
    permutations_max: MAX_PERMUTATIONS,
    null_work_budget: "the runtime's own (5.0e10 by default); over it the null is declined and every other column is still computed"
  },
  dates: { work: 0, note: "the date layer reads sequence NAMES and no codon; its cap is alignment_chars_max and its cost is milliseconds" },
  work: {
    definition:
      "codon sites x sequences^2 (x " + DMS_MUTANTS_PER_SITE + " for dms; analyze is sized like meme and caps its DMS section by its own budget; " +
      "dating model-free is sized as codon sites x sequences, dates as 0), measured on the file as submitted",
    sync_max: MAX_SYNC_WORK,
    hard_max: MAX_WORK,
    sync_codons_max: MAX_SYNC_CODONS
  },
  permutations_max: MAX_PERMUTATIONS,
  permulations_max: MAX_PERMULATIONS,
  job_timeout_sec: JOB_TIMEOUT_MS / 1000,
  analyze: { wait_default_sec: ANALYZE_WAIT_DEFAULT_SEC, wait_max_sec: ANALYZE_WAIT_MAX_SEC, inline_limit_bytes: ANALYZE_INLINE_MAX_BYTES }
};

/**
 * The completed hyphaeon_temporal jobs in a job store, newest first.
 *
 * A temporal run gets a resource of its own for the same reason a report does — a client should be
 * able to read a finished run without holding the tool call's reply — and it serves the SUMMARY and
 * the honesty block rather than the record, because the record is megabytes (measured: 2.1 MB on
 * the 98 x 566 H5N1 example at the reference's own 250 time points). The sections are named in the
 * body so the resource is a door to `get_results section=` rather than a dead end.
 */
export function listTemporalRuns(jobs) {
  if (!jobs || typeof jobs.list !== "function") return [];
  return jobs
    .list()
    // A STOPPED RUN THAT KEPT A RECORD IS READABLE TOO (src/jobs.js): the runtime classified at the
    // draws it reached and returned a complete record, and a resource list that hid it would send a
    // client back to a tool call to re-earn numbers this process already has. It is listed as
    // stopped, never as finished, and `partial_result` travels with it.
    .filter((j) => j.analysis === "temporal" && (j.status === "completed" || (j.status === "cancelled" && j.partial_result)))
    .sort((a, b) => String(b.finished_at || "").localeCompare(String(a.finished_at || "")));
}

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

  server.registerResource(
    "temporal",
    new ResourceTemplate("hyphaeon://temporal/{id}", {
      list: async () => ({
        resources: listTemporalRuns(jobs).map((j) => ({
          uri: "hyphaeon://temporal/" + j.job_id,
          name: "temporal " + j.job_id.slice(0, 8),
          description:
            j.status === "cancelled"
              ? "hyphaeon_temporal run STOPPED " + j.finished_at + " (" + j.elapsed_sec + " s): a partial run, read `partial` for the draw count it reached"
              : "hyphaeon_temporal run finished " + j.finished_at + " (" + j.elapsed_sec + " s)",
          mimeType: "application/json"
        }))
      }),
      complete: {
        id: async (value) => listTemporalRuns(jobs).map((j) => j.job_id).filter((id) => id.startsWith(value || ""))
      }
    }),
    {
      title: "Finished HyphAeon temporal runs",
      description:
        "A completed hyphaeon_temporal run by its id: the reference's eighteen summary keys, the date review, and the " +
        "HONESTY block (null_state, whether the calls are final, why nothing is called when nothing is, the p_perm fill " +
        "note, the set the wave shares are conditioned on, and the {command, reproduces, caveats} reproduction line). " +
        "NOT the record: its trajectory store alone is megabytes, so the sites, curves, waves, permutations, dates, " +
        "candidates and warnings are read with get_results section=<name>, which this resource names. A running or " +
        "unknown id reads as an error saying so.",
      mimeType: "application/json"
    },
    async (uri, variables) => {
      const id = Array.isArray(variables.id) ? variables.id[0] : variables.id;
      const text = temporalText(jobs, id);
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

/**
 * The JSON text of a finished temporal run's summary and honesty block, or an "Error: ..." line.
 *
 * NEVER THE WHOLE RECORD. `p_perm` is 1.0 at every codon that never reached stage two and the
 * trajectory store is megabytes, so a resource that served the record would hand a client both the
 * bulk it cannot use and the two columns it must not read unqualified. The honesty block is what
 * qualifies them, and it is the part this resource exists to deliver.
 */
export function temporalText(jobs, id) {
  if (!jobs) return "Error: this server keeps no job store, so no temporal runs are available.";
  if (typeof id !== "string" || !/^[0-9a-f]{32}$/.test(id)) return "Error: a temporal id is the 32-hex job_id hyphaeon_temporal returned.";
  const job = jobs.get(id);
  if (!job) return "Error: no job " + id + " (jobs expire after their TTL).";
  if (job.analysis !== "temporal") return "Error: job " + id + " is a hyphaeon_" + job.analysis + " run, not a temporal run; read it with get_results" + (job.analysis === "analyze" ? " or hyphaeon://report/" + id : "") + ".";
  const kept = typeof jobs.kept === "function" ? jobs.kept(id) : undefined;
  if (job.status !== "completed" && !kept) {
    return (
      "Error: temporal run " + id + " is " + job.status +
      (job.status === "failed" && job.error ? ": " + job.error.message : "") +
      (job.status === "running" ? " (poll job_status; nothing of a temporal run is readable until it completes, because its calls are computed at the end)" : "") +
      (job.status === "cancelled"
        ? job.result_pending
          ? " and its runner has not finished unwinding; read it again in a moment"
          : " and kept nothing: the cancel arrived before the first permutation chunk finished, and everything downstream of the null is computed at the end"
        : "") +
      "."
    );
  }
  const stored = kept ? kept.value : jobs.result(id);
  if (!stored || !stored.result || !stored.result.record) return "Error: temporal run " + id + " kept no record.";
  const partial = kept
    ? Object.assign(
        { cancelled: true, kept_at: kept.at },
        (stored.result.honesty && stored.result.honesty.null_truncated) || { completed: null, requested: null },
        { reason: "cancel_job was called while this run was in flight; the runtime returned the record it had finished." }
      )
    : null;
  return JSON.stringify(
    {
      analysis: "temporal",
      job_id: id,
      status: kept ? "cancelled" : "completed",
      partial_result: !!kept,
      ...(partial ? { partial } : {}),
      stage: stored.result.record.stage,
      summary: temporalSummary(stored.result.record),
      honesty: stored.result.honesty,
      date_review: stored.result.date_review,
      sections: TEMPORAL_SECTIONS,
      next:
        "get_results job_id=" + id + " section=<" + TEMPORAL_SECTIONS.join("|") +
        ">. The record itself is never served whole: its [codons x time] trajectory store alone is megabytes.",
      provenance: stored.provenance
    },
    null,
    2
  );
}
