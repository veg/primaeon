/**
 * resources.js — the four HyphAeon MCP resources.
 *
 * WHY THIS FILE EXISTS
 *
 * PLAN.md 3.6: hyphaeon://models, hyphaeon://methods/requirements, hyphaeon://caveats,
 * hyphaeon://examples/{name}. Modelled on datamonkey-js-server lib/mcp/resources.js (static
 * resources plus one ResourceTemplate), in ESM.
 *
 *   models        the same view list_models returns (src/models.js);
 *   requirements  per-pillar requirements: tree rules, options with the CLI defaults from
 *                 hyphaeon/cli.py (veg/HyphAeon@3cb9cc6), the caps from src/caps.js, and the
 *                 warning codes hyphaeon_validate can emit — so a client can plan a call without
 *                 trial and error;
 *   caveats       mcp/caveats.json: the model card facts of PLAN.md 2 and the numbers of
 *                 HyphAeon/model_eval/README.md, keyed by model_version;
 *   examples      the bundled example files from HyphAeon/examples (env HYPHAEON_EXAMPLES_DIR),
 *                 listed through the template's list callback and served by bare file name.
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
import { CODES } from "./validate.js";
import { listExamples, readExample, readManifest } from "./models.js";

const CAVEATS_URL = new URL("../caveats.json", import.meta.url);

const TREE_RULE =
  "Optional: a Newick/NEXUS tree in `tree`, or a tree embedded in the alignment, or use_tn93 " +
  "(TN93 distances from the sequences). Tips must match sequence names exactly. Topology-only " +
  "trees get HKY85 branch lengths from HyPhy when it is on PATH; max patristic > 10 is rescaled.";

export const METHOD_REQUIREMENTS = {
  meme: {
    name: "Site selection (MEME surrogate)",
    tool: "hyphaeon_meme",
    cli: "hyphaeon meme (aliases predict, site-selection)",
    requires_codon_alignment: true,
    tree: TREE_RULE,
    model_outputs: ["lrt"],
    surrogate_for: "MEME",
    options: {
      model_variant: { cli: "--model-variant", default: "general", values: ["general", "viral"] },
      max_species: { cli: "--max-species", default: null, range: [2, TAXON_CAP] },
      use_tn93: { cli: "--use-tn93 / --no-tree", default: false },
      filter: { cli: "--filter", default: false },
      filter_p_thresh: { cli: "--filter-p-thresh", default: 0.01 },
      min_patch_consec: { cli: "--min-patch-consec", default: 3 },
      attribute: { cli: "--attribute", default: false },
      attribution_min_lrt: { cli: "--attribution-min-lrt", default: 3.84 },
      no_prune_duplicates: { cli: "--no-prune-duplicates", default: false },
      batch_size: { cli: "--batch-size", default: "adaptive" },
      cpu: { cli: "--cpu", default: false }
    },
    result_keys: ["taxa_count", "codon_count", "runtime_sec", "filter_enabled", "artifacts_masked", "attribution_enabled", "attributions", "sites[]"],
    site_keys: ["site", "hyphaeon_lrt", "p_value", "q_value", "is_invariable", "evolutionary_epoch?", "adaptation_mode?", "top_driver?", "top_mutation?", "attribution_details?"]
  },
  busted: {
    name: "Gene-level omnibus (BUSTED surrogate)",
    tool: "hyphaeon_busted",
    cli: "hyphaeon busted (aliases omnibus, gene-selection)",
    requires_codon_alignment: true,
    tree: TREE_RULE,
    model_outputs: ["lrt", "root_repr -> head_busted"],
    surrogate_for: "BUSTED",
    options: {
      model_variant: { cli: "--model-variant", default: "general", values: ["general", "viral"] },
      max_species: { cli: "--max-species", default: 512, range: [2, TAXON_CAP] },
      use_tn93: { cli: "--use-tn93 / --no-tree", default: false },
      batch_size: { cli: "--batch-size", default: "adaptive" },
      cpu: { cli: "--cpu", default: false }
    },
    result_keys: ["gene", "taxa", "sites", "p_value_acat", "p_value_simes", "omnibus_lrt", "predicted_gene_lrt", "selection_probability", "synonymous_rate_variation", "total_selection_energy", "sig_sites_p05", "sig_sites_p10", "rate_distributions{omega_k, proportion_k}", "positive_selection_detected", "elapsed_seconds"]
  },
  epistasis: {
    name: "Co-selection network and epistatic sectors",
    tool: "hyphaeon_epistasis",
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
    result_keys: ["matched_genes", "total_sites", "evaluated_sites", "evaluation_scope", "pearson_r", "spearman_rho", "thresholds{\"0.05\",\"0.10\" -> roc_auc, ppv, fpr, confusion}", "per_gene[]", "warnings[]"]
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
      description: "Model variants, training regime, artifact hashes and caps from models/manifest.json (or the reference's known variants when the manifest is absent).",
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
      description: "Per-pillar inputs, options with CLI defaults, result keys, size caps, and the warning codes hyphaeon_validate emits.",
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
                surface_now: "python-reference",
                note: "Phase 0: every analysis runs through the Python CLI bridge; provenance.surface says so. Ported pillars will report mcp-stdio / mcp-http."
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
}

function mimeFor(name) {
  if (name.endsWith(".json")) return "application/json";
  if (name.endsWith(".csv")) return "text/csv";
  return "text/plain";
}
