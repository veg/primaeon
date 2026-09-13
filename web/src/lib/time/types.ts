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

export const TIME_SET_SCHEMA_VERSION = 1;

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
	rootMode: 'midpoint' | 'outgroup';
	outgroup: string | null;
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
}

/** A listing row: the record without its entries, which are the bulk of it. */
export type TimeSetListing = Omit<TimeSetRecord, 'dates' | 'inputs'> & {
	dated: number;
	total: number;
	alignmentName: string | null;
};
