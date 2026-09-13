/**
 * prompts.js — interpretation guides: one per pillar, and one for the whole report.
 *
 * WHY THIS FILE EXISTS
 *
 * PLAN.md 3.6: "Prompts. One interpretation guide per pillar, written from section 2." Section 2
 * is the list of hard truths (surrogate not truth; rank strong, scale compressed; regime-dependent
 * calibration; invariable means not scored; base vs viral; sequences are unpublished research).
 * The style is the AxoMEME guide in datamonkey-js-server lib/mcp/prompts.js:369-392: "Read this
 * first", key fields, what significance does and does not mean, common misinterpretations.
 *
 * Phase 2 adds `interpret-report`, the guide for what hyphaeon_analyze returns: PLAN.md 4.0's
 * "one action: upload, everything runs" report, read in the order its sections arrive
 * (diagnostics -> sites -> gene -> epistasis + sectors -> attribution -> filter -> DMS ->
 * phenotype on demand), with what each section can and cannot support and the Monte Carlo caveat
 * on `p_perm` that HyphAeon/PHASE2A.md measured (B = 1,000 carries about +-0.03 absolute; the
 * parity class was written for B = 10,000).
 *
 * The numbers quoted here are the ones in PLAN.md 2, HyphAeon/model_eval/README.md
 * (veg/HyphAeon@3cb9cc6) and HyphAeon/PHASE2A.md, and are also in mcp/caveats.json; if the model
 * changes, both change.
 */

import { z } from "zod";

const SURROGATE_PREAMBLE =
  "## Read this first\n" +
  "HyphAeon is a **neural surrogate for MEME**, evaluated against MEME, not against truth. Every " +
  "result carries `provenance.is_surrogate: true` and `surrogate_for: \"MEME\"`; carry that caveat " +
  "into anything you say about the numbers. `provenance.surface` says who computed them: " +
  "`mcp-stdio` / `mcp-http` is the JavaScript port running in the MCP process, which since Phase 3 " +
  "is EVERY tool — phenotype included — with no Python anywhere (LRTs match `hyphaeon meme` within " +
  "1e-5, p/q are the same float32 values, network edges and sector membership are exact, permutation " +
  "p-values agree statistically). MDS eigenvector signs are canonical (`provenance.mds_sign`).\n" +
  "`provenance.preprocessing.tree_source` says where the distances came from: `user` / `embedded` " +
  "means the tree you supplied (or one inside the alignment) had branch lengths and was used as it " +
  "is; `tn93` means there was no usable tree, so pairwise Tamura-Nei 93 distances were computed from " +
  "the sequences instead (PLAN.md D22, the reference's own `--use-tn93`, rho = 0.9997 against the " +
  "tree-based path). A tree is optional on every tool; `preprocessing.tree_free.reason` says which " +
  "of `requested` / `no_tree` / `no_branch_lengths` applied.\n\n";

