/**
 * ingest.js — the one call a surface makes to date a dataset, and the record it hands back.
 *
 * WHY THIS FILE EXISTS. `parse_temporal_metadata` (hyphaeon/temporal.py:248-330) and
 * `parse_sample_dates` (hyphaeon/dating.py:387-487) are the reference's two dispatchers: each
 * decides what kind of file it was given, reads it, falls back to the headers under its own rule,
 * and returns a `{name: float}` dict. What neither returns is ANY account of what it did — which
 * column it chose, which names failed to match, which components of a date it invented, or which
 * taxa it is about to drop. `parse_temporal_metadata` returns a dict that simply does not mention
 * the taxa it could not date, and they vanish downstream without a word.
 *
 * That silence is the product problem this layer exists to fix, so this module returns a
 * `DateIngest`: ONE ROW PER ALIGNMENT TAXON, always, including the undated ones, each carrying the
 * raw string it was read from, which rule read it, which source it came from, what was imputed and
 * at which name-matching tier it was matched — plus the coverage counts, the span, the units and a
 * list of structured warnings in the shape `diagnose()` and `pipeline.js` already use.
 *
 * WHAT IT NEVER DOES. It opens nothing: every input is TEXT the caller already read (a browser
 * File, an MCP argument, a server upload), so one function serves every surface and the module
 * imports nothing from `node:fs`. It never throws on bad input — a refusal is a
 * `severity: 'refuse'` warning and `ok: false`, matching `diagnose()`'s contract — and it never
 * converts a string into a number itself: every conversion goes through `@veg/hyphaeon-js` by way
 * of `library.js`.
 *
 * THE ORDER OF SOURCES, AND WHOSE FALLBACK POLICY IT IS. Per taxon:
 *
 *     the supplied source (a table, an Auspice build, a JSON map, a caller's map)
 *  -> the custom pattern      (dating.py:474-479, tried per taxon before the built-in rules)
 *  -> the sequence name       (dating.py:481-483)
 *
 * That is DATING's policy, chosen deliberately over TEMPORAL's. temporal.py:322-329 guards the
 * header fallback with `len(dates) == 0`, so a table covering 80 % of the taxa leaves the other
 * 20 % undated and dropped; dating falls back for every taxon still missing. Dating's is the only
 * one of the two that is not a silent data loss. Temporal's behaviour is still reachable — it is
 * what `headerFallback: false` gives — and `DATES_HEADER_FALLBACK` names the count either way.
 *
 * THE UNITS DECISION IS MADE ONCE AND SHOWN. `timeUnits` is the only switch between the calendar
 * and non-calendar readings of the same string, and the library never infers it (temporal.py:90-102
 * versus :104-147: the same header gives different numbers). When the caller does not supply one,
 * `inferTimeUnits` decides from the date COLUMN NAME first and from a two-way probe of the values
 * second, and `DATES_UNITS_INFERRED` carries both counts so a page can print the evidence rather
 * than the conclusion.
 *
 * WHERE IT PLUGS IN. Nowhere, yet, and that is deliberate: `runtime/src/pipeline.js` is NOT edited
 * in this phase. `prepareRun` keeps its exact signature and its exact `preprocessing` block; this
 * layer sits beside it and is composed by the caller. `alignDatesToRun(ingest, prep)` is the only
 * place the two meet, and it meets them read-only — it reads `prep.loaded.taxa` and
 * `prep.preprocessing.dropped_taxa`, returns a new object, and never mutates `prep`.
 */

import {
	parseDate,
	extractDate,
	parseHeaderDate,
	parseFlexibleDate,
	parseAlignmentSequences,
	isDated,
	emptyParse,
	CALENDAR_TIME_UNITS,
	CALENDAR_YEAR_MIN,
	CALENDAR_YEAR_MAX,
	hasDateLayer,
	missingDateExports
} from './library.js';
import {
	DATE_SCHEMA_VERSION,
	DATE_DIAGNOSTIC_CODES,
	DATE_THRESHOLDS,
	DATE_MESSAGES,
	nameSample,
	fillMessage
} from './codes.js';
import { isAuspiceJson, walkAuspiceDates, readJsonDateMap } from './auspice.js';
import {
	readDateTable,
	tableDateMap,
	ALL_DATE_COLUMN_CANDIDATES,
	NON_CALENDAR_DATE_COLUMNS
} from './table.js';
import { compileDateRegex, applyDateRegexAll } from './regex.js';
import { datesFromHeaders, archival1959Candidates, archival1959Changes } from './headers.js';
import { matchDateNames, usedFuzzyTier } from './match.js';

/** The non-calendar unit a probe reads against. Generations is the reference's own first candidate. */
const PROBE_NON_CALENDAR = 'generations';

// =================================================================================================
// Small shared helpers
// =================================================================================================

/** A warning in PLAN.md §3.5's shape, the one `pipeline.js`'s `warning()` already emits. */
function warn(code, severity, message, data = {}) {
	return { code, severity, message, data };
}

/** `DATE_DIAGNOSTIC_CODES` order, stable within a code; an unknown code sorts last. */
function sortWarnings(warnings) {
	const rank = (w) => {
		const i = DATE_DIAGNOSTIC_CODES.indexOf(w.code);
		return i < 0 ? DATE_DIAGNOSTIC_CODES.length : i;
	};
	return warnings
		.map((w, i) => ({ w, i }))
		.sort((a, b) => rank(a.w) - rank(b.w) || a.i - b.i)
		.map((x) => x.w);
}

/** `{count, names, sample}` — the whole list kept, a capped sample for a message. */
function nameBlock(names, cap = DATE_THRESHOLDS.sampleNames) {
	const list = Array.from(names ?? []);
	return { count: list.length, names: list, sample: list.slice(0, cap) };
}

/** A `Map` from a Map, a plain object, or an array of pairs. `null` stays `null`. */
function toMap(value) {
	if (value === null || value === undefined) return null;
	if (value instanceof Map) return value;
	if (Array.isArray(value)) return new Map(value);
	if (typeof value === 'object') return new Map(Object.entries(value));
	return null;
}

/**
 * The taxon names a date map must be keyed on: exactly what `prepareRun` will index by.
 *
 * `pipeline.js:457` calls the library's `parseAlignmentSequences(alignmentText)` and works from its
 * keys, and the library names a sequence by the FIRST WHITESPACE TOKEN of its header. A date map
 * keyed on the raw `>` line, or on display-tree tips, is a match failure this layer would then have
 * to explain. Re-exported so no surface has to know that.
 *
 * @param {string} alignmentText
 * @returns {string[]}
 */
export function taxaForDates(alignmentText) {
	return Array.from(parseAlignmentSequences(alignmentText).keys());
}

// =================================================================================================
// Source kind
// =================================================================================================

/**
 * What was this file? `dating.py:415-436` dispatches on the suffix (`.json` -> Auspice or flat map,
 * `.xml` -> BEAST, else delimited); `temporal.py:267-277` only ever reads a table. We sniff the
 * CONTENT and use the name as a tie-break, because a metadata export named `.txt` is common and
 * being wrong here costs a whole dataset.
 *
 * @param {string} text
 * @param {string} [fileName]
 * @returns {'auspice'|'json-map'|'table'|'beast'|'unknown'}
 */
