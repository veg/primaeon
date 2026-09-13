/**
 * downloads.ts — the two files `/time` writes: the review table as CSV and the dates as JSON.
 *
 * WHY THIS FILE EXISTS. A review a reader cannot take away is a screen, not a result. Both files
 * are written here rather than in the component so the column list can be a constant and a test can
 * assert that the constant still matches the runtime's row shape — the two cannot drift without a
 * failure.
 *
 * THESE ARE PrimAeon's OWN FILES AND THEY SAY SO. Whether `hyphaeon dating` accepts a dates file,
 * and in what shape, is UNVERIFIED against the dating branch; claiming command-line
 * interchangeability we have not tested would be exactly the kind of promise web/DESIGN.md §5
 * forbids. The JSON's `entries` map is `{taxon: value}`, which is the shape all three upstream
 * parsers build internally, and the provenance block carries every option, the matching tier and
 * the library version, so a run is reproducible from the file alone.
 *
 * THE CSV CARRIES THE PROVENANCE COLUMNS, NOT ONLY THE NUMBER. `source`, `rule`, `read_from`,
 * `imputed` and `name_match` are the whole point of the page; a two-column export would hand the
 * reader back the silence the page exists to break.
 */

import type { ReviewRow } from './dateReview';
import type { TimeSetRecord } from './types';

/** The CSV header, in order. `downloads.test.ts` asserts it against the runtime's row shape. */
export const DATES_CSV_COLUMNS = [
	'sequence',
	'date',
	'reads_as',
	'source',
	'rule',
	'read_from',
	'imputed',
	'name_match'
] as const;

function csvCell(value: string): string {
	return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** One row per sequence, in the order the table is currently showing them. */
export function datesCsv(rows: readonly ReviewRow[]): string {
	const lines = [DATES_CSV_COLUMNS.join(',')];
	for (const r of rows) {
		lines.push(
			[
				r.taxon,
				r.value == null || !Number.isFinite(r.value) ? '' : String(r.value),
				r.readsAs === '—' ? '' : r.readsAs,
				r.source,
				r.rule,
				r.raw ?? '',
				r.imputedText === '—' ? '' : r.imputedText,
				r.matchText === '—' ? '' : r.matchText
			]
				.map((v) => csvCell(String(v)))
				.join(',')
		);
	}
	return `${lines.join('\n')}\n`;
}

export interface DatesJson {
	generator: string;
	units: string;
	entries: Record<string, number>;
	undated: string[];
	provenance: Record<string, unknown>;
}

/** The `{taxon: value}` map plus everything needed to reproduce it. */
export function datesJson(record: TimeSetRecord, libraryVersion: string | null = null): string {
	const entries: Record<string, number> = {};
	const undated: string[] = [];
	for (const e of record.dates.entries) {
		if (e.value == null || !Number.isFinite(e.value)) undated.push(e.taxon);
		else entries[e.taxon] = e.value;
	}
	const doc: DatesJson = {
		generator: 'PrimAeon /time — this is PrimAeon’s own file, not a hyphaeon CLI input format',
		units: record.options.units,
		entries,
		undated,
		provenance: {
			schema_version: record.schemaVersion,
			generated: record.createdAtIso,
			alignment: record.inputs.alignmentName,
			alignment_sha256: record.inputs.alignmentDigest?.sha256 ?? null,
			metadata: record.inputs.metadataName,
			metadata_sha256: record.inputs.metadataDigest?.sha256 ?? null,
			units_inferred: record.options.unitsInferred,
			header_fallback: record.options.headerFallback,
			archival_1959: record.options.archival1959,
			custom_pattern: record.options.customPattern,
			id_column: record.options.idColumn,
			date_column: record.options.dateColumn,
			delimiter: record.options.delimiter,
			match_tier: record.dates.summary.matchTier,
			match_tiers: record.dates.summary.matchTiers,
			by_rule: record.dates.summary.byRule,
			library: libraryVersion
		}
	};
	return `${JSON.stringify(doc, null, 2)}\n`;
}

/** Trigger a download of `text` as `filename`. The one browser-only function in this file. */
export function saveText(filename: string, text: string, type = 'text/plain'): void {
	const blob = new Blob([text], { type: `${type};charset=utf-8` });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	a.remove();
	URL.revokeObjectURL(url);
}