const P_PERM_CAVEAT =
  "- **`p_perm` is a Monte Carlo estimate, and at small B it is noisy on every surface.** With " +
  "`n_permutations` = B, the estimate's standard error is about sqrt(p(1-p)/B): at B = 1,000 a " +
  "sector reported at p_perm = 0.09 could read 0.06 or 0.12 on the next seed, and the null moments " +
  "(`null_coherence_mean/std/95`) move by ~5%. Do not print p_perm to three decimals at B = 1,000; " +
  "report it as a band, or rerun with n_permutations = 10,000 (the function's default and the " +
  "setting the cross-surface parity class was written for; its floor is then 1e-4). The Python " +
  "reference and the JavaScript port agree on p_perm only within 3 * sqrt(p(1-p)/B) — each side " +
  "draws its own permutations\n";

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
      "the omega values for classes 1 and 2 are fixed by construction in the reference\n" +
      "- The neural head is one seeded draw of a head the reference loads unseeded " +
      "(`provenance.neural_head.deterministic_upstream: false`): only the statistical fields are " +
      "reproducible against `hyphaeon busted`\n\n" +
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
      "- `edges[]` — pairs of sites whose per-taxon attribution vectors are similar: `similarity` " +
      "(float32 cosine), `shared_branches` (= `shared_taxa`: the reference has no branch projection, " +
      "\"branches\" means taxa), `p_val` (= `hyper_p`, a Student-t p on the cosine), `fdr_q` (BH over " +
      "every candidate pair), `cesi` (composite epistatic selection index), `lrt_u` / `lrt_v`, " +
      "`ref_u` / `ref_v` (consensus amino acids)\n" +
      "- `sectors[]` — groups of sites from the network: `sites`, `size`, `spectral_coherence` " +
      "(lambda_1 / trace of the sector's attribution covariance), `p_perm` with " +
      "`null_coherence_mean/std/95` from random K-site subsets, `isotropic_baseline` (1/K), " +
      "`mean_lrt`, `pars_signature` / `consensus_signature`, and `focal_*` when a focal taxon was named\n" +
      "- `plasticity[]` — the digital DMS of the sector sites (or, with no sector, of the sites on " +
      "edges with CESI >= 3), unless `no_dms` (see the dms guide)\n" +
      "- `coselection_edges`, `epistatic_sectors`, `selection_dms_plasticity` duplicate `edges`, " +
      "`sectors`, `plasticity` (the reference writes both names)\n\n" +
      "## Significance\n" +
      "- An edge says two sites' selection signal falls on the same taxa of THIS tree. That is " +
      "co-selection on the tree, not physical contact, though the paper reports contact enrichment\n" +
      P_PERM_CAVEAT +
      "- Sector membership depends on graph tie-breaking (modularity communities, then eigenvector " +
      "pruning at |v| >= 0.10); treat borderline sites as borderline. The edge set and the membership " +
      "are exact across surfaces; a pair whose cosine sits within ~5e-7 of `min_sim` is the one " +
      "thing that could differ\n" +
      "- The CLI's default `min_sim` is 0.30 while the underlying function's is 0.35; the tools " +
      "mirror the CLI. `max_overlap` is accepted and never used by the reference\n" +
      "- Everything rests on the surrogate's per-site signal and attention; the regime caveats of " +
      "hyphaeon_meme apply to every edge\n\n" +
      "## Common misinterpretations\n" +
      "- Reporting an edge as a contact or an interaction: it is co-occurrence of selection on taxa\n" +
      "- Reading `spectral_coherence` without its null: `null_coherence_95` is the bar to clear\n" +
      "- Quoting `p_perm = 0.093` from a 1,000-permutation run as if it were exact\n" +
      "- Comparing CESI across genes\n"
  },
  dms: {
    title: "Interpret hyphaeon_dms results",
    text:
      "# Interpreting HyphAeon digital deep mutational scanning\n\n" +
      SURROGATE_PREAMBLE +
      "## Key fields\n" +
      "- `plasticity[]` — per site: `wt_aa`, `baseline_lrt`, `p_value` (Self-Liang of the baseline), " +
      "`mutant_deltas` (delta-LRT for each of the 19 alternatives substituted in `focal_taxon`), " +
      "`mean/max/min_delta_lrt`, `intrinsic_plasticity`\n" +
      "- `focal_taxon` — whose sequence was mutated: the first taxon whose lower-cased name contains " +
      "the requested string, else the first taxon (the reference reports the CALLER's string, and a " +
      "string that matches nothing silently means taxon 0 — check `provenance.preprocessing`)\n" +
      "- `total_mutations` = 19 x codon_count, whatever subset was swept (the reference's " +
      "arithmetic); the app's progressive DMS reports `progress: {done, total}` alongside\n\n" +
      "## Significance\n" +
      "- A delta-LRT is the change in the SURROGATE's MEME-style score when one residue is " +
      "swapped; it is not a fitness effect, a stability change or a laboratory DMS measurement\n" +
      "- High `intrinsic_plasticity` = the model's score barely moves whatever is substituted " +
      "(permissive); low = the site's score depends on the exact residue (rigid, often catalytic " +
      "or structural in the paper's examples)\n" +
      "- Deltas are on the compressed LRT scale (slope ~0.16 vs MEME) — compare within a gene\n" +
      "- Substitutions use one canonical codon per amino acid (the reference's hand-written table), " +
      "so synonymous context is not explored\n\n" +
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
      "- Foreground sets defined by regex or preset match on taxon NAMES: verify the matched list\n" +
      "- **Permulations need a phylogeny.** With `permulations > 0` AND a tree with branch lengths, " +
      "`p_assoc_perm` and `gene_p_value_perm` come from a Brownian-motion null over the trait. A " +
      "TREE-FREE run (no tree, or no usable branch lengths) has no phylogeny to draw a covariance " +
      "from, so they are skipped: check `permulations.reason` (`tree-free`, `no-tree`, " +
      "`not-requested`, `failed`) and read `p_assoc` as the parametric t-test p, which is what " +
      "`hyphaeon phenotype --use-tn93` reports too. The display-only neighbour-joining tree is NOT " +
      "used as a null, deliberately: a null built from the same distances as the alternative shares " +
      "its error\n" +
      "- `permulations` (Brownian permuLations of the trait, `--permulations`, default 0) and " +
      "`n_permutations` (random K-site subsets for trait SECTOR significance, `--n-permutations`, " +
      "default 10,000) are different nulls one letter apart; say which one a p-value came from\n\n" +
      "## Common misinterpretations\n" +
      "- Reading `q_value <= alpha` as proof of adaptive convergence\n" +
      "- Reporting sites with `foreground_freq_pct` near `background_freq_pct` because rho is high\n" +
      "- Treating a shallow or star-like tree as a valid panel (hyphaeon_validate STAR_LIKE)\n"
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
  },
  dates: {
    title: "Interpret hyphaeon_dates results",
    text:
      "# Reading a HyphAeon date review\n\n" +
      "## Read this first\n" +
      "This tool runs NO MODEL. It answers one question — which of these sequences carries a sampling " +
      "date, and how do we know — and its answer is what makes `hyphaeon_dating` and " +
      "`hyphaeon_temporal` safe to run. Call it before either of them, every time.\n\n" +
      "## Key fields\n" +
      "- `headline` — one sentence: how many dated, from which source, by which rules, over what span, " +
      "in what units\n" +
      "- `date_review.coverage` — `taxa_total`, `dated`, `undated`, and the per-source counts. **The " +
      "difference between `taxa_total` and `dated` is the number of sequences the analyses will drop " +
      "without saying so.** Measured on the bundled examples: H1N1 dates 95 of 100 from headers, " +
      "korber 142 of 143, H5N1 98 of 98\n" +
      "- `date_review.by_rule` — which parser read each date. This is the column that tells you whether " +
      "a date is a date. `header_bare_number` means \"the first delimiter-bound number in the name\", " +
      "which claims an accession or an isolate index just as happily as a generation\n" +
      "- `date_review.rows[]` — one entry per sequence: `raw`, `value`, `rule`, `source`, `matched_name`, " +
      "`match_tier`, `imputed` and which components were imputed. A sequence is never omitted\n" +
      "- `date_review.time_units` and `time_units_source` — `inferred` means a calendar-majority rule " +
      "decided; `supplied` means you named it and that check was BYPASSED\n" +
      "- `date_review.unmatched_metadata` — metadata rows that named no sequence. **The most important " +
      "line in the output when you supplied a table**: with `header_fallback` on (the default), a table " +
      "that matched nothing still produces a dated run, from different dates than you supplied\n" +
      "- `date_review.match_tiers` — how many names matched exactly and how many needed quote-stripping, " +
      "case folding, first-token or field containment. Substring matching is deliberately not a tier: " +
      "`EPI_ISL_4021` must never match `EPI_ISL_402124`\n" +
      "- `clock` — whether this set can carry a clock at all, and separately whether it clears " +
      "temporal surveillance's higher bar (5 dated sequences, counted AFTER the taxon cap and the " +
      "duplicate collapse, which this tool has not applied)\n" +
      "- `gate.blocking[]` — what the two analyses will refuse on until you override it\n\n" +
      "## The two gates, and why they exist\n" +
      "The browser asks a human these two questions and waits for an answer. A tool call has nobody to " +
      "ask, so the analyses REFUSE and name the override rather than pick the interpretation that " +
      "produces the prettier answer.\n" +
      "- **`DATES_BARE_NUMBER_MAJORITY`** — half or more of the dates came from the bare-number rule. " +
      "Measured on the bundled H1N1 set: with the units inferred, 95 of 100 sequences date by " +
      "`header_decimal_year` over 2009.25-2009.91; forced to `generations`, 100 of 100 date, 75 of them " +
      "by `header_bare_number`, and the axis runs **from 1 to 46,241,654** with no error anywhere. " +
      "Override with `accept_bare_numbers: true` only after reading `by_rule` and the `span`\n" +
      "- **`DATES_UNDATED_PRESENT`** — some sequences carry no date. Override with `drop_undated: true` " +
      "and the run is then on the dated subset, which the provenance records\n\n" +
      "## Common misinterpretations\n" +
      "- Reading `dated: 95` as \"95 of my sequences\" when you submitted 100 — the analysis is about 95\n" +
      "- Trusting a span whose dates came from `header_bare_number`\n" +
      "- Passing `time_units` to \"be explicit\": it bypasses the calendar-majority check that is the " +
      "only thing standing between a surveillance file and a 46-million-unit axis\n" +
      "- Assuming a supplied metadata table was used: check `coverage.from_table` and " +
      "`unmatched_metadata`, because the header fallback fills in silently\n" +
      "- Treating an imputed date as measured: `DATES_IMPUTED` means a missing month or day was invented\n"
  },
  dating: {
    title: "Interpret hyphaeon_dating results",
    text:
      "# Interpreting a HyphAeon molecular clock\n\n" +
      "## Read this first\n" +
      "This is a root-to-tip regression of sequence divergence against sampling time. It is NOT a " +
      "Bayesian phylodynamic analysis and its intervals are not posterior intervals; it is the same " +
      "estimator TempEst and the reference's `hyphaeon dating` compute, with one addition and several " +
      "named absences.\n" +
      "**Quote the distance mode with the date, never the date alone.** `distance_mode` is `tn93` " +
      "(model-free, the default) or `latent` (`use_model: true`, which runs a second ONNX graph over " +
      "every codon). They are different answers on the same data: measured on the korber example, " +
      "`t_mrca` 1938.77 model-free against 1926.81 with the graph — twelve years apart, with the whole " +
      "warning set changing. `distance_mode_reason` says why this run got the mode it got.\n\n" +
      "## Key fields\n" +
      "- `record.t_mrca` and `record.ci_mrca` — the ancestor date and its interval, by " +
      "`record.ci_method` (fieller is the default and is an exact ratio-test inversion)\n" +
      "- `record.mu` — substitutions per site per unit time; `record.active_model` says whether the " +
      "line or the spline was selected, and `record.selected_clock` how\n" +
      "- `record.ols`, `record.pgls`, `record.spline`, `record.ensemble` — the individual fits. " +
      "`pgls` and `latent_root` are null unless `use_model` ran\n" +
      "- `taxa_summary[]` — per sequence: `sampling_date`, `root_divergence`, `fitted_divergence`, " +
      "`predicted_date`, `temporal_residual`, `z_score`, `is_outlier`, `is_holdout`, and " +
      "`prediction_method` — **a column the reference does not emit at all**, and it matters: on the " +
      "korber example 12 of 142 rows come from an ancestral linear inverse, 12 from the spline's linear " +
      "arm and 118 from the root find. Three models in one column, unmarked upstream\n" +
      "- `honesty.estimators_not_built` — what this build does not estimate and why. Without the dating " +
      "graph that includes the attention PGLS and the latent-root search; always it includes the " +
      "power-law clock and leave-one-out\n" +
      "- `date_review` — the dated set this clock was fitted to. Read it\n\n" +
      "## Significance\n" +
      "- A clock is a SLOPE. Check `record.timespan` and the residual spread before believing " +
      "`t_mrca`: a set sampled over months cannot date an ancestor centuries back, whatever the " +
      "interval says\n" +
      "- `DATING_SPLINE_NO_INTERVAL` is load-bearing: upstream, every bootstrap replicate of the spline " +
      "dies in a bare `except` (dating.py:1912 passes numpy's `rcond=` to scipy's `cond=`) and all four " +
      "intervals collapse to their point estimates. **A zero-width 95% interval must never be drawn as " +
      "one**\n" +
      "- `DATING_MRCA_AFTER_EARLIEST_SAMPLE`, `DATING_NON_POSITIVE_RATE` and " +
      "`DATING_UNBOUNDED_ANTIQUITY` each mean the regression produced something that is arithmetically " +
      "fine and biologically not\n" +
      "- Outliers are flagged at |z| > 2.5 by a NON-ROBUST rule: a single badly dated sequence moves " +
      "the line and can flag its neighbours instead of itself\n\n" +
      "## Reproduction\n" +
      "`provenance.reference_command` is a `{command, reproduces, caveats}` OBJECT, not the argv array " +
      "the other pillars carry. `reproduces` is **false whenever the dates came from sequence headers**: " +
      "this build's date layer is the union of all three upstream parsers and reads names " +
      "`hyphaeon dating` cannot (measured on korber, 142 of 143 by a rule the reference does not have), " +
      "so a different dated set is a different regression. Export the dates as a two-column CSV and pass " +
      "it with `-d` to reproduce the run. Read `caveats` before quoting `command`.\n\n" +
      "## Common misinterpretations\n" +
      "- Quoting `t_mrca` without `distance_mode`\n" +
      "- Reading a zero-width interval as precision\n" +
      "- Treating `predicted_date` as a measurement rather than an inverse of the fitted clock\n" +
      "- Assuming `use_model: true` is a better version of the same estimate: it is a different one\n" +
      "- Reporting the clock without the date review that produced its time axis\n"
  },
  temporal: {
    title: "Interpret hyphaeon_temporal results",
    text:
      "# Interpreting HyphAeon temporal selection surveillance\n\n" +
      SURROGATE_PREAMBLE +
      "## What this pillar computes\n" +
      "For every codon: a smoothed prevalence trajectory through calendar time, a sweep velocity, a peak " +
      "date and intensity, half-rise and half-fall times, FWHM and area. Then a two-stage filter — an " +
      "energy floor (stage one, the `candidates`), then a date-shuffling permutation null with BH q " +
      "(stage two) — an fPCA decomposition of the confirmed set into four dynamic wave modes, and a " +
      "four-way classification of each codon against the static MEME-surrogate call.\n" +
      "**The record is never returned inline.** It is megabytes (measured: 2.1 MB on a 98 x 566 example " +
      "at the reference's own 250 time points, 7.2 MB on a 4,384-codon run, 92% of it the trajectory " +
      "store). The tool answers with the summary and a `job_id`; `get_results section=` pages it.\n\n" +
      "## THE NULL HAS FOUR STATES, AND ONLY ONE OF THEM IS A RESULT\n" +
      "`honesty.null_state`:\n" +
      "- `not-started` — no shuffle drawn yet; the run may still reach one\n" +
      "- `running` — draws are arriving and **nothing downstream of them exists**\n" +
      "- `finished` — the calls, the three sweep counts and the wave modes are final. A run STOPPED by " +
      "the caller that kept at least one draw is here too: the runtime catches its own abort, classifies " +
      "at the achieved count and returns a complete record, so those labels ARE results, at a coarser " +
      "p-grid\n" +
      "- `stopped` — the null ended and produced nothing usable (declined over budget, or stopped before " +
      "a draw finished). Saying \"has not finished\" here is false: nothing is coming\n\n" +
      "**Do not read `permutations.tested` instead.** It flips true after the first chunk, while " +
      "`classification`, `is_confirmed_sweep` and the sweep counts are still the scored payload's zeros, " +
      "so it prints a completed negative finding one second into a run — and prints it every time, " +
      "because p at draw k is (1 + exceedances)/(k + 1) and starts near 1 for every codon. " +
      "`honesty.uncalled_because` is the clause to quote when nothing is called; do not invent your own.\n" +
      "`honesty.wave_columns_pending` marks a record whose wave loadings and R2 are still interim ZERO " +
      "arrays rather than measured zeros.\n" +
      "`honesty.null_truncated` is set when the run was STOPPED mid-null: it carries `completed` of " +
      "`requested` draws and the p-grid that count bought (1/(completed + 1)). Quote the ACHIEVED count " +
      "whenever you quote a sweep count from such a run, never the requested one — the numbers are real " +
      "at that B and the reply says `status: \"cancelled\"`, `partial_result: true` beside them.\n\n" +
      "## `p_perm = 1.0` IS OFTEN NOT A MEASUREMENT\n" +
      "`p_perm` and `q_perm` are 1.0 at every codon that never reached stage two — 4,138 of 4,384 on the " +
      "engine's acceptance run — which is a p-value printed for a test that was not run. That is the " +
      "reference's own fill (temporal.py:620-621), replicated on purpose so the CSVs diff clean, and " +
      "`sites.stage1` is the mask that separates a measured 1.0 from an assumed one. Read those two " +
      "columns **only at the candidates**. A CANDIDATE whose null did not run carries NaN, never 1.0.\n" +
      "Never count \"sites with p_perm <= 0.05\" over all codons.\n\n" +
      "## THE WAVE SHARES MOVE WITH THE NULL\n" +
      "`fpca_wave_variance_pct` is computed over the CONFIRMED-SWEEP set, which is thresholded on the " +
      "permutation p, which comes from a different generator than the reference's (xoshiro256** " +
      "per-draw substreams here, numpy MT19937 at a hard-coded `RandomState(42)` upstream). The " +
      "arithmetic is identical and the answer still differs: measured on H1N1 at B = 100, **32 confirmed " +
      "sweeps here against the reference's 18**, and shares 33.84/28.26/17.81/11.11 % against " +
      "39.67/32.37/13.92/9.31 — 5.8 points on the leading mode. Compare shapes and ordering, not digits.\n" +
      "There is a SECOND branch: with fewer than four confirmed codons the modes are extracted from the " +
      "strongest candidates by peak intensity, read off the trajectories BEFORE the null was drawn. " +
      "`waves.source` and `honesty.wave_variance.conditioned_on` say which sentence applies; the null " +
      "still decided which branch was taken.\n" +
      "Wave signs follow this build's `canonical` convention (D28); the reference has none, so a mode " +
      "and its negative are the same mode.\n\n" +
      "## `escape_hatch_used`\n" +
      "When nothing clears confirmation the reference silently falls back to calling candidates at " +
      "`p_perm <= 0.10 OR static LRT >= 3.84` and records that in NO output file. A run that confirmed " +
      "nothing and one that confirmed thirty through the hatch look identical in the reference's CSV. " +
      "This flag is the only place the difference is visible — check it before quoting a sweep count.\n\n" +
      "## The dates decide the analysis\n" +
      "`record.dates.beyond_reference` counts the dates read by a rule `hyphaeon temporal` does not " +
      "have. A different dated set is a different time axis, kernel, candidate set and null — the two " +
      "runs are not comparable sequence by sequence. `TEMPORAL_DUPLICATES_COLLAPSED` matters on " +
      "surveillance data specifically: identical haplotypes sampled on different days collapse to one " +
      "date, deleting time points. `primaeon.taxon_cap` is `applied` when Faith's-PD subsampling ran, " +
      "and that subsampling is TIME-BLIND (D27): it can remove the early part of an epidemic, which is " +
      "the part a sweep is measured against.\n\n" +
      "## Reproduction\n" +
      "`provenance.reference_command` is a `{command, reproduces, caveats}` OBJECT. `reproduces` is " +
      "**false on every run whose null drew at all**, and its caveat zero — emitted whether or not it is " +
      "false — says the four CSVs will not diff clean: measured on H1N1, 1 of 4,384 site rows " +
      "byte-identical and 0 of 60 wave rows matching, because the model columns agree at ~1e-6 rather " +
      "than digit for digit. Compare numerically. Never print `command` without `reproduces` and " +
      "`caveats`.\n\n" +
      "## Common misinterpretations\n" +
      "- Reporting a negative finding from a running or stopped null\n" +
      "- Counting p_perm <= 0.05 over all codons instead of over the candidates\n" +
      "- Quoting wave variance shares to two decimals as if they were reproducible\n" +
      "- Reading `selection_intensity` and `sweep_velocity` in the CSV as two quantities (they are one " +
      "array written twice, temporal.py:807-808)\n" +
      "- Reading a peak date of `t_min` at an invariable codon as an early sweep (`argmax` of a zero " +
      "row is 0; `sites.peak_at_first_grid_point` marks it)\n" +
      "- Calling a sweep confirmed without checking `escape_hatch_used`\n" +
      "- Treating a trajectory as an allele-frequency time series: it is the model's attention-weighted " +
      "prevalence of a non-root residue, a surrogate quantity\n"
  },
  report: {
    title: "Interpret a hyphaeon_analyze report",
    text:
      "# Interpreting the HyphAeon report (hyphaeon_analyze)\n\n" +
      SURROGATE_PREAMBLE +
      "## What a report is\n" +
      "`hyphaeon_analyze` is the product's one action: an alignment (with or without a tree) goes in " +
      "and every analysis that needs no further input runs, in a fixed order, and lands in one " +
      "`ReportRecord` (`schema_version: 2, kind: \"report\"`) with `inputs`, `options`, `diagnostics`, " +
      "`sections`, `provenance` and `timings` (seconds per phase). Large reports come back as a " +
      "summary plus a `job_id`: `get_results` with `section=` pages one section at a time (`top`, " +
      "`fields`, `summary_only` apply), `job_status` lists `sections_ready` while it is still running, " +
      "and `hyphaeon://report/{id}` serves the finished record. Read the sections in the order below " +
      "— it is the order they were computed and the order each one's evidence depends on the last.\n\n" +
      "## 1. `diagnostics` — what was done to the data\n" +
      "The library's \"Before you run\" checks and the automatic repairs: U->T, trailing-codon trim, " +
      "duplicate collapse, Faith's-PD taxon cap, the variant chosen from tree depth, and the tree " +
      "decision — a tree with branch lengths is used as it is, otherwise pairwise TN93 distances " +
      "(`TREE_FREE_TN93`, info, with the reason). Check " +
      "`provenance.preprocessing` (taxa in vs used, `tree_source`, `distance_rescaled`) before " +
      "trusting any number below: a report on 20 haplotypes collapsed from 200 sequences is a report " +
      "on 20. `DEEP_LARGE_TREE` means every p-value below is ordering only; `SHALLOW_TREE` means the " +
      "`viral` variant was the right one and `provenance.model_variant` says whether it ran.\n\n" +
      "## 2. `sections.sites` — site selection (MEME surrogate)\n" +
      "The core result: `sites[]` with `hyphaeon_lrt`, `p_value`, `q_value`, `is_invariable` and the " +
      "app's `call` / `percentile` / `zScore`, plus `summary`. Can support: WHICH sites carry the " +
      "strongest episodic signal in this alignment, ranked. Cannot support: a MEME p-value, a claim " +
      "of positive selection without a real MEME run, or a comparison of LRTs across genes. " +
      "Invariable sites were not scored. Rank is strong (ROC-AUC 0.914), scale is compressed " +
      "(slope 0.16), calibration is regime-dependent (FPR 5-7% at 20-50 taxa, ~36% at 100 taxa on " +
      "deep trees).\n\n" +
      "## 3. `sections.gene` — the omnibus (BUSTED surrogate)\n" +
      "`record` (the `hyphaeon busted` record) and `statistics`. `p_value_acat` and `p_value_simes` " +
      "are exact functions of the site LRTs above and inherit their calibration; `omnibus_lrt` is " +
      "the energy above the nominal 5% line. The neural head fields (`selection_probability`, " +
      "`predicted_gene_lrt`, omega classes, SRV) are one seeded draw of a head the reference loads " +
      "unseeded. Can support: whether the alignment as a whole shows signal, with the components " +
      "named. Cannot support: BUSTED's p-value, or a verdict from `positive_selection_detected` alone.\n\n" +
      "## 4. `sections.epistasis` — co-selection network and sectors\n" +
      "`edges[]` (pairs whose attribution vectors are similar across taxa; `cesi`, `fdr_q`), " +
      "`sectors[]` (groups of such sites with `spectral_coherence`, `p_perm`, the null band), " +
      "optionally `plasticity[]` for sector sites and `graph`. Can support: which selected sites " +
      "co-vary on this tree, and whether a group is more coherent than random K-subsets of sites. " +
      "Cannot support: physical contact, an interaction mechanism, or CESI comparisons across genes. " +
      "The edge set and membership are exact across surfaces.\n" +
      P_PERM_CAVEAT +
      "\n## 5. `sections.attribution` — who drives the called sites\n" +
      "`attributions` keyed by 1-indexed site, for sites at or above the attribution LRT threshold: " +
      "per-taxon counterfactual delta-LRT, `top_driver`, `top_mutation`, `evolutionary_epoch`, " +
      "`adaptation_mode`. Can support: which taxon's residue the surrogate's score at a site depends " +
      "on most. Cannot support: a substitution's fitness effect, or the direction of selection.\n\n" +
      "## 6. `sections.filter` — alignment-artifact screen\n" +
      "`artifacts_masked[]` (codon ranges in one taxon that look like alignment error: a hypergeometric " +
      "patch plus a counterfactual outlier), `filter_enabled`, and `cleaned` re-scored sites when " +
      "anything was masked. Shown as \"N suspicious patches\"; the report never hides the unmasked " +
      "result. Can support: that a top site rests on one taxon's dubious stretch. Cannot support: that " +
      "the alignment is correct because nothing was flagged.\n\n" +
      "## 7. `sections.dms` — digital deep mutational scan (last, progressive, capped)\n" +
      "`plasticity[]` (19 delta-LRTs and `intrinsic_plasticity` per swept site), `focal_taxon`, " +
      "`total_mutations`, `progress: {done, total}` and `cancelled` when it stopped early. This is the " +
      "expensive section (19 x L forward passes) so it runs last, fills progressively and is capped by " +
      "a work budget; when `progress.done < progress.total` the scan is PARTIAL and the report says so " +
      "— do not describe unswept sites as rigid or plastic. Can support: which swept sites' surrogate " +
      "score is robust to substitution and which are not. Cannot support: pathogenicity, stability, " +
      "or a laboratory DMS.\n\n" +
      "## 8. `sections.phenotype` — only when a trait was given\n" +
      "Phenotype association needs a trait, so it cannot run unasked: it is `null` unless the call " +
      "carried a `phenotype` block (preset, foreground list/regex, or a CSV). When it did, the " +
      "section came from the SAME forward pass as the sections above " +
      "(`provenance.phenotype_source: \"report-pass\"`) and holds `sites[]` with `association_rho`, " +
      "`score`, `q_value` and the foreground/background frequencies, `trait_sectors[]`, " +
      "`coselection_pairs[]` and the gene-level tracks. Can support: which sites' selection signal " +
      "lands on the trait's taxa. Cannot support: adaptive convergence, or any claim from `q_value` " +
      "alone — read the two frequency columns beside rho, and check " +
      "`phenotype_meta.foreground_count` first. `permulations.reason` says why there is no " +
      "permulation column (a tree-free run has no phylogeny for a Brownian null). Without a trait, " +
      "run `hyphaeon_phenotype`, or re-run `hyphaeon_analyze` with the block.\n\n" +
      "## Provenance and reproduction\n" +
      "`provenance` carries `surface`, `model_variant`, `artifact_sha256`, `seed`, `mds_sign`, " +
      "`preprocessing`, `warnings`, the `options` as submitted and the `hyphaeon <cmd>` lines that " +
      "reproduce each section with the Python reference CLI, and `preprocessing.tree_source` " +
      "(`user` / `embedded` / `tn93`). `timings` says where the seconds went. " +
      "Sequences submitted to a remote server are unpublished research: say so before sending them.\n\n" +
      "## Common misinterpretations\n" +
      "- Reading the report as a completed selection analysis: it is a surrogate's ranking, to be " +
      "confirmed with HyPhy MEME / BUSTED on Datamonkey before anything is reported\n" +
      "- Quoting p-values from a deep, large tree as calibrated\n" +
      "- Treating a partial DMS as a scan of the gene\n" +
      "- Printing `p_perm` to three decimals from a 1,000-permutation null\n" +
      "- Calling an epistasis edge a contact, or an attribution driver a causal mutation\n"
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
              "The product has ONE action: give `hyphaeon_analyze` the alignment (and a tree if you have " +
              "one) and everything that needs no further input runs — diagnostics, sites, gene, epistasis + " +
              "sectors, attribution, the artifact filter, then a capped digital DMS — into one report. Reach " +
              "for a per-pillar tool when you want one section with the CLI's options, or a job you can size.\n\n" +
              "| Question | Tool | Needs | Confirm with |\n" +
              "|---|---|---|---|\n" +
              "| What does HyphAeon say about this alignment? | `hyphaeon_analyze` | codon alignment (+ tree) | the per-pillar confirmations below |\n" +
              "| Which codon sites show episodic positive selection? | `hyphaeon_meme` | codon alignment (a tree is optional) | HyPhy MEME |\n" +
              "| Is there selection anywhere in this gene? | `hyphaeon_busted` | same | HyPhy BUSTED |\n" +
              "| Which sites are co-selected / form sectors? | `hyphaeon_epistasis` | same; permutations cost time | structural or experimental evidence |\n" +
              "| Which substitutions would change the selection signal at a site? | `hyphaeon_dms` | same; 19 x sites passes, <= 3,000 sites | laboratory DMS |\n" +
              "| Which sites associate with a trait across the tree? | `hyphaeon_phenotype` | same + a trait definition (preset, foreground or CSV) | permulations (they need a tree), then an independent panel |\n" +
              "| Which sequences carry a sampling date, and how do we know? | `hyphaeon_dates` | codon alignment (+ metadata, optional) | nothing: it runs no model and is the pre-flight for the two below |\n" +
              "| When did these sequences last share an ancestor, and how fast do they evolve? | `hyphaeon_dating` | dated alignment (no tree; D34) | BEAST / TreeTime; quote `distance_mode` with the date |\n" +
              "| Which sites swept, and when? | `hyphaeon_temporal` | dated alignment, 5+ dated sequences | the null\'s `null_state` before quoting anything; then HyPhy on the called sites |\n" +
              "| How well does the surrogate match MEME on my gene? | `hyphaeon_evaluate` | a hyphaeon meme CSV + HyPhy MEME JSON | — |\n\n" +
              "## Before a TIME-AWARE run\n" +
              "`hyphaeon_dates` first, always. It runs no model, costs milliseconds, and is the only place that says " +
              "which sequences got a date and by what rule. Both time pillars REFUSE two date sets a human would be " +
              "asked about in the browser: one whose dates are mostly bare numbers read out of sequence names " +
              "(`accept_bare_numbers`), and one that leaves sequences undated and would drop them silently " +
              "(`drop_undated`). Neither override should be passed before reading `date_review.by_rule`.\n\n" +
              "## Before any run\n" +
              "1. `hyphaeon_validate` — format, frame, stops, name matching, tree regime, cost. Refusals must be fixed; warnings decide the variant and how much to trust p-values. A missing tree is NOT a refusal: `TREE_FREE_TN93` (info) says the run will use pairwise TN93 distances instead (PLAN.md D22). (`hyphaeon_analyze` runs the same diagnostics itself and records them.)\n" +
              "2. Pick the variant: `general` for deep cross-species trees, `viral` for shallow viral trees (SHALLOW_TREE suggests it).\n" +
              "3. Every result is a surrogate for MEME (`provenance.is_surrogate`). Rank first; confirm with the real method.\n\n" +
              "Read `hyphaeon://methods/requirements` for options and caps, `hyphaeon://caveats` for the model card and calibration numbers, and the `interpret-report` prompt for how to read a whole report."
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