export function detectDateSourceKind(text, fileName = '') {
	const name = String(fileName ?? '').toLowerCase();
	const body = String(text ?? '');
	const head = body.slice(0, 4096).trimStart();

	if (name.endsWith('.xml') || head.startsWith('<?xml') || head.startsWith('<beast')) return 'beast';

	if (head.startsWith('{') || head.startsWith('[')) {
		let json;
		try {
			json = JSON.parse(body);
		} catch {
			return 'unknown';
		}
		if (isAuspiceJson(json)) return 'auspice';
		if (json !== null && typeof json === 'object' && !Array.isArray(json)) {
			// A flat `{name: value}` object is dating.py:424-432's other shape. Accept it only when
			// the values are scalars or `{year: ...}` dicts; anything else is a JSON we do not know.
			const values = Object.values(json);
			if (values.length === 0) return 'json-map';
			const scalar = values.every(
				(v) =>
					v === null ||
					typeof v === 'number' ||
					typeof v === 'string' ||
					typeof v === 'boolean' ||
					(typeof v === 'object' && !Array.isArray(v))
			);
			return scalar ? 'json-map' : 'unknown';
		}
		return 'unknown';
	}

	if (body.trim() === '') return 'unknown';
	// A delimited table is a text whose first non-empty line splits into at least two fields by one
	// of the sniff's candidates. One column is not a date table: there is nothing to pair a name to.
	const first = body.split(/\r\n|\r|\n/).find((l) => l.trim() !== '') ?? '';
	for (const sep of ['\t', ',', ';', '|']) {
		if (first.split(sep).length >= 2) return 'table';
	}
	return 'unknown';
}

// =================================================================================================
// Units
// =================================================================================================

/**
 * Decide the time axis, and say what the decision was made on.
 *
 * The rule, in order:
 *   1. `hint` supplied by the caller                       -> `source: 'supplied'`
 *   2. the date COLUMN NAME is a non-calendar one          -> 'generations' | 'days'
 *      (`NON_CALENDAR_DATE_COLUMNS`, the non-calendar half of temporal.py:296-301)
 *   3. a two-way probe of the candidate strings: parse each under `'years'` and under
 *      `'generations'` and take whichever dates MORE, calendar winning a tie
 *   4. nothing parses either way -> `'years'`, the library's own fall-through
 *
 * DEPARTURE FROM THE LITERAL RULE, AND THE MEASUREMENT BEHIND IT. The specification's rule 3 reads
 * "every value parses under 'years' and lands inside the gate", falling to `'arbitrary'` otherwise.
 * MEASURED on `examples/korber_env_gp160.fasta`: 142 of 143 names date under `'years'` and the one
 * that does not is `CONSENSUS`, which is not a sequence date at all. A strict "every" test would
 * therefore read the flagship HIV example as an `'arbitrary'` axis and destroy it. Counting instead
 * of requiring keeps the intended answer on every real file and still flips cleanly on the
 * generations case (a 25-clone LTEE panel dates 0 under years and 25 under generations).
 *
 * THE PROBE MUST USE THE RIGHT PATH. A metadata cell and a sequence name are read by different
 * functions with different rules (temporal.py:73-151 versus :196-245), and probing a name with the
 * value path is how a file of LANL names comes back as a generations axis: `parseDate` cannot read
 * `B86US.SFMHS18` at all on a calendar axis, but its non-calendar branch finds the first number
 * anywhere in the string (temporal.py:96) and answers 86. MEASURED before the fix: all 143 korber
 * names probed as 0 calendar / 142 non-calendar and the flagship example inferred `'generations'`.
 * `path` selects the pair, and defaults to `'value'` when values were supplied and `'name'` when
 * the probe falls back to the taxon names.
 *
 * @param {readonly any[]} values the candidate raw strings — table cells, Auspice attributes
 * @param {{taxa?: readonly string[], dateColumn?: string|null, hint?: string|null,
 *   path?: 'value'|'name'}} [context]
 * @returns {{timeUnits: string, source: 'supplied'|'inferred', evidence: object}}
 */
export function inferTimeUnits(values, context = {}) {
	const hint = context.hint ?? null;
	if (hint) {
		return { timeUnits: hint, source: 'supplied', evidence: { reason: 'supplied' } };
	}

	const column = context.dateColumn ?? null;
	if (column) {
		const byName = NON_CALENDAR_DATE_COLUMNS[String(column).toLowerCase()];
		if (byName) {
			return {
				timeUnits: byName,
				source: 'inferred',
				evidence: { reason: 'column_name', column, candidates: 0, yearsDated: 0, nonCalendarDated: 0 }
			};
		}
	}

	const valueList = Array.from(values ?? []);
	const candidates = valueList.length > 0 ? valueList : Array.from(context.taxa ?? []);
	const path = context.path ?? (valueList.length > 0 ? 'value' : 'name');
	const calendarProbe =
		path === 'name' ? (v) => parseHeaderDate(v) : (v) => parseDate(v, { timeUnits: CALENDAR_TIME_UNITS });
	const nonCalendarProbe =
		path === 'name'
			? (v) => extractDate(v, { timeUnits: PROBE_NON_CALENDAR })
			: (v) => parseDate(v, { timeUnits: PROBE_NON_CALENDAR });

	let yearsDated = 0;
	let nonCalendarDated = 0;
	for (const v of candidates) {
		if (isDated(calendarProbe(v))) yearsDated++;
		if (isDated(nonCalendarProbe(v))) nonCalendarDated++;
	}

	const calendarShare = candidates.length > 0 ? yearsDated / candidates.length : 0;
	const evidence = {
		reason: 'values',
		path,
		column,
		candidates: candidates.length,
		yearsDated,
		nonCalendarDated,
		calendarShare
	};
	// A CALENDAR MAJORITY WINS OUTRIGHT, whatever the non-calendar pass scored. The two passes are
	// not comparable as counts: the non-calendar name path ends in a bare-number rule
	// (temporal.py:210) that claims the first delimited number in ANY name, so it scores near 100 %
	// on files that are plainly calendar. See `DATE_THRESHOLDS.calendarMajority` for the three
	// measurements behind the number.
	if (calendarShare >= DATE_THRESHOLDS.calendarMajority) {
		return { timeUnits: CALENDAR_TIME_UNITS, source: 'inferred', evidence };
	}
	if (nonCalendarDated > yearsDated) {
		return { timeUnits: PROBE_NON_CALENDAR, source: 'inferred', evidence };
	}
	return { timeUnits: CALENDAR_TIME_UNITS, source: 'inferred', evidence };
}

// =================================================================================================
// Span
// =================================================================================================

/**
 * The shape of the time axis a set of values describes. `tied` is the size of the largest group
 * sharing one value: a surveillance set where 80 % of the sequences carry the same month is a set
 * with far less temporal information than its count suggests.
 *
 * @param {Iterable<number>} values
 * @returns {{min: number, max: number, span: number, unique: number, tied: number, finite: number}|null}
 */
