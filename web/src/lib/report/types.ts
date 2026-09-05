/**
 * types.ts — the payload of each report section, in the Python reference's result key names.
 *
 * WHY THIS FILE EXISTS. The orchestrator contract (runtime/src/analyze.js `runEverything`) hands
 * the page one payload per section through `onSection(name, payload, {final})`, and each payload
 * is the document the corresponding CLI command writes: `hyphaeon meme` for `sites` (the Phase 1
 * `MemeRecord`), `hyphaeon busted` for `gene` (`record` key for key with cli.py:486-505 plus the
 * runtime's `statistics`), `hyphaeon epistasis` for `epistasis` (`edges` / `sectors` with the
 * fixture's field names, fixtures/e2e/epistasis_Smc6_n_permutations_1000.json), `--attribute` and
 * `--filter` for `attribution` and `filter`, `hyphaeon dms` for `dms`. Declaring them here, once,
 * means the section components read the same names the parity harness compares and a gallery
 * record produced by the Node prebake is the same type as a live one. App-side additions are
 * marked as such (`progress`, `cancelled`, `skipped` on DMS: streaming state the CLI has no
 * notion of).
 */

import type { AttributionRecord, FilterMetrics, MaskedPatch, MemeRecord, SiteRecord } from '$lib/results/types';

/** `sites`: `runMeme`'s document, i.e. the Phase 1 record the Sites section already renders. */
export type SitesSection = MemeRecord;

/** cli.py:486-505 — the `hyphaeon busted` record, key for key (fixtures/e2e/busted_Smc6.json). */
export interface BustedRecord {
	alignment: string | null;
	gene: string | null;
	taxa: number;
	sites: number;
	p_value_acat: number;
	p_value_simes: number;
	omnibus_lrt: number;
	/** Neural head fields: null when the head did not run; NOT reproducible upstream (runtime/src/busted.js). */
	predicted_gene_lrt: number | null;
	selection_probability: number | null;
	synonymous_rate_variation: number | null;
	total_selection_energy: number;
	sig_sites_p05: number;
	sig_sites_p10: number;
	rate_distributions: {
		omega_1: number | null;
		proportion_1: number | null;
		omega_2: number | null;
		proportion_2: number | null;
		omega_3: number | null;
		proportion_3: number | null;
	};
	positive_selection_detected: boolean | null;
	elapsed_seconds: number | null;
	[extra: string]: unknown;
}

export interface GeneSection {
	record: BustedRecord;
	statistics: {
		numVariable: number;
		pAcat: number;
		pSimes: number;
		omnibusLrt: number;
		totalSelectionEnergy: number;
		sigSitesP05: number;
		sigSitesP10: number;
		[extra: string]: unknown;
	};
	/** `provenance.neural_head` from runBusted, when the runtime kept it on the section. */
	neural_head?: {
		enabled: boolean;
		artifact_sha256: string | null;
		export_seed: number | null;
		deterministic_upstream: false;
		note: string;
	} | null;
	[extra: string]: unknown;
}

/** One co-selection edge (epistasis.py compute_branch_coselection_network; fixture `edges[]`). */
export interface EpistasisEdge {
	site_u: number;
	site_v: number;
	ref_u: string;
	ref_v: string;
	lrt_u: number;
	lrt_v: number;
	similarity: number;
	shared_taxa: number;
	shared_branches: number;
	p_val: number;
	hyper_p: number;
	fdr_q: number;
	cesi: number;
}

/** One epistatic sector (epistasis.py extract_epistatic_sectors_tse; fixture `sectors[]`). */
export interface EpistaticSector {
	sector_id: number;
	size: number;
	/** 1-indexed sites. */
	sites: number[];
	spectral_coherence: number;
	/** Empirical one-sided p over B permutations; ±0.03 of Monte Carlo error at B = 1,000 (PHASE2A). */
	p_perm: number;
	null_coherence_mean: number;
	null_coherence_std: number;
	null_coherence_95: number;
	/** 1/K. */
	isotropic_baseline: number;
	shared_taxa: number;
	shared_branches: number;
	mean_lrt: number;
	pars_signature: string;
	consensus_signature: string;
	[extra: string]: unknown;
}

/** One DMS site record (epistasis.py:567-577; fixture `plasticity[]`). Deltas are mutant − baseline. */
export interface DmsSiteRecord {
	site: number;
	wt_aa: string;
	baseline_lrt: number;
	p_value: number;
	intrinsic_plasticity: number;
	mean_delta_lrt: number;
	max_delta_lrt: number;
	min_delta_lrt: number;
	/** The 19 other residues → ΔLRT. */
	mutant_deltas: Record<string, number>;
}

