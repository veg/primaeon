/**
 * beast.js — `parse_beast_xml` (hyphaeon/dataset.py:84-233), ported statement by statement, plus
 * its own date helper `_parse_numeric_or_calendar_date` (dataset.py:62-81) and the DIFFERENT taxon
 * ladder `parse_sample_dates` uses on the way out (dating.py:433-442).
 *
 * WHY THIS FILE EXISTS, AND WHY IT IS HERE RATHER THAN IN THE LIBRARY. It is a DOCUMENT READER, and
 * PLAN-TEMPORAL.md §5.1.2 already placed this class of code app-side: "Delimiter-sniffing CSV,
 * Auspice JSON walk, column discovery | Absent, and by the split rule this belongs in the app,
 * beside the FASTA validator, not in the library." The BEAST reader goes beside `auspice.js` for
 * the same reason: it knows about file shapes and about what a reader is shown, not about tensors.
 * `xml.js` is the half that turns bytes into ElementTree-shaped nodes; this half is the port.
 *
 * THIS IS THE ONE FILE IN `runtime/src/dates/` THAT HOLDS A DATE PARSER, AND IT IS DELIBERATE.
 * `date-ingestion.test.js`'s NO SECOND PARSER guard forbids a date regular expression anywhere in
 * this directory, because every string-to-time conversion belongs to `@veg/hyphaeon-js`. The
 * REFERENCE, however, has two: `parse_date_to_decimal` (temporal.py:73-151), which the library
 * mirrors, and `_parse_numeric_or_calendar_date` (dataset.py:62-81), which nothing mirrors and
 * which is reachable only from a BEAST document. They disagree, and a port that quietly routed
 * BEAST values through the library's parser would be changing the reference's own numbers:
 *
 *   MEASURED, `beastDateValue` against `parseDate(s, {timeUnits: 'years'})`:
 *     '2019-03-31'  2019.2488021902807  vs 2019.2410958904109   (+2.815 days, the worst of 2019-20)
 *     '2021-04-15'  2021.28832991102    vs 2021.2849315068493   (+1.241 days)
 *     '2021-04'     2021.2916666666667  vs 2021.2849315068493   (+2.46 days; a DIFFERENT convention
 *                                                                again, mid-month by twelfths)
 *     over all 731 dates of 2019+2020: mean |offset| 0.001988 yr = 0.73 days, max 0.007706 yr.
 *     '1799', '2150', '50', '-3', '1e9' are all KEPT here and are all NaN under the library's
 *     calendar gate, so re-reading a BEAST value would silently drop the taxon entirely.
 *
 * So the guard gains ONE named exemption for this file, the divergence is asserted by a test rather
 * than waived, and `ingest.js` feeds these values in as ALREADY-PARSED `DateParse` records that the
 * library never sees again.
 *
 * WHAT THE READER RETURNS, AND WHO COMPOSES IT. A BEAST XML is the only date source that can carry
 * an ALIGNMENT and a STARTING TREE as well as dates, so `parseBeastXml` returns all three exactly
 * as the reference does, and the CALLER composes them. That is the reference's own rule, twice:
 * `run_mrca_dating` (dating.py:2467-2471) and `cmd_autoclock` fill each slot from the XML only if
 * that slot is still empty (`if alignment_path is None: …`, `if dates_source is None …`,
 * `if tree_path is None and has_xml_tree and not use_tn93: …`), while `-d file.xml`
 * (dating.py:433-442) takes the DATES alone. `beastToFasta` is provided so a surface handed only an
 * XML can hand `prepareRun` a normal alignment; nothing here decides which slot wins, because a
 * drop zone has no argument order and that decision is the surface's.
 *
 * EVERY UPSTREAM QUIRK BELOW IS REPLICATED, NOT FIXED, and each is marked
 * `UPSTREAM QUIRK (dataset.py:NNN)` with what it does and what a reader would expect instead. The
 * app's answer to them is not a correction; it is a warning code raised by `ingest.js` off the
 * `provenance` block this file returns, which the reference cannot produce at all.
 *
 * MEASURED DIVERGENCES FROM THE REFERENCE THAT ARE OURS, the first three from the reader, the
 * fourth from a floating-point representation JavaScript cannot express and none from this port:
 *   1. A document nesting more than `XML_LIMITS.maxDepth` (512) is REFUSED; ElementTree reads a
 *      50,000-deep document in 37.8 ms and accepts it. See `xml.js`'s header for the quadratic
 *      namespace cost that buys the cap.
 *   2. A document whose internal subset REFERENCES a parameter entity (`%p;`) is refused as an
 *      undefined entity; ElementTree parses it and silently drops whatever the entity was standing
 *      in for (measured: `param_entity.xml`, ok, 0 sequences, 0 dates). Both sides end with no
 *      data; ours says why.
 *   3. `parse_beast_xml` accepts a PATH or the content itself (dataset.py:103-107) and opens `.gz`.
 *      This directory opens nothing — every entry takes text the surface already read and inflated
 *      — so that branch has no home here, exactly as `auspice.js` records for `temporal.py:154`.
 *      The bug at dating.py:433 that makes `.xml.gz` unreachable there (`Path('a.xml.gz').suffix`
 *      is `'.gz'`) is therefore not reproducible on our side either.
 *   4. `<date value="-nan"/>` stores a NaN whose SIGN BIT differs: measured, CPython's
 *      `float('-NAN')` is the bit pattern `000000000000f8ff` and ours is `000000000000f87f`.
 *      JavaScript has no way to produce a negative NaN through arithmetic, and no comparison,
 *      serialisation or `Number.isFinite` test in this repository can tell the two apart, so the
 *      difference is unobservable above the raw eight bytes. Both sides land in
 *      `provenance.nonfinite` and both are named by `ingest.js`.
 */

import {
	parseXmlDocument,
	iterElements,
	findAllDescendants,
	findChild,
	createWorkBudget,
	chargeWork,
	XmlReadError
} from './xml.js';
import { CALENDAR_YEAR_MIN, CALENDAR_YEAR_MAX, PY_WS, pyStrip } from './library.js';
import { BEAST_DATE_RULES } from './codes.js';

