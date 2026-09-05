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

/** `phenotype` is Phase 3: the report renders the offer, never a result. */
export type PhenotypeSection = null;

export interface ReportSections {
	sites: SitesSection | null;
	gene: GeneSection | null;
	epistasis: EpistasisSection | null;
	attribution: AttributionSection | null;
	filter: FilterSection | null;
	dms: DmsSection | null;
	phenotype: PhenotypeSection;
}

export function emptySections(): ReportSections {
	return { sites: null, gene: null, epistasis: null, attribution: null, filter: null, dms: null, phenotype: null };
}
