/*
	types.ts — the reduced temporal-report record shapes the /reports page reads.

	WHY THIS FILE EXISTS. REPORTS_PLAN.md §5: the /reports tab renders the DAA-safe records written
	by web/scripts/prebake-temporal.mjs. These types mirror that script's output exactly (one
	<gene>.json record, the study index.json, and genome-map.json) so the page never re-derives a
	number — it only draws what the prebake reduced. Nothing here is per-sequence: the sampling
	strip carries aggregate counts per calendar quarter, never a strain or a date.
*/

/** One codon row from <gene>_temporal_sites_summary.csv, variable sites only. */
export interface TemporalSite {
	site: number;
	ref_aa: string;
	derived_aa: string;
	mutation_label: string;
	/** CONFIRMED_SWEEP | RESCUED_SWEEP | CONCORDANT_STATIC_SWEEP | TEMPORAL_NOISE | FLAT_NO_SIGNAL */
	classification: string;
	cross_classification: string;
	is_confirmed_sweep: boolean;
	is_rescued_sweep: boolean;
	is_concordant_sweep: boolean;
	lrt: number | null;
	q_static: number | null;
	q_perm: number | null;
	r2_fpca: number | null;
	peak_date: number | null;
	peak_intensity: number | null;
	fwhm_years: number | null;
	auc: number | null;
	/** L_{s,1..4}: projection onto the four fPCA wave modes. */
	wave_loadings: (number | null)[];
}

/** A per-site trajectory, kept only for confirmed/rescued sweep sites, downsampled. */
export interface TemporalCurve {
	site: number;
	mutation_label: string;
	/** Decimal-year timepoints, shared by a/v/p. */
	t: number[];
	/** â_s(t): continuous selection intensity. */
	a: (number | null)[];
	/** v_s(t): positive sweep velocity. */
	v: (number | null)[];
	/** prevalence(t): genotype frequency at the site over time. */
	p: (number | null)[];
}

/** Collective fPCA wave modes W_1..W_4(t). */
export interface TemporalWaves {
	t: number[];
	/** Four arrays, W[k-1] is W_k over `t`. */
	W: (number | null)[][];
}

/** Aggregate sampling density: sequences per calendar quarter. Counts only (DAA-safe). */
export interface TemporalSampling {
	bins: { t: number; n: number }[];
}

export interface TemporalSummary {
	taxa_total: number;
	codons_total: number;
	codons_variable: number;
	codons_invariable: number;
	timespan_years: number;
	t_min: number;
	t_max: number;
	confirmed_sweeps: number;
	rescued_sweeps: number;
	concordant_sweeps: number;
	filtered_static_noise: number;
	fpca_wave_variance_pct: number[];
	runtime_sec: number;
}

export interface TemporalReduction {
	curve_points: number;
	raw_curve_points: number;
	curves_kept: string;
	sites_kept: string;
	round_dp: number;
	sampling_bins: string;
}

export interface TemporalGeneRecord {
	gene: string;
	schema_version: number;
	/** [start, end] on NC_045512.2, or null if unknown. */
	coords: [number, number] | null;
	summary: TemporalSummary;
	sites: TemporalSite[];
	curves: TemporalCurve[];
	waves: TemporalWaves;
	sampling: TemporalSampling | null;
	reduction: TemporalReduction;
}

/** One row of the study index. */
export interface TemporalIndexGene {
	gene: string;
	coords: [number, number] | null;
	taxa_total: number;
	codons_total: number;
	codons_variable: number;
	confirmed_sweeps: number;
	rescued_sweeps: number;
	timespan_years: number;
	t_min: number;
	t_max: number;
	fpca_wave_variance_pct: number[];
	bytes: number;
}

export interface TemporalIndex {
	schema_version: number;
	study: string;
	source_version: number;
	source_hash: string;
	genes: TemporalIndexGene[];
	partial: boolean;
}

export interface GenomeMapGene {
	gene: string;
	start: number;
	end: number;
	run: boolean;
	confirmed_sweeps: number | null;
	rescued_sweeps: number | null;
	codons_variable: number | null;
}

export interface GenomeMap {
	schema_version: number;
	reference: string;
	genes: GenomeMapGene[];
}

/** Human-readable labels + the canonical epidemic-wave reading (REPORTS_PLAN.md §4). */
export const CLASSIFICATION_LABELS: Record<string, string> = {
	CONFIRMED_SWEEP: 'Confirmed sweep',
	RESCUED_SWEEP: 'Rescued sweep',
	CONCORDANT_STATIC_SWEEP: 'Concordant static sweep',
	TEMPORAL_NOISE: 'Temporal noise',
	FLAT_NO_SIGNAL: 'Flat, no signal',
	INVARIABLE: 'Invariable'
};

/**
 * The engine guide's canonical mapping of the four fPCA modes to SARS-CoV-2 epidemic waves. These
 * are the DATA-DRIVEN modes' typical correspondence, NOT Pango-lineage frequencies (which this data
 * cannot support — REPORTS_PLAN.md §4.1). The page states this caveat wherever the labels appear.
 */
export const WAVE_READING = [
	'Pre-Omicron / Delta transition',
	'Omicron BA.1 displacement',
	'BA.5 / BQ.1 takeover',
	'XBB / JN.1 diversification'
];