export function dateSpan(values) {
	const list = Array.from(values ?? []).filter((v) => Number.isFinite(v));
	if (list.length === 0) return null;
	let min = Infinity;
	let max = -Infinity;
	/** @type {Map<number, number>} */
	const tally = new Map();
	for (const v of list) {
		if (v < min) min = v;
		if (v > max) max = v;
		tally.set(v, (tally.get(v) ?? 0) + 1);
	}
	let tied = 0;
	for (const n of tally.values()) if (n > tied) tied = n;
	return { min, max, span: max - min, unique: tally.size, tied, finite: list.length };
}

/**
 * The dates in a given taxon order, `NaN` where undated — the shape every pillar wants and the one
 * `run_ols_dating` (dating.py:1170) consumes.
 *
 * @param {DateIngest} ingest
 * @param {readonly string[]} [taxa] defaults to the ingest's own row order
 * @returns {Float64Array}
 */
export function datesVector(ingest, taxa) {
	const order = taxa ? Array.from(taxa) : ingest.rows.map((r) => r.taxon);
	const byTaxon = new Map(ingest.rows.map((r) => [r.taxon, r.value]));
	const out = new Float64Array(order.length);
	for (let i = 0; i < order.length; i++) {
		const v = byTaxon.get(order[i]);
		out[i] = v === undefined ? NaN : v;
	}
	return out;
}

// =================================================================================================
// The dispatcher
// =================================================================================================

/**
 * @typedef {{taxon: string, raw: string|null, value: number, rule: string, source: string,
 *   imputed: boolean, imputations: {month: boolean, day: boolean, dayClamped: boolean},
 *   matched: string|null, matched_name: string|null, match_tier: string|null,
 *   used: boolean|undefined}} DateRow
 */

/**
 * @typedef {{schema_version: number, ok: boolean, time_units: string,
 *   time_units_source: 'supplied'|'inferred', time_units_evidence: object,
 *   source: string, sources_used: string[], source_name: string|null, source_kind: string|null,
 *   coverage: object, rows: DateRow[], unmatched_metadata: object, unmatched_taxa: object,
 *   match_tier: string|null, match_tiers: Record<string, number>, ambiguous: object[],
 *   span: object|null, table: object|null, auspice: object|null, regex: object|null,
 *   headers: object|null, warnings: Array<{code: string, severity: string, message: string,
 *   data: object}>}} DateIngest
 */

/**
 * Date every taxon of an alignment, from whichever sources were supplied, and say how.
 *
 * @param {{
 *   taxa: readonly string[],
 *   headerOf?: Map<string,string>|Record<string,string>|null,
 *   source?: string|object|null,
 *   sourceName?: string,
 *   sourceKind?: 'auspice'|'json-map'|'table'|'beast'|'map'|'auto',
 *   timeUnits?: string|null,
 *   strainCol?: string|null,
 *   dateCol?: string|null,
 *   delimiter?: string|null,
 *   dateRegex?: string|null,
 *   regexFlags?: string,
 *   archival1959?: boolean,
 *   headerFallback?: boolean,
 *   sampleNames?: number
 * }} args
 * @returns {DateIngest}
 */
