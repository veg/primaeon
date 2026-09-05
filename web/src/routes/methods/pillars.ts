/**
 * pillars.ts — the method text of the /methods page, one entry per report section.
 *
 * WHY THIS FILE EXISTS. PLAN.md §4.1 gives /methods "one page per pillar"; D21 (§4.0) fixes the
 * pillars and their order as the sections of the one report: diagnostics, sites (meme), gene
 * (busted), epistasis + sectors, attribution, filter, DMS, phenotype (on demand), and evaluate,
 * the deliberate secondary tool. Each entry says what is computed, in one paragraph that mirrors
 * the Python reference function by function (hyphaeon/cli.py, inference.py, stats.py,
 * epistasis.py, attribution.py, filter.py, phenotype.py, evaluation.py at veg/HyphAeon tag
 * phase-2a), what the port was validated against (PHASE1.md, PHASE2A.md), and where the real
 * method runs. The numbers about the model's behaviour are NOT here: they come from
 * web/caveats.json through $lib/caveats and are rendered by Caveats.svelte under each section.
 * App-side semantics (order, streaming, caps, the toggles) are labelled as such in `cost` and
 * in the text, so a reader can tell the reference's behaviour from this application's.
 */

import type { PillarKey } from '$lib/caveats';

export interface RealMethod {
	/** The HyPhy method, as Datamonkey names it. */
	label: string;
	href: string;
	note: string;
}

export interface Pillar {
	id: PillarKey;
	title: string;
	/** The reference command this section mirrors, or the step of the report it describes. */
	command: string;
	/** Model outputs the pillar reads. */
	needs: string;
	/** Cost in the browser, app-side (PLAN.md §4.0). */
	cost: string;
	computed: string;
	/** Result keys, as the Python writes them. */
	fields: string[];
	validated: string;
	real: RealMethod | null;
	/** Set when the report offers the analysis rather than running it. */
	status?: string;
}

