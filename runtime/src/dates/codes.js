/**
 * codes.js — the vocabulary of the date ingestion layer: diagnostic codes, thresholds, the four
 * enums and the refusal messages.
 *
 * WHY THIS FILE EXISTS. It imports nothing, deliberately, for the same reason
 * `prescreen/scope.js` and `treeSanitation.js` import nothing: a caller that only wants to know
 * what a code MEANS — the `/time` route rendering a warning, the MCP classifying an error as an
 * input fault — must be able to ask without loading a parser, a table reader or the library.
 *
 * WHAT IT IS NOT. There is no date arithmetic here and there must never be: no year gate, no
 * month table, no two-digit pivot, no date regular expression. Every string-to-time conversion in
 * this directory goes through `@veg/hyphaeon-js` (`parseDate`, `extractDate`, `parseHeaderDate`,
 * `parseFlexibleDate`), which mirrors `hyphaeon/temporal.py:73-245` and `hyphaeon/dating.py:317-384`
 * function for function. A second parser in this repository is a bug, not a convenience.
 *
 * THE CODES ARE NAMESPACED `DATES_*` / `DATE_*` so they never collide with the library's
 * `DIAGNOSTIC_CODES`, and they are ORDERED: `DATE_DIAGNOSTIC_CODES` is the report order, exactly
 * as `diagnostics.js` sorts `diagnose()`'s output by `DIAGNOSTIC_CODES`.
 */

/**
 * Bumped when `DateIngest`'s shape changes in a way a stored record cannot be read under.
 * v2 (BEAST XML): the record gained a `beast` block beside `table` and `auspice`, `'beast'` joined
 * `DATE_SOURCES`, and a row may now carry a `BEAST_DATE_RULES` rule id the library does not know.
 */
export const DATE_SCHEMA_VERSION = 2;

/**
 * Deterministic report order. A warning whose code is not in this list sorts last, stably.
 * The order runs: could not read the source -> could not find the columns -> could not match the
 * names -> the source read but said less than it looked like -> what was invented -> the shape of
 * the answer -> the four arithmetic impossibilities.
 */
export const DATE_DIAGNOSTIC_CODES = Object.freeze([
	'DATES_SOURCE_UNREADABLE',
	'DATES_SOURCE_KIND_UNKNOWN',
	'DATES_XML_UNPARSABLE',
	'DATES_XML_UNSAFE',
	'DATES_BEAST_NOT_BEAST',
	'DATES_BEAST_NO_DATES',
	'DATES_BEAST_NAMESPACED',
	'DATES_BEAST_MULTIPLE_ALIGNMENTS',
	'DATES_BEAST_SEQ_PREFIX',
	'DATES_BEAST_DIRECTION_IGNORED',
	'DATES_BEAST_TRAIT_NOT_DATE',
	'DATES_BEAST_DATE_SCALE',
	'DATES_BEAST_DATE_UNGATED',
	'DATES_BEAST_CARRIES_INPUTS',
	'DATES_TABLE_NO_DATE_COLUMN',
	'DATES_TABLE_COLUMN_GUESSED',
	'DATES_DELIMITER_GUESSED',
	'DATES_TABLE_NO_MATCH',
	'DATES_FUZZY_MATCH',
	'DATES_AMBIGUOUS_MATCH',
	'DATES_UNMATCHED_METADATA',
	'DATES_DUPLICATE_METADATA',
	'DATES_AUSPICE_NO_TIPS',
	'DATES_AUSPICE_TIP_NAME_FALLBACK',
	'DATE_REGEX_INVALID',
	'DATE_REGEX_NO_GROUP',
	'DATE_REGEX_EXTRA_GROUPS',
	'DATE_REGEX_NO_MATCH',
	'DATES_HEADER_FALLBACK',
	'DATES_PARTIAL_COVERAGE',
	'DATES_IMPUTED',
	'DATES_DAY_CLAMPED',
	'DATES_OUT_OF_RANGE',
	'DATES_UNITS_INFERRED',
	'DATES_MIXED_SCALE',
	'DATES_ARCHIVAL_1959_AVAILABLE',
	'DATES_ARCHIVAL_1959_APPLIED',
	'DATES_TIED',
	'DATES_SPAN_SHORT',
	'DATES_DROPPED_BY_CAP',
	'DATES_NONE',
	'DATES_TOO_FEW',
	'DATES_NO_SPAN'
]);

/**
 * The numbers this layer decides with. Each one is a judgement, not a measurement, and is stated
 * here so it can be argued with in one place.
 */
