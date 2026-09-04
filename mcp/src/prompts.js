/**
 * prompts.js — interpretation guides, one per pillar.
 *
 * WHY THIS FILE EXISTS
 *
 * PLAN.md 3.6: "Prompts. One interpretation guide per pillar, written from section 2." Section 2
 * is the list of hard truths (surrogate not truth; rank strong, scale compressed; regime-dependent
 * calibration; invariable means not scored; base vs viral; sequences are unpublished research).
 * The style is the AxoMEME guide in datamonkey-js-server lib/mcp/prompts.js:369-392: "Read this
 * first", key fields, what significance does and does not mean, common misinterpretations.
 *
 * The numbers quoted here are the ones in PLAN.md 2 and HyphAeon/model_eval/README.md
 * (veg/HyphAeon@3cb9cc6) and are also in mcp/caveats.json; if the model changes, both change.
 */

import { z } from "zod";

const SURROGATE_PREAMBLE =
  "## Read this first\n" +
  "HyphAeon is a **neural surrogate for MEME**, evaluated against MEME, not against truth. Every " +
  "result carries `provenance.is_surrogate: true` and `surrogate_for: \"MEME\"`; carry that caveat " +
  "into anything you say about the numbers. `provenance.surface` says who computed them: " +
  "`mcp-stdio` / `mcp-http` is the JavaScript port running in the MCP process (hyphaeon_meme, " +
  "hyphaeon_busted, hyphaeon_evaluate; LRTs match `hyphaeon meme` within 1e-5 and p/q are the " +
  "same float32 values); `python-reference` is the Python reference implementation through a " +
  "bridge (hyphaeon_epistasis, hyphaeon_dms, hyphaeon_phenotype, until their ports land).\n\n";

