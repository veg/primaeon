/**
 * resources.js — the HyphAeon MCP resources.
 *
 * WHY THIS FILE EXISTS
 *
 * PLAN.md 3.6: hyphaeon://models, hyphaeon://methods/requirements, hyphaeon://caveats,
 * hyphaeon://examples/{name}; Phase 1b adds hyphaeon://gallery and hyphaeon://gallery/{name}.
 * Modelled on datamonkey-js-server lib/mcp/resources.js (static resources plus ResourceTemplates),
 * in ESM.
 *
 *   models        the manifest as the runtime's reader validates it (src/models.js over
 *                 runtime/src/manifest.js `loadManifest`), with per-variant graph paths;
 *   requirements  per-pillar requirements: tree rules, options with the CLI defaults from
 *                 hyphaeon/cli.py (veg/HyphAeon phase-1a), the caps from src/caps.js, the warning
 *                 codes hyphaeon_validate can emit, and which pillars run in-process — so a client
 *                 can plan a call without trial and error;
 *   caveats       mcp/caveats.json: the model card facts of PLAN.md 2 and the numbers of
 *                 HyphAeon/model_eval/README.md, keyed by model_version;
 *   examples      the bundled example files from HyphAeon/examples (env HYPHAEON_EXAMPLES_DIR),
 *                 listed through the template's list callback and served by bare file name;
 *   gallery       the prebaked site-selection records web/scripts/prebake-gallery.mjs writes under
 *                 web/static/gallery (env HYPHAEON_GALLERY_DIR): the index, and one record per
 *                 example by id (`bat_oas1`, `Smc6`, ...) — the same documents the /gallery page
 *                 opens, so a client can read a result without running anything.
 */