export const DATE_THRESHOLDS = Object.freeze({
	/** Two dated points give a line with zero residual degrees of freedom; `dating.py:1179` refuses
	 *  below three for exactly that reason, so the date layer refuses there too. */
	minDatedTaxa: 3,
	/** Below this fraction of taxa dated, `DATES_PARTIAL_COVERAGE` at warn. The reference drops the
	 *  remainder silently (temporal.py:323 guards its fallback with `len(dates) == 0`). */
	lowCoverageFraction: 0.9,
	/** How many names a warning carries, matching `diagnostics.js`'s own `LIST_CAP` idiom. */
	sampleNames: 10,
	/** Lines the delimiter sniff reads. Twenty is enough to catch a header plus a body whose first
	 *  row happens to contain an embedded comma, and cheap on a 100 MB table. */
	sniffLines: 20,
	/** max/min of |finite non-zero values| above which `DATES_MIXED_SCALE` fires: a set holding both
	 *  2021.3 and 12 is two different time axes in one column. */
	mixedScaleRatio: 1000,
	/** Fraction of dated taxa sharing one value above which `DATES_TIED` fires. */
	tiedFraction: 0.5,
	/**
	 * Fraction of candidate strings that must read as CALENDAR dates for `inferTimeUnits` to call
	 * the axis calendar, whatever the non-calendar pass scored. MEASURED on the three shipped
	 * examples: `korber_env_gp160.fasta` 142/143 = 0.993, `H1N1_2009_pandemic.fasta` 95/100 = 0.95,
	 * `H5N1_HA_metadata.csv` 98/98 = 1.0; a generations panel scores 0. A bare "whichever dates
	 * more" rule reads H1N1 as GENERATIONS — the non-calendar bare-field rule claims the pipe field
	 * `121` on all 100 names where the calendar rules reach 95 — and the dates then run from 1 to
	 * 46,241,654 with no error anywhere. That is the parsers survey's divergence D-20, and this
	 * threshold is what stops it.
	 */
	calendarMajority: 0.5,
	/** A calendar span below this (in years) raises `DATES_SPAN_SHORT`. */
	shortSpanYears: 1,
	/** A user pattern longer than this is refused unrun: it is user input handed to a regular
	 *  expression engine, and the page must not hang on a catastrophic backtrack. */
	maxPatternLength: 512
});

/** Where a row's value came from. `'none'` is a taxon nothing dated. */
export const DATE_SOURCES = Object.freeze([
	'map',
	'auspice',
	'table',
	'beast',
	'regex',
	'header',
	'none'
]);

/**
 * THE RULE IDS A BEAST DATE CARRIES, and the only rule ids in this repository that are not the
 * library's `DATE_RULES`.
 *
 * A row's `rule` is normally whatever `@veg/hyphaeon-js` said read the string, because every other
 * source's values go through the library. A BEAST value does NOT: `_parse_numeric_or_calendar_date`
 * (dataset.py:62-81) is a second parser IN THE REFERENCE, with its own arithmetic and no year gate,
 * and re-reading its answer through the library would destroy it (measured in `beast.js`'s header:
 * `1799`, `50`, `1e9` all become NaN, and every calendar date moves by up to 2.815 days). So the
 * value is carried in as already parsed, and it says which of the reference's three branches
 * produced it — the review table must be able to name a number's provenance, and 'decimal_year'
 * would have been a lie.
 */
export const BEAST_DATE_RULES = Object.freeze({
	/** `float(s)` succeeded — ungated, so `1799`, `-3`, `1e9`, `nan` and `inf` all land here. */
	FLOAT: 'beast_float',
	/** `YYYY-MM-DD` through `year + (month-1)/12 + (day-1)/365.25` (dataset.py:73). */
	YMD: 'beast_ymd',
	/** `YYYY-MM` through `year + (month-0.5)/12` (dataset.py:79). */
	YEAR_MONTH: 'beast_year_month'
});

/** Every `BEAST_DATE_RULES` value, for a surface that labels rules by table. */
export const BEAST_DATE_RULE_IDS = Object.freeze(Object.values(BEAST_DATE_RULES));

/** What a supplied source was read AS. `'map'` is a caller-supplied object, not a file. */
export const DATE_SOURCE_KINDS = Object.freeze(['auspice', 'json-map', 'table', 'beast', 'unknown']);

/**
 * The name-matching ladder, weakest last. Tiers 1-4 are the house ladder the library's `matchTaxa`
 * already speaks (`js/src/preprocess/tree.js:398-443`); 5-7 are this layer's, and 7 is the only
 * one that fixes a GISAID table keyed on an accession that appears as one field of the header.
 * Substring matching is deliberately NOT a tier at any strength: `EPI_ISL_4021` must never match
 * `EPI_ISL_402124`, because the failure mode of a fuzzy match here is a plausible WRONG date.
 */
