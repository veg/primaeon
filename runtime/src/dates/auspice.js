/**
 * auspice.js — the Nextstrain Auspice v2 tip walk.
 *
 * WHY THIS FILE EXISTS. `parse_dates_from_auspice_json` (hyphaeon/temporal.py:154-193) opens a
 * file, walks a tree and decides which node counts as a tip. That is file-and-structure work, so
 * by the split rule in CLAUDE.md it is the application's, and the library's own header names it as
 * one of the three things it deliberately left here. The conversion of whatever it finds into a
 * number is still the library's: every branch below ends in `parseDate` or `extractDate`.
 *
 * WHAT IS REPLICATED, LINE BY LINE (temporal.py:163-190):
 *
 *   - the root is `data.get('tree', data)` (:159) — a build with no `tree` key IS the tree;
 *   - a node with no `children` is a tip, and nothing else is (:164-165). An INTERNAL node's date
 *     is never read, even when Auspice put one there, which is why a build's inferred ancestral
 *     dates cannot leak into a sampling-date vector;
 *   - a tip with no `name` is skipped without a word (:167-168). We count them (`nameless`),
 *     because a build that silently contributed nothing is exactly what this layer exists to make
 *     visible;
 *   - the attribute order is `num_date.value` -> `date.value` -> `year.value` -> a BARE SCALAR
 *     `num_date` -> a BARE SCALAR `date` (:172-182). There is NO bare-scalar `year` branch in the
 *     reference — do not add one;
 *   - only when all of those gave NaN is the TIP NAME itself parsed (:184-186);
 *   - a name seen twice overwrites, because the reference writes into a dict (:189). Recorded in
 *     `duplicates`.
 *
 * WHY `attrUsed` IS COUNTED, which the reference does not do. A build whose dates ALL came from
 * the tip-name fallback is a build whose `num_date` never loaded — a Nextstrain export that lost
 * its date annotations, read by a regex instead. The numbers look fine and are not the build's.
 * `DATES_AUSPICE_TIP_NAME_FALLBACK` is raised off this counter.
 *
 * WHY THE WALK IS ITERATIVE. The reference recurses (`def recurse(node)`, :163). An Auspice build
 * of a surveillance clade is deep and a browser stack is not, so the same traversal runs over an
 * explicit stack. Children are pushed in reverse so the visit order matches the reference's
 * `for child in children` — which matters only for `duplicates` (who overwrites whom), but that is
 * a fact the page prints.
 *
 * ONE DELIBERATE DIVERGENCE, FLAGGED. The reference never threads `time_units` into this walk
 * (temporal.py:170-186 call `parse_date_to_decimal(...)` with its default), so a build on a
 * generations axis is gated to [1800, 2100] and returns nothing at all. We pass the caller's
 * `timeUnits` through. Under `'years'` — every real Auspice build — the behaviour is identical;
 * under a non-calendar unit the reference's answer is an empty map, which is not a better answer.
 * The divergence is named in the parsers' upstream list (item 8).
 */

import { parseDate, extractDate, isDated, CALENDAR_TIME_UNITS } from './library.js';

/**
 * @typedef {{
 *   dates: Map<string, any>,
 *   raws: Map<string, string>,
 *   attrOf: Map<string, string>,
 *   tips: number,
 *   dated: number,
 *   attrUsed: {num_date: number, date: number, year: number, num_date_scalar: number,
 *              date_scalar: number, tip_name: number},
 *   nameless: number,
 *   duplicates: string[],
 *   rootKey: 'tree'|'self'
 * }} AuspiceDates
 *
 * `raws` is the exact string each answer was read FROM — the attribute's own value, or the tip name
 * when the fallback fired. The reference keeps only the number; the review table needs the string
 * beside it, because a reader checks `2019-12-30 -> 2019.9945` and cannot check `2019.9945` alone.
 */