export function ingestDates(args = {}) {
	if (!hasDateLayer()) {
		throw new Error(
			`@veg/hyphaeon-js does not export ${missingDateExports().join(', ')}: the linked engine ` +
				`predates js/src/dates.js (feat/date-parsers).`
		);
	}

	const taxa = Array.from(args.taxa ?? []);
	const cap = args.sampleNames ?? DATE_THRESHOLDS.sampleNames;
	const headerFallback = args.headerFallback !== false;
	const archival1959 = args.archival1959 === true;
	const sourceName = args.sourceName ?? null;
	/** The string a NAME rule reads: the full header when the caller supplied one, else the key. */
	const headerMap = toMap(args.headerOf);
	const headerFor = (taxon) => {
		const h = headerMap?.get(taxon);
		return typeof h === 'string' && h !== '' ? h : taxon;
	};
	const headerNames = taxa.map(headerFor);

	/** @type {Array<{code: string, severity: string, message: string, data: object}>} */
	const warnings = [];
	/** @type {Map<string, {parse: any, raw: string|null, source: string, matchedName: string|null, tier: string|null}>} */
	const resolved = new Map();
	/** @type {string[]} */
	const sourcesUsed = [];

	// --- 1. read the supplied source ------------------------------------------------------------
	const supplied = args.source ?? null;
	let sourceKind = args.sourceKind && args.sourceKind !== 'auto' ? args.sourceKind : null;
	/** @type {Map<string, any>|null} */
	let sourceDates = null;
	/** @type {Map<string, string>|null} */
	let sourceRaws = null;
	/** Every name the source offered, dated or NOT: an undated row reads its reason from here. */
	/** @type {Map<string, any>} */
	let sourceParses = new Map();
	let tableBlock = null;
	let auspiceBlock = null;
	let sourceFatal = false;

	// The units must be known before a table cell or an Auspice attribute is parsed, and the
	// evidence for them lives in the source. So the source is read TWICE when the units are being
	// inferred: once to get the raw strings and the column name, then for real. Both passes are
	// string work over text already in memory — microseconds at surveillance size — and the
	// alternative is a units decision made after the parse it changes.
	let timeUnits = args.timeUnits ?? null;
	let timeUnitsSource = /** @type {'supplied'|'inferred'} */ (timeUnits ? 'supplied' : 'inferred');
	let timeUnitsEvidence = { reason: 'supplied' };

	if (supplied !== null && supplied !== undefined && supplied !== '') {
		if (typeof supplied === 'string') {
			sourceKind = sourceKind ?? detectDateSourceKind(supplied, sourceName ?? '');
		} else if (supplied instanceof Map || typeof supplied === 'object') {
			sourceKind = sourceKind ?? (isAuspiceJson(supplied) ? 'auspice' : 'map');
		}

		if (sourceKind === 'beast') {
			warnings.push(
				warn('DATES_BEAST_XML_UNSUPPORTED', 'refuse', DATE_MESSAGES.BEAST_XML_UNSUPPORTED, {
					file: sourceName
				})
			);
			sourceFatal = true;
		} else if (sourceKind === 'unknown') {
			warnings.push(
				warn(
					'DATES_SOURCE_KIND_UNKNOWN',
					'refuse',
					fillMessage(DATE_MESSAGES.SOURCE_KIND_UNKNOWN, { file: sourceName ?? 'The metadata file' }),
					{ file: sourceName, head: String(supplied).slice(0, 200) }
				)
			);
			sourceFatal = true;
		} else if (sourceKind === 'table') {
			try {
				if (timeUnits === null) {
					const probe = readDateTable(supplied, {
						fileName: sourceName ?? '',
						delimiter: args.delimiter ?? null,
						strainCol: args.strainCol ?? null,
						dateCol: args.dateCol ?? null,
						timeUnits: CALENDAR_TIME_UNITS
					});
					const inferred = inferTimeUnits(probe.rawValues, {
						taxa: headerNames,
						dateColumn: probe.date.column
					});
					timeUnits = inferred.timeUnits;
					timeUnitsEvidence = inferred.evidence;
				}
				const read = readDateTable(supplied, {
					fileName: sourceName ?? '',
					delimiter: args.delimiter ?? null,
					strainCol: args.strainCol ?? null,
					dateCol: args.dateCol ?? null,
					timeUnits
				});
				tableBlock = read;
				if (read.date.column === null) {
					warnings.push(
						warn(
							'DATES_TABLE_NO_DATE_COLUMN',
							'refuse',
							fillMessage(DATE_MESSAGES.TABLE_NO_DATE_COLUMN, {
								file: sourceName ?? 'the metadata file',
								columns: read.columns.join(', ') || '(none)',
								candidates: ALL_DATE_COLUMN_CANDIDATES.join(', ')
							}),
							{ columns: read.columns, candidates: ALL_DATE_COLUMN_CANDIDATES }
						)
					);
					sourceFatal = true;
				} else {
					const map = tableDateMap(read);
					sourceDates = map.dates;
					sourceRaws = map.raws;
					sourceParses = map.parses;
				}
			} catch (err) {
				warnings.push(
					warn(
						'DATES_SOURCE_UNREADABLE',
						'refuse',
						fillMessage(DATE_MESSAGES.SOURCE_UNREADABLE, {
							file: sourceName ?? 'The metadata file',
							kind: 'a delimited table',
							error: err?.message ?? String(err)
						}),
						{ file: sourceName, error: err?.message ?? String(err) }
					)
				);
				sourceFatal = true;
			}
		} else if (sourceKind === 'auspice') {
			try {
				const json = typeof supplied === 'string' ? JSON.parse(supplied) : supplied;
				if (timeUnits === null) {
					const probe = walkAuspiceDates(json, { timeUnits: CALENDAR_TIME_UNITS });
					const inferred = inferTimeUnits(Array.from(probe.raws.values()), { taxa: headerNames });
					timeUnits = inferred.timeUnits;
					timeUnitsEvidence = inferred.evidence;
				}
				const walk = walkAuspiceDates(json, { timeUnits });
				auspiceBlock = walk;
				sourceDates = walk.dates;
				sourceRaws = walk.raws;
				if (walk.tips === 0 || (walk.tips > 0 && walk.tips === walk.nameless)) {
					warnings.push(
						warn(
							'DATES_AUSPICE_NO_TIPS',
							'refuse',
							fillMessage(DATE_MESSAGES.AUSPICE_NO_TIPS, { file: sourceName ?? 'The file' }),
							{ root_key: walk.rootKey, tips: walk.tips, nameless: walk.nameless }
						)
					);
					sourceFatal = true;
				}
			} catch (err) {
				warnings.push(
					warn(
						'DATES_SOURCE_UNREADABLE',
						'refuse',
						fillMessage(DATE_MESSAGES.SOURCE_UNREADABLE, {
							file: sourceName ?? 'The file',
							kind: 'a Nextstrain Auspice JSON',
							error: err?.message ?? String(err)
						}),
						{ file: sourceName, error: err?.message ?? String(err) }
					)
				);
				sourceFatal = true;
			}
		} else if (sourceKind === 'json-map' || sourceKind === 'map') {
			try {
				const obj =
					typeof supplied === 'string'
						? JSON.parse(supplied)
						: supplied instanceof Map
							? Object.fromEntries(supplied)
							: supplied;
				if (timeUnits === null) {
					const inferred = inferTimeUnits(Object.values(obj ?? {}), { taxa: headerNames });
					timeUnits = inferred.timeUnits;
					timeUnitsEvidence = inferred.evidence;
				}
				const read = readJsonDateMap(obj, { timeUnits }, parseFlexibleDate);
				sourceDates = read.dates;
				sourceRaws = read.raws;
			} catch (err) {
				warnings.push(
					warn(
						'DATES_SOURCE_UNREADABLE',
						'refuse',
						fillMessage(DATE_MESSAGES.SOURCE_UNREADABLE, {
							file: sourceName ?? 'The file',
							kind: 'a name-to-date map',
							error: err?.message ?? String(err)
						}),
						{ file: sourceName, error: err?.message ?? String(err) }
					)
				);
				sourceFatal = true;
			}
		}
	}

	// No source, or a source that could not be read: the units are still decided, from the headers.
	if (timeUnits === null) {
		const inferred = inferTimeUnits([], { taxa: headerNames, path: 'name' });
		timeUnits = inferred.timeUnits;
		timeUnitsEvidence = inferred.evidence;
	}

	const sourceLabel =
		sourceKind === 'table' ? 'table' : sourceKind === 'auspice' ? 'auspice' : sourceKind ? 'map' : null;

	// --- 2. match the source's names to the alignment's taxa ------------------------------------
	// The match runs over every name the source OFFERED, not only the ones it dated: a taxon whose
	// row exists but whose cell was unreadable is a MATCHED taxon with an undated cell, and saying
	// "not in the table" about it would send the reader looking for the wrong problem.
	const sourceNames =
		sourceParses.size > 0
			? Array.from(sourceParses.keys())
			: Array.from(sourceDates?.keys() ?? []);
	const match = matchDateNames(sourceNames, taxa);
	if (sourceDates && sourceNames.length > 0) {
		for (const taxon of taxa) {
			const hit = match.assignments.get(taxon);
			if (!hit) continue;
			const parse = sourceDates.get(hit.name);
			if (!isDated(parse)) continue;
			resolved.set(taxon, {
				parse,
				raw: sourceRaws?.get(hit.name) ?? null,
				source: sourceLabel ?? 'table',
				matchedName: hit.name,
				tier: hit.tier
			});
		}
		if (resolved.size > 0 && sourceLabel) sourcesUsed.push(sourceLabel);
	}

	// --- 3. the custom pattern, per still-undated taxon (dating.py:474-479) ----------------------
	let regexBlock = null;
	if (args.dateRegex) {
		const compiled = compileDateRegex(args.dateRegex, { flags: args.regexFlags ?? '' });
		regexBlock = {
			pattern: compiled.pattern,
			flags: compiled.flags,
			valid: compiled.valid,
			groups: compiled.groups,
			error: compiled.error,
			matched: 0,
			dated: 0,
			stopped: false
		};
		if (!compiled.valid) {
			warnings.push(
				warn(compiled.code ?? 'DATE_REGEX_INVALID', 'refuse', compiled.error ?? DATE_MESSAGES.REGEX_INVALID, {
					pattern: compiled.pattern
				})
			);
		} else {
			const pending = taxa.filter((t) => !resolved.has(t));
			const sweep = applyDateRegexAll(pending.map(headerFor), compiled, { timeUnits });
			regexBlock.matched = sweep.matched;
			regexBlock.stopped = sweep.stopped;
			for (const taxon of pending) {
				const parse = sweep.dates.get(headerFor(taxon));
				if (!isDated(parse)) continue;
				resolved.set(taxon, {
					parse,
					raw: sweep.raws.get(headerFor(taxon)) ?? null,
					source: 'regex',
					matchedName: null,
					tier: null
				});
				regexBlock.dated++;
			}
			if (regexBlock.dated > 0) sourcesUsed.push('regex');
			if (sweep.matched === 0) {
				warnings.push(
					warn('DATE_REGEX_NO_MATCH', 'warn', 'The pattern matched no sequence name.', {
						pattern: compiled.pattern,
						scanned: sweep.scanned
					})
				);
			}
			if (sweep.stopped) {
				warnings.push(
					warn(
						'DATE_REGEX_NO_MATCH',
						'warn',
						'The pattern was still running after its time budget and the sweep was stopped; ' +
							'the names it had not reached are undated.',
						{ pattern: compiled.pattern, scanned: sweep.scanned, of: pending.length }
					)
				);
			}
		}
	}

	// --- 4. the header fallback, per still-undated taxon (dating.py:481-483) ---------------------
	let headerBlock = null;
	const pendingBeforeHeaders = taxa.filter((t) => !resolved.has(t));
	const anchorCandidates = archival1959Candidates(headerNames);
	/** Every header attempt, dated or not — the row loop reads the FAILED ones for their reason. */
	let headerParses = new Map();
	if (headerFallback) {
		const read = datesFromHeaders(pendingBeforeHeaders.map(headerFor), { timeUnits, archival1959 });
		headerParses = read.parses;
		headerBlock = {
			attempted: read.attempted,
			dated: read.dated,
			rules: read.rules,
			parser: read.parser,
			archival_1959_candidates: anchorCandidates
		};
		for (const taxon of pendingBeforeHeaders) {
			const parse = read.dates.get(headerFor(taxon));
			if (!isDated(parse)) continue;
			resolved.set(taxon, {
				parse,
				raw: headerFor(taxon),
				source: 'header',
				matchedName: null,
				tier: null
			});
		}
		if (read.dated > 0) sourcesUsed.push('header');
	} else {
		headerBlock = {
			attempted: 0,
			dated: 0,
			rules: {},
			parser: 'none',
			archival_1959_candidates: anchorCandidates
		};
	}

	// --- 5. the rows: one per taxon, ALWAYS, including the undated -------------------------------
	/** @type {DateRow[]} */
	const rows = [];
	const coverage = {
		taxa_total: taxa.length,
		dated: 0,
		undated: 0,
		coverage: 0,
		from_map: 0,
		from_auspice: 0,
		from_table: 0,
		from_regex: 0,
		from_header: 0,
		imputed: 0,
		day_clamped: 0,
		out_of_range: 0,
		archival_1959: 0
	};
	/** @type {Record<string, number>} */
	const byRule = {};

	for (const taxon of taxa) {
		const hit = resolved.get(taxon);
		const assigned = match.assignments.get(taxon) ?? null;
		if (!hit) {
			// An undated taxon still gets a row, and still records WHY it has no date: `out_of_range`
			// (the value read fine and the [1800, 2100] gate rejected it) is a different story from
			// `unparsed` or `none`, and the reference cannot tell them apart at all.
			// WHY THIS TAXON HAS NO DATE, in the reference's own vocabulary. `out_of_range` (a number
			// was read and the [1800, 2100] gate rejected it, temporal.py:106) is a different story
			// from `unparsed` (no rule claimed the string) and from `none` (there was no string at
			// all) — and the reference cannot tell the three apart, because all of them are NaN.
			// The value the taxon WOULD have had is asked for in source order, so the reason names
			// the last place a date was actually looked for.
			const sourceParse = assigned
				? (sourceParses.get(assigned.name) ?? sourceDates?.get(assigned.name) ?? null)
				: null;
			const headerParse = headerParses.get(headerFor(taxon)) ?? null;
			const reason =
				(sourceParse && sourceParse.rule !== 'none' ? sourceParse.rule : null) ??
				(headerParse && headerParse.rule !== 'none' ? headerParse.rule : null) ??
				emptyParse(timeUnits).rule;
			rows.push({
				taxon,
				raw: assigned ? (sourceRaws?.get(assigned.name) ?? null) : null,
				value: NaN,
				rule: reason,
				source: 'none',
				imputed: false,
				imputations: { month: false, day: false, dayClamped: false },
				matched: null,
				matched_name: assigned ? assigned.name : null,
				match_tier: assigned ? assigned.tier : null,
				used: undefined
			});
			coverage.undated++;
			byRule[reason] = (byRule[reason] ?? 0) + 1;
			if (reason === 'out_of_range') coverage.out_of_range++;
			continue;
		}

		const p = hit.parse;
		rows.push({
			taxon,
			raw: hit.raw,
			value: p.value,
			rule: p.rule,
			source: hit.source,
			imputed: Boolean(p.imputed),
			imputations: {
				month: Boolean(p.imputations?.month),
				day: Boolean(p.imputations?.day),
				dayClamped: Boolean(p.imputations?.dayClamped)
			},
			matched: p.matched ?? null,
			matched_name: hit.matchedName,
			match_tier: hit.tier,
			used: undefined
		});
		coverage.dated++;
		byRule[p.rule] = (byRule[p.rule] ?? 0) + 1;
		if (p.imputed) coverage.imputed++;
		if (p.imputations?.dayClamped) coverage.day_clamped++;
		if (p.rule === 'archival_1959') coverage.archival_1959++;
		if (hit.source === 'table') coverage.from_table++;
		else if (hit.source === 'auspice') coverage.from_auspice++;
		else if (hit.source === 'map') coverage.from_map++;
		else if (hit.source === 'regex') coverage.from_regex++;
		else if (hit.source === 'header') coverage.from_header++;
	}
	coverage.coverage = taxa.length > 0 ? coverage.dated / taxa.length : 0;

	const span = dateSpan(rows.map((r) => r.value));
	const dominant =
		[
			['table', coverage.from_table],
			['auspice', coverage.from_auspice],
			['map', coverage.from_map],
			['header', coverage.from_header],
			['regex', coverage.from_regex]
		].sort((a, b) => b[1] - a[1])[0] ?? null;

	// --- 6. the warnings ------------------------------------------------------------------------
	if (tableBlock) {
		if (tableBlock.delimiter.source === 'sniffed') {
			warnings.push(
				warn(
					'DATES_DELIMITER_GUESSED',
					'info',
					`The column separator was read from the file's own content as ` +
						`${describeDelimiter(tableBlock.delimiter.delimiter)} ` +
						`(${Math.round(tableBlock.delimiter.confidence * 100)} % of the lines read agree).`,
					{
						delimiter: tableBlock.delimiter.delimiter,
						confidence: tableBlock.delimiter.confidence,
						extension_hint: tableBlock.delimiter.extensionHint,
						agrees_with_extension: tableBlock.delimiter.agrees
					}
				)
			);
		}
		if (tableBlock.strain.guessed || tableBlock.date.guessed) {
			const guessed = [];
			if (tableBlock.strain.guessed) guessed.push(`identifier: '${tableBlock.strain.column}' (${tableBlock.strain.source})`);
			if (tableBlock.date.guessed) guessed.push(`date: '${tableBlock.date.column}' (${tableBlock.date.source})`);
			warnings.push(
				warn(
					'DATES_TABLE_COLUMN_GUESSED',
					'warn',
					`No column name matched, so a column was guessed — ${guessed.join('; ')}. ` +
						`Name the column explicitly if that is wrong: a wrong guess dates the whole dataset ` +
						`from the wrong column without failing.`,
					{
						strain: tableBlock.strain,
						date: tableBlock.date,
						columns: tableBlock.columns
					}
				)
			);
		}
		if (tableBlock.duplicates.length > 0) {
			const conflicting = tableBlock.duplicates.filter((d) => d.conflicting);
			warnings.push(
				warn(
					'DATES_DUPLICATE_METADATA',
					conflicting.length > 0 ? 'warn' : 'info',
					conflicting.length > 0
						? `${conflicting.length} name(s) appear more than once in the table with DIFFERENT dates; ` +
							`the last row won, as the reference's own dict assignment does.`
						: `${tableBlock.duplicates.length} name(s) appear more than once in the table with the ` +
							`same date.`,
					{ duplicates: tableBlock.duplicates.slice(0, cap), total: tableBlock.duplicates.length }
				)
			);
		}
	}

	if (auspiceBlock) {
		const fromName = auspiceBlock.attrUsed.tip_name;
		if (fromName > 0 && fromName >= auspiceBlock.dated / 2) {
			warnings.push(
				warn(
					'DATES_AUSPICE_TIP_NAME_FALLBACK',
					'warn',
					`${fromName} of ${auspiceBlock.dated} dated tips were dated from the TIP NAME rather than ` +
						`from a \`node_attrs\` date. A build whose \`num_date\` never loaded reads exactly like ` +
						`this, and the numbers are then the parser's, not the build's.`,
					{ attr_used: auspiceBlock.attrUsed, tips: auspiceBlock.tips, dated: auspiceBlock.dated }
				)
			);
		}
	}

	if (sourceDates && sourceNames.length > 0) {
		const matchedCount = Array.from(match.assignments.keys()).length;
		if (matchedCount === 0) {
			const rescued = headerFallback && coverage.dated >= DATE_THRESHOLDS.minDatedTaxa;
			const parts = [
				fillMessage(DATE_MESSAGES.TABLE_NO_MATCH, {
					n: sourceNames.length,
					metadata: nameSample(sourceNames, cap),
					alignment: nameSample(taxa, cap)
				})
			];
			if (tableBlock && tableBlock.numericNames > 0) {
				parts.push(
					fillMessage(DATE_MESSAGES.TABLE_NUMERIC_NAMES, {
						k: tableBlock.numericNames,
						column: tableBlock.strain.column
					})
				);
			}
			if (rescued) {
				parts.push(
					`The dates shown came from the sequence names instead; the metadata file contributed nothing.`
				);
			}
			warnings.push(
				warn('DATES_TABLE_NO_MATCH', rescued ? 'warn' : 'refuse', parts.join(' '), {
					metadata_names: sourceNames.slice(0, cap),
					taxa: taxa.slice(0, cap),
					metadata_total: sourceNames.length,
					numeric_names: tableBlock?.numericNames ?? 0,
					tiers_tried: Object.keys(match.tiers),
					rescued_by_headers: rescued
				})
			);
		} else if (match.unmatchedMetadata.length > 0) {
			warnings.push(
				warn(
					'DATES_UNMATCHED_METADATA',
					'warn',
					`${match.unmatchedMetadata.length} of ${sourceNames.length} names in the metadata source ` +
						`name no sequence in this alignment, so they contributed nothing.`,
					nameBlock(match.unmatchedMetadata, cap)
				)
			);
		}

		if (usedFuzzyTier(match)) {
			warnings.push(
				warn(
					'DATES_FUZZY_MATCH',
					'warn',
					`Not every metadata name matched its sequence exactly; ${describeTiers(match.tiers)}. ` +
						`Each row says which tier matched it, so the inference can be checked rather than trusted.`,
					{ tiers: match.tiers, weakest: match.tier, examples: match.examples.slice(0, cap) }
				)
			);
		}
		if (match.ambiguous.length > 0) {
			warnings.push(
				warn(
					'DATES_AMBIGUOUS_MATCH',
					'warn',
					`${match.ambiguous.length} name(s) could have been matched to more than one sequence, or ` +
						`more than one name claimed the same sequence. None of them was used: guessing here ` +
						`dates a sequence from its neighbour's record.`,
					{ ambiguous: match.ambiguous.slice(0, cap), total: match.ambiguous.length }
				)
			);
		}
	}

	if (coverage.from_header > 0 && sourceDates && sourceNames.length > 0) {
		warnings.push(
			warn(
				'DATES_HEADER_FALLBACK',
				'info',
				`${coverage.from_header} sequence(s) the metadata source did not date were dated from their ` +
					`own names instead. \`hyphaeon meme --temporal\` would have left them undated and dropped ` +
					`them: temporal.py:323 runs the header fallback only when the table produced nothing at all.`,
				{ count: coverage.from_header, rules: headerBlock?.rules ?? {} }
			)
		);
	}

	if (coverage.dated > 0 && coverage.coverage < DATE_THRESHOLDS.lowCoverageFraction) {
		warnings.push(
			warn(
				'DATES_PARTIAL_COVERAGE',
				'warn',
				`${coverage.dated} of ${coverage.taxa_total} sequences carry a date. The other ` +
					`${coverage.undated} will be dropped by any time-aware analysis; they are listed here ` +
					`because the reference drops them without saying so.`,
				nameBlock(
					rows.filter((r) => !Number.isFinite(r.value)).map((r) => r.taxon),
					cap
				)
			)
		);
	}

	if (coverage.imputed > 0) {
		warnings.push(
			warn(
				'DATES_IMPUTED',
				'warn',
				`${coverage.imputed} date(s) are partly invented: a missing month becomes June and a ` +
					`missing day the 15th (temporal.py:132-142), and a two-digit LANL year gains a flat +0.5. ` +
					`Each such row names which component was imputed.`,
				{
					count: coverage.imputed,
					examples: rows
						.filter((r) => r.imputed)
						.slice(0, cap)
						.map((r) => ({ taxon: r.taxon, raw: r.raw, value: r.value, rule: r.rule, imputations: r.imputations }))
				}
			)
		);
	}

	if (coverage.day_clamped > 0) {
		warnings.push(
			warn(
				'DATES_DAY_CLAMPED',
				'info',
				`${coverage.day_clamped} date(s) had the day moved back: temporal.py:144 clamps every month ` +
					`to 30 days and February to 28, so 31 January is read as 30 January and 29 February is ` +
					`unreachable.`,
				{
					count: coverage.day_clamped,
					examples: rows
						.filter((r) => r.imputations.dayClamped)
						.slice(0, cap)
						.map((r) => ({ taxon: r.taxon, raw: r.raw, value: r.value }))
				}
			)
		);
	}

	if (coverage.out_of_range > 0) {
		warnings.push(
			warn(
				'DATES_OUT_OF_RANGE',
				'warn',
				`${coverage.out_of_range} value(s) parsed as a number and were then rejected because they ` +
					`fall outside ${CALENDAR_YEAR_MIN}–${CALENDAR_YEAR_MAX} (temporal.py:106). The reference ` +
					`cannot tell these apart from a string it could not read at all.`,
				{
					count: coverage.out_of_range,
					examples: rows
						.filter((r) => r.rule === 'out_of_range')
						.slice(0, cap)
						.map((r) => ({ taxon: r.taxon, raw: r.raw }))
				}
			)
		);
	}

	if (timeUnitsSource === 'inferred') {
		warnings.push(
			warn(
				'DATES_UNITS_INFERRED',
				'warn',
				`The time axis was inferred as '${timeUnits}'; it was not supplied. The same string reads as ` +
					`a different number on a calendar axis and on a generations axis, so this decision changes ` +
					`the answer rather than its label.`,
				timeUnitsEvidence
			)
		);
	}

	const finite = rows.map((r) => r.value).filter((v) => Number.isFinite(v) && v !== 0).map(Math.abs);
	if (finite.length > 1) {
		const lo = Math.min(...finite);
		const hi = Math.max(...finite);
		if (lo > 0 && hi / lo > DATE_THRESHOLDS.mixedScaleRatio) {
			warnings.push(
				warn(
					'DATES_MIXED_SCALE',
					'warn',
					`The dated values span ${lo} to ${hi}, a ratio of more than ` +
						`${DATE_THRESHOLDS.mixedScaleRatio}. That is usually two different time axes in one ` +
						`column — a decimal year beside an elapsed count, which nothing downstream tells apart ` +
						`(dating.py:355-360 returns weeks and days onto the same axis a year is on).`,
					{ min: lo, max: hi, ratio: hi / lo }
				)
			);
		}
	}

	if (anchorCandidates.length > 0) {
		const changes = archival1959Changes(headerNames, { timeUnits });
		if (!archival1959) {
			warnings.push(
				warn(
					'DATES_ARCHIVAL_1959_AVAILABLE',
					'info',
					`${anchorCandidates.length} sequence name(s) contain 'Z59', 'ZR59' or '1959'. ` +
						`\`hyphaeon dating\` dates every one of them to exactly 1959.5 before trying any pattern ` +
						`(dating.py:330-332). That rule is OFF here. Turning it on would change ` +
						`${changes.length} of them.`,
					{ candidates: anchorCandidates.slice(0, cap), total: anchorCandidates.length, changes: changes.slice(0, cap) }
				)
			);
		} else {
			warnings.push(
				warn(
					'DATES_ARCHIVAL_1959_APPLIED',
					'warn',
					`The archival 1959 anchor is ON: ${anchorCandidates.length} name(s) matching 'Z59', ` +
						`'ZR59' or '1959' are dated to 1959.5 whatever else their name says. It is an unbounded ` +
						`substring test, so a strain number that happens to read 1959 is caught too.`,
					{ candidates: anchorCandidates.slice(0, cap), total: anchorCandidates.length, changes: changes.slice(0, cap) }
				)
			);
		}
	}

	if (span && coverage.dated > 0 && span.tied > coverage.dated * DATE_THRESHOLDS.tiedFraction && span.unique > 1) {
		warnings.push(
			warn(
				'DATES_TIED',
				'info',
				`${span.tied} of ${coverage.dated} dated sequences carry the same value. A set with one dominant ` +
					`date carries far less temporal information than its count suggests.`,
				{ tied: span.tied, dated: coverage.dated, unique: span.unique }
			)
		);
	}

	if (
		span &&
		span.unique > 1 &&
		timeUnits === CALENDAR_TIME_UNITS &&
		span.span < DATE_THRESHOLDS.shortSpanYears
	) {
		warnings.push(
			warn(
				'DATES_SPAN_SHORT',
				'warn',
				`The sampling dates span ${span.span.toFixed(4)} years. A clock is a slope against time, and ` +
					`over a span this short it will be poorly determined — which is a result, not an input error.`,
				{ span: span.span, min: span.min, max: span.max }
			)
		);
	}

	// --- 7. the four arithmetic refusals --------------------------------------------------------
	if (coverage.dated === 0) {
		warnings.push(
			warn('DATES_NONE', 'refuse', DATE_MESSAGES.NONE, {
				sources_tried: sourcesTried(sourceKind, Boolean(args.dateRegex), headerFallback),
				taxa_total: coverage.taxa_total
			})
		);
	} else if (coverage.dated < DATE_THRESHOLDS.minDatedTaxa) {
		warnings.push(
			warn(
				'DATES_TOO_FEW',
				'refuse',
				fillMessage(DATE_MESSAGES.TOO_FEW, {
					dated: coverage.dated,
					min: DATE_THRESHOLDS.minDatedTaxa
				}),
				{ dated: coverage.dated, min: DATE_THRESHOLDS.minDatedTaxa }
			)
		);
	} else if (span && (span.unique < 2 || span.span === 0)) {
		warnings.push(
			warn('DATES_NO_SPAN', 'refuse', fillMessage(DATE_MESSAGES.NO_SPAN, { value: span.min }), {
				value: span.min,
				dated: coverage.dated
			})
		);
	}

	const sorted = sortWarnings(warnings);
	return {
		schema_version: DATE_SCHEMA_VERSION,
		ok: !sorted.some((w) => w.severity === 'refuse'),
		time_units: timeUnits,
		time_units_source: timeUnitsSource,
		time_units_evidence: timeUnitsEvidence,
		source: coverage.dated > 0 && dominant && dominant[1] > 0 ? dominant[0] : 'none',
		sources_used: sourcesUsed,
		source_name: sourceName,
		source_kind: sourceKind,
		coverage,
		by_rule: byRule,
		rows,
		unmatched_metadata: nameBlock(sourceNames.length > 0 ? match.unmatchedMetadata : [], cap),
		unmatched_taxa: nameBlock(
			rows.filter((r) => !Number.isFinite(r.value)).map((r) => r.taxon),
			cap
		),
		match_tier: match.tier,
		match_tiers: match.tiers,
		ambiguous: match.ambiguous,
		span,
		table: tableBlock ? tableSummary(tableBlock) : null,
		auspice: auspiceBlock ? auspiceSummary(auspiceBlock) : null,
		regex: regexBlock,
		headers: headerBlock,
		warnings: sorted
	};
}