export const DATE_MATCH_TIERS = Object.freeze([
	'exact',
	'quote_stripped',
	'whitespace_collapsed',
	'case_insensitive',
	'first_token',
	'sanitized',
	'field_containment'
]);

/**
 * The ladder a BEAST document's names are matched on: `DATE_MATCH_TIERS` with ONE tier inserted
 * after `exact`.
 *
 * `seq_prefix_stripped` removes a leading `seq_` from BOTH sides, which covers both of
 * dating.py:438-442's branches at once (`seq_A` in the XML against `A` in the alignment, and `A` in
 * the XML against `seq_A` in the alignment) and adds nothing fuzzier than the reference already
 * does. It is a BEAST-only tier because the prefix is a BEAST 2 idiom — `<sequence id="seq_A"
 * taxon="A" …>` — and the table and Auspice paths must not move.
 */
export const BEAST_MATCH_TIERS = Object.freeze([
	'exact',
	'seq_prefix_stripped',
	'quote_stripped',
	'whitespace_collapsed',
	'case_insensitive',
	'first_token',
	'sanitized',
	'field_containment'
]);

/** The candidate delimiters the sniff tries, in preference order for a tie. */
export const DATE_DELIMITER_CANDIDATES = Object.freeze(['\t', ',', ';', '|', ' ']);

/**
 * The refusals, verbatim. This layer RETURNS them; it never throws, matching `diagnose()`'s
 * contract ("it never throws on bad input"). `{...}` placeholders are filled by `ingest.js`.
 */