export const GUIDES = {
  meme: {
    title: "Interpret hyphaeon_meme results",
    text:
      "# Interpreting HyphAeon site selection (MEME surrogate)\n\n" +
      SURROGATE_PREAMBLE +
      "## Key fields\n" +
      "- `sites[]` — one row per codon site: `hyphaeon_lrt`, `p_value` (MEME asymptotic mixture " +
      "1/3 d0 + 2/3 (0.45 chi2_1 + 0.55 chi2_2)), `q_value` (Benjamini-Hochberg), `is_invariable`\n" +
      "- `is_invariable: true` means the site was **not scored** — its LRT is 0 by construction, " +
      "not because selection was tested and absent. Never rank or count these as zeros\n" +
      "- with `attribute`: `top_driver`, `top_mutation`, `evolutionary_epoch`, `adaptation_mode` and " +
      "`attribution_details` per attributed site\n" +
      "- with `filter`: `artifacts_masked[]` (codon ranges masked in one taxon) and the sites are " +
      "re-scored on the cleaned alignment\n" +
      "- `taxa_count` is the taxa the model saw AFTER duplicate collapse and PD subsampling\n\n" +
      "## Significance\n" +
      "- **Rank is strong, scale is compressed.** On HIV-1 RT the Spearman correlation with MEME's " +
      "LRT is 0.53 but the regression slope is 0.16; across the literature set ROC-AUC is 0.914 with " +
      "PPV 50.6%. Sort by `hyphaeon_lrt`, report rank and percentile within this alignment, and show " +
      "p and q beside them — never p or q alone\n" +
      "- **Calibration depends on regime.** On neutral simulations the false-positive rate at alpha " +
      "0.05 is 5-7% for 20-50 taxa but about 36% at 100 taxa on deep trees. If hyphaeon_validate " +
      "reported DEEP_LARGE_TREE, treat p-values as ordering only\n" +
      "- A site of interest should be confirmed with a real MEME run on Datamonkey before it is " +
      "reported as under selection\n\n" +
      "## Common misinterpretations\n" +
      "- Quoting `p_value` as MEME's p-value: it is the surrogate's, and the surrogate's LRT scale is " +
      "compressed\n" +
      "- Counting invariable sites as non-selected: they were not scored\n" +
      "- Comparing LRTs between two alignments: the ranking is within one alignment\n" +
      "- Reading a top-ranked site as positive: some site is top-ranked in every alignment\n" +
      "- Ignoring the variant: `general` is trained on deep mammalian trees; on shallow viral trees " +
      "`viral` correlates far better with MEME (rho ~0.43 vs ~0.10)\n"
  },
  busted: {
    title: "Interpret hyphaeon_busted results",
    text:
      "# Interpreting HyphAeon gene-level omnibus (BUSTED surrogate)\n\n" +
      SURROGATE_PREAMBLE +
      "## Key fields\n" +
      "- `p_value_acat` — Cauchy combination of the per-site Self-Liang p-values over variable sites\n" +
      "- `p_value_simes` — Simes combination over all sites\n" +
      "- `omnibus_lrt` — sum of max(0, LRT - 3.841) over sites: the selection energy above the " +
      "nominal 5% line\n" +
      "- `selection_probability`, `predicted_gene_lrt`, `synonymous_rate_variation`, " +
      "`rate_distributions` — the neural BUSTED head read from the pooled hidden state\n" +
      "- `positive_selection_detected` is `p_value_acat < 0.05 OR selection_probability > 0.5`\n" +
      "- `sig_sites_p05` / `sig_sites_p10` — counts of sites under the nominal thresholds\n\n" +
      "## Significance\n" +
      "- Report the components, not the flag: a gene can be flagged by the neural head alone " +
      "while both combination p-values are above 0.05. Say which one fired\n" +
      "- The combination tests inherit the per-site calibration caveats (regime-dependent FPR), so " +
      "on deep, large trees `p_value_acat` will be small more often than it should\n" +
      "- `rate_distributions` are predicted proportions and omegas, not maximum-likelihood fits; " +
      "the omega values for classes 1 and 2 are fixed by construction in the reference\n\n" +
      "## Common misinterpretations\n" +
      "- Treating `p_value_acat` as BUSTED's p-value\n" +
      "- Reading `selection_probability` as a posterior from a fitted model\n" +
      "- Comparing `omnibus_lrt` between genes of different length without normalising by sites\n"
  },
  epistasis: {
    title: "Interpret hyphaeon_epistasis results",
    text:
      "# Interpreting HyphAeon co-selection networks and epistatic sectors\n\n" +
      SURROGATE_PREAMBLE +
      "## Key fields\n" +
      "- `edges[]` — pairs of sites whose per-branch attribution vectors are similar: `similarity` " +
      "(cosine), `shared_branches`, `p_val`, `fdr_q`, `cesi` (composite epistatic selection index), " +
      "`lrt_u` / `lrt_v`, `ref_u` / `ref_v` (reference amino acids)\n" +
      "- `sectors[]` — groups of sites from the network: `sites`, `size`, `spectral_coherence` " +
      "(lambda_1 / trace), `p_perm` with `null_coherence_mean/std/95` from random K-site subsets, " +
      "`mean_lrt`, `pars_signature`\n" +
      "- `plasticity[]` — the digital DMS of sector nodes (see the dms guide), unless `no_dms`\n\n" +
      "## Significance\n" +
      "- An edge says two sites' selection signal falls on the same branches of THIS tree. That is " +
      "co-selection on the tree, not physical contact, though the paper reports contact enrichment\n" +
      "- `p_perm` is a Monte Carlo p-value: with n_permutations = 10,000 its floor is 1e-4, and it " +
      "is reproducible only statistically across surfaces (each side draws its own permutations)\n" +
      "- Sector membership depends on graph tie-breaking; treat borderline sites as borderline\n" +
      "- Everything rests on the surrogate's per-site signal and attention; the regime caveats of " +
      "hyphaeon_meme apply to every edge\n\n" +
      "## Common misinterpretations\n" +
      "- Reporting an edge as a contact or an interaction: it is co-occurrence of selection on branches\n" +
      "- Reading `spectral_coherence` without its null: `null_coherence_95` is the bar to clear\n" +
      "- Comparing CESI across genes\n"
  },
  dms: {
    title: "Interpret hyphaeon_dms results",
    text:
      "# Interpreting HyphAeon digital deep mutational scanning\n\n" +
      SURROGATE_PREAMBLE +
      "## Key fields\n" +
      "- `plasticity[]` — per site: `wt_aa`, `baseline_lrt`, `p_value`, `mutant_deltas` (delta-LRT for " +
      "each of the 19 alternatives in `focal_taxon`), `mean/max/min_delta_lrt`, `intrinsic_plasticity`\n" +
      "- `focal_taxon` — whose sequence was mutated (consensus by default)\n" +
      "- `total_mutations` = 19 x sites evaluated\n\n" +
      "## Significance\n" +
      "- A delta-LRT is the change in the SURROGATE's MEME-style score when one residue is " +
      "swapped; it is not a fitness effect, a stability change or a laboratory DMS measurement\n" +
      "- High `intrinsic_plasticity` = the model's score barely moves whatever is substituted " +
      "(permissive); low = the site's score depends on the exact residue (rigid, often catalytic " +
      "or structural in the paper's examples)\n" +
      "- Deltas are on the compressed LRT scale (slope ~0.16 vs MEME) — compare within a gene\n\n" +
      "## Common misinterpretations\n" +
      "- Calling a mutant \"deleterious\" or \"pathogenic\" from a negative delta-LRT\n" +
      "- Ranking mutants across genes or across variants of the model\n" +
      "- Forgetting that the tree (and its branch lengths) is fixed while the sequence is mutated\n"
  },
  phenotype: {
    title: "Interpret hyphaeon_phenotype results",
    text:
      "# Interpreting HyphAeon phenotype association (PhyloWAS)\n\n" +
      SURROGATE_PREAMBLE +
      "## Key fields\n" +
      "- `phenotype_meta` — how the trait was defined (preset / foreground / file), foreground and " +
      "background counts. Check the counts first: a preset that matched two taxa is not a test\n" +
      "- `sites[]` — per site: `association_rho`, `p_value` / `q_value`, `score`, `p_assoc_parametric`, " +
      "`p_assoc_perm` (with permulations), `foreground_freq_pct` / `background_freq_pct`, `ref_aa` " +
      "/ `derived_aa`, `fg_mean_attn` / `bg_mean_attn`\n" +
      "- `spectral_energy`, `norm_spectral_ratio`, `p_evd_length_adjusted` — gene-level trait signal\n" +
      "- `gene_p_value_perm` — Brownian-motion permulation p (only with `permulations > 0`)\n" +
      "- `trait_sectors[]`, `coselection_pairs[]` — sectors and pairs restricted to associated sites\n" +
      "- `compact_pars_signature` — the foreground-vs-background amino-acid signature\n\n" +
      "## Significance\n" +
      "- The association is directional: foreground taxa share a derived state AND the model's " +
      "attention lands on their branches. It is confounded by phylogeny in exactly the way " +
      "convergence tests are; permulations (RERconverge-style) are the phylogenetically aware null " +
      "and are worth their cost when a claim will be made\n" +
      "- `p_assoc_perm` and `gene_p_value_perm` are statistical across surfaces (own seeds)\n" +
      "- Foreground sets defined by regex or preset match on taxon NAMES: verify the matched list\n\n" +
      "## Common misinterpretations\n" +
      "- Reading `q_value <= alpha` as proof of adaptive convergence\n" +
      "- Reporting sites with `foreground_freq_pct` near `background_freq_pct` because rho is high\n" +
      "- Treating a shallow or star-like tree as a valid panel (hyphaeon_validate STAR_LIKE_TREE)\n"
  },
  evaluate: {
    title: "Interpret hyphaeon_evaluate results",
    text:
      "# Interpreting HyphAeon-vs-MEME concordance\n\n" +
      "## Read this first\n" +
      "`hyphaeon_evaluate` runs no model. It compares a `hyphaeon meme` CSV with a HyPhy MEME JSON " +
      "for the same gene and reports how well the surrogate reproduces MEME — the same question " +
      "the paper answers, on your data.\n\n" +
      "## Key fields\n" +
      "- `pearson_r`, `spearman_rho` — on LRT over `evaluated_sites` (variable sites only with " +
      "`variable_only`)\n" +
      "- `thresholds[\"0.05\"]` / `[\"0.10\"]` — `roc_auc` (HyphAeon LRT ranking MEME's calls), " +
      "`ppv`, `fpr`, and the confusion matrix, with the inclusive definitions spelled out in " +
      "`*_definition`\n" +
      "- `warnings[]` — clamped negative MEME LRTs, dropped sites under `allow_site_mismatch`\n" +
      "- `per_gene[]` — site counts per gene\n\n" +
      "## Significance\n" +
      "- Expect Spearman 0.3-0.5 on real genes: the reference reports 0.37 (Smc6), 0.27 (bat_oas1), " +
      "0.31 (camelid), and 0.53 on HIV-1 RT. In long genes most sites are near zero on both sides, " +
      "which depresses rank correlation while the top sites still agree\n" +
      "- ROC-AUC near 0.9 with PPV near 0.5 is the literature aggregate: a good ranker, a weak " +
      "classifier at fixed thresholds\n\n" +
      "## Common misinterpretations\n" +
      "- Reading a low Cohen-style agreement as \"the model is wrong\" when the ROC-AUC is high: the " +
      "scale is compressed, so fixed p-value gates disagree while the ordering agrees\n" +
      "- Pooling genes of very different regimes into one correlation\n"
  }
};