export { XmlReadError };

/**
 * Python's `str.strip("'\"")` is a CHAR-SET strip, not a quote-PAIR strip: `''A''` loses all four
 * quotes and `"A'` loses both. `match.js`'s `stripQuotes` strips PAIRS and is deliberately not used
 * here — it would keep a quote the reference removes and the two sides would key on different names.
 * @param {string} s
 * @returns {string}
 */
function pyStripQuotes(s) {
	return String(s).replace(/^['"]+|['"]+$/g, '');
}

/**
 * `str.strip()` and `re`'s `\s` come from the LIBRARY, never from `String.prototype.trim` or `/\s/`.
 *
 * MEASURED by enumerating all 1,114,112 code points on CPython 3.14.0: `str.isspace()` and
 * `re.match(r'\s\Z', c)` accept EXACTLY the same 29 characters, which is what `library.js`'s
 * `PY_WS` spells and what `pyStrip` strips. Against JavaScript that set is five characters wider
 * (the information separators U+001C-U+001F, which XML 1.0 forbids in content, and U+0085 NEL,
 * which it allows) and one narrower (U+FEFF, which `trim()` strips and Python does not), and BOTH
 * differences change an answer here — measured against the reference:
 *
 *   `<date>` text `'<NEL>2019-03-31'`  is 2019.2488021902807 upstream, because `str.strip()`
 *       removes the NEL and the `YYYY-MM-DD` branch then matches; `String(v).trim()` left it in
 *       place and the port returned `None`.
 *   `'<BOM>1980'`                      is `None` upstream, because `str.strip()` leaves the BOM and
 *       `float()` refuses it; `trim()` removed it and the port returned 1980.0.
 *   `<sequence>AC<BOM>GT</sequence>`   is `AC<BOM>GT` upstream, because `re`'s `\s` does not match
 *       the BOM either; `/\s+/` scrubbed it and the port returned `ACGT`.
 *
 * NOTE that `float()` has a SECOND, different space set of its own — see `PY_FLOAT_SPACE` below.
 */
const PY_SPACE_RUN = new RegExp(`${PY_WS}+`, 'gu');

/**
 * Python counts EVERY Unicode decimal digit, not just `0`-`9`, and JavaScript counts none of the
 * others: `float()` runs the same `PyUnicode_TransformDecimalAndSpaceToASCII` described above, and
 * `re`'s `\d` on a `str` pattern matches the whole `Nd` category, while JavaScript's `\d` and
 * `Number()` are ASCII-only. MEASURED against the reference: `'١٩٨٠'` (Arabic-Indic) and `'１９８０'`
 * (fullwidth) are both 1980.0 upstream, `'١٩٨٠-٠٣-٠٥'` takes the YYYY-MM-DD branch and gives
 * 1980.1776180698153, and `float('١9')` is 19.0 — the scripts may be MIXED. A port that left these
 * ASCII-only returned `None` for all six and silently undated the taxon.
 *
 * The value of an `Nd` code point is recovered without a table because every `Nd` run is exactly
 * ten code points long starting at that script's zero, so the zero is the first code point below
 * this one that is not preceded by another `Nd`. Applied ONLY when the string holds a non-ASCII
 * character, so the ordinary path is untouched: measured, the guard alone is 5.1 ms per 100,000
 * calls (51 ns), against 0.93 µs for a whole `beastDateValue` on an ASCII `YYYY-MM-DD`.
 * @param {string} s
 * @returns {string}
 */
function asciifyDigits(s) {
	if (!/[^\x00-\x7f]/.test(s)) return s;
	return s.replace(/\p{Nd}/gu, (d) => {
		const cp = d.codePointAt(0);
		let zero = cp;
		while (zero > 0 && /\p{Nd}/u.test(String.fromCodePoint(zero - 1))) zero--;
		return String(cp - zero);
	});
}

/**
 * The whitespace `float()` strips off both ends of its argument, which is NOT `PY_WS`.
 *
 * `float()` runs `PyUnicode_TransformDecimalAndSpaceToASCII` first, so any character CPython counts
 * as a space becomes an ASCII space and is then skipped. MEASURED by feeding `float(c + '1' + c)`
 * every code point below U+3001 on CPython 3.14.0: the accepted set is
 * `\t \n \v \f \r SPACE U+0085 U+00A0 U+1680 U+2000-U+200A U+2028 U+2029 U+202F U+205F U+3000` —
 * `PY_WS` MINUS the four information separators U+001C-U+001F (measured: `float('\x1c1')` raises),
 * and JavaScript's `\s` plus U+0085 minus U+FEFF. None of the three can stand in for another, so
 * this class is written out beside the library's.
 */
const PY_FLOAT_SPACE =
	'\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const PY_FLOAT_TRIM = new RegExp(`^[${PY_FLOAT_SPACE}]+|[${PY_FLOAT_SPACE}]+$`, 'gu');

/**
 * `float(s)` with Python's grammar, which is NOT `Number(s)`.
 *
 * Python accepts `1_000` (PEP 515), `inf`, `infinity` and `nan` in any case, and REJECTS `0x10`,
 * the empty string and `1,000`; `Number()` accepts `0x10` and turns `''` into 0. Getting this wrong
 * changes which values the reference keeps, which is the whole point of the exemption above.
 *
 * IT ALSO TOLERATES SURROUNDING WHITESPACE, and that is reachable here rather than academic:
 * dataset.py:66 is `s = str(v_str).strip().strip("'\"")`, which strips whitespace BEFORE the quotes
 * and never again after, so padding written INSIDE a NEXUS-style quoted value survives into
 * `float()` and is accepted. MEASURED against the reference: `<date value="' 2011.5 '"/>` is
 * 2011.5 upstream, and a version of this function that anchored the grammar against the untrimmed
 * string returned `None` and left the taxon undated — in a four-taxon probe document
 * (`' 2011.5 '`, a `<date>` text node, `'2004.0'`, a trait entry `D=' 1999.25 '`) the reference
 * dated A, B, C and D and the port dated only C.
 *
 * @param {string} s
 * @returns {number|null} `null` where Python raises `ValueError`
 */
function pythonFloat(s) {
	const t = s.replace(PY_FLOAT_TRIM, '');
	const special = /^([+-]?)(inf(?:inity)?|nan)$/i.exec(t);
	if (special) {
		if (special[2].toLowerCase() === 'nan') return NaN;
		return special[1] === '-' ? -Infinity : Infinity;
	}
	const grammar =
		/^[+-]?(?:\d+(?:_\d+)*(?:\.(?:\d+(?:_\d+)*)?)?|\.\d+(?:_\d+)*)(?:[eE][+-]?\d+(?:_\d+)*)?$/;
	if (!grammar.test(t)) return null;
	return Number(t.replace(/_/g, ''));
}

/**
 * `_parse_numeric_or_calendar_date` (dataset.py:62-81), with the branch that fired.
 *
 * UPSTREAM QUIRK (dataset.py:67-69): THERE IS NO GATE OF ANY KIND on the float path. `float(s)` is
 * tried first and whatever it returns is kept — measured: `1799`, `2150`, `50`, `-3`, `1e9`,
 * `1_000` all accepted, and all NaN under the library's [CALENDAR_YEAR_MIN, CALENDAR_YEAR_MAX]
 * gate. A reader would expect a year.
 *
 * UPSTREAM QUIRK (dataset.py:67-69 with :172): `nan` and `inf` PARSE, and the caller's guard is
 * `if parsed_d is not None`, which NaN passes. Measured: `<date value="nan"/>` puts NaN into
 * `dates` and `inf` puts Infinity. A NaN date reaching a clock regression is a silent poison; we
 * store it faithfully and `ingest.js` names it.
 *
 * UPSTREAM QUIRK (dataset.py:73): THE CALENDAR FORMULA IS NOT A DECIMAL YEAR. `YYYY-MM-DD` becomes
 * `year + (month-1)/12 + (day-1)/365.25` — twelfths mixed with 365.25ths, and neither term is a
 * day of the year. A correct conversion is the library's `year + (date - Jan 1).days / days_in_year`
 * (temporal.py:137-141). Measured offsets are in this file's header.
 *
 * UPSTREAM QUIRK (dataset.py:79): `YYYY-MM` uses a THIRD convention, `year + (month-0.5)/12` —
 * mid-month by twelfths — where the library imputes day 15 and converts properly.
 *
 * UPSTREAM QUIRK (dataset.py:71-75): NO CALENDAR VALIDATION. Month and day are `\d{1,2}` with no
 * range check and no date construction. Measured: `2020-13-45` gives 2021.1204654346338, and
 * `2020-00-00` gives 2019.9139288158797 — a date in the PREVIOUS YEAR, because month 0 contributes
 * -1/12 and day 0 contributes -1/365.25. A masked date written `0000` is a common BEAST idiom.
 *
 * PYTHON'S `$` IS NOT JAVASCRIPT'S. In `re`, `$` without `MULTILINE` matches at the end of the
 * string OR just before a SINGLE newline at the end of it; in JavaScript it matches only at the
 * end. The same quote-then-strip order that reaches `float()` with padding reaches these two
 * regular expressions with a trailing newline, so the difference is reachable: MEASURED,
 * `re.match(r'^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$', '2019-03-31\n')` matches and gives
 * 2019.2488021902807, `'2019-03-31\n\n'` and `'2019-03-31\r'` do not match, and a `<date>` element
 * whose text is `'2019-03-31\n'` (quoted, the newline inside the quotes) was dated upstream and
 * dropped by a port anchored on a bare `$`. `\n?$` is that rule written out.
 *
 * @param {string|null|undefined} value
 * @returns {{value: number, rule: string}|null} `null` is the reference's `None`
 */
export function beastDateParse(value) {
	if (!value) return null; // dataset.py:64, `if not v_str`
	// dataset.py:66, then the decimal transform `float()`, `re` and `int()` all apply on their own.
	const s = asciifyDigits(pyStripQuotes(pyStrip(String(value))));
	const f = pythonFloat(s);
	if (f !== null) return { value: f, rule: BEAST_DATE_RULES.FLOAT };
	// dataset.py:71-75 — YYYY-MM-DD
	const ymd = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})\n?$/.exec(s);
	if (ymd) {
		const y = Number(ymd[1]);
		const mth = Number(ymd[2]);
		const day = Number(ymd[3]);
		return { value: y + (mth - 1.0) / 12.0 + (day - 1.0) / 365.25, rule: BEAST_DATE_RULES.YMD };
	}
	// dataset.py:77-80 — YYYY-MM
	const ym = /^(\d{4})[-/](\d{1,2})\n?$/.exec(s);
	if (ym) {
		const y = Number(ym[1]);
		const mth = Number(ym[2]);
		return { value: y + (mth - 0.5) / 12.0, rule: BEAST_DATE_RULES.YEAR_MONTH };
	}
	return null; // dataset.py:81
}

