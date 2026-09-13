/**
 * types.ts — the `/time` page's record and the shapes its view models are built from.
 *
 * WHY THIS FILE EXISTS. A date set belongs to a DATASET; a `ReportRecord` is one selection RUN.
 * Hanging the reviewed dates off a report would mean a reader who re-runs loses their review, and
 * a reader who has not run anything has nowhere to keep it. So `/time` writes its own record into
 * its own store (lib/storage/timesets.ts) in the same database, and `TimeSetRecord.id` is what
 * phase 3's dating record will reference as `timeSetId`. Nothing else here is designed for a later
 * phase.
 *
 * `DateEntry` IS THE RUNTIME'S OWN ROW, not a re-spelling of it. `ingestDates` (runtime/src/dates/)
 * returns one row per alignment taxon carrying the value, the library rule that produced it, what
 * was imputed, the exact substring the rule consumed and how the name was matched — which is
 * precisely the review table's eight columns. Re-mapping the keys on the way into the record would
 * buy nothing and would be one more place for the two shapes to drift, so the snake_case of
 * `matched_name` and `match_tier` is kept exactly as the runtime emits it.
 *
 * ROW OBJECTS, NOT COLUMN ARRAYS, AND THE REASON IS A MEASUREMENT NOT A TASTE. PLAN-TEMPORAL's
 * column-oriented warning is about the temporal pillar's site × time table, a quarter of a million
 * cells. This is one small object per taxon: 3,000 taxa at surveillance size is a few hundred
 * kilobytes of plain objects, the page virtualises the rendering rather than the data, and column
 * arrays would cost legibility for nothing.
 *
 * THE TEXTS ARE KEPT, as `ReportRecord` keeps `inputs.alignmentText`: the review has to survive a
 * reload, and phase 3's dating run needs the sequences. The same quota caveat applies and the same
 * `QUOTA_MESSAGE` is shown.
 */

import type { InputDigest } from '$lib/api';

export const TIME_SET_SCHEMA_VERSION = 2;

/** The library's four axes. `years` is the only calendar one. */
export type TimeUnits = 'years' | 'generations' | 'days' | 'arbitrary';

export const TIME_UNIT_OPTIONS: ReadonlyArray<{ value: TimeUnits; label: string }> = [
	{ value: 'years', label: 'Calendar years' },
	{ value: 'generations', label: 'Generations' },
	{ value: 'days', label: 'Days' },
	{ value: 'arbitrary', label: 'Arbitrary time' }
];

/** Which source produced a row's date. The runtime's `DATE_SOURCES`, narrowed to what /time uses. */
export type DateSource = 'map' | 'auspice' | 'table' | 'regex' | 'header' | 'none';

/**
 * One alignment sequence's date, exactly as `ingestDates` returns it.
 *
 * `value` is NaN in memory for an undated sequence and becomes `null` across a JSON round trip, so
 * the type admits both and every consumer guards with `Number.isFinite` rather than with `== null`.
 */
export interface DateEntry {
	taxon: string;
	raw: string | null;
	value: number | null;
	rule: string;
	source: DateSource;
	imputed: boolean;
	imputations: { month: boolean; day: boolean; dayClamped: boolean };
	matched: string | null;
	matched_name: string | null;
	match_tier: string | null;
}

export interface DateSummary {
	total: number;
	dated: number;
	undated: number;
	imputed: number;
	dayClamped: number;
	outOfRange: number;
	unmatchedNames: number;
	notInTable: number;
	span: { min: number; max: number; span: number } | null;
	units: TimeUnits;
	unitsInferred: boolean;
	bySource: Record<string, number>;
	byRule: Record<string, number>;
	matchTier: string | null;
	matchTiers: Record<string, number>;
}

/**
 * Which sequence divergence is measured to. `dating.py:624-699` tests four cases in this order and
 * the first is a literal key test against the alignment, so a sequence actually NAMED `earliest`
 * beats the magic string; `'taxon'` here is that case and carries the name in `rootTaxon`.
 */
export type DatingRootChoice = 'consensus' | 'unweighted' | 'earliest' | 'taxon';

/** Everything the reader set, so a review is reproducible from the record alone. */
export interface TimeSetOptions {
	units: TimeUnits;
	unitsInferred: boolean;
	headerFallback: boolean;
	archival1959: boolean;
	customPattern: string | null;
	idColumn: string | null;
	dateColumn: string | null;
	delimiter: string | null;
	dropUndated: boolean;
	/**
	 * THE CLOCK PREVIEW'S TREE ROOT, not the dating run's. It selects where `rootToTip.js` re-roots
	 * the reader's tree before walking it; the dating pillar is tree-free and has no such thing.
	 * The two were nearly given one name and must not be: they answer different questions on
	 * different inputs, and a reader who changed one and saw the other move would be right to
	 * distrust both. The dating fields below are prefixed `dating*` for the same reason.
	 */
	rootMode: 'midpoint' | 'outgroup';
	outgroup: string | null;