export const PROMPT_NAMES = Object.freeze(["choose-analysis", ...Object.keys(GUIDES).map((k) => "interpret-" + k)]);

/**
 * @param {import("@modelcontextprotocol/sdk/server/mcp.js").McpServer} server
 */
export function registerPrompts(server) {
  server.registerPrompt(
    "choose-analysis",
    {
      title: "Choose a HyphAeon analysis",
      description: "Maps a biological question to the HyphAeon tool that answers it, with the caveats that apply.",
      argsSchema: { question: z.string().optional().describe("Your biological question (optional)") }
    },
    (args) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              (args && args.question ? "Based on your question: \"" + args.question + "\"\n\n" : "") +
              "# HyphAeon analysis selection\n\n" +
              "| Question | Tool | Needs | Confirm with |\n" +
              "|---|---|---|---|\n" +
              "| Which codon sites show episodic positive selection? | `hyphaeon_meme` | codon alignment + tree (or use_tn93) | HyPhy MEME |\n" +
              "| Is there selection anywhere in this gene? | `hyphaeon_busted` | same | HyPhy BUSTED |\n" +
              "| Which sites are co-selected / form sectors? | `hyphaeon_epistasis` | same; expensive on large trees | structural or experimental evidence |\n" +
              "| Which substitutions would change the selection signal at a site? | `hyphaeon_dms` | same; 19 x sites passes, <= 3,000 sites | laboratory DMS |\n" +
              "| Which sites associate with a trait across the tree? | `hyphaeon_phenotype` | same + a trait definition | permulations, then an independent panel |\n" +
              "| How well does the surrogate match MEME on my gene? | `hyphaeon_evaluate` | a hyphaeon meme CSV + HyPhy MEME JSON | — |\n\n" +
              "## Before any run\n" +
              "1. `hyphaeon_validate` — format, frame, stops, name matching, tree regime, cost. Refusals must be fixed; warnings decide the variant and how much to trust p-values.\n" +
              "2. Pick the variant: `general` for deep cross-species trees, `viral` for shallow viral trees (SHALLOW_TREE suggests it).\n" +
              "3. Every result is a surrogate for MEME (`provenance.is_surrogate`). Rank first; confirm with the real method.\n\n" +
              "Read `hyphaeon://methods/requirements` for options and caps, and `hyphaeon://caveats` for the model card and calibration numbers."
          }
        }
      ]
    })
  );

  for (const [pillar, guide] of Object.entries(GUIDES)) {
    server.registerPrompt(
      "interpret-" + pillar,
      { title: guide.title, description: "Interpretation guide for " + guide.title.replace("Interpret ", "") + ": key fields, what significance means, common misinterpretations." },
      () => ({ messages: [{ role: "user", content: { type: "text", text: guide.text } }] })
    );
  }
}