/** Which sources a run actually tried, for `DATES_NONE`'s data. */
function sourcesTried(sourceKind, hasRegex, headerFallback) {
	const tried = [];
	if (sourceKind) tried.push(sourceKind);
	if (hasRegex) tried.push('regex');
	if (headerFallback) tried.push('header');
	return tried;
}

/** `'\t'` is not a readable word in a sentence. */
function describeDelimiter(sep) {
	if (sep === '\t') return 'a tab';
	if (sep === ',') return 'a comma';
	if (sep === ';') return 'a semicolon';
	if (sep === '|') return 'a pipe';
	if (sep === ' ') return 'a space';
	return `'${sep}'`;
}

/** `"14 matched exactly, 3 by case"` for the fuzzy-match warning. */
function describeTiers(tiers) {
	const parts = [];
	for (const [tier, n] of Object.entries(tiers ?? {})) {
		if (n > 0) parts.push(`${n} at '${tier}'`);
	}
	return parts.join(', ');
}

/** The record-shaped, structured-clonable half of a table read (no `DateParse` objects). */
function tableSummary(read) {
	return {
		delimiter: read.delimiter.delimiter,
		delimiter_source: read.delimiter.source,
		delimiter_confidence: read.delimiter.confidence,
		delimiter_extension_hint: read.delimiter.extensionHint,
		columns: read.columns,
		strain_col: read.strain.column,
		strain_col_source: read.strain.source,
		strain_col_alternatives: read.strain.alternatives,
		date_col: read.date.column,
		date_col_source: read.date.source,
		date_col_alternatives: read.date.alternatives,
		rows_read: read.rowsRead,
		rows_dated: read.rowsDated,
		duplicates: read.duplicates,
		numeric_names: read.numericNames
	};
}

