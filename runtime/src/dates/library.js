/**
 * library.js — the one place this directory reaches into `@veg/hyphaeon-js`, and the capability
 * probe that lets the rest of the package survive a library that predates the date layer.
 *
 * WHY THIS FILE EXISTS. Every other module here imports the library's date functions from this
 * module, not from the package, for two reasons.
 *
 *   1. THE LINK VERSION IS NOT PINNED TO THIS COMMIT. `runtime/package.json` resolves
 *      `@veg/hyphaeon-js` by `file:../../HyphAeon/js`, and CI checks the engine out at
 *      `ENGINE_REF` — `phase-4b` at the time of writing, which predates `js/src/dates.js`
 *      (`feat/date-parsers`). A NAMED import of a missing export is an ES-module LINK error, not a
 *      runtime one: `export * from './dates/index.js'` in `runtime/src/index.js` would take every
 *      other runtime suite down with it. A namespace import (`import * as lib`) never fails on a
 *      missing name, so the package still loads and `hasDateLayer()` reports the truth. The date
 *      suites skip loudly on that probe (`describe.skipIf`) instead of the whole workspace going
 *      red for a reason that has nothing to do with the change under test.
 *   2. IT MAKES THE NO-SECOND-PARSER RULE CHECKABLE. There is exactly one import of the library's
 *      date surface in `runtime/src/`, in this file, and `date-ingestion.test.js` asserts that no
 *      module under `runtime/src/dates/` contains a year gate, a month table or a date regular
 *      expression. If a convention has to be understood that the library does not read, it is
 *      ported into `js/src/dates.js` upstream; it is never added here.
 *
 * WHAT THE LIBRARY GIVES US, at veg/HyphAeon `feat/date-parsers` (`d998cab`):
 *
 *   parseDate(value, {timeUnits})            temporal.py:73-151   value path, calendar or not
 *   extractDate(name, {timeUnits})           temporal.py:196-245  name path, calendar or not
 *   parseHeaderDate(name, {archival1959})    dating.py:317-364    name path, the SUPERSET (it
 *                                                                delegates to extractDate first,
 *                                                                then Korber, LANL, WPI, DPI)
 *   parseFlexibleDate(value)                 dating.py:367-384    value path, ungated numeric
 *   matchesArchival1959(name)                dating.py:330-332    the predicate, so we can OFFER it
 *   isNonCalendarTimeUnits(timeUnits)        the reference's own membership test
 *
 * Every one returns a `DateParse`: `{value, rule, imputed, imputations: {month, day, dayClamped},
 * matched, timeUnits}`, with `value` NaN when nothing was read. That record IS the review table:
 * `rule` says which convention fired, `imputations` says which component of the answer was
 * invented rather than read, and `matched` is the substring a reader checks the number against.
 *
 * Also taken from the library, and likewise never re-implemented here: `parsePhenotypeTable`
 * (`js/src/phenotype.js:489`), a pandas-faithful delimited reader — RFC 4180 quoting, blank-line
 * skipping, per-column dtype inference, the `PANDAS_NA_VALUES` set. Sniffing the separator is this
 * layer's job; reading the file with it is not.
 */

import * as lib from '@veg/hyphaeon-js';

/** The names this directory needs. A library missing any one of them has no date layer. */
const REQUIRED = Object.freeze([
	'parseDate',
	'extractDate',
	'parseHeaderDate',
	'parseFlexibleDate',
	'matchesArchival1959',
	'isNonCalendarTimeUnits',
	'DATE_RULES',
	'TIME_UNITS',
	'CALENDAR_TIME_UNITS',
	'CALENDAR_YEAR_MIN',
	'CALENDAR_YEAR_MAX'
]);

/**
 * Does the linked `@veg/hyphaeon-js` carry the date layer? Call it before calling anything else
 * here; `ingestDates` raises `DATES_SOURCE_UNREADABLE`-free, plain `Error` when it does not,
 * because a library that old is a build fault, not a bad upload.
 * @returns {boolean}
 */
export function hasDateLayer() {
	return REQUIRED.every((name) => lib[name] !== undefined && lib[name] !== null);
}

/** The names that are missing, for the message a skipped suite prints. */
export function missingDateExports() {
	return REQUIRED.filter((name) => lib[name] === undefined || lib[name] === null);
}