/**
 * The reference's own return value, for a test that compares the two sides number for number.
 * @param {string|null|undefined} value
 * @returns {number|null}
 */
export function beastDateValue(value) {
	const parsed = beastDateParse(value);
	return parsed === null ? null : parsed.value;
}

/**
 * The fixed cost of examining one `<sequence>` element, in the units `xml.js` meters. Measured
 * beside the charge itself, in `parseBeastXml`'s sequence loop.
 */
const SEQUENCE_UNITS = 64;

/** Is this value one the library's calendar gate would have thrown away? */
function isUngated(v) {
	return Number.isFinite(v) && (v < CALENDAR_YEAR_MIN || v > CALENDAR_YEAR_MAX);
}

/**
 * @typedef {{version: string, sequences: Map<string,string>, dates: Map<string,number>,
 *   tree_newick: string|null, taxa: string[], provenance: object}} BeastDocument
 */

/**
 * `parse_beast_xml` (dataset.py:84-233).
 *
 * @param {string} text the XML document, already decoded and inflated by the surface
 * @param {{fileName?: string, limits?: object}} [options]
 * @returns {BeastDocument}
 * @throws {XmlReadError} only from the reader: malformed, too large, too deep, entity policy
 */
export function parseBeastXml(text, options = {}) {
	const doc = parseXmlDocument(text, options);
	const root = doc.root;
	// ONE meter for the whole read. `parse_beast_xml` has no bound of its own and is quadratic in
	// nesting depth (xml.js's header carries the measured shape); every traversal and every
	// re-reading of element text below charges this, and going over it refuses the document.
	const work = createWorkBudget(options.limits ?? {});

	// --- version heuristic (dataset.py:114-120) -------------------------------------------------
	// UPSTREAM QUIRK (dataset.py:117): THE SECOND CLAUSE IS DEAD CODE. `'namespace' in
	// root.attrib.get('spec','').lower()` sits behind `'spec' in root.attrib or …`: if `spec` IS on
	// the root the `or` short-circuits, and if it is not then `.get('spec','')` is `''` and
	// `'namespace' in ''` is False. It was plainly meant to read `root.attrib.get('namespace','')`.
	// Replicated as written — we do NOT read `namespace`. Measured on the reference's own BEAST 2
	// fixture, whose root carries `namespace="beast.evolution.alignment:…"`: it is called BEAST 2
	// only by clause 3, and deleting the one `spec=` on its `<trait>` makes the same file report
	// 'BEAST 1'.
	//
	// UPSTREAM QUIRK (dataset.py:118): ONE `spec` ATTRIBUTE ANYWHERE decides the version, so a
	// BEAST 1.10 file with a single `spec=` on any descendant prints as 'BEAST 2'. It is a LABEL,
	// not a switch — both date passes run on every document regardless — but it is shown to a
	// reader, so it is replicated rather than corrected.
	const specSomewhere = (() => {
		for (const el of iterElements(root, work)) if ('spec' in el.attrib) return true;
		return false;
	})();
	const isBeast2 =
		'spec' in root.attrib ||
		String(root.attrib.spec ?? '')
			.toLowerCase()
			.includes('namespace') ||
		specSomewhere;
	const version = isBeast2 ? 'BEAST 2' : root.tag.toLowerCase().includes('beast') ? 'BEAST 1' : 'BEAST XML';

	// --- 1. sequences (dataset.py:122-152) ------------------------------------------------------
	// UPSTREAM QUIRK (dataset.py:123): every `<alignment>` comes before every `<data>`, whatever
	// the document order, which decides ties across the two element names. `.//sequence` is a
	// DESCENDANT search, so a `<data>` nested inside a `<data>` has its children counted by both.
	//
	// NOTE (xml.js): a namespaced document matches NOTHING here, because ElementTree names a
	// namespaced element `{uri}alignment` and these searches are unqualified. Measured against the
	// reference: `<beast xmlns="http://beast2.org">…<data><sequence …/></data></beast>` returns 0
	// sequences, 0 dates and version 'BEAST 1'. Replicated exactly; `ingest.js` says so out loud
	// rather than showing a reader an empty result.
	const alignNodes = [
		...findAllDescendants(root, 'alignment', work),
		...findAllDescendants(root, 'data', work)
	];
	/** @type {Array<Map<string,string>>} */
	const candidates = [];
	/** @type {Array<{index: number, size: number, dataType: string|null}>} */
	const alignmentSizes = [];
	/** @type {string[]} */
	const duplicateSequences = [];
	let valueAttrSeqs = 0;
	let textSeqs = 0;
	let tailSeqs = 0;

	for (const node of alignNodes) {
		const seqElems = findAllDescendants(node, 'sequence', work);
		if (seqElems.length === 0) continue; // dataset.py:127
		/** @type {Map<string,string>} */
		const cur = new Map();
		for (const s of seqElems) {
			// The FIXED cost of one `<sequence>`, beside the per-character cost charged below. A
			// budget that priced only characters under-charged a document of very short sequences by
			// two orders of magnitude: MEASURED, the three-step normalisation plus a `Map` write is
			// 106.9 ns on a 4-base sequence and 13.8 us on a 30,000-base one, i.e. 26.7 ns per
			// character against 0.46 — the same fixed ~100 ns either way. 64 units is that fixed cost
			// at the ~1.8 ns a unit is worth in situ. Without it, a 509-deep chain of 60,000
			// four-base sequences ran 1.9 s before the meter noticed; with it, 0.3 s.
			chargeWork(work, SEQUENCE_UNITS);
			const tChild = findChild(s, 'taxon', work);
			let tName = null;
			if (tChild !== null) tName = tChild.attrib.idref || tChild.attrib.id || null;
			if (!tName) tName = s.attrib.taxon || s.attrib.id || null;

			let seq = '';
			if ('value' in s.attrib) {
				// UPSTREAM QUIRK (dataset.py:139): `value=""` WINS over the element's own text,
				// because the test is `'value' in s.attrib`, not a truthiness test.
				seq = s.attrib.value;
				valueAttrSeqs++;
			} else if (s.text && pyStrip(s.text)) {
				seq = pyStrip(s.text);
				textSeqs++;
			} else if (tChild !== null && tChild.tail && pyStrip(tChild.tail)) {
				// dataset.py:145 — the BEAST 1 shape `<sequence><taxon idref="A"/>ACGT</sequence>`
				// stores the sequence as the TAIL of the taxon child. This single line is why the
				// reader must keep tails.
				seq = pyStrip(tChild.tail);
				tailSeqs++;
			}

			// UPSTREAM QUIRK (dataset.py:147): `U`→`T` is applied to every sequence unconditionally,
			// with no look at `dataType`, so a protein alignment's selenocysteine `U` becomes `T`.
			// The reference has no `dataType` check at all; we do not add one, and the app's existing
			// coding-alignment gate refuses such an alignment downstream with its own reason.
			// The three passes below are the CHARACTER half of the budget: a nested chain of
			// alignment nodes re-normalises the same sequences once per ancestor, which is where
			// 14.3 MiB of well-formed XML bought sixteen seconds before this charge existed.
			chargeWork(work, seq.length);
			seq = seq.replace(PY_SPACE_RUN, '').toUpperCase().replace(/U/g, 'T');
			if (tName && seq) {
				const key = pyStripQuotes(tName);
				// UPSTREAM QUIRK: a dict assignment, so a repeated taxon SILENTLY takes the LAST
				// value. Measured: two sequences for one name keep the later one.
				if (cur.has(key)) duplicateSequences.push(key);
				cur.set(key, seq);
			}
		}
		if (cur.size > 0) {
			alignmentSizes.push({
				index: candidates.length,
				size: cur.size,
				dataType: node.attrib.dataType ?? null
			});
			candidates.push(cur);
		}
	}

	// UPSTREAM QUIRK (dataset.py:152): `max(candidates, key=len)` counts TAXA, not sites, and
	// Python's `max` keeps the FIRST maximal element on a tie. A partitioned analysis with one
	// `<data>` per partition therefore contributes exactly ONE partition, silently. Replicated with
	// a strict `>` so the first maximum wins here too.
	let chosenIndex = -1;
	let seqDict = new Map();
	for (let i = 0; i < candidates.length; i++) {
		if (chosenIndex === -1 || candidates[i].size > seqDict.size) {
			seqDict = candidates[i];
			chosenIndex = i;
		}
	}

	// --- 2. dates (dataset.py:154-188) ----------------------------------------------------------
	/** @type {Map<string,number>} */
	const datesMap = new Map();
	/** @type {Map<string,string>} */
	const raws = new Map();
	/** @type {Map<string,string>} */
	const rules = new Map();
	/** @type {string[]} */
	const duplicateDates = [];
	let directionAttrs = 0;
	let unitsAttrs = 0;
	let beast1Dates = 0;
	let beast2Dates = 0;

	const store = (key, raw, parsed) => {
		if (datesMap.has(key)) duplicateDates.push(key);
		datesMap.set(key, parsed.value);
		raws.set(key, raw);
		rules.set(key, parsed.rule);
	};

	// BEAST 1: every `<taxon>` ANYWHERE, which includes the `<taxon idref=…>` stubs inside
	// `<sequence>` (dataset.py:158).
	for (const tx of findAllDescendants(root, 'taxon', work)) {
		const tId = tx.attrib.id || tx.attrib.idref;
		if (!tId) continue;
		const tClean = pyStripQuotes(tId);
		const d = findChild(tx, 'date', work);
		let valStr = null;
		if (d !== null) {
			// UPSTREAM QUIRK: `direction` and `units` are NEVER READ — `grep -n 'direction\|units='
			// hyphaeon/dataset.py` returns nothing. Measured: `<date value="10" direction="backwards"
			// units="days"/>` stores 10.0, so a ten-days-before-present age becomes the year 10 AD.
			// A whole dataset can come out mirror-imaged in time with no error anywhere. We store the
			// same number and count the attributes so `ingest.js` can say it.
			if ('direction' in d.attrib) directionAttrs++;
			if ('units' in d.attrib) unitsAttrs++;
			valStr = d.attrib.value || (d.text ? pyStrip(d.text) : null);
		} else if ('date' in tx.attrib) {
			valStr = tx.attrib.date;
		}
		if (valStr !== null && valStr !== undefined) {
			const parsed = beastDateParse(valStr);
			if (parsed !== null) {
				store(tClean, valStr, parsed);
				beast1Dates++;
			}
		}
	}

	// BEAST 2: `<trait traitname="date" value="a=…,b=…">` (dataset.py:176-188).
	/** @type {Array<{name: string, entries: number, exact: boolean}>} */
	const traits = [];
	for (const tr of findAllDescendants(root, 'trait', work)) {
		const tAttr = String(tr.attrib.traitname || tr.attrib.name || '').toLowerCase();
		// UPSTREAM QUIRK (dataset.py:177-178): this is a SUBSTRING test. Measured:
		// `traitname="dateBackward"` fires and its ages-before-present are stored as forward dates;
		// `name="date-forward"` fires too. `traitname="location"` is correctly ignored.
		if (!tAttr.includes('date')) continue;
		// UPSTREAM QUIRK (dataset.py:179): an EMPTY `value=""` BEATS the element text, because the
		// default of `.get` applies only when the attribute is ABSENT. Measured:
		// `<trait traitname="date" value="">A=1980</trait>` yields no dates at all.
		const valText = 'value' in tr.attrib ? tr.attrib.value : (tr.text ?? '');
		chargeWork(work, valText.length);
		const entries = pyStrip(valText).split(/[,;\n\r]+/);
		let taken = 0;
		for (const entry of entries) {
			if (!entry.includes('=')) continue;
			const eq = entry.indexOf('=');
			// Python strips WHITESPACE then QUOTES from the key, and only whitespace from the value —
			// the value's quotes are stripped later, inside the date helper.
			const k = pyStripQuotes(pyStrip(entry.slice(0, eq)));
			const vStr = pyStrip(entry.slice(eq + 1));
			const parsed = beastDateParse(vStr);
			if (parsed !== null) {
				// The BEAST 2 pass runs AFTER the BEAST 1 pass and OVERWRITES on a key collision.
				store(k, vStr, parsed);
				taken++;
				beast2Dates++;
			}
		}
		traits.push({
			name: String(tr.attrib.traitname || tr.attrib.name || ''),
			entries: taken,
			exact: tAttr === 'date'
		});
	}

	// --- 3. taxon reconciliation (dataset.py:190-202) -------------------------------------------
	// UPSTREAM QUIRK: branch 2 RENAMES the sequence (`reconciled[k[4:]] = v`) with no collision
	// check, so `taxa` — which is `list(reconciled_seqs.keys())` — changes shape; branch 3 GROWS
	// `dates_map` and KEEPS the `seq_` key too, so the returned `len(dates)` can exceed the number
	// of dated sequences. Measured: sequence `seq_A` + date `A` gives `sequences {'A': …}` and
	// `taxa ['A']`; sequence `A` + date `seq_A` gives `dates {'seq_A': 1980.0, 'A': 1980.0}`.
	/** @type {Map<string,string>} */
	const reconciled = new Map();
	/** @type {Array<{from: string, to: string}>} */
	const renamed = [];
	/** @type {string[]} */
	const datesAdded = [];
	for (const [k, v] of seqDict) {
		if (datesMap.has(k)) {
			reconciled.set(k, v);
		} else if (k.startsWith('seq_') && datesMap.has(k.slice(4))) {
			reconciled.set(k.slice(4), v);
			renamed.push({ from: k, to: k.slice(4) });
		} else if (datesMap.has(`seq_${k}`)) {
			reconciled.set(k, v);
			datesMap.set(k, datesMap.get(`seq_${k}`));
			raws.set(k, raws.get(`seq_${k}`) ?? '');
			rules.set(k, rules.get(`seq_${k}`) ?? BEAST_DATE_RULES.FLOAT);
			datesAdded.push(k);
		} else {
			reconciled.set(k, v);
		}
	}

	// --- 4. the starting tree (dataset.py:204-225) ----------------------------------------------
	let treeNewick = null;
	let treeFrom = null;
	for (const el of iterElements(root, work)) {
		if (el.tag.toLowerCase().includes('newick') && el.text && pyStrip(el.text).startsWith('(')) {
			treeNewick = pyStrip(el.text);
			treeFrom = `<${el.tag}> text`;
			break;
		}
		for (const attrK of Object.keys(el.attrib)) {
			const attrV = el.attrib[attrK];
			if (attrK.toLowerCase().includes('newick') && typeof attrV === 'string' && pyStrip(attrV).startsWith('(')) {
				treeNewick = pyStrip(attrV);
				treeFrom = `<${el.tag} ${attrK}=…>`;
				break; // UPSTREAM QUIRK (dataset.py:213): this `break` leaves only the INNER loop.
			}
		}
		// UPSTREAM QUIRK (dataset.py:214-216): because that `break` was the inner one, this test then
		// runs on the SAME element and can OVERWRITE the attribute's value with the element's text.
		// Replicated in this exact order.
		//
		// UPSTREAM QUIRK (dataset.py:214): a Newick without a trailing `;` is only ever found by the
		// `newick`-named tag or attribute branches. Measured: `<init>((A:1,B:1):1)</init>` gives
		// None; add the `;` and it is found. A leading NEXUS-style comment kills detection outright,
		// because every branch requires `.strip().startswith('(')`.
		if (el.text && pyStrip(el.text).startsWith('(') && pyStrip(el.text).endsWith(';')) {
			treeNewick = pyStrip(el.text);
			treeFrom = `<${el.tag}> text`;
			break;
		}
		if (treeNewick) break;
	}

	if (treeNewick) {
		// UPSTREAM QUIRK (dataset.py:222-223): the comment strip is `\[&[^\]]*\]` ONLY, so a `[…]`
		// comment without `&` survives into the Newick and will then fail the app's tree reader; and
		// the second pass strips `\{[^}]*\}`, which silently discards a HyPhy `{FG}` foreground
		// partition a reader may have meant to keep. Note also that `[&…]` cannot appear literally in
		// XML text (`&` starts an entity), so a real annotated tree is written `[&amp;…]`; the
		// unescaped form is not well-formed and the whole document is refused (measured: ElementTree
		// raises "not well-formed (invalid token): line 1, column 29" on exactly that file).
		treeNewick = treeNewick.replace(/\[&[^\]]*\]/g, '');
		treeNewick = treeNewick.replace(/\{[^}]*\}/g, '');
		if (!treeNewick.endsWith(';')) treeNewick += ';';
	}

	// --- the app-only provenance block ----------------------------------------------------------
	// The reference returns five keys and no account of how it got them. Everything below is what
	// `ingest.js` turns into warnings; none of it changes a number.
	const ungated = [];
	const nonfinite = [];
	for (const [k, v] of datesMap) {
		if (!Number.isFinite(v)) nonfinite.push(k);
		else if (isUngated(v)) ungated.push(k);
	}
	const calendarRules = new Set([BEAST_DATE_RULES.YMD, BEAST_DATE_RULES.YEAR_MONTH]);
	let calendarDates = 0;
	for (const rule of rules.values()) if (calendarRules.has(rule)) calendarDates++;

	// `names_with_whitespace` is JavaScript's `\s` and is the field `ingest.js` already reports;
	// `names_unsafe_for_fasta` is the accurate one, on Python's whitespace and the quote strip, and
	// is what `beastToFasta` refuses on. They disagree on exactly five characters — U+001C-U+001F
	// and U+0085 are whitespace to Python and not to `\s`, U+FEFF the reverse — so a name carrying
	// one of those is in the second list and not the first. The second list is the one to read.
	const namesWithWhitespace = Array.from(reconciled.keys()).filter((n) => /\s/.test(n));
	const unsafeForFasta = unsafeFastaNames(reconciled.keys());

	return {
		version,
		sequences: reconciled,
		dates: datesMap,
		tree_newick: treeNewick,
		taxa: Array.from(reconciled.keys()),
		provenance: {
			raws,
			rules,
			namespaced: doc.namespaced,
			elements: doc.elements,
			depth: doc.depth,
			doctype_entities: doc.entities,
			alignments: { seen: candidates.length, chosen_index: chosenIndex, sizes: alignmentSizes },
			sequence_sources: { value_attr: valueAttrSeqs, element_text: textSeqs, taxon_tail: tailSeqs },
			traits,
			dates_from: { beast1: beast1Dates, beast2: beast2Dates },
			direction_attrs: directionAttrs,
			units_attrs: unitsAttrs,
			calendar_dates: calendarDates,
			ungated,
			nonfinite,
			duplicates: { sequences: duplicateSequences, dates: duplicateDates },
			reconciliation: { renamed, dates_added: datesAdded },
			names_with_whitespace: namesWithWhitespace,
			names_unsafe_for_fasta: unsafeForFasta,
			tree_from: treeFrom,
			/** What this read cost against `XML_LIMITS.maxWork`, so a surface can print the headroom. */
			work: { spent: work.spent, max: work.max }
		}
	};
}