/** Likewise for the Auspice walk. */
function auspiceSummary(walk) {
	return {
		tips: walk.tips,
		dated: walk.dated,
		attr_used: walk.attrUsed,
		nameless: walk.nameless,
		duplicates: walk.duplicates,
		root_key: walk.rootKey
	};
}

// =================================================================================================
// The seam with prepareRun
// =================================================================================================

/**
 * Reconcile a `DateIngest` with a completed `prepareRun()`: which dated taxa the taxon cap, the
 * haplotype collapse or the tree pruning removed, what the span is over the taxa the MODEL actually
 * saw, and whether the survivors still clear the refusals.
 *
 * READ-ONLY. It reads `prep.loaded.taxa` and `prep.preprocessing.dropped_taxa` and returns a new
 * object; it never mutates `prep`, and `pipeline.js` is not edited by this phase. `DATES_DROPPED_BY_CAP`
 * lives here because only here is it known that the 256-taxon cap ate the first six months of the
 * epidemic — the ingest alone cannot know, and `prepareRun` alone does not know the dates.
 *
 * @param {DateIngest} ingest
 * @param {{loaded?: {taxa?: readonly string[]}, preprocessing?: object}} prep
 * @returns {{vector: Float64Array, taxa: string[], kept: number, dropped_dated: string[],
 *   span: object|null, ok: boolean, warnings: Array<object>}}
 */
