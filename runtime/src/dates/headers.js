/**
 * headers.js — reading a date out of the sequence name itself, per taxon.
 *
 * WHY THIS FILE EXISTS. The two references fall back to the headers in two incompatible ways, and
 * the choice between them decides whether a reader with a partial metadata table keeps 143
 * sequences or 78.
 *
 *   temporal.py:322-329  `if len(missing_taxa) > 0 and len(dates) == 0:` — the fallback runs ONLY
 *                        when the table produced NOTHING AT ALL. A table covering 80 % of the taxa
 *                        therefore leaves the other 20 % undated, and `parse_temporal_metadata`
 *                        returns a dict that simply does not mention them. They are dropped
 *                        downstream without a word.
 *   dating.py:470-483    the fallback runs PER TAXON, for every taxon still missing, and the
 *                        `--date-regex` is tried first for each.
 *
 * This layer takes dating's, because it is the only one of the two that is not a silent data loss —
 * and it says, per row, that it fell back (`source: 'header'`, and `DATES_HEADER_FALLBACK` names
 * the count). The temporal behaviour is not lost: it is what `headerFallback: false` gives, and the
 * warning text names the line that guards it.
 *
 * WHICH LIBRARY FUNCTION, AND WHY. `parseHeaderDate` mirrors `dating.py:317-364`, which is the
 * SUPERSET: it delegates to `extract_date_from_string` first (the ISO, decimal-year, year-month
 * and trailing-year patterns) and only then tries Korber/LANL two-digit years, the LANL pipe form,
 * WPI and DPI. It is D31's union in one line, which is why it is what a header fallback calls.
 * MEASURED on `examples/korber_env_gp160.fasta`, 143 names: `extract_date_from_string` dates 0 of
 * them and `parse_header_timestamp` dates 142 — every LANL name in the flagship HIV example is
 * invisible to the temporal pillar's own parser.
 *
 * THE ONE DELIBERATE DIVERGENCE IN THIS DIRECTORY: `archival1959` DEFAULTS TO FALSE.
 * dating.py:330-332 opens `parse_header_timestamp` with
 *
 *     if 'Z59' in name or 'ZR59' in name or '1959' in name:
 *         return 1959.5
 *
 * before any pattern is tried. It is a dataset-specific calibration for one sequence — the 1959
 * Léopoldville isolate that anchors the flagship ancestor estimate — written as an unbounded
 * substring test on the whole header. Executed: `A/Brisbane/1959/2019` returns 1959.5 though its
 * real date is 2019, and `seq_11959_2020` returns 1959.5 because `1959` occurs inside `11959`.
 * In a dating analysis that failure moves the answer by decades without erroring, and the outlier
 * table then flags the correctly-dated sequences as the anomalies.
 *
 * The library made the rule opt-in and exposed the predicate; this module offers it. When
 * candidates exist and the rule is off, `DATES_ARCHIVAL_1959_AVAILABLE` names them and what they
 * would become; when a reader turns it on, `DATES_ARCHIVAL_1959_APPLIED` names them again and every
 * affected row reads `rule: 'archival_1959'`. It is never on by default and never silent in either
 * direction.
 *
 * MEASURED, AND IT IS WHAT MAKES SHIPPING IT OFF SAFE: on `korber_env_gp160.fasta` the anchor
 * changes ZERO rows, because the Korber two-digit rule reads `Z59ZR.ZHU` as 1959.5 anyway. The
 * flagship example loses nothing by the default.
 *
 * NON-CALENDAR UNITS. `parse_header_timestamp` has no `time_units` parameter at all, so under
 * generations or days it would return calendar answers — a header shaped `clone_g5000` would come
 * back undated rather than as 5000 generations. Under a non-calendar unit this module calls
 * `extractDate` with the caller's units, which is the reference's own non-calendar name path
 * (temporal.py:206-210). Under `'years'`, the only units the dating pillar can reach, the two are
 * the same call.
 */

import {
	extractDate,
	parseHeaderDate,
	matchesArchival1959,
	isDated,
	CALENDAR_TIME_UNITS
} from './library.js';

/**
 * Date every taxon from its own name.
 *
 * @param {readonly string[]} taxa
 * @param {{timeUnits?: string, archival1959?: boolean}} [options]
 * @returns {{dates: Map<string, any>, parses: Map<string, any>, attempted: number, dated: number,
 *   rules: Record<string, number>, parser: 'header'|'extract'}}
 *   only taxa that parsed appear in `dates`; `rule` on each says which pattern fired. `parses`
 *   holds EVERY attempt, dated or not, because the rule of a FAILED attempt is the only thing that
 *   separates "your date is fine, the gate rejected it" (`out_of_range`) from "no rule claimed this
 *   string" (`unparsed`) — a distinction the reference erases by returning NaN for both.
 */
export function datesFromHeaders(taxa, options = {}) {
	const timeUnits = options.timeUnits ?? CALENDAR_TIME_UNITS;
	const archival1959 = options.archival1959 === true;
	const calendar = timeUnits === CALENDAR_TIME_UNITS;

	/** @type {Map<string, any>} */
	const dates = new Map();
	/** @type {Map<string, any>} */
	const parses = new Map();
	/** @type {Record<string, number>} */
	const rules = {};
	let attempted = 0;
	let dated = 0;

	for (const taxon of taxa ?? []) {
		attempted++;
		const parse = calendar
			? parseHeaderDate(taxon, { archival1959 })
			: extractDate(taxon, { timeUnits });
		parses.set(taxon, parse);
		if (!isDated(parse)) continue;
		dates.set(taxon, parse);
		dated++;
		rules[parse.rule] = (rules[parse.rule] ?? 0) + 1;
	}

	return { dates, parses, attempted, dated, rules, parser: calendar ? 'header' : 'extract' };
}

/**
 * Which taxa the opt-in 1959 rule WOULD claim, without applying it — `matchesArchival1959` is the
 * `dating.py:331` substring test on its own. The page prints this list beside what each name would
 * become, so the reader decides rather than discovers.
 *
 * @param {readonly string[]} taxa
 * @returns {string[]}
 */
export function archival1959Candidates(taxa) {
	return Array.from(taxa ?? []).filter((t) => matchesArchival1959(t));
}

/**
 * What the anchor would CHANGE, which is a smaller and more useful set than what it would claim:
 * a name the Korber rule already reads as 1959.5 is not moved by it.
 *
 * @param {readonly string[]} taxa
 * @param {{timeUnits?: string}} [options]
 * @returns {Array<{taxon: string, without: number, with: number}>}
 */
export function archival1959Changes(taxa, options = {}) {
	const timeUnits = options.timeUnits ?? CALENDAR_TIME_UNITS;
	if (timeUnits !== CALENDAR_TIME_UNITS) return [];
	const out = [];
	for (const taxon of archival1959Candidates(taxa)) {
		const off = parseHeaderDate(taxon, { archival1959: false });
		const on = parseHeaderDate(taxon, { archival1959: true });
		if (!Object.is(off.value, on.value)) {
			out.push({ taxon, without: off.value, with: on.value });
		}
	}
	return out;
}