export const PILLARS: readonly Pillar[] = [
	{
		id: 'diagnostics',
		title: 'Diagnostics and repairs',
		command: 'report step 1 · diagnose() from @veg/hyphaeon-js',
		needs: 'none',
		cost: 'milliseconds; a second or two more when the pairwise TN93 distance matrix has to be computed',
		computed:
			'One set of checks runs before the model on every surface (browser, MCP, server) and produces the same warning codes: format sniff and embedded tree, U read as T, the non-ACGT fraction, length modulo 3 with in-frame stops and a frameshift heuristic, the unknown-codon fraction, unequal lengths, identical sequences, taxa below three or above the cap, tree-to-alignment name matching in three tiers, missing or negative or saturated branch lengths, a maximum patristic distance above 10, the depth regime, and a cost estimate. Repairs are automatic and recorded: trailing codons trimmed, duplicate haplotypes collapsed with their tips, Faith’s-PD subsampling above the taxon cap, and the variant chosen from median patristic depth. The tree is not repaired at all: one with branch lengths is used as given, and one without — or none — puts the run in tree-free mode, where pairwise TN93 distances feed the embedding directly (the TREE_FREE_TN93 note carries the reason, and TN93_SATURATED_PAIRS counts the pairs too divergent to estimate). The only blocking outcomes are refuse-level: fewer than three taxa, a pervasive frameshift, an unparseable file, alignment taxa with no tip in a tree that IS being used, or a distance matrix that cannot be computed at all.',
		fields: ['warnings[].code', 'warnings[].severity', 'provenance.preprocessing', 'provenance.model_variant'],
		validated:
			'The library’s diagnose() is the same code in the browser worker, the MCP’s hyphaeon_validate and the server’s /validate, so the codes cannot drift between surfaces. The tree-free distances are the reference’s own: the ported TN93 matrix is bit-identical to the Python package’s on every bundled example, and the MDS coordinates that follow agree to 7.8e-8 without any sign allowance. Everything applied to your data is shown in the strip at the top of the report and can be changed under “Re-run with”.',
		real: null
	},
	{
		id: 'sites',
		title: 'Site selection',
		command: 'hyphaeon meme',
		needs: 'lrt',
		cost: 'one forward pass over the variable sites; seconds',
		computed:
			'The alignment and tree become the four tensors (codon tokens, amino-acid tokens, the patristic distance matrix, 4-D classical MDS coordinates with canonical eigenvector signs) plus an invariable-site mask. Only variable sites go through the network; each receives a non-negative LRT from the 16-threshold ordinal head, and invariable sites keep LRT 0. The p-value is the MEME asymptotic mixture null, 1/3 δ₀ + 2/3 (0.45 χ²₁ + 0.55 χ²₂), so an LRT of 0 gives p = 2/3; q is Benjamini–Hochberg over all sites; both are stored as float32, as the CLI writes them. App-side, the report adds the columns DataMonkey’s AxoMEME shows beside them, computed from the same LRTs: a local z-score, the percentile among variable sites, and a tier call that toggles between “q ≤ 0.10” and “top 5% of variable sites”.',
		fields: ['site', 'hyphaeon_lrt', 'p_value', 'q_value', 'is_invariable', 'call', 'percentile'],
		validated:
			'Against hyphaeon meme on the five bundled examples at the parity class 1e-5 · max(1, |LRT|): Smc6 reproduces at a maximum |ΔLRT| of 5.7e-6 under Node and the browser agrees with Node at 5.3e-6; p and q are bit-equal given the LRT; taxa, site order and the invariable flag are exact. Against MEME itself, the calibration and concordance measurements below.',
		real: {
			label: 'MEME on Datamonkey',
			href: 'https://www.datamonkey.org/meme',
			note: 'Upload the same alignment and tree. MEME’s JSON can then be loaded on the Evaluate page against this run’s CSV.'
		}
	},
	{
		id: 'gene',
		title: 'Gene-level omnibus',
		command: 'hyphaeon busted',
		needs: 'lrt + root_repr',
		cost: 'free from the same forward pass, plus one head pass; negligible',
		computed:
			'The same forward pass keeps the pooled hidden state root_repr for each variable site in a [1, L, 384] tensor. Per-site p-values here use the Self and Liang (1987) mixture, 0.5 δ₀ + 0.5 χ²₁, not the MEME mixture. p_ACAT is the Cauchy combination of the variable sites’ p-values (the mean of tan((0.5 − p)π), back-transformed); p_Simes is the minimum over ranks of (L / rank) · p_sorted; omnibus_lrt = Σ max(0, LRT − 3.841); total_selection_energy = Σ LRT; sig_sites_p05 and sig_sites_p10 count sites below 0.05 and 0.10. The hidden states go through busted_head.onnx, which returns a selection probability, a predicted gene LRT, synonymous rate variation Var(α), ω₃, and the proportions of a three-class ω mixture with ω₁ = 0.10 and ω₂ = 1.00 fixed. positive_selection_detected is p_ACAT < 0.05 or selection probability > 0.5.',
		fields: [
			'p_value_acat',
			'p_value_simes',
			'omnibus_lrt',
			'total_selection_energy',
			'sig_sites_p05',
			'selection_probability',
			'synonymous_rate_variation',
			'rate_distributions'
		],
		validated:
			'The statistical fields against hyphaeon busted at the class: on Smc6 under the canonical MDS convention p_ACAT 0.1179765 against the reference’s 0.1179764, omnibus LRT 3.29886 against 3.29887, significant-site counts exact. The neural head cannot be validated against the reference because the reference is not reproducible there (below).',
		real: {
			label: 'BUSTED[S] on Datamonkey',
			href: 'https://www.datamonkey.org/busted',
			note: 'The real omnibus test with synonymous rate variation, on the same alignment and tree.'
		}
	},
	{
		id: 'epistasis',
		title: 'Epistasis and sectors',
		command: 'hyphaeon epistasis',
		needs: 'lrt + mean_root_attns',
		cost: 'graph math on the same forward pass; the permutation null runs in a worker; seconds',
		computed:
			'The forward pass also returns the root-to-leaf attention mean_root_attns, one weight per taxon per site. Multiplied by the indicator of taxa whose amino acid differs from the site’s consensus, and by the site’s LRT, it gives each site an attribution vector over taxa, with a Self–Liang p per site. The co-selection network takes the float32 cosine between every pair of attribution rows, a Student-t p-value with N − 2 degrees of freedom, Benjamini–Hochberg over all pairs, and the composite epistatic selection index CESI; an edge is kept when cosine ≥ 0.30, shared mutated taxa ≥ 2, q ≤ 0.05, both LRTs ≥ 1.0 and CESI ≥ 2.0. Sector mining takes the sub-graph of connected sites, splits it into greedy-modularity communities (Clauset–Newman–Moore), scores each by spectral coherence C(S) = λ₁ / trace of the community’s attribution Gram matrix, prunes sites with |v_dom| < 0.10, keeps C(S) ≥ 0.50, and tests each sector against B random K-site subsets of active sites drawn with xoshiro256** from the seed: p_perm, the null mean, standard deviation and 95th percentile, and the isotropic baseline 1/K. Sectors are sorted by coherence, then size.',
		fields: ['edges[].similarity', 'edges[].shared_taxa', 'edges[].cesi', 'edges[].fdr_q', 'sectors[].sites', 'sectors[].spectral_coherence', 'sectors[].p_perm', 'sectors[].null_coherence_95'],
		validated:
			'Against hyphaeon epistasis --seed 42 on Smc6, on the model’s own attention: leaf attributions, LRTs and p-values bit-equal; the five edges bit-identical, key order included; both sectors exact in membership, coherence and strings; p_perm within 3√(p(1−p)/B) at B = 1,000 and at B = 100,000 with three seeds a side. Sector ids reproduce CPython’s set iteration order, which decides them in networkx.',
		real: {
			label: 'BGM on Datamonkey',
			href: 'https://www.datamonkey.org/bgm',
			note: 'A Bayesian graphical model of co-evolving sites on the same alignment. A different method, not the surrogate’s target, so agreement corroborates rather than reproduces.'
		}
	},
	{
		id: 'attribution',
		title: 'Attribution',
		command: 'hyphaeon meme --attribute',
		needs: 'lrt',
		cost: 're-scoring loop over the non-consensus taxa at called sites; seconds',
		computed:
			'At each site the report calls (LRT ≥ 3.84 by default, nominal p ≤ 0.05), the consensus codon is the most frequent one; each taxon that differs is mutated to it, alone, and the site is re-scored through the same tree cache. delta_lrt = LRT − LRT_mutated and pct_signal_explained = max(0, delta_lrt / LRT) per driver; drivers are sorted by delta_lrt, and top_driver and top_mutation name the largest. The delta_lrt-weighted mean of the positive drivers’ mean patristic depth to the other taxa, relative to the tree’s maximum, places the signal in an evolutionary epoch: a recent terminal sweep, an intermediate subclade burst, or a deep ancestral divergence.',
		fields: ['top_driver', 'top_mutation', 'evolutionary_epoch', 'attribution_details[].delta_lrt', 'attribution_details[].pct_signal_explained'],
		validated:
			'The attribute_selection fixture replayed through ONNX: maximum |Δ delta_lrt| 1.10e-5 over the six attributed Smc6 sites; driver order, codons and epoch strings exact.',
		real: null
	},
	{
		id: 'filter',
		title: 'Alignment-artifact filter',
		command: 'hyphaeon meme --filter',
		needs: 'lrt',
		cost: 'two re-scoring passes; seconds',
		computed:
			'Stage one scans the site p-values: a window of at most 35 codons holding at least 3 sites at p ≤ 0.05 is a candidate patch when the hypergeometric probability of that many hits in that span, given the alignment-wide count, is below 0.01. Stage two audits each patch per taxon: the longest run of consecutive radical mismatches against the column consensus and that taxon’s share of the patch’s mismatches, the outlier contamination index; a taxon is an artifact when run ≥ 3 and OCI ≥ 0.25, or run ≥ 4. Artifact codons are masked to gaps, the cleaned alignment is re-scored, and both sets of scores are kept. App-side, the report shows the number of masked patches and a masked/unmasked toggle; the mask is never applied silently and never offered as a pre-run option.',
		fields: ['artifacts_masked[].taxon', 'artifacts_masked[].start', 'artifacts_masked[].end', 'artifacts_masked[].outlier_contamination_index', 'cleaned_metrics'],
		validated:
			'The camelid end-to-end fixture: patches, artifact audit rows and cleaned metrics replayed exactly through the library’s runAlignmentFilter in CLI mode; the cleaned re-score at the LRT class. Two reference quirks pass through by design: --filter with an embedded tree and at least one masked artifact fails at the cleaned reload upstream, and the cleaned re-score reuses the baseline tree cache.',
		real: null
	},
	{
		id: 'dms',
		title: 'Digital deep mutational scan',
		command: 'hyphaeon dms',
		needs: 'lrt (19 · L passes)',
		cost: 'the expensive one: 19 · L forward passes, tens of seconds to minutes; runs last, fills in progressively, cancellable, capped by work',
		computed:
			'One focal taxon (the first, or --focal-taxon). At each site its amino acid is replaced by each of the other 19 through the canonical codon for that residue (GCC for A, TGC for C, and so on), giving 19 mutant alignments per site that go through the network in chunks. delta = LRT_mutant − LRT_baseline; intrinsic_plasticity Φ is the mean |delta| over the 19; the mean, maximum and minimum delta and the full mutant_deltas map are kept with the baseline LRT and its Self–Liang p. App-side, the report draws the 19 × L heatmap and the plasticity track as sites finish, and stops at the work cap 19 · L · N² with an offer to finish on the server.',
		fields: ['plasticity[].site', 'plasticity[].wt_aa', 'plasticity[].baseline_lrt', 'plasticity[].intrinsic_plasticity', 'plasticity[].max_delta_lrt', 'plasticity[].mutant_deltas', 'total_mutations'],
		validated:
			'The run_insilico_selection_dms fixture: every delta, baseline and reduction bit-equal via playback of the recorded model outputs; p-values at 1e-9. The ONNX replay at the LRT class is the runtime’s.',
		real: null
	},
	{
		id: 'phenotype',
		title: 'Phenotype association',
		command: 'hyphaeon phenotype',
		needs: 'lrt + mean_root_attns',
		cost: 'seconds; on demand, because it needs a trait, and it runs on the model the report already loaded',
		status:
			'Runs in the browser. Describe the trait on the report — a curated preset that matches these taxa, tips clicked on the tree, a pasted list or pattern, or a trait table — and the pillar runs beside the other sections. There is no Python behind it on any surface.',
		computed:
			'The trait vector comes from one of three sources, in the reference’s own priority order: a table (CSV or TSV, a species column and a trait column, binary or continuous), a curated preset (echolocation, marine, fossorial, hibernation, longevity, high altitude, cardenolide resistance, dim light), or an inline foreground list — where each entry is tried as a regular expression first and only then as a glob. Attribution vectors over taxa are computed exactly as for epistasis, from the same attention and the same non-consensus indicator, and each site’s attribution row is correlated with the trait vector: ρ on the unit hypersphere, a Student-t p on N−2 degrees of freedom, and a combined p that is the Cauchy combination of that and the site’s own LRT p, with Benjamini–Hochberg q over the combined column. score = √max(0, LRT) × max(0, ρ) orders the table, and the first fifteen sites clearing ρ ≥ 0.40 and score ≥ 0.50 become the PARS signature of reference and derived residues with their foreground and background frequencies. Gene-level: spectral energy ‖A·ŷ‖, its ratio to the Frobenius norm, and a length-adjusted extreme-value p for the largest association against a null of standard error 1/√max(10, N). The called sites (q ≤ α with ρ > 0) go through the same sector miner as the epistasis pillar, at its looser trait gates. With permulations > 0 and a tree with branch lengths, Brownian-motion permulations of the trait give a second, empirical gene p and replace the parametric association p; without such a tree they are skipped and said to be skipped.',
		fields: [
			'sites[].association_rho',
			'sites[].score',
			'sites[].p_value',
			'sites[].q_value',
			'compact_pars_signature',
			'p_evd_length_adjusted',
			'norm_spectral_ratio',
			'trait_sectors',
			'gene_p_value_perm'
		],
		validated:
			'Against run_phenotype_association on RHO with the README marine foreground, on the model’s own captured attention: the 21 record keys identical and in order, 145 site rows in the same score order, every string, count, frequency column and both attention means bit-identical, and the model-dependent columns (attribution norm, ρ, its p-values, score and q) within 1e-6 — the residuals all trace to one float32 BLAS reduction that no JavaScript summation reproduces. The one trait sector matches in membership, coherence, null moments and PARS string. resolve_phenotype_vector (15 cases), compute_phylogenetic_covariance (3) and generate_permulations (3) have their own fixtures; the permulation draws are checked statistically, as the plan’s classes require.',
		real: {
			label: 'Contrast-FEL on Datamonkey',
			href: 'https://www.datamonkey.org/contrast-fel',
			note: 'Tests whether selection differs between foreground and background branches at each site: the closest real method to a trait association.'
		}
	},
	{
		id: 'evaluate',
		title: 'Evaluate against MEME',
		command: 'hyphaeon evaluate',
		needs: 'none',
		cost: 'instant; no model runs',
		computed:
			'A prediction CSV from meme and a MEME JSON are paired by gene name (.csv and .MEME.json stripped); MEME’s global site ids are recovered from its partition coverage; sites are pooled across genes. Pearson r and Spearman ρ on the LRTs. At α = 0.05 and 0.10, MEME’s p ≤ α is the reference label and hyphaeon_lrt the score for ROC-AUC, and both methods’ p ≤ α calls fill a confusion matrix for PPV = TP / (TP + FP) and FPR = FP / (FP + TN); per-gene site counts are listed; a metric that is undefined (one class) is reported as null with a warning.',
		fields: ['pearson_r', 'spearman_rho', 'thresholds[].roc_auc', 'thresholds[].ppv', 'thresholds[].fpr', 'thresholds[].confusion', 'per_gene'],
		validated:
			'evaluateFiles against the Python on the end-to-end fixtures at 1e-9 for every metric; confusion matrices exact. This is the tool behind the concordance numbers quoted on this page, run on the bundled genes against HyPhy 2.5.101.',
		real: {
			label: 'MEME on Datamonkey',
			href: 'https://www.datamonkey.org/meme',
			note: 'Run MEME, download its JSON, and load it on the Evaluate page beside the CSV from your report.'
		}
	}
];