/**
 * The OTHER taxon ladder: `parse_sample_dates`'s BEAST branch (dating.py:433-442).
 *
 * It differs from the reconciliation inside the parser in four ways, and using either in the
 * other's place changes which taxa get dates. It iterates the RUN'S taxa rather than the
 * sequences; it quote-strips the TAXON (the parser quote-strips only at collection time); it is
 * READ-ONLY — it never renames a sequence and never writes back into `dates`; and it has no `else`
 * branch, so an unmatched taxon is simply absent and falls through to the header fallback
 * (dating.py:474-483), which this layer already replicates. The output is keyed on the ORIGINAL
 * taxon, not on the stripped one.
 *
 * @param {readonly string[]} taxa the run's taxa, exactly as `prepareRun` will index them
 * @param {{dates: Map<string,number>}} parsed a `parseBeastXml` result
 * @returns {Map<string, number>}
 */
export function beastDatesForTaxa(taxa, parsed) {
	/** @type {Map<string,number>} */
	const out = new Map();
	const dates = parsed?.dates ?? new Map();
	for (const t of taxa ?? []) {
		const tClean = pyStripQuotes(t);
		if (dates.has(tClean)) out.set(t, dates.get(tClean));
		else if (tClean.startsWith('seq_') && dates.has(tClean.slice(4))) out.set(t, dates.get(tClean.slice(4)));
		else if (dates.has(`seq_${tClean}`)) out.set(t, dates.get(`seq_${tClean}`));
	}
	return out;
}