export interface EpistasisSection {
	edges: EpistasisEdge[];
	sectors: EpistaticSector[];
	/** The sector sites' DMS, when the epistasis pillar ran it (CLI behaviour); the full scan is `dms`. */
	plasticity?: DmsSiteRecord[] | null;
	/** `CoselectionGraph.toJson()` when the runtime kept it; the network is drawn from `edges` either way. */
	graph?: unknown;
	/** B used for `p_perm`, and the seed, when the runtime records them. */
	n_permutations?: number;
	seed?: number;
	evaluated_taxa?: number;
	[extra: string]: unknown;
}

export interface AttributionSection {
	/** attribution.py records keyed by the 1-indexed site as a string (cli.py:307). */
	attributions: Record<string, AttributionRecord>;
	attribution_enabled: boolean;
	[extra: string]: unknown;
}

export interface FilterSection {
	artifacts_masked: MaskedPatch[];
	filter_enabled: boolean;
	/** The re-scored sites after masking, when at least one patch was masked. */
	cleaned?: { sites: SiteRecord[]; alignment?: { names: string[]; sequences: string[] } | null } | null;
	masked_codon_ranges_1idx_by_taxon?: Record<string, number[][]>;
	raw_metrics?: FilterMetrics;
	cleaned_metrics?: FilterMetrics;
	[extra: string]: unknown;
}

export interface DmsSection {
	plasticity: DmsSiteRecord[];
	focal_taxon: string;
	/** 19 × codon_count, as the reference reports it whatever was swept. */
	total_mutations: number;
	/** App-side: sites swept so far / sites to sweep (progressive fill). */
	progress: { done: number; total: number };
	/** The scan was cancelled; `plasticity` holds what finished (runtime/src/dms.js: `cancelled: true, reason`). */
	cancelled?: boolean;
	/** The scan did not start because 19·L·N² exceeded `options.dms.workBudget` (`skipped: true, reason, work, budget`). */
	skipped?: boolean | { reason: string; work: number; budget: number } | null;
	/** Fewer sites than requested were swept to fit the budget (`capped: true, reason`). */
	capped?: boolean;
	reason?: string;
	work?: number;
	budget?: number;
	sites_swept?: number;
	sites_requested?: number;
	[extra: string]: unknown;
}

/** An optional section that failed (runtime/src/analyze.js `sectionError`): the report keeps the slot with the apology. */
export interface FailedSection {
	failed: true;
	error: string;
	stack?: string | null;
}

export function isFailedSection(payload: unknown): payload is FailedSection {
	return Boolean(payload && typeof payload === 'object' && (payload as { failed?: unknown }).failed === true);
}

/** The DMS `skipped` marker in one shape, whichever the producer wrote. */
export function dmsSkipped(dms: DmsSection | null | undefined): { reason: string; work: number; budget: number } | null {
	if (!dms || !dms.skipped) return null;
	if (dms.skipped === true) return { reason: dms.reason ?? 'above the work budget', work: dms.work ?? 0, budget: dms.budget ?? 0 };
	return dms.skipped;
}

// ---- phenotype (Phase 3) ------------------------------------------------------------------------

/**
 * One site row of `hyphaeon phenotype`, in phenotype.py:1085's key order (the 16 keys the library's
 * `runPhenotypeAssociation` pushes, plus the `q_value` Benjamini-Hochberg adds afterwards). Rows
 * arrive sorted by `score`, descending — NOT by site — because the reference sorts them that way
 * before the BH pass, and the PARS bracket reads the first 15 of that order.
 */
export interface PhenotypeSiteRecord {
	site: number;
	ref_aa: string;
	derived_aa: string;
	hyphaeon_lrt: number;
	p_lrt: number;
	attribution_norm: number;
	fg_mean_attn: number;
	bg_mean_attn: number;
	association_rho: number;
	/** ACAT of `p_lrt` and `p_assoc`; the column BH is run on. */
	p_value: number;
	p_assoc: number;
	p_assoc_parametric: number;
	/** The permulation p when permulations ran, else null on every row. */
	p_assoc_perm: number | null;
	score: number;
	foreground_freq_pct: number;
	background_freq_pct: number;
	q_value?: number;
	[extra: string]: unknown;
}

/** One trait co-selection pair (phenotype.py:545-600). `site_u` / `site_v` are NOT position-ordered. */
export interface PhenotypeCoselectionPair {
	site_u: number;
	site_v: number;
	similarity: number;
	cesi: number;
	[extra: string]: unknown;
}