function need(name) {
	const fn = lib[name];
	if (typeof fn !== 'function') {
		throw new Error(
			`@veg/hyphaeon-js does not export ${name}: the linked engine predates js/src/dates.js ` +
				`(feat/date-parsers). Check out an engine carrying the date layer beside this repository.`
		);
	}
	return fn;
}

/** `parse_date_to_decimal` in record form (temporal.py:73-151). @type {(value: any, options?: {timeUnits?: string}) => any} */
export const parseDate = (value, options) => need('parseDate')(value, options);

/** `extract_date_from_string` in record form (temporal.py:196-245). @type {(name: any, options?: {timeUnits?: string}) => any} */
export const extractDate = (name, options) => need('extractDate')(name, options);

/** `parse_header_timestamp` in record form (dating.py:317-364); `archival1959` defaults FALSE. */
export const parseHeaderDate = (name, options) => need('parseHeaderDate')(name, options);

/** `_parse_timestamp_flexible` in record form (dating.py:367-384). */
export const parseFlexibleDate = (value) => need('parseFlexibleDate')(value);

/** The `dating.py:331` substring test on its own, so an app can offer the rule rather than apply it. */
export const matchesArchival1959 = (name) => need('matchesArchival1959')(name);

/** The reference's own `time_units in (...)` membership: an unrecognised string is CALENDAR. */
export const isNonCalendarTimeUnits = (timeUnits) => need('isNonCalendarTimeUnits')(timeUnits);

/** `pd.read_csv` reduced to what a date table needs (phenotype.js:489). */
export const parsePhenotypeTable = (text, sep) => need('parsePhenotypeTable')(text, sep);

/** CPython `str.strip()` — the bare `.strip()` of temporal.py:314 and dating.py:467. */
export const pyStrip = (s) => need('pyStrip')(s);

/** `str(float)` as pandas prints it, for a cell an inferred float column turned into a number. */
export const pyFloatStr = (x) => need('pyFloatStr')(x);

/** `parseAlignmentSequences`, so `taxaForDates` names taxa exactly as `prepareRun` does. */
export const parseAlignmentSequences = (text) => need('parseAlignmentSequences')(text);

/** The library's rule registry, `{id: id}`. Frozen; `{}` when the library is too old. */
export const DATE_RULES = lib.DATE_RULES ?? Object.freeze({});

/** `['years','generations','days','arbitrary']`. */
export const TIME_UNITS = lib.TIME_UNITS ?? Object.freeze(['years', 'generations', 'days', 'arbitrary']);

/** `'years'`. */
export const CALENDAR_TIME_UNITS = lib.CALENDAR_TIME_UNITS ?? 'years';

/** The calendar gate, temporal.py:106. */
export const CALENDAR_YEAR_MIN = lib.CALENDAR_YEAR_MIN ?? 1800;
/** @see CALENDAR_YEAR_MIN */
export const CALENDAR_YEAR_MAX = lib.CALENDAR_YEAR_MAX ?? 2100;

/**
 * `str(row[col])` for a cell of a `parsePhenotypeTable` frame — the library keeps its own
 * `cellToString` private, and this is the same three lines (phenotype.js:552-556): an NA prints
 * `nan`, a float column prints through `pyFloatStr`, an integer column prints without a fraction.
 * It is pandas' `str()`, not a date rule, which is why it may live app-side.
 *
 * @param {any} value
 * @param {boolean} isFloatColumn
 * @returns {string}
 */
export function cellToString(value, isFloatColumn) {
	if (value === null || value === undefined) return 'nan';
	if (typeof value === 'number') return isFloatColumn ? pyFloatStr(value) : String(value);
	return String(value);
}

/**
 * A `DateParse` that read nothing, for a cell or a name no rule claimed. The shape must match the
 * library's exactly, so a row built here is indistinguishable from one the library returned.
 * @param {string} [timeUnits]
 * @returns {{value: number, rule: string, imputed: boolean,
 *   imputations: {month: boolean, day: boolean, dayClamped: boolean}, matched: string|null,
 *   timeUnits: string}}
 */
export function emptyParse(timeUnits = CALENDAR_TIME_UNITS) {
	return {
		value: NaN,
		rule: 'none',
		imputed: false,
		imputations: { month: false, day: false, dayClamped: false },
		matched: null,
		timeUnits
	};
}

/** Did this parse produce a usable number? (`NaN` is the library's "nothing"; `Infinity` is Q10.) */
export function isDated(parse) {
	return Boolean(parse) && Number.isFinite(parse.value);
}