	// ---- phase 3: the dating run -----------------------------------------------------------------
	/** Which of `compute_tree_free_divergences`' four cases the run takes. */
	datingRoot: DatingRootChoice;
	/** The sequence name for `datingRoot === 'taxon'`; null otherwise. */
	rootTaxon: string | null;
	/** `--clock-model`. `auto` is the reference's default and the only one that runs the F test. */
	clockModel: 'auto' | 'linear' | 'spline';
	/**
	 * `--ci-method`, restricted to what this build ports. The reference's `poisson`,
	 * `residual-boot` and `jackknife` each need a bit-compatible mirror of numpy's PCG64, so
	 * `runDating` REFUSES them by name rather than silently returning Fieller as the reference's
	 * own `else` branch does — and this type refuses to offer them.
	 */
	ciMethod: 'fieller' | 'delta';
	/** Sequences the reader dropped from the fit. Never silent: named in the record and both files. */
	excludedTaxa: string[];
}

/**
 * What a dating run left behind, stored beside the review. `record` is the reference's own
 * `hyphaeon dating -o out.json` document (its 22 keys, its order) plus the one added `primaeon`
 * block; `rows` is `taxa_summary` in ALIGNMENT order, each row carrying our extra
 * `prediction_method` column.
 *
 * THERE IS NO BOOTSTRAP FIELD AND THERE IS NO SEED. This pillar draws no random numbers at all:
 * the reference's spline bootstrap raises on every replicate upstream (`dating.py:1917` passes
 * numpy's `rcond=` to `scipy.linalg.lstsq`), and the three interval methods that would need a
 * generator are not ported. Adding a `bootstrap` option would advertise something the build does
 * not do.
 */
export interface DatingResult {
	ok: boolean;
	refusal: string | null;
	warnings: Array<{ code: string; severity: string; message: string; data?: unknown }>;
	record: Record<string, unknown>;
	rows: TaxonDatingRow[];
	/** `'ols' | 'spline'` — which model the reference's own selection rule chose. */
	activeName: string;
	/** The reference's own sentence, byte for byte (`selected_clock`). */
	selectedClock: string;
	ensemble: { t_mrca: number | null; ci_mrca: number[] | null; weights: Record<string, number> };
	rootDescription: string;
	rootCase: number;
	elapsedMs: number;
	ranAtIso: string;
	options: DatingRunOptions;
}

/** The dating knobs, echoed into the result so a stored run says what produced it. */
export interface DatingRunOptions {
	root: DatingRootChoice;
	rootTaxon: string | null;
	clockModel: 'auto' | 'linear' | 'spline';
	ciMethod: 'fieller' | 'delta';
	excludedTaxa: string[];
	units: TimeUnits;
}

/**
 * One row of `taxa_summary`. The first ten keys and their order are the reference's
 * (`dating.py:3052-3062`), because they are the CSV download's contract; `prediction_method` is
 * ours and is appended last.
 */
export interface TaxonDatingRow {
	taxon: string;
	sampling_date: number;
	root_divergence: number;
	fitted_divergence: number;
	predicted_date: number;
	divergence_residual: number;
	temporal_residual: number;
	z_score: number;
	is_outlier: boolean;
	is_holdout: boolean;
	prediction_method: string;
}

export interface TimeSetInputs {
	alignmentName: string | null;
	alignmentText: string;
	alignmentDigest: InputDigest | null;
	treeName: string | null;
	treeText: string | null;
	metadataName: string | null;
	metadataText: string | null;
	metadataDigest: InputDigest | null;
}

export interface TimeSetRecord {
	id: string;
	schemaVersion: number;
	createdAt: number;
	createdAtIso: string;
	/** The alignment file name; what a listing shows. */
	name: string;
	inputs: TimeSetInputs;
	options: TimeSetOptions;
	dates: {
		entries: DateEntry[];
		summary: DateSummary;
		unmatchedMetadata: string[];
	};
	/** The structured warnings `ingestDates` produced, in its own report order. */
	warnings: Array<{ code: string; severity: string; message: string; data?: unknown }>;
	ready: boolean;
	/** Phase 3. Null until the reader asks for an estimate; `fromStored` leaves a v1 record alone. */
	dating: DatingResult | null;
}

/** A listing row: the record without its entries, which are the bulk of it. */
export type TimeSetListing = Omit<TimeSetRecord, 'dates' | 'inputs' | 'dating'> & {
	dated: number;
	total: number;
	alignmentName: string | null;
};