/** Is this value shaped like `{value: ...}`, the Auspice v2 attribute form (temporal.py:172)? */
function attrWithValue(attrs, key) {
	const a = attrs?.[key];
	return a !== null && typeof a === 'object' && !Array.isArray(a) && 'value' in a;
}

/** `isinstance(attrs[key], (int, float, str))` — the bare-scalar branch (temporal.py:180). */
function attrScalar(attrs, key) {
	const a = attrs?.[key];
	return typeof a === 'number' || typeof a === 'string' || typeof a === 'boolean';
}

/**
 * The shapes `temporal.py:159`'s `data.get('tree', data)` accepts: a build with a `tree`, a bare
 * tree object, or a v2 payload with `version`/`meta`. A flat `{name: date}` map is NOT one of
 * these — `dating.py:424-432` reads that separately, and `ingest.js` calls it `'json-map'`.
 *
 * @param {any} value a parsed object (or a JSON string)
 * @returns {boolean}
 */
export function isAuspiceJson(value) {
	let data = value;
	if (typeof data === 'string') {
		try {
			data = JSON.parse(data);
		} catch {
			return false;
		}
	}
	if (data === null || typeof data !== 'object' || Array.isArray(data)) return false;
	if (Object.prototype.hasOwnProperty.call(data, 'tree')) return true;
	// A bare tree object: a node is recognisable by carrying children or Auspice's own annotations.
	if (Array.isArray(data.children)) return true;
	if (typeof data.name === 'string' && data.node_attrs !== undefined) return true;
	return false;
}

/**
 * `parse_dates_from_auspice_json` (temporal.py:154-193), minus the `open()`.
 *
 * @param {object|string} json a parsed object, or the JSON text
 * @param {{timeUnits?: string}} [options]
 * @returns {AuspiceDates}
 * @throws {SyntaxError} when `json` is text that will not parse — the caller turns that into
 *   `DATES_SOURCE_UNREADABLE`, because a refusal is a message, not an exception, above this line.
 */
export function walkAuspiceDates(json, options = {}) {
	const timeUnits = options.timeUnits ?? CALENDAR_TIME_UNITS;
	const data = typeof json === 'string' ? JSON.parse(json) : json;

	const hasTree =
		data !== null && typeof data === 'object' && Object.prototype.hasOwnProperty.call(data, 'tree');
	const root = hasTree ? data.tree : data;

	/** @type {AuspiceDates} */
	const out = {
		dates: new Map(),
		raws: new Map(),
		attrOf: new Map(),
		tips: 0,
		dated: 0,
		attrUsed: { num_date: 0, date: 0, year: 0, num_date_scalar: 0, date_scalar: 0, tip_name: 0 },
		nameless: 0,
		duplicates: [],
		rootKey: hasTree ? 'tree' : 'self'
	};
	if (root === null || typeof root !== 'object') return out;

	/** Auspice v2 allows a list of roots; the reference would fail on one, so treat it as a node list. */
	const stack = Array.isArray(root) ? [...root].reverse() : [root];

	while (stack.length > 0) {
		const node = stack.pop();
		if (node === null || typeof node !== 'object') continue;
		const children = Array.isArray(node.children) ? node.children : [];
		if (children.length > 0) {
			// `else: for child in children: recurse(child)` (temporal.py:188-190). Reverse, so that
			// popping visits them in the reference's order.
			for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
			continue;
		}

		out.tips++;
		const name = node.name;
		// `if not name: return` (temporal.py:167-168) — Python truthiness, so '' is nameless too.
		if (!name || typeof name !== 'string') {
			out.nameless++;
			continue;
		}

		const attrs = node.node_attrs && typeof node.node_attrs === 'object' ? node.node_attrs : {};
		let parse = null;
		/** @type {keyof AuspiceDates['attrUsed']|null} */
		let used = null;
		/** The exact value the answer was read from, for the review table's "Read from" column. */
		let raw = null;

		if (attrWithValue(attrs, 'num_date')) {
			raw = attrs.num_date.value;
			parse = parseDate(raw, { timeUnits });
			used = 'num_date';
		} else if (attrWithValue(attrs, 'date')) {
			raw = attrs.date.value;
			parse = parseDate(raw, { timeUnits });
			used = 'date';
		} else if (attrWithValue(attrs, 'year')) {
			raw = attrs.year.value;
			parse = parseDate(raw, { timeUnits });
			used = 'year';
		} else if (attrScalar(attrs, 'num_date')) {
			raw = attrs.num_date;
			parse = parseDate(raw, { timeUnits });
			used = 'num_date_scalar';
		} else if (attrScalar(attrs, 'date')) {
			raw = attrs.date;
			parse = parseDate(raw, { timeUnits });
			used = 'date_scalar';
		}

		// `if np.isnan(val): val = extract_date_from_string(name)` (temporal.py:184-186). Note that
		// the fallback runs whether or not an attribute existed — an attribute holding 'unknown'
		// hands the name path its turn, exactly as the reference does.
		if (!isDated(parse)) {
			const fromName = extractDate(name, { timeUnits });
			if (isDated(fromName)) {
				parse = fromName;
				used = 'tip_name';
				raw = name;
			}
		}

		if (isDated(parse)) {
			if (out.dates.has(name)) out.duplicates.push(name);
			else out.dated++;
			out.dates.set(name, parse); // the dict assignment of temporal.py:189: the later tip wins
			out.raws.set(name, raw === null || raw === undefined ? name : String(raw));
			if (used) {
				out.attrUsed[used]++;
				out.attrOf.set(name, used);
			}
		}
	}

	return out;
}