export const DATE_MESSAGES = Object.freeze({
	NONE:
		'No sequence could be dated. Nothing in this dataset carries a time coordinate, so no ' +
		'time-aware analysis can run. Dates are read from FASTA headers, from a Nextstrain Auspice ' +
		'JSON, or from a CSV/TSV table with a name column and a date column — add one of those, or ' +
		'supply a pattern that matches your header convention.',
	TOO_FEW:
		'Only {dated} sequence(s) could be dated; at least {min} are needed. Two dated points define ' +
		'a line with no residual degrees of freedom, so every clock rate and every ancestor interval ' +
		'would be undefined.',
	NO_SPAN:
		'Every dated sequence carries the same date ({value}). A clock is a slope against time; with ' +
		'no spread on the time axis there is nothing to estimate.',
	TABLE_NO_MATCH:
		'The metadata file names {n} sequences and none of them is in this alignment, at any matching ' +
		'tier. Metadata names are compared to sequence names; these do not correspond. ' +
		'Metadata: {metadata}. Alignment: {alignment}.',
	TABLE_NUMERIC_NAMES:
		"{k} name(s) in the '{column}' column were read as numbers ('12345' became '12345.0'); quote " +
		'that column or export it as text.',
	TABLE_NO_DATE_COLUMN:
		'No date column was found in {file}. Columns read: {columns}. Name the column explicitly, or ' +
		'rename it to one of: {candidates}.',
	REGEX_INVALID: 'The pattern could not be compiled: {error}.',
	REGEX_NO_GROUP:
		'The pattern has no capturing group. The date is taken from the first group, so the part of ' +
		'the name that is the date must be in parentheses: for example `_(\\d{4}-\\d{2}-\\d{2})$`.',
	/**
	 * A pattern with more than one capturing group is USABLE — `dating.py:478` reads `m.group(1)` and
	 * so does `applyDateRegex` — but only the first group is a date, and a reader who wrote two
	 * groups almost always meant the second one to matter. Accepting it silently and reporting
	 * `valid: true, groups: 2` told them nothing. This is a note, not a refusal: the pattern runs,
	 * and it runs exactly as the reference would run it.
	 */
	REGEX_EXTRA_GROUPS:
		'The pattern has {groups} capturing groups and only the FIRST is read as the date ' +
		'(dating.py:478, `m.group(1)`); every other group is matched and then discarded. If the date is ' +
		'in a later group, move it to the front, or make the earlier ones non-capturing with `(?:…)`.',
	REGEX_TOO_LONG:
		'The pattern is {length} characters long; the limit is {max}. A pattern that large is almost ' +
		'always a paste accident, and running it against every name risks hanging the page.',
	XML_UNPARSABLE:
		'{file} is not well-formed XML: {error}. The reference refuses the same file for the same ' +
		'reason (dataset.py:109-110 turns the parser\'s error into a ValueError). A BEAST annotation ' +
		'written `[&rate=…]` in element text is the usual cause: a bare `&` starts an entity, so it ' +
		'must be written `[&amp;rate=…]` or wrapped in CDATA. If the file is gzipped, decompress it ' +
		'first — this reader takes text, never bytes.',
	// ONE CODE, FIVE REASONS, AND THE SENTENCE HAS TO FIT ALL OF THEM. `ingest.js` maps every
	// `XmlReadError` reason but `malformed` here: `too_large`, `too_deep`, `entity_expansion`,
	// `entity_depth` and `too_much_work`. Only the first is caught before any parsing, so the
	// wording says WHOSE limit it was rather than when — the old 'refused before it was read' was
	// false for the other four — and the no-network clause is attached as a standing property of
	// this reader rather than as the cause, which it is only for the two entity reasons. The
	// `{error}` is `XmlReadError.message`, which names the limit it hit and, for `too_much_work`,
	// the nesting that caused it and the two ways out; `data.reason` carries the machine-readable
	// half. It ENDS the sentence because it already ends in a full stop of its own — spliced into
	// the middle it read `…as a separate FASTA file and let the XML carry only the dates.. Nothing
	// in it was fetched…`. See `xml.js`'s header for what each limit is worth.
	XML_UNSAFE:
		'{file} was refused by this reader\'s own limits rather than by the XML parser — nothing in ' +
		'it was fetched or opened either way, since external entities are never resolved here and ' +
		'this reader has no filesystem and no network. {error}',
	BEAST_NOT_BEAST:
		'{file} is well-formed XML but holds nothing a BEAST file holds: no <alignment>/<data> ' +
		'sequences, no <taxon><date> or date <trait>, and no starting tree. The reference reads such ' +
		'a file as an empty result and dates nothing (measured on `<root><a/></root>`: version ' +
		'"BEAST XML", 0 sequences, 0 dates). If this IS a BEAST file, check whether it declares an ' +
		'XML namespace: `parse_beast_xml` searches for unqualified tags (dataset.py:123), so a ' +
		'document whose root carries `xmlns=` matches nothing in it.',
	BEAST_NO_DATES:
		'{file} was read as {version} and carries {sequences} sequence(s), but no sampling date. ' +
		'Dates are read from BEAST 1 `<taxon id="…"><date value="…"/>` (dataset.py:158-174) or from a ' +
		'BEAST 2 `<trait traitname="date" value="a=…,b=…"/>` (dataset.py:176-188); this file has ' +
		'neither.',
	BEAST_DATE_SCALE:
		'{n} date(s) were read from a calendar string by the BEAST reader\'s OWN arithmetic ' +
		'(dataset.py:71-80), which is not a decimal year: `YYYY-MM-DD` becomes ' +
		'`year + (month-1)/12 + (day-1)/365.25` and `YYYY-MM` becomes `year + (month-0.5)/12`. ' +
		'MEASURED against the conversion every other source in PrimAeon uses (temporal.py:137-141): ' +
		'mean offset 0.73 days, worst 2.815 days (2019-03-31). These numbers are the reference\'s, so ' +
		'`hyphaeon dating --beast` will agree with them — and a CSV of the same dates will not.',
	SOURCE_UNREADABLE: '{file} could not be read as {kind}: {error}.',
	SOURCE_KIND_UNKNOWN:
		'{file} is neither a Nextstrain Auspice JSON, a name-to-date JSON object, nor a delimited table.',
	AUSPICE_NO_TIPS:
		'{file} parsed as JSON but contains no tip with a name; a Nextstrain v2 build has a `tree` ' +
		'whose childless nodes carry `name` and `node_attrs`.'
});

/**
 * `"a, b and c"` for a message, and the sample cap that keeps a refusal readable.
 * @param {ArrayLike<string>} names
 * @param {number} [limit]
 * @returns {string}
 */
export function nameSample(names, limit = DATE_THRESHOLDS.sampleNames) {
	const list = Array.from(names).slice(0, limit);
	const rest = names.length - list.length;
	const body = list.map((n) => `'${n}'`).join(', ');
	return rest > 0 ? `${body} and ${rest} more` : body;
}

/**
 * Fill a `DATE_MESSAGES` template. Missing keys are left as written, so a template typo shows up
 * in the message rather than as `undefined`.
 * @param {string} template
 * @param {Record<string, string|number>} values
 * @returns {string}
 */
export function fillMessage(template, values = {}) {
	return String(template).replace(/\{(\w+)\}/g, (whole, key) =>
		Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : whole
	);
}
