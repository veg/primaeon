/**
 * ruleLabel.ts — the library's rule ids in the page's words, and the one place that mapping lives.
 *
 * WHY THIS FILE EXISTS. `@veg/hyphaeon-js`'s `DATE_RULES` names 21 rules, and the review table's
 * "Rule" column is the answer to D31's demand that the page say WHICH RULE matched each sequence.
 * `korber_isolate` is the right id in a JSON download and the wrong thing to print in a table, so
 * the words are here, once, and the download keeps the id.
 *
 * THE MAP IS TOTAL, AND A TEST ENFORCES IT. `ruleLabel.test.ts` iterates `DATE_RULES` and fails on
 * any id with no sentence — the same contract `lib/diagnostics/panel.ts` holds for diagnostic
 * codes. A library that gains a rule must gain a sentence in the same change, or the page would
 * print a bare identifier at a reader and call it an explanation.
 *
 * TWO IDS CARRY A CLAIM AND ARE WORDED CAREFULLY. `out_of_range` is NOT "no date found": the
 * library separates it from `unparsed` precisely so a page can say *your date is fine, the
 * 1800–2100 gate rejected it* (library Q6), and losing that distinction here would put the two
 * failures in one bucket again. And `archival_1959` says what it is — a hard-coded calibration for
 * one sequence, off unless the reader turns it on (library Q1).
 */

/** Rule id → the short phrase in the Rule column. */
export const RULE_LABELS: Readonly<Record<string, string>> = Object.freeze({
	none: 'no value',
	non_calendar_numeric: 'plain number',
	non_calendar_embedded: 'first number in the cell',
	numeric: 'decimal year',
	decimal_year: 'decimal year',
	ymd: 'ISO date',
	out_of_range: 'outside 1800–2100',
	unparsed: 'no pattern matched',

	header_iso: 'ISO date in the name',
	header_decimal_year: 'decimal year in the name',
	header_year_month: 'year and month in the name',
	header_trailing_year: 'trailing year in the name',
	header_unit_token: 'generation or day token',
	header_unit_suffix: 'number with a unit suffix',
	header_bare_number: 'bare number field',

	archival_1959: 'archival 1959 anchor',
	korber_isolate: 'LANL two-digit year',
	lanl_pipe_year: 'LANL country and year',
	wpi: 'weeks post infection',
	dpi: 'days post infection',

	flexible_numeric: 'number, ungated',
	custom_pattern: 'custom pattern'
});

/** Rule id → one sentence saying what was read and what, if anything, was invented. */
export const RULE_NOTES: Readonly<Record<string, string>> = Object.freeze({
	none: 'The cell was empty or held one of the null words (unknown, nan, none, na, ?).',
	non_calendar_numeric: 'The value was a number and was taken as it stands; no calendar gate applies off the year axis.',
	non_calendar_embedded: 'The first run of digits anywhere in the string was taken, with no delimiter required.',
	numeric: 'The value arrived as a number inside 1800–2100 and was used as a decimal year.',
	decimal_year: 'The string parsed as a decimal year inside 1800–2100. A bare four-digit year is read as 1 January, not mid-year.',
	ymd: 'A four-digit year with optional month and day. A missing month becomes June and a missing day the 15th; the day is capped at 30, or 28 in February.',
	out_of_range: 'A year was read but fell outside 1800–2100, so it was rejected. The string is not unreadable; the gate refused it.',
	unparsed: 'No rule matched this string.',

	header_iso: 'An ISO date preceded by | / _ or a space. A hyphen does not count as a delimiter upstream.',
	header_decimal_year: 'A decimal year with two to four decimal places. One decimal place is not matched upstream, which loses real dates.',
	header_year_month: 'A year and month; the day was imputed to the 15th.',
	header_trailing_year: 'A four-digit year at the very end of the name, anchored there, read as 1 January.',
	header_unit_token: 'An explicit unit prefix such as gen_5000, g5000 or d120.',
	header_unit_suffix: 'A number carrying a unit suffix, such as 20000gen.',
	header_bare_number: 'The first delimiter-bound number in the name, with no unit at all.',

	archival_1959: 'The name contains Z59, ZR59 or 1959, which the reference dating pillar hard-codes to mid-1959 before trying any pattern. This is a calibration for one archival isolate, not a reading of the name.',
	korber_isolate: 'A LANL/Korber name of the form B86US.*: the two-digit year 86 with a pivot hard-coded at 30, plus a flat half-year that is invented rather than read.',
	lanl_pipe_year: 'A LANL name carrying an uppercase country code and a two-digit year, plus the same invented half-year.',
	wpi: 'Weeks post infection, returned raw. It is not a calendar year and nothing downstream converts it.',
	dpi: 'Days post infection, returned raw. It is not a calendar year and nothing downstream converts it.',

	flexible_numeric: 'A plain number with no year gate at all, the dating pillar’s own fallback.',
	custom_pattern: 'Your pattern matched, and its first capturing group was read as the date.'
});

/** The words for the Source column. `fallback` is a table run whose row came from the header. */
export const SOURCE_LABELS: Readonly<Record<string, string>> = Object.freeze({
	map: 'name-to-date JSON',
	auspice: 'Auspice',
	table: 'metadata',
	regex: 'pattern',
	header: 'header',
	none: 'none'
});

export function ruleLabel(rule: string | null | undefined): string {
	if (!rule) return RULE_LABELS.unparsed;
	return RULE_LABELS[rule] ?? rule;
}

export function ruleNote(rule: string | null | undefined): string {
	if (!rule) return RULE_NOTES.unparsed;
	return RULE_NOTES[rule] ?? '';
}

export function sourceLabel(source: string | null | undefined, tableLoaded = false): string {
	if (!source) return SOURCE_LABELS.none;
	if (source === 'header' && tableLoaded) return 'header (fallback)';
	return SOURCE_LABELS[source] ?? source;
}

/** The Imputed column: what the parser invented, in the order a reader reads it. */
export function imputationLabel(entry: {
	imputed: boolean;
	imputations: { month: boolean; day: boolean; dayClamped: boolean };
}): string {
	const parts: string[] = [];
	if (entry.imputations.month && entry.imputations.day) parts.push('month and day');
	else if (entry.imputations.month) parts.push('month');
	else if (entry.imputations.day) parts.push('day');
	if (entry.imputations.dayClamped) parts.push('day clamped to 30');
	return parts.length === 0 ? '—' : parts.join(', ');
}

/** The Name match column. `null` on a header or pattern row; those were never matched to anything. */
export function matchTierLabel(tier: string | null, tableLoaded: boolean): string {
	if (!tier) return tableLoaded ? 'not in table' : '—';
	switch (tier) {
		case 'exact':
			return 'exact';
		case 'quote_stripped':
			return 'quote-stripped';
		case 'whitespace_collapsed':
			return 'whitespace collapsed';
		case 'case_insensitive':
			return 'case-folded';
		case 'first_token':
			return 'first token';
		case 'sanitized':
			return 'sanitised';
		case 'field_containment':
			return 'one field of the name';
		default:
			return tier;
	}
}
