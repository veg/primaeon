/**
 * regex.js — the user-supplied date pattern (`hyphaeon dating --date-regex`).
 *
 * WHY THIS FILE EXISTS. `dating.py:473-484` lets a reader describe their own header convention with
 * a regular expression, tried per taxon BEFORE the built-in header rules. Compiling user input,
 * deciding it is safe to run, and saying why it was refused are application work; what to do with
 * the captured text is not — that goes straight to the library's `parseFlexibleDate`.
 *
 * THE UPSTREAM DEFECT, REPLICATED IN VALUE AND REFUSED IN FORM. dating.py:476-479 reads:
 *
 *     m = re.search(date_regex, t)
 *     if m:
 *         extracted = _parse_timestamp_flexible(m.group(1))
 *
 * `m.group(1)` on a pattern with no capturing group raises `IndexError`, uncaught, and the CLI
 * dies with a traceback on the reader's first attempt at their own convention. The house rule says
 * a bug is replicated, not quietly fixed — and it is: the VALUE this module produces for a pattern
 * with a group is identical to the reference's. What it does not do is crash. A pattern with no
 * group is refused at the input, before it is ever run, with a message saying what to put in
 * parentheses. Refusing to run is not a different answer to the same question; it is the same
 * failure, reported instead of thrown.
 *
 * TWO OBLIGATIONS THE REFERENCE DOES NOT HAVE, because this runs in a tab rather than a shell:
 *
 *   - A pattern is user input handed to a backtracking engine. `(a+)+$` against a 200-character
 *     header is exponential, and a hung tab has no Ctrl-C. `DATE_THRESHOLDS.maxPatternLength`
 *     refuses a pattern too large to be anything but a paste accident, and `applyDateRegexAll`
 *     sweeps under a wall-clock budget and reports the stop rather than finishing.
 *   - The pattern, its flags and its hit count are carried in the diagnostics, so a run is
 *     reproducible from the record alone.
 *
 * FLAGS. The reference uses a bare `re.search`, so the default here is no flags at all. `g` is
 * forbidden rather than ignored: a `RegExp` carrying it holds `lastIndex` between calls, and the
 * same pattern over the same list would then date every other taxon.
 */

import { parseDate, parseFlexibleDate, CALENDAR_TIME_UNITS } from './library.js';
import { DATE_THRESHOLDS, DATE_MESSAGES, fillMessage } from './codes.js';

/**
 * @typedef {{regex: RegExp|null, valid: boolean, error: string|null, code: string|null,
 *   groups: number, pattern: string, flags: string, source: 'user'}} CompiledDateRegex
 */

/**
 * How many capturing groups does a pattern have? The standard trick: a pattern alternated with
 * empty matches the empty string, and the result's length minus one is the group count. It costs
 * one match on `''` and, unlike counting `(` by eye, it is right about `(?:…)`, `(?<name>…)`,
 * `\(` and a `(` inside a character class.
 *
 * @param {RegExp} regex
 * @returns {number}
 */
function countGroups(regex) {
	const probe = new RegExp(`${regex.source}|`, regex.flags.replace('g', ''));
	const m = probe.exec('');
	return m ? m.length - 1 : 0;
}

/**
 * Compile a reader's pattern, or say why not.
 *
 * @param {string} pattern
 * @param {{flags?: string}} [options]
 * @returns {CompiledDateRegex}
 */
export function compileDateRegex(pattern, options = {}) {
	const flags = (options.flags ?? '').replace('g', '');
	const src = String(pattern ?? '');
	/** @type {CompiledDateRegex} */
	const base = { regex: null, valid: false, error: null, code: null, groups: 0, pattern: src, flags, source: 'user' };

	if (src === '') return { ...base, code: 'DATE_REGEX_INVALID', error: 'The pattern is empty.' };
	if (src.length > DATE_THRESHOLDS.maxPatternLength) {
		return {
			...base,
			code: 'DATE_REGEX_INVALID',
			error: fillMessage(DATE_MESSAGES.REGEX_TOO_LONG, {
				length: src.length,
				max: DATE_THRESHOLDS.maxPatternLength
			})
		};
	}

	let regex;
	try {
		regex = new RegExp(src, flags);
	} catch (err) {
		return {
			...base,
			code: 'DATE_REGEX_INVALID',
			error: fillMessage(DATE_MESSAGES.REGEX_INVALID, { error: err?.message ?? String(err) })
		};
	}

	const groups = countGroups(regex);
	if (groups === 0) {
		// dating.py:478 reads `m.group(1)`: with no group there is nothing to read and CPython raises.
		return { ...base, regex, groups, code: 'DATE_REGEX_NO_GROUP', error: DATE_MESSAGES.REGEX_NO_GROUP };
	}
	return { regex, valid: true, error: null, code: null, groups, pattern: src, flags, source: 'user' };
}

/**
 * `dating.py:476-479` for one name: search, take group 1, hand it to the flexible parser.
 *
 * Under a non-calendar `timeUnits` the flexible parser is the wrong one — `_parse_timestamp_flexible`
 * is calendar only (dating.py:375 never receives `time_units`, the divergence filed as item 8) — so
 * the captured text goes to `parseDate` with the caller's units instead. Under `'years'`, which is
 * every case the reference can reach, the two are the same call.
 *
 * @param {string} name
 * @param {CompiledDateRegex} compiled
 * @param {{timeUnits?: string}} [options]
 * @returns {{parse: any, captured: string}|null} `null` when the pattern did not match at all
 */
export function applyDateRegex(name, compiled, options = {}) {
	if (!compiled?.valid || !compiled.regex) return null;
	const m = compiled.regex.exec(String(name ?? ''));
	if (!m) return null;
	const captured = m[1];
	if (captured === undefined) return null; // an optional group that did not participate
	const timeUnits = options.timeUnits ?? CALENDAR_TIME_UNITS;
	const parse =
		timeUnits === CALENDAR_TIME_UNITS ? parseFlexibleDate(captured) : parseDate(captured, { timeUnits });
	return { parse, captured };
}

/**
 * The whole sweep, under a wall-clock budget.
 *
 * @param {readonly string[]} taxa
 * @param {CompiledDateRegex} compiled
 * @param {{timeUnits?: string, budgetMs?: number}} [options]
 * @returns {{dates: Map<string, any>, raws: Map<string, string>, matched: number,
 *   scanned: number, stopped: boolean}}
 */
export function applyDateRegexAll(taxa, compiled, options = {}) {
	/** @type {Map<string, any>} */
	const dates = new Map();
	/** @type {Map<string, string>} */
	const raws = new Map();
	const out = { dates, raws, matched: 0, scanned: 0, stopped: false };
	if (!compiled?.valid) return out;

	const budget = options.budgetMs ?? 2000;
	const started = Date.now();
	for (const taxon of taxa ?? []) {
		if (out.scanned % 64 === 0 && Date.now() - started > budget) {
			out.stopped = true;
			break;
		}
		out.scanned++;
		const hit = applyDateRegex(taxon, compiled, options);
		if (!hit) continue;
		out.matched++;
		if (!Number.isFinite(hit.parse.value)) continue;
		dates.set(taxon, hit.parse);
		raws.set(taxon, hit.captured);
	}
	return out;
}