/**
 * `dating.py:424-432`'s OTHER JSON shape: a file with no `tree` key is read as a flat
 * `{name: value}` map through `_parse_timestamp_flexible`, with one odd second chance — a value
 * that is a dict carrying `year` is retried as `v['year']` (:430-431). Replicated including the
 * fact that the second chance does NOT re-check for NaN, so `{"a": {"year": "nonsense"}}` writes
 * NaN into the reference's map; here it simply stays undated and is counted.
 *
 * Under a non-calendar `timeUnits` the flexible parser has no idea what to do (it is calendar
 * only, dating.py:375), so this threads the caller's units into `parseDate` instead and says so in
 * the returned `parser` field.
 *
 * @param {object} json a parsed object
 * @param {{timeUnits?: string}} [options]
 * @param {(value: any) => any} flexible injected so `ingest.js` owns the library import
 * @returns {{dates: Map<string, any>, raws: Map<string, string>, keys: number, dated: number,
 *   yearRescued: number, parser: 'flexible'|'value'}}
 */
export function readJsonDateMap(json, options, flexible) {
	const timeUnits = options?.timeUnits ?? CALENDAR_TIME_UNITS;
	const calendar = timeUnits === CALENDAR_TIME_UNITS;
	/** @type {Map<string, any>} */
	const dates = new Map();
	/** @type {Map<string, string>} */
	const raws = new Map();
	let keys = 0;
	let dated = 0;
	let yearRescued = 0;
	for (const [k, v] of Object.entries(json ?? {})) {
		keys++;
		let parse = calendar ? flexible(v) : parseDate(v, { timeUnits });
		let raw = v;
		if (!isDated(parse) && v !== null && typeof v === 'object' && !Array.isArray(v) && 'year' in v) {
			const retry = calendar ? flexible(v.year) : parseDate(v.year, { timeUnits });
			if (isDated(retry)) {
				parse = retry;
				raw = v.year;
				yearRescued++;
			}
		}
		if (isDated(parse)) {
			dates.set(k, parse);
			raws.set(k, String(raw));
			dated++;
		}
	}
	return { dates, raws, keys, dated, yearRescued, parser: calendar ? 'flexible' : 'value' };
}