// =================================================================================================
// A BEAST taxon id is not a FASTA name, and the gap between them is not cosmetic
// =================================================================================================

/**
 * The hazards a BEAST taxon id carries into a FASTA header, as `provenance.names_unsafe_for_fasta`
 * and `BeastFastaError.names` report them.
 */
export const FASTA_NAME_HAZARDS = Object.freeze({
	/** The name is empty once the reader has stripped it, so the header has no name at all. */
	EMPTY: 'empty',
	/** The name holds Python whitespace, so the reader keeps only the part before it. */
	WHITESPACE: 'whitespace',
	/** The name starts or ends with `'` or `"`, which the reader strips off. */
	QUOTED: 'quoted'
});

/**
 * One character of Python whitespace, the class the library's FASTA reader splits and strips on.
 * `PY_WS` is a character class; this is that class matched once, anywhere.
 */
const PY_SPACE_ANYWHERE = new RegExp(PY_WS, 'u');

/**
 * What `parseAlignmentSequences` would do to this taxon id if it were written as a FASTA header.
 *
 * MEASURED, not assumed — the library's FASTA branch (`js/src/preprocess/parse.js:212-230`,
 * `parse_alignment_sequences`, dataset.py:302-315) does exactly three things to a `>` line, and each
 * one is a way to lose a taxon:
 *
 *   1. `pySplitLines` cuts the file into lines FIRST. Every one of Python's eleven line boundaries
 *      (`\n`, `\r`, `\r\n`, `\v`, `\f`, U+001C, U+001D, U+001E, U+0085, U+2028, U+2029) is also a
 *      member of `PY_WS`, so a name carrying one does not merely truncate — it ENDS THE HEADER,
 *      and whatever follows becomes a new line of the file. A `>` there opens a new record. That is
 *      the injection: MEASURED, a
 *      THREE-taxon BEAST 1 document whose first taxon is written `<taxon id="A&#10;&gt;INJECTED">`
 *      produced a FASTA the library read back as FOUR sequences — one of them named `INJECTED`,
 *      carrying taxon A's bases, while `A` itself came back empty.
 *   2. `pySplit(line[1:])[0]` keeps only the FIRST whitespace token, so `A seq1` and `A seq2` both
 *      become `A`. MEASURED: a three-taxon document with those two names produced a FASTA the
 *      library read back as TWO sequences — the first was overwritten by the second, silently — and
 *      `beastDatesForTaxa` then dated one taxon of the three, because the dates are keyed on the
 *      full id and the run's taxa are the truncated one.
 *   3. `pyStripChars(token, '\'"')` strips quotes off both ends, so `'A` reads back as `A`. This
 *      one is NOT reachable through `parseBeastXml` as the reference is written — every name it
 *      stores went through `str.strip("'\"")` at collection (dataset.py:150, dataset.py:161), so no
 *      key it returns begins or ends with a quote, including the ones dataset.py:190-202 rebuilds
 *      by slicing `seq_` off the front. The check stays because `beastToFasta` is exported and the
 *      reader's third transform is real: a caller that builds its own `{sequences, taxa}` gets the
 *      refusal rather than a name the alignment reader quietly shortens. Pinned both ways in
 *      `runtime/test/beast-xml.test.js`.
 *
 * A name with none of the three reads back as ITSELF, byte for byte; the equivalence is asserted
 * against the library over a table of adversarial names in `runtime/test/beast-xml.test.js`.
 *
 * @param {string} name
 * @returns {string|null} a `FASTA_NAME_HAZARDS` member, or `null` when the name round-trips
 */