import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFile } from "node:fs/promises";
import {
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
import { CODES, NATIVE_ANALYSES, BRIDGED_ANALYSES } from "./validate.js";
import { listExamples, listGalleryRecords, readExample, readGalleryIndex, readGalleryRecord, readManifest } from "./models.js";

const CAVEATS_URL = new URL("../caveats.json", import.meta.url);

const TREE_RULE =
  "Optional: a Newick/NEXUS tree in `tree`, or a tree embedded in the alignment. Tips must match " +
  "sequence names (exact, then quote-stripped, then case-insensitive). Topology-only trees get " +
  "HKY85 branch lengths from HyPhy when the server has an estimator (list_models reports it), else " +
  "dataset.py's 1e-3 defaults; max patristic > 10 is rescaled. use_tn93 (TN93 distances instead of " +
  "a tree) is accepted by the bridged pillars only.";

export const METHOD_REQUIREMENTS = {
  meme: {
    name: "Site selection (MEME surrogate)",
    tool: "hyphaeon_meme",
    engine: "in-process",
    cli: "hyphaeon meme (aliases predict, site-selection)",
    requires_codon_alignment: true,
    tree: TREE_RULE,
    model_outputs: ["lrt"],
    surrogate_for: "MEME",
    options: {
      model_variant: { cli: "--model-variant", default: "general", values: ["general", "viral"] },
      max_species: { cli: "--max-species", default: null, range: [2, TAXON_CAP] },
      use_tn93: { cli: "--use-tn93 / --no-tree", default: false, note: "refused in-process (no TN93 implementation)" },
      filter: { cli: "--filter", default: false },
      filter_p_thresh: { cli: "--filter-p-thresh", default: 0.01 },
      min_patch_consec: { cli: "--min-patch-consec", default: 3, note: "recorded; only the default is applied in-process" },
      attribute: { cli: "--attribute", default: false },
      attribution_min_lrt: { cli: "--attribution-min-lrt", default: 3.84 },
      no_prune_duplicates: { cli: "--no-prune-duplicates", default: false },
      batch_size: { cli: "--batch-size", default: "adaptive" },
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
    tree: TREE_RULE,
    model_outputs: ["lrt", "root_repr -> busted_head.onnx"],
    surrogate_for: "BUSTED",
    options: {
      model_variant: { cli: "--model-variant", default: "general", values: ["general", "viral"], note: "the busted head ships for general only; viral gives the statistical fields with null neural fields" },
      max_species: { cli: "--max-species", default: 512, range: [2, TAXON_CAP] },
      use_tn93: { cli: "--use-tn93 / --no-tree", default: false, note: "refused in-process" },
      batch_size: { cli: "--batch-size", default: "adaptive" },
      gene: { default: "the alignment file's stem" },
      cpu: { cli: "--cpu", default: false }
    },
    result_keys: ["alignment", "gene", "taxa", "sites", "p_value_acat", "p_value_simes", "omnibus_lrt", "predicted_gene_lrt", "selection_probability", "synonymous_rate_variation", "total_selection_energy", "sig_sites_p05", "sig_sites_p10", "rate_distributions{omega_k, proportion_k}", "positive_selection_detected", "elapsed_seconds", "sites_detail[]", "statistics", "summary"],
    reproducible_fields: ["p_value_acat", "p_value_simes", "omnibus_lrt", "total_selection_energy", "sig_sites_p05", "sig_sites_p10"],
    neural_fields_note: "predicted_gene_lrt, selection_probability, synonymous_rate_variation, omega_3 and proportion_* come from one seeded draw of a head the reference loads unseeded (provenance.neural_head.deterministic_upstream false)."
  },
  epistasis: {
    name: "Co-selection network and epistatic sectors",
    tool: "hyphaeon_epistasis",
    engine: "python-reference",
    cli: "hyphaeon epistasis (aliases coselection, sector, network)",
    requires_codon_alignment: true,
    tree: TREE_RULE,
    model_outputs: ["lrt", "mean_root_attns"],
    surrogate_for: "MEME (site signal) — the network itself has no HyPhy counterpart",
    options: {
      use_tn93: { cli: "--use-tn93 / --no-tree", default: false },
      focal_taxon: { cli: "--focal-taxon", default: "consensus" },
      min_sim: { cli: "--min-sim", default: 0.3 },
      min_shared: { cli: "--min-shared", default: 2 },
      max_fdr: { cli: "--max-fdr", default: 0.05 },
      min_lrt: { cli: "--min-lrt", default: 1.0 },
      min_clique_size: { cli: "--min-clique-size", default: 3 },
      max_overlap: { cli: "--max-overlap", default: 0.5 },
      min_coherence: { cli: "--min-coherence", default: 0.5 },
      n_permutations: { cli: "--n-permutations", default: 10000, max: MAX_PERMUTATIONS },
      max_perm_p: { cli: "--max-perm-p", default: null },
      no_dms: { cli: "--no-dms", default: false },
      cpu: { cli: "--cpu", default: false },
      model_variant: { cli: "(not available on this subcommand)", default: "general" }
    },
    result_keys: ["taxa_count", "codon_count", "edges[]", "sectors[]", "plasticity[]"],
    edge_keys: ["site_u", "site_v", "ref_u", "ref_v", "lrt_u", "lrt_v", "similarity", "shared_taxa", "shared_branches", "p_val", "hyper_p", "fdr_q", "cesi"],
    sector_keys: ["sector_id", "size", "sites[]", "spectral_coherence", "p_perm", "null_coherence_mean", "null_coherence_std", "null_coherence_95", "isotropic_baseline", "mean_lrt", "pars_signature"]
  },
  dms: {
    name: "Digital deep mutational scan",
    tool: "hyphaeon_dms",
    engine: "python-reference",
    cli: "hyphaeon dms (aliases essm, digital-dms)",
    requires_codon_alignment: true,
    tree: TREE_RULE,
    model_outputs: ["lrt (19 x L passes)"],
    surrogate_for: "no HyPhy counterpart; delta-LRT of the MEME surrogate under substitution",
    options: {
      use_tn93: { cli: "--use-tn93 / --no-tree", default: false },
      focal_taxon: { cli: "--focal-taxon", default: "consensus" },
      cpu: { cli: "--cpu", default: false },
      model_variant: { cli: "(not available on this subcommand)", default: "general" }
    },
    result_keys: ["taxa_count", "codon_count", "focal_taxon", "total_mutations", "plasticity[]"],
    plasticity_keys: ["site", "wt_aa", "baseline_lrt", "p_value", "intrinsic_plasticity", "mean_delta_lrt", "max_delta_lrt", "min_delta_lrt", "mutant_deltas{AA: dLRT}"]
  },
  phenotype: {
    name: "Phenotype association (PhyloWAS)",
    tool: "hyphaeon_phenotype",
    engine: "python-reference",
    cli: "hyphaeon phenotype (aliases phylowas, trait)",
    requires_codon_alignment: true,
    tree: TREE_RULE,
    model_outputs: ["lrt", "mean_root_attns"],
    surrogate_for: "no HyPhy counterpart; attention-based trait association",
    trait: "One of preset, foreground (comma list or regex), or phenotype_file (CSV/TSV) is required.",
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
      use_tn93: { cli: "--use-tn93 / --no-tree", default: false },
      cpu: { cli: "--cpu", default: false }
    },
    result_keys: ["phenotype_meta", "taxa_count", "codon_count", "significant_sites_count", "spectral_energy", "norm_spectral_ratio", "max_assoc", "p_evd_length_adjusted", "compact_pars_signature", "permulations_count", "gene_p_value_perm", "sites[]", "trait_sectors[]", "coselection_pairs[]"],
    site_keys: ["site", "ref_aa", "derived_aa", "hyphaeon_lrt", "p_lrt", "association_rho", "p_value", "p_assoc", "p_assoc_parametric", "p_assoc_perm", "score", "foreground_freq_pct", "background_freq_pct", "q_value", "fg_mean_attn", "bg_mean_attn"]
  },
  evaluate: {
    name: "Concordance with HyPhy MEME",
    tool: "hyphaeon_evaluate",
    engine: "in-process",
    cli: "hyphaeon evaluate --prediction --meme-result",
    requires_codon_alignment: false,
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
    definition: "codon sites x sequences^2 (x " + DMS_MUTANTS_PER_SITE + " for dms), measured on the file as submitted",
    sync_max: MAX_SYNC_WORK,
    hard_max: MAX_WORK,
    sync_codons_max: MAX_SYNC_CODONS
  },
  permutations_max: MAX_PERMUTATIONS,
  permulations_max: MAX_PERMULATIONS,
  job_timeout_sec: JOB_TIMEOUT_MS / 1000
};

/**
 * @param {import("@modelcontextprotocol/sdk/server/mcp.js").McpServer} server
 * @param {{env?: object, logger?: object}} [deps]
 */
export function registerResources(server, deps = {}) {
  const env = deps.env || process.env;

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
      description: "Per-pillar inputs, options with CLI defaults, result keys, size caps, which pillars run in-process, and the warning codes hyphaeon_validate emits.",
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
              caps: CAPS,
              validation_codes: CODES,
              provenance: {
                native: { surfaces: ["mcp-stdio", "mcp-http"], analyses: [...NATIVE_ANALYSES], note: "Computed in the MCP process by @veg/hyphaeon-js through @veg/hyphaeon-runtime over onnxruntime-node." },
                bridged: { surface: "python-reference", analyses: [...BRIDGED_ANALYSES], note: "Run through the Python reference CLI until the port lands (PLAN.md 8, phases 2-3)." }
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
      description: "The gallery index (web/static/gallery/index.json): one prebaked site-selection run per bundled example, with the card numbers and which entries have a record.",
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
      description: "The prebaked site-selection result document for a bundled example, by gallery id (e.g. bat_oas1, Smc6); the same document the /gallery page opens.",
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
}

function mimeFor(name) {
  if (name.endsWith(".json")) return "application/json";
  if (name.endsWith(".csv")) return "text/csv";
  return "text/plain";
}