export function alignDatesToRun(ingest, prep) {
	const kept = Array.from(prep?.loaded?.taxa ?? []);
	const keptSet = new Set(kept);
	const vector = datesVector(ingest, kept);
	const droppedDated = ingest.rows
		.filter((r) => Number.isFinite(r.value) && !keptSet.has(r.taxon))
		.map((r) => r.taxon);
	const span = dateSpan(vector);
	const datedKept = Array.from(vector).filter((v) => Number.isFinite(v)).length;

	/** @type {Array<object>} */
	const warnings = [];
	if (droppedDated.length > 0) {
		const before = ingest.span;
		warnings.push(
			warn(
				'DATES_DROPPED_BY_CAP',
				'warn',
				`${droppedDated.length} dated sequence(s) were removed before the model ran — by the taxon ` +
					`cap, the duplicate collapse or the tree pruning — so they are not on the time axis the ` +
					`analysis sees. The span went from ` +
					`${before ? `${before.min} – ${before.max}` : 'nothing'} to ` +
					`${span ? `${span.min} – ${span.max}` : 'nothing'}.`,
				{
					dropped: droppedDated.slice(0, DATE_THRESHOLDS.sampleNames),
					dropped_total: droppedDated.length,
					span_before: before,
					span_after: span,
					taxon_cap: prep?.preprocessing?.taxon_cap ?? null
				}
			)
		);
	}
	if (datedKept === 0) {
		warnings.push(warn('DATES_NONE', 'refuse', DATE_MESSAGES.NONE, { after_prepare: true }));
	} else if (datedKept < DATE_THRESHOLDS.minDatedTaxa) {
		warnings.push(
			warn(
				'DATES_TOO_FEW',
				'refuse',
				fillMessage(DATE_MESSAGES.TOO_FEW, { dated: datedKept, min: DATE_THRESHOLDS.minDatedTaxa }),
				{ dated: datedKept, min: DATE_THRESHOLDS.minDatedTaxa, after_prepare: true }
			)
		);
	} else if (span && (span.unique < 2 || span.span === 0)) {
		warnings.push(
			warn('DATES_NO_SPAN', 'refuse', fillMessage(DATE_MESSAGES.NO_SPAN, { value: span.min }), {
				value: span.min,
				after_prepare: true
			})
		);
	}

	return {
		vector,
		taxa: kept,
		kept: datedKept,
		dropped_dated: droppedDated,
		span,
		ok: ingest.ok && !warnings.some((w) => w.severity === 'refuse'),
		warnings: sortWarnings(warnings)
	};
}