/** `resolve_phenotype_vector`'s meta dict, key for key (phenotype.py:127-215). */
export interface PhenotypeMeta {
	mode: string;
	foreground_count: number;
	background_count: number;
	/** The CLI's own sentence; EMPTY when a bare vector was passed instead of the options. */
	description: string;
	[extra: string]: unknown;
}

/**
 * `hyphaeon phenotype`'s document (phenotype.py:624-646, 21 keys in order), plus the app-side
 * fields the runtime attaches: what the trait was, whether permulations ran, and how long it took.
 * Everything not marked app-side is the reference's.
 */
export interface PhenotypeSection {
	alignment: string | null;
	tree: string | null;
	taxa_count: number;
	codon_count: number;
	phenotype_meta: PhenotypeMeta;
	spectral_energy: number;
	norm_spectral_ratio: number;
	max_assoc: number;
	p_evd_length_adjusted: number;
	score_track_a: number;
	score_track_b: number;
	dual_track_composite: number;
	/** `[ D83 - G101 - ... ]`, or `[]` when no site reached rho ≥ 0.40 and score ≥ 0.50. */
	compact_pars_signature: string;
	/** The REQUESTED B when the permulations succeeded, 0 when they did not: a "did they run" flag. */
	permulations_count: number;
	gene_p_value_perm: number | null;
	significant_sites_count: number;
	coselection_pairs_count: number;
	trait_sectors_count: number;
	coselection_pairs: PhenotypeCoselectionPair[];
	/** The sector miner's own records, the same shape the epistasis section carries. */
	trait_sectors: EpistaticSector[];
	sites: PhenotypeSiteRecord[];
	// --- the runtime's own block, appended after the reference's keys (runtime/src/phenotype.js) ---
	/** `describeTrait`: which of the three sources the trait came from, and what it matched. */
	trait?: {
		source: 'table' | 'preset' | 'foreground' | 'vector' | string;
		preset: string | null;
		mode: string | null;
		foreground_count: number;
		background_count: number;
		description: string;
		/** True when a `background` was supplied: phenotype.py:125 declares it and never reads it. */
		background_ignored: boolean;
	};
	/**
	 * Why the permulations ran or did not. `reason` is one of `PERMULATION_SKIP_REASONS`
	 * (`not-requested` | `tree-free` | `no-tree` | `failed`) and null when they ran; `detail` is the
	 * sentence to print where the gene-level empirical p would have been.
	 */
	permulations?: { requested: number; ran: number; reason: string | null; detail: string | null; seed: number };
	/** B and the seed of the trait-sector null, with its Monte Carlo caveat. */
	sector_permutations?: { n: number; seed: number; rng: string; note: string };
	/** 'shared-pass' when the report's own forward pass was reused, 'all-sites' for the CLI's loop. */
	attention_source?: string;
	thresholds?: Record<string, number>;
	/** The resolved options: `permulations`, `minTaxa`, `alpha`, `nPermutations`, `maxPermP`, `seed`. */
	options?: { alpha?: number; seed?: number; permulations?: number; nPermutations?: number; minTaxa?: number; [extra: string]: unknown };
	elapsed_sec?: number;
	[extra: string]: unknown;
}

/** True for a payload that is a finished phenotype record rather than a failure marker or null. */
export function isPhenotypeRecord(payload: unknown): payload is PhenotypeSection {
	return Boolean(payload && typeof payload === 'object' && Array.isArray((payload as PhenotypeSection).sites));
}

/**
 * The sites the panel calls: `q_value <= alpha` with a POSITIVE association, which is the same
 * bracket the reference takes into its trait co-selection block (phenotype.py:545). A negative rho
 * at a small q means the site tracks the BACKGROUND, and the pillar is directional by design.
 */
export function phenotypeCalledSites(section: PhenotypeSection, alpha = 0.05): PhenotypeSiteRecord[] {
	return section.sites.filter((s) => (s.q_value ?? 1) <= alpha && s.association_rho > 0);
}

export interface ReportSections {
	sites: SitesSection | null;
	gene: GeneSection | null;
	epistasis: EpistasisSection | null;
	attribution: AttributionSection | null;
	filter: FilterSection | null;
	dms: DmsSection | null;
	/** Null until the reader asks for it: the trait is theirs to supply (PLAN.md §4.0 row 8). */
	phenotype: PhenotypeSection | FailedSection | null;
}

export function emptySections(): ReportSections {
	return { sites: null, gene: null, epistasis: null, attribution: null, filter: null, dms: null, phenotype: null };
}