export function fastaNameHazard(name) {
	const s = String(name ?? '');
	if (s === '') return FASTA_NAME_HAZARDS.EMPTY;
	if (PY_SPACE_ANYWHERE.test(s)) return FASTA_NAME_HAZARDS.WHITESPACE;
	if (/^['"]|['"]$/.test(s)) return FASTA_NAME_HAZARDS.QUOTED;
	return null;
}

/**
 * Every name in `taxa` that would not survive the round trip, with the hazard that would take it.
 * @param {Iterable<string>} taxa
 * @returns {Array<{name: string, hazard: string}>}
 */
export function unsafeFastaNames(taxa) {
	/** @type {Array<{name: string, hazard: string}>} */
	const out = [];
	for (const name of taxa ?? []) {
		const hazard = fastaNameHazard(name);
		if (hazard !== null) out.push({ name, hazard });
	}
	return out;
}

/** How a hazard reads in the refusal, one clause per kind. */
const HAZARD_CLAUSE = Object.freeze({
	[FASTA_NAME_HAZARDS.EMPTY]: 'is empty, and a FASTA header with no name is an error the alignment reader raises',
	[FASTA_NAME_HAZARDS.WHITESPACE]:
		'contains whitespace, and the alignment reader keeps only the part before it — a line break ' +
		'there would end the header outright and a `>` after it would start a whole new sequence',
	[FASTA_NAME_HAZARDS.QUOTED]: 'starts or ends with a quote, which the alignment reader strips off'
});

/** `'A\n>B'` shown so a reader can see the character that did it. */
function showName(name) {
	return JSON.stringify(String(name));
}

/**
 * The refusal `beastToFasta` raises. Typed and carrying the offending names so a surface can list
 * them rather than re-deriving them from a sentence.
 */
export class BeastFastaError extends Error {
	/**
	 * @param {string} message
	 * @param {Array<{name: string, hazard: string}>} names
	 */
	constructor(message, names) {
		super(message);
		this.name = 'BeastFastaError';
		/** A stable code, so a surface classifies without reading the sentence. */
		this.code = 'BEAST_NAME_NOT_FASTA';
		this.names = names;
	}
}

/**
 * The XML's alignment as FASTA, in `taxa` order.
 *
 * THIS IS THE APP'S OWN FUNCTION AND MIRRORS NOTHING. The reference hands `parse_beast_xml`'s
 * `sequences` dict straight to its own tensor code (dataset.py:269); every surface here speaks
 * FASTA, and the library's `parseAlignmentSequences` has no XML branch, so an XML that supplies the
 * alignment has to be materialised before `prepareRun`, `diagnose()` or any size cap can see it.
 *
 * IT REFUSES RATHER THAN RENAMES, and that is a decision with an alternative that was rejected.
 * A BEAST taxon id is a free string; a FASTA name is the first whitespace token of a `>` line with
 * its quotes stripped. `fastaNameHazard` above records, with measurements, the three ways the gap
 * loses or invents a sequence. The two ways to close it:
 *
 *   SANITISE — rewrite `A seq1` as `A_seq1`, de-duplicate the collisions, carry the mapping in
 *   provenance. Rejected: the reader would then be reading a report about taxa they never named,
 *   the mapping is visible only to a surface that chooses to print it, and every downstream
 *   artefact — the alignment download, the site tree, the MCP reference command — would carry our
 *   names rather than theirs. Renaming a taxon behind the reader's back is the failure mode this
 *   whole directory exists to avoid.
 *
 *   REFUSE — throw, name the taxa, say what would have happened and what to do instead. Taken.
 *   It cannot be silenced by a surface that forgets to print a warning: `/time` shows the message
 *   as the drop's failure, and the MCP and the server return it as the error. The cost is that a
 *   document whose taxa carry spaces no longer yields an alignment; it was never yielding a
 *   CORRECT one, and the same XML still supplies its dates and its starting tree, so dropping a
 *   FASTA beside it is the whole fix.
 *
 * Nothing here refuses at PARSE time: an XML dropped for its dates alone is matched against the
 * reader's own alignment and never becomes FASTA, so the refusal belongs at the one point where a
 * name becomes a header — this function — and not before it.
 *
 * @param {{sequences: Map<string,string>, taxa: string[]}} parsed
 * @param {{lineWidth?: number}} [options] `0` (the default) writes each sequence on one line
 * @returns {string}
 * @throws {BeastFastaError} when a taxon id cannot be written as a FASTA header unchanged
 */
export function beastToFasta(parsed, options = {}) {
	const width = options.lineWidth ?? 0;
	const taxa = parsed?.taxa ?? [];

	// Checked over the taxa that will actually be WRITTEN: a name with no sequence never reaches a
	// header, so it cannot lose or invent one and is not this function's business.
	const written = Array.from(taxa).filter((t) => parsed?.sequences?.get(t) !== undefined);
	const unsafe = unsafeFastaNames(written);
	if (unsafe.length > 0) {
		const shown = unsafe
			.slice(0, 5)
			.map(({ name, hazard }) => `${showName(name)} ${HAZARD_CLAUSE[hazard]}`)
			.join('; ');
		const rest = unsafe.length > 5 ? ` (and ${unsafe.length - 5} more)` : '';
		throw new BeastFastaError(
			`The XML's alignment cannot be written as FASTA: ${unsafe.length} of ${written.length} ` +
				`taxon id(s) would not read back as themselves. ${shown}${rest}. The alignment reader ` +
				`names a sequence by the first whitespace token of its '>' line with the quotes stripped ` +
				`(parse_alignment_sequences, dataset.py:302-315), so these sequences would be renamed, ` +
				`merged into one another or split into records the XML never declared. Rename the taxa ` +
				`in the XML, or drop the alignment as its own FASTA file — the XML's dates and starting ` +
				`tree are still read either way.`,
			unsafe
		);
	}

	const out = [];
	for (const taxon of taxa) {
		const seq = parsed.sequences.get(taxon);
		if (seq === undefined) continue;
		out.push(`>${taxon}`);
		if (width > 0) {
			for (let i = 0; i < seq.length; i += width) out.push(seq.slice(i, i + width));
		} else {
			out.push(seq);
		}
	}
	return out.length > 0 ? `${out.join('\n')}\n` : '';
}
