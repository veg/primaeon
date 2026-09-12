/**
 * record.ts — building a `TimeSetRecord` from an ingest, and reading one back that was written
 * before a field existed.
 *
 * WHY THIS FILE EXISTS. The page holds reactive state; the store holds a plain, structured-clonable
 * object. Converting between the two in a component would put the schema in the markup, and the
 * schema is the thing phase 3 will reference by id. So the conversion is here, with a test.
 *
 * SCHEMA 2 ADDED ONE KEY, `dating`, AND CHANGED NOTHING ELSE. A v1 record opens with `dating: null`
 * and the five new `TimeSetOptions` fields at their defaults, which is exactly the state a review
 * that never asked for an estimate is in — so the version bump is a label on the shape, not a
 * migration, and no stored review is lost.
 *
 * READING IS DEFENSIVE IN ONE DIRECTION ONLY. `fromStored()` fills in what a v1 record may be
 * missing and never removes what it does not recognise, so a record written by a later build opens
 * in an earlier one with its own fields intact — the same non-destructive rule `lib/storage/
 * results.ts` holds for the database upgrade itself.
 */

import { newRunId } from '$lib/storage/results';
import type { DateIngestLike } from './dateReview';
import {
	TIME_SET_SCHEMA_VERSION,
	type DateEntry,
	type DatingResult,
	type DateSummary,
	type TimeSetInputs,
	type TimeSetOptions,
	type TimeSetRecord,
	type TimeUnits
} from './types';

export function summarise(ingest: DateIngestLike): DateSummary {
	const c = ingest.coverage;
	let notInTable = 0;
	for (const row of ingest.rows) if (row.source !== 'table' && ingest.table) notInTable += 1;
	return {
		total: c.taxa_total,
		dated: c.dated,
		undated: c.undated,
		imputed: c.imputed,
		dayClamped: c.day_clamped,
		outOfRange: c.out_of_range,
		unmatchedNames: ingest.unmatched_metadata?.count ?? 0,
		notInTable,
		span: ingest.span ? { min: ingest.span.min, max: ingest.span.max, span: ingest.span.span } : null,
		units: ingest.time_units,
		unitsInferred: ingest.time_units_source === 'inferred',
		bySource: {
			header: c.from_header,
			metadata: c.from_table,
			auspice: c.from_auspice,
			map: c.from_map,
			pattern: c.from_regex
		},
		byRule: { ...ingest.by_rule },
		matchTier: ingest.match_tier,
		matchTiers: { ...ingest.match_tiers }
	};
}

export interface BuildInput {
	id?: string;
	inputs: TimeSetInputs;
	options: TimeSetOptions;
	ingest: DateIngestLike;
	ready: boolean;
	/** Phase 3: the ancestor-date run, or null until the reader asks for one. */
	dating?: DatingResult | null;
	now?: number;
}

export function buildRecord({ id, inputs, options, ingest, ready, dating = null, now = Date.now() }: BuildInput): TimeSetRecord {
	return {
		id: id ?? newRunId(),
		schemaVersion: TIME_SET_SCHEMA_VERSION,
		createdAt: now,
		createdAtIso: new Date(now).toISOString(),
		name: inputs.alignmentName ?? 'pasted sequences',
		inputs,
		options,
		dates: {
			// Plain objects only: the record crosses a structured clone into IndexedDB.
			entries: ingest.rows.map((row) => ({ ...row, imputations: { ...row.imputations } })) as DateEntry[],
			summary: summarise(ingest),
			unmatchedMetadata: [...(ingest.unmatched_metadata?.names ?? [])]
		},
		warnings: ingest.warnings.map((w) => ({ code: w.code, severity: w.severity, message: w.message, data: w.data })),
		ready,
		dating
	};
}

const DEFAULT_OPTIONS: TimeSetOptions = {
	units: 'years',
	unitsInferred: true,
	headerFallback: true,
	archival1959: false,
	customPattern: null,
	idColumn: null,
	dateColumn: null,
	delimiter: null,
	dropUndated: false,
	rootMode: 'midpoint',
	outgroup: null,
	datingRoot: 'consensus',
	rootTaxon: null,
	clockModel: 'auto',
	ciMethod: 'fieller',
	excludedTaxa: []
};

/** Fill in what an older record is missing; never drop a field this build does not know. */
export function fromStored(raw: unknown): TimeSetRecord | null {
	if (!raw || typeof raw !== 'object') return null;
	const record = raw as Partial<TimeSetRecord> & Record<string, unknown>;
	if (!record.id || !record.dates) return null;
	const dates = record.dates as TimeSetRecord['dates'];
	return {
		...(record as TimeSetRecord),
		schemaVersion: record.schemaVersion ?? 1,
		createdAt: record.createdAt ?? 0,
		createdAtIso: record.createdAtIso ?? new Date(record.createdAt ?? 0).toISOString(),
		name: record.name ?? 'stored review',
		options: { ...DEFAULT_OPTIONS, ...(record.options ?? {}) },
		dates: {
			entries: dates.entries ?? [],
			summary: dates.summary,
			unmatchedMetadata: dates.unmatchedMetadata ?? []
		},
		warnings: record.warnings ?? [],
		ready: record.ready ?? false,
		// A v1 record has no `dating` key at all; filling it with null is the additive read this
		// file's header promises, and a record written by a LATER build keeps whatever it carries.
		dating: record.dating ?? null
	};
}

/** The units a stored record was reviewed under; the page restores the radio from it. */
export function storedUnits(record: TimeSetRecord): TimeUnits {
	return record.options.units;
}