/**
 * The `dates` block a `/time` record carries beside `preprocessing`, in `preprocessing`'s own
 * snake_case so the provenance panel renders it with the machinery it already has.
 *
 * It is a SIBLING key on the record, not a new key inside `preprocessing`: that keeps every
 * existing record shape, every existing test and every existing download byte-identical, which is
 * the whole reason `pipeline.js` is untouched by this phase.
 *
 * @param {DateIngest} ingest
 * @param {ReturnType<typeof alignDatesToRun>|null} [aligned]
 * @returns {object}
 */
export function datesPreprocessing(ingest, aligned = null) {
	return {
		schema_version: ingest.schema_version,
		ok: ingest.ok,
		time_units: ingest.time_units,
		time_units_source: ingest.time_units_source,
		time_units_evidence: ingest.time_units_evidence,
		source: ingest.source,
		sources_used: ingest.sources_used,
		source_name: ingest.source_name,
		source_kind: ingest.source_kind,
		taxa_total: ingest.coverage.taxa_total,
		dated: ingest.coverage.dated,
		undated: ingest.coverage.undated,
		coverage: ingest.coverage.coverage,
		by_source: {
			map: ingest.coverage.from_map,
			auspice: ingest.coverage.from_auspice,
			table: ingest.coverage.from_table,
			regex: ingest.coverage.from_regex,
			header: ingest.coverage.from_header
		},
		by_rule: ingest.by_rule,
		imputed: ingest.coverage.imputed,
		day_clamped: ingest.coverage.day_clamped,
		out_of_range: ingest.coverage.out_of_range,
		archival_1959: ingest.coverage.archival_1959,
		match_tier: ingest.match_tier,
		match_tiers: ingest.match_tiers,
		span: ingest.span,
		undated_taxa: ingest.unmatched_taxa.names,
		unmatched_metadata: ingest.unmatched_metadata.names,
		table: ingest.table,
		auspice: ingest.auspice,
		regex: ingest.regex ? { ...ingest.regex } : null,
		headers: ingest.headers,
		warnings: ingest.warnings,
		after_prepare: aligned
			? {
					kept: aligned.kept,
					dropped_dated: aligned.dropped_dated,
					span: aligned.span,
					ok: aligned.ok,
					warnings: aligned.warnings
				}
			: null
	};
}
