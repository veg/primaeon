/**
 * beast-xml.test.js — the BEAST XML reader, against the reference's own two documents, then quirk
 * by quirk, then document by hostile document.
 *
 * WHY THIS FILE EXISTS. `runtime/src/dates/beast.js` is a port of `parse_beast_xml`
 * (hyphaeon/dataset.py:84-233), and a port is only a port if it reproduces the reference including
 * the parts nobody would write on purpose. So:
 *
 *   - THE ACCEPTANCE GATE is the two XML documents in `HyphAeon/tests/test_dating.py:115-175`,
 *     inlined VERBATIM, asserted against every assertion those tests make plus the full return the
 *     reference actually produces (`tree_newick`, `taxa`).
 *   - EVERY QUIRK IS PINNED, so a later "fix" fails here rather than silently changing numbers a
 *     reader will compare with `hyphaeon dating --beast`. Each expected value in this file was
 *     produced by RUNNING `hyphaeon.dataset.parse_beast_xml` (and
 *     `_parse_numeric_or_calendar_date`) on the same input, not by reading the source.
 *   - THE HOSTILE CORPUS is here because this reader is the one place a user's file reaches a
 *     parser with a DTD. The billion-laughs and quadratic-blowup documents must stay forever: the
 *     probe that designed this reader proved that charging entity DECLARATIONS rather than
 *     RESOLUTIONS lets the quadratic document through to a V8 "Invalid string length" crash.
 *
 * WHAT THE REFERENCE ANSWERED, MEASURED SIDE BY SIDE. On a 20-document corpus (the two acceptance
 * files, a namespaced BEAST 2, CDATA, BOM+CRLF, a legitimate internal entity, a parameter entity,
 * billion laughs, quadratic blowup, XXE by file and by http, an unused external DTD, 50,000-deep
 * nesting, mismatched tags, a truncated upload, `__proto__` names, a raw `&` in a Newick, an
 * escaped one, and a non-BEAST XML) this port returns EXACTLY what Python's ElementTree-backed
 * reference returns on 18, and differs on 2 by deliberate, documented policy: the 50,000-deep
 * document (we refuse at depth 512; the reference reads it in 37.8 ms) and the parameter-entity
 * document (we refuse as an undefined entity; the reference parses it and silently drops the taxon
 * the entity named — measured: 0 sequences, 0 dates either way).
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
	parseBeastXml,
	beastDateParse,
	beastDateValue,
	beastDatesForTaxa,
	beastToFasta,
	BeastFastaError,
	FASTA_NAME_HAZARDS,
	fastaNameHazard,
	unsafeFastaNames,
	parseXmlDocument,
	iterElements,
	createWorkBudget,
	chargeWork,
	XmlReadError,
	XML_LIMITS,
	XML_REFUSALS,
	ingestDates,
	taxaForDates,
	hasDateLayer,
	missingDateExports,
	BEAST_DATE_RULES,
	BEAST_MATCH_TIERS,
	DATE_MATCH_TIERS,
	DATE_DIAGNOSTIC_CODES,
	detectDateSourceKind
} from '../src/dates/index.js';
import { parseDate, parseAlignmentSequences } from '../src/dates/library.js';
import { newickLabel } from '../src/nj.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNTIME = join(HERE, '..');
const ENGINE = process.env.HYPHAEON_ENGINE_DIR ?? join(RUNTIME, '..', '..', 'HyphAeon');
const EXAMPLES = join(ENGINE, 'examples');

const HAS_LIBRARY = hasDateLayer();
if (!HAS_LIBRARY) {
	console.warn(
		`\n[beast-xml] SUITE SKIPPED — the linked @veg/hyphaeon-js does not export ` +
			`${missingDateExports().join(', ')}.\n`
	);
}
const HAS_EXAMPLES = existsSync(join(EXAMPLES, 'H5N1_HA_geo.fasta'));
if (!HAS_EXAMPLES) console.warn(`\n[beast-xml] EXAMPLE-FILE CASES SKIPPED — needs ${EXAMPLES}.\n`);

const suite = describe.skipIf(!HAS_LIBRARY);
const withExamples = describe.skipIf(!HAS_LIBRARY || !HAS_EXAMPLES);

const codes = (ingest) => ingest.warnings.map((w) => w.code);
const pick = (ingest, code) => ingest.warnings.find((w) => w.code === code);

// =================================================================================================
// The acceptance gate: the reference's own two documents
// =================================================================================================

/** HyphAeon/tests/test_dating.py:119-134, verbatim. */
const BEAST1_XML = `<?xml version="1.0" standalone="yes"?>
<beast version="1.10.4">
    <taxa id="taxa">
        <taxon id="taxon_A"><date value="1980.0" direction="forwards" units="years"/></taxon>
        <taxon id="taxon_B"><date value="1990.0" direction="forwards" units="years"/></taxon>
        <taxon id="taxon_C"><date value="2000.0" direction="forwards" units="years"/></taxon>
        <taxon id="taxon_D"><date value="2010.0" direction="forwards" units="years"/></taxon>
    </taxa>
    <alignment id="alignment" dataType="nucleotide">
        <sequence><taxon idref="taxon_A"/>ATGGCC</sequence>
        <sequence><taxon idref="taxon_B"/>ATGGCA</sequence>
        <sequence><taxon idref="taxon_C"/>ATGGTA</sequence>
        <sequence><taxon idref="taxon_D"/>TTGGTA</sequence>
    </alignment>
    <newick id="startingTree">((taxon_A:0.01,taxon_B:0.02):0.05,(taxon_C:0.03,taxon_D:0.04):0.05);</newick>
</beast>
`;

/** HyphAeon/tests/test_dating.py:152-167, verbatim. */
const BEAST2_XML = `<beast version="2.6" namespace="beast.evolution.alignment:beast.evolution.tree">
    <data id="h1n1" name="alignment">
        <sequence id="seq_A" taxon="isolate_A" value="ATGGCC"/>
        <sequence id="seq_B" taxon="isolate_B" value="ATGGCA"/>
        <sequence id="seq_C" taxon="isolate_C" value="ATGGTA"/>
        <sequence id="seq_D" taxon="isolate_D" value="TTGGTA"/>
    </data>
    <trait id="dateTrait" spec="beast.evolution.tree.TraitSet" traitname="date" value="
        isolate_A=1990.25,
        isolate_B=2000.50,
        isolate_C=2010.75,
        isolate_D=2020.00
    "/>
</beast>
`;

suite('the reference\'s own acceptance documents (tests/test_dating.py:115-175)', () => {
	it('test_parse_beast_1_xml: every assertion it makes, plus the full return it does not check', () => {
		const r = parseBeastXml(BEAST1_XML);
		// tests/test_dating.py:138-146
		expect(r.version).toBe('BEAST 1');
		expect(r.sequences.size).toBe(4);
		expect(r.sequences.get('taxon_A')).toBe('ATGGCC');
		expect(r.dates.size).toBe(4);
		expect(r.dates.get('taxon_A')).toBe(1980.0);
		expect(r.dates.get('taxon_D')).toBe(2010.0);
		expect(r.tree_newick).not.toBeNull();
		expect(r.tree_newick).toContain('taxon_A');
		// measured on the reference, which its own test does not assert
		expect(r.tree_newick).toBe(
			'((taxon_A:0.01,taxon_B:0.02):0.05,(taxon_C:0.03,taxon_D:0.04):0.05);'
		);
		expect(r.taxa).toEqual(['taxon_A', 'taxon_B', 'taxon_C', 'taxon_D']);
		expect(Object.fromEntries(r.sequences)).toEqual({
			taxon_A: 'ATGGCC',
			taxon_B: 'ATGGCA',
			taxon_C: 'ATGGTA',
			taxon_D: 'TTGGTA'
		});
	});

	it('the BEAST 1 sequence is read from the TAXON CHILD\'S TAIL, which is why tails exist here', () => {
		const r = parseBeastXml(BEAST1_XML);
		expect(r.provenance.sequence_sources).toEqual({ value_attr: 0, element_text: 0, taxon_tail: 4 });
	});

	it('test_parse_beast_2_xml: every assertion it makes, plus tree_newick === null', () => {
		const r = parseBeastXml(BEAST2_XML);
		// tests/test_dating.py:169-175
		expect(r.version).toBe('BEAST 2');
		expect(r.sequences.size).toBe(4);
		expect(r.sequences.get('isolate_A')).toBe('ATGGCC');
		expect(r.dates.size).toBe(4);
		expect(r.dates.get('isolate_A')).toBe(1990.25);
		expect(r.dates.get('isolate_D')).toBe(2020.0);
		// measured on the reference
		expect(r.tree_newick).toBeNull();
		expect(r.taxa).toEqual(['isolate_A', 'isolate_B', 'isolate_C', 'isolate_D']);
	});

	it('both documents date their taxa end to end, through ingestDates', () => {
		const ing = ingestDates({
			taxa: ['taxon_A', 'taxon_B', 'taxon_C', 'taxon_D'],
			source: BEAST1_XML,
			sourceName: 'beast1.xml'
		});
		expect(ing.ok).toBe(true);
		expect(ing.source).toBe('beast');
		expect(ing.source_kind).toBe('beast');
		expect(ing.coverage.dated).toBe(4);
		expect(ing.coverage.from_beast).toBe(4);
		expect(ing.rows.map((r) => r.value)).toEqual([1980, 1990, 2000, 2010]);
		expect(ing.by_rule).toEqual({ beast_float: 4 });
		expect(ing.rows[0].source).toBe('beast');
		expect(ing.rows[0].raw).toBe('1980.0');
		expect(ing.beast.version).toBe('BEAST 1');
		expect(ing.beast.tree_present).toBe(true);
		expect(ing.beast.sequences).toBe(4);
	});
});

// =================================================================================================
// `_parse_numeric_or_calendar_date` (dataset.py:62-81), and the divergence the exemption buys
// =================================================================================================

suite('the BEAST date helper is the REFERENCE\'S second parser, not the library\'s', () => {
	// Every expected value below was produced by running
	// `hyphaeon.dataset._parse_numeric_or_calendar_date` on the same string.
	const REFERENCE_ANSWERS = [
		['2005', 2005.0, BEAST_DATE_RULES.FLOAT],
		['2021-04-15', 2021.28832991102, BEAST_DATE_RULES.YMD],
		['2021/04/15', 2021.28832991102, BEAST_DATE_RULES.YMD],
		['2019-03-31', 2019.2488021902807, BEAST_DATE_RULES.YMD],
		['2020-12-31', 2020.9988021902807, BEAST_DATE_RULES.YMD],
		['2021-04', 2021.2916666666667, BEAST_DATE_RULES.YEAR_MONTH],
		['1799', 1799.0, BEAST_DATE_RULES.FLOAT],
		['2150', 2150.0, BEAST_DATE_RULES.FLOAT],
		['50', 50.0, BEAST_DATE_RULES.FLOAT],
		['-3', -3.0, BEAST_DATE_RULES.FLOAT],
		['1e9', 1000000000.0, BEAST_DATE_RULES.FLOAT],
		['1_000', 1000.0, BEAST_DATE_RULES.FLOAT],
		['2020-13-45', 2021.1204654346338, BEAST_DATE_RULES.YMD],
		['2020-00-00', 2019.9139288158797, BEAST_DATE_RULES.YMD],
		['2020-02-31', 2020.1654688569472, BEAST_DATE_RULES.YMD]
	];

	it('reproduces the reference value for value, including the ungated and the impossible', () => {
		for (const [s, value, rule] of REFERENCE_ANSWERS) {
			expect(beastDateValue(s), s).toBe(value);
			expect(beastDateParse(s).rule, s).toBe(rule);
		}
	});

	it('THE DIVERGENCE, ASSERTED RATHER THAN WAIVED: 2019-03-31 is 2.815 days from the library', () => {
		// This is the whole justification for `beast.js`'s NO SECOND PARSER exemption. The reference
		// has TWO string-to-time functions and they disagree; the library mirrors the other one.
		const beast = beastDateValue('2019-03-31');
		const library = parseDate('2019-03-31', { timeUnits: 'years' }).value;
		expect(beast).toBe(2019.2488021902807);
		expect(library).toBe(2019.2410958904109);
		expect((beast - library) * 365.25).toBeCloseTo(2.8147, 3);
	});

	it('a value the reference keeps is NaN under the library\'s gate, which is why it is never re-read', () => {
		for (const s of ['1799', '2150', '50', '-3', '1e9']) {
			expect(beastDateValue(s), s).not.toBeNull();
			expect(Number.isNaN(parseDate(s, { timeUnits: 'years' }).value), s).toBe(true);
		}
	});

	it('parses Python\'s float grammar, not JavaScript\'s: 1_000 yes, 0x10 no, \'\' no', () => {
		expect(beastDateValue('1_000')).toBe(1000);
		expect(beastDateValue('0x10')).toBeNull();
		expect(beastDateValue('')).toBeNull();
		expect(beastDateValue('   ')).toBeNull();
		expect(beastDateValue('2005-XX-XX')).toBeNull();
		expect(beastDateValue('nan')).toBeNaN();
		expect(beastDateValue('inf')).toBe(Infinity);
		expect(beastDateValue('-inf')).toBe(-Infinity);
	});

	it('strips quotes as a CHAR SET, the way Python\'s str.strip("\'\\"") does', () => {
		expect(beastDateValue("''2005''")).toBe(2005);
		expect(beastDateValue('"2005')).toBe(2005);
	});

	// ---------------------------------------------------------------------------------------------
	// dataset.py:66 is `s = str(v_str).strip().strip("'\"")` — whitespace FIRST, quotes SECOND, and
	// never whitespace again. So anything written INSIDE a NEXUS-style quoted value survives into
	// `float()` and into the two calendar regular expressions, where three Python behaviours that
	// have no JavaScript equivalent decide the answer. Every value below was produced by running
	// `hyphaeon.dataset._parse_numeric_or_calendar_date` on CPython 3.14.0, not by reading the
	// source; a port that used `Number`, `String.prototype.trim` and a bare `$` returned `null` for
	// all but one of them and silently left the taxon undated.
	// ---------------------------------------------------------------------------------------------
	it('float() TOLERATES SURROUNDING WHITESPACE, so a quoted, padded value is still a date', () => {
		expect(beastDateValue("' 2011.5 '")).toBe(2011.5);
		expect(beastDateValue("'\t1980\t'")).toBe(1980);
		expect(beastDateValue("'\n1980.0\n'")).toBe(1980);
		expect(beastDateValue("' 1e9 '")).toBe(1000000000);
		expect(beastDateValue("'1_000 '")).toBe(1000);
		expect(beastDateValue("'.5 '")).toBe(0.5);
		expect(beastDateValue("' nan '")).toBeNaN();
		// …but NOT U+FEFF, which `float()` refuses and `String.prototype.trim` would have removed.
		expect(beastDateValue("'\ufeff1980'")).toBeNull();
		expect(beastDateValue('\ufeff1980')).toBeNull();
	});

	it("Python's `$` matches before ONE trailing newline, and JavaScript's does not", () => {
		expect(beastDateValue("'2019-03-31\n'")).toBe(2019.2488021902807);
		expect(beastDateParse("'2019-03-31\n'").rule).toBe(BEAST_DATE_RULES.YMD);
		expect(beastDateValue("'2019-03\n'")).toBe(2019.2083333333333);
		expect(beastDateParse("'2019-03\n'").rule).toBe(BEAST_DATE_RULES.YEAR_MONTH);
		// One newline only, and a carriage return is not a newline.
		expect(beastDateValue("'2019-03-31\n\n'")).toBeNull();
		expect(beastDateValue("'2019-03-31\r'")).toBeNull();
		// Unquoted, `str.strip()` has already removed both and the value parses either way.
		expect(beastDateValue('2019-03-31\n\n')).toBe(2019.2488021902807);
		expect(beastDateValue('2019-03-31\r')).toBe(2019.2488021902807);
	});

	it("str.strip() is not trim(): it takes U+0085 and leaves U+FEFF, and both change an answer", () => {
		// NEL is whitespace to Python and not to JavaScript, so `str.strip()` uncovers the date.
		expect(beastDateValue('\u00852019-03-31')).toBe(2019.2488021902807);
		expect(beastDateValue('\u00851980')).toBe(1980);
		expect(beastDateValue("'\u00851982\u0085'")).toBe(1982); // float()'s own space set
		expect(beastDateValue("'\u00852019-03-31'")).toBeNull(); // …which the regex does not share
		// U+3000 is whitespace to both.
		expect(beastDateValue('\u30001980')).toBe(1980);
		expect(beastDateValue("'\u30002019-03-31'")).toBeNull();
	});

	it('counts EVERY Unicode decimal digit, as float(), re and int() all do', () => {
		expect(beastDateValue('١٩٨٠')).toBe(1980); // Arabic-Indic 1980
		expect(beastDateValue('１９８０')).toBe(1980); // fullwidth 1980
		expect(beastDateValue('١٩٨٠-٠٣-٠٥')).toBe(
			1980.1776180698153
		);
		expect(beastDateParse('١٩٨٠-٠٣-٠٥').rule).toBe(
			BEAST_DATE_RULES.YMD
		);
		expect(beastDateValue('١9')).toBe(19); // the scripts may be MIXED
		expect(beastDateValue('1٩')).toBe(19);
	});

	it('the same three rules reach a whole document, values and sequences alike', () => {
		// Measured against `parse_beast_xml` on this exact document: dates {C, D, E} only, and
		// sequence A KEEPS its U+FEFF because Python's `\s` does not match it.
		const xml = [
			'<?xml version="1.0"?>',
			'<beast version="1.10.4">',
			'  <taxa>',
			'    <taxon id="A"><date>\'\u00852019-03-31\'</date></taxon>',
			'    <taxon id="B"><date>\'\ufeff1980\'</date></taxon>',
			'    <taxon id="C"><date>\'\u30001981\'</date></taxon>',
			'    <taxon id="D"><date value="\'\u00851982\u0085\'"/></taxon>',
			'  </taxa>',
			'  <alignment>',
			'    <sequence><taxon idref="A"/>AC\ufeffGT</sequence>',
			'    <sequence><taxon idref="B"/>AC\u0085GT</sequence>',
			'    <sequence><taxon idref="C"/>AC\u3000GT</sequence>',
			'    <sequence><taxon idref="D"/>AC GT</sequence>',
			'  </alignment>',
			'  <trait traitname="date" value="E=\u00851990\u0085,F=\ufeff1991"/>',
			'</beast>'
		].join('\n');
		const got = parseBeastXml(xml);
		expect([...got.dates.keys()]).toEqual(['C', 'D', 'E']);
		expect([...got.dates.values()]).toEqual([1981, 1982, 1990]);
		expect(got.sequences.get('A')).toBe('AC\ufeffGT');
		expect(got.sequences.get('B')).toBe('ACGT');
		expect(got.sequences.get('C')).toBe('ACGT');
		expect(got.sequences.get('D')).toBe('ACGT');
	});
});

// =================================================================================================
// The quirks, pinned one at a time
// =================================================================================================

suite('every upstream quirk is replicated, and a later "fix" fails here', () => {
	it('QUIRK dataset.py:118 — ONE `spec` attribute anywhere makes a BEAST 1.10 file "BEAST 2"', () => {
		const one = '<beast version="1.10.4"><x spec="anything"/><taxa><taxon id="a"><date value="2000"/></taxon></taxa></beast>';
		expect(parseBeastXml(one).version).toBe('BEAST 2');
	});

	it('QUIRK dataset.py:117 — the `namespace` clause is DEAD CODE, so the namespace is never read', () => {
		// The reference's own BEAST 2 fixture is called BEAST 2 only by the `spec` clause. Measured:
		// delete the one `spec=` on its <trait> and the same file, namespace and <data> block intact,
		// reports 'BEAST 1'.
		const withoutSpec = BEAST2_XML.replace(' spec="beast.evolution.tree.TraitSet"', '');
		expect(withoutSpec).toContain('namespace="beast.evolution.alignment');
		expect(parseBeastXml(withoutSpec).version).toBe('BEAST 1');
		expect(parseBeastXml(BEAST2_XML).version).toBe('BEAST 2');
	});

	it('QUIRK — `direction` and `units` are never read: a backwards age becomes the year 10', () => {
		const xml = '<beast><taxa><taxon id="a"><date value="10" direction="backwards" units="days"/></taxon></taxa></beast>';
		const r = parseBeastXml(xml);
		expect(r.dates.get('a')).toBe(10.0);
		expect(r.provenance.direction_attrs).toBe(1);
		expect(r.provenance.units_attrs).toBe(1);
	});

	it('QUIRK dataset.py:152 — the alignment with the most TAXA wins, and a tie goes to the first', () => {
		const twoBlocks =
			'<beast><alignment><sequence taxon="a" value="AAA"/></alignment>' +
			'<alignment><sequence taxon="b" value="CCC"/></alignment></beast>';
		expect(Object.fromEntries(parseBeastXml(twoBlocks).sequences)).toEqual({ a: 'AAA' });
		const biggerSecond =
			'<beast><alignment><sequence taxon="a" value="AAA"/></alignment>' +
			'<alignment><sequence taxon="b" value="CCC"/><sequence taxon="c" value="GGG"/></alignment></beast>';
		expect(Object.keys(Object.fromEntries(parseBeastXml(biggerSecond).sequences))).toEqual(['b', 'c']);
		expect(parseBeastXml(biggerSecond).provenance.alignments.seen).toBe(2);
		expect(parseBeastXml(biggerSecond).provenance.alignments.chosen_index).toBe(1);
	});

	it('QUIRK dataset.py:123 — every <alignment> is searched before every <data>, whatever the order', () => {
		const dataFirst =
			'<beast><data><sequence taxon="b" value="CCC"/></data>' +
			'<alignment><sequence taxon="a" value="AAA"/></alignment></beast>';
		// One taxon each: the tie goes to the FIRST candidate, and `<alignment>` is always first.
		expect(Object.fromEntries(parseBeastXml(dataFirst).sequences)).toEqual({ a: 'AAA' });
	});

	it('QUIRK dataset.py:139 — an empty `value=""` beats the element\'s own text', () => {
		const seq = '<beast><alignment><sequence taxon="a" value="">ATG</sequence></alignment></beast>';
		expect(parseBeastXml(seq).sequences.size).toBe(0);
		const trait = '<beast><trait traitname="date" value="">a=1980</trait></beast>';
		expect(parseBeastXml(trait).dates.size).toBe(0);
		const traitText = '<beast><trait traitname="date">a=1980</trait></beast>';
		expect(parseBeastXml(traitText).dates.get('a')).toBe(1980);
	});

	it('QUIRK dataset.py:177 — the trait test is a SUBSTRING test, so `dateBackward` is read as dates', () => {
		const xml = '<beast><trait traitname="dateBackward" value="a=5,b=10"/><trait traitname="location" value="a=UK"/></beast>';
		const r = parseBeastXml(xml);
		expect(Object.fromEntries(r.dates)).toEqual({ a: 5, b: 10 });
		expect(r.provenance.traits.find((t) => t.name === 'dateBackward').exact).toBe(false);
		expect(r.provenance.traits.some((t) => t.name === 'location')).toBe(false);
	});

	it('QUIRK — a duplicate taxon silently takes the LAST value, in both maps', () => {
		const xml =
			'<beast><taxa><taxon id="a"><date value="1980"/></taxon><taxon id="a"><date value="1999"/></taxon></taxa>' +
			'<alignment><sequence taxon="a" value="AAA"/><sequence taxon="a" value="CCC"/></alignment></beast>';
		const r = parseBeastXml(xml);
		expect(r.dates.get('a')).toBe(1999);
		expect(r.sequences.get('a')).toBe('CCC');
		expect(r.provenance.duplicates).toEqual({ sequences: ['a'], dates: ['a'] });
	});

	it('QUIRK dataset.py:192-202 — the seq_ dance RENAMES a sequence and GROWS the date map', () => {
		const renames = '<beast><alignment><sequence id="seq_A" value="ATG"/></alignment><taxa><taxon id="A"><date value="1980"/></taxon></taxa></beast>';
		const r1 = parseBeastXml(renames);
		expect(Object.fromEntries(r1.sequences)).toEqual({ A: 'ATG' });
		expect(r1.taxa).toEqual(['A']);
		expect(r1.provenance.reconciliation.renamed).toEqual([{ from: 'seq_A', to: 'A' }]);

		const grows = '<beast><alignment><sequence id="A" value="ATG"/></alignment><taxa><taxon id="seq_A"><date value="1980"/></taxon></taxa></beast>';
		const r2 = parseBeastXml(grows);
		expect(Object.fromEntries(r2.sequences)).toEqual({ A: 'ATG' });
		expect(Object.fromEntries(r2.dates)).toEqual({ seq_A: 1980, A: 1980 });
		expect(r2.provenance.reconciliation.dates_added).toEqual(['A']);
	});

	it('the OTHER ladder, dating.py:436-442, is read-only and keyed on the ORIGINAL taxon', () => {
		const parsed = parseBeastXml(
			'<beast><taxa><taxon id="A"><date value="1980"/></taxon><taxon id="seq_B"><date value="1990"/></taxon></taxa></beast>'
		);
		const before = parsed.dates.size;
		const out = beastDatesForTaxa(["'A'", 'seq_A', 'B', 'missing'], parsed);
		expect(Object.fromEntries(out)).toEqual({ "'A'": 1980, seq_A: 1980, B: 1990 });
		// it never writes back, unlike the reconciliation inside the parser
		expect(parsed.dates.size).toBe(before);
	});

	it('QUIRK dataset.py:147 — `U` becomes `T` unconditionally, whatever the dataType says', () => {
		const xml = '<beast><alignment dataType="aminoacid"><sequence taxon="a" value="MUK"/></alignment></beast>';
		expect(parseBeastXml(xml).sequences.get('a')).toBe('MTK');
	});

	it('a sequence is whitespace-stripped and upper-cased, so a multi-line block joins', () => {
		const xml = '<beast><alignment><sequence><taxon idref="a"/>\n   atg gcc\n  </sequence></alignment></beast>';
		expect(parseBeastXml(xml).sequences.get('a')).toBe('ATGGCC');
	});

	it('QUIRK dataset.py:210-216 — the attribute branch\'s `break` is the INNER one, so text wins', () => {
		const both = '<beast><tree newick="(a:1,b:2);">(c:1,d:2);</tree></beast>';
		expect(parseBeastXml(both).tree_newick).toBe('(c:1,d:2);');
		const attrOnly = '<beast><tree newick="(a:1,b:2);"/></beast>';
		expect(parseBeastXml(attrOnly).tree_newick).toBe('(a:1,b:2);');
	});

	it('QUIRK dataset.py:214 — a Newick without a `;` is found only by a `newick`-named tag', () => {
		expect(parseBeastXml('<beast><init>((A:1,B:1):1)</init></beast>').tree_newick).toBeNull();
		expect(parseBeastXml('<beast><init>((A:1,B:1):1);</init></beast>').tree_newick).toBe('((A:1,B:1):1);');
		expect(parseBeastXml('<beast><newick>((A:1,B:1):1)</newick></beast>').tree_newick).toBe('((A:1,B:1):1);');
		// a leading NEXUS-style comment kills detection outright: every branch requires `(` first
		expect(parseBeastXml('<beast><newick>[c]((A:1,B:1):1);</newick></beast>').tree_newick).toBeNull();
	});

	it('QUIRK dataset.py:222-223 — `[&…]` and `{…}` are stripped, a `[…]` without `&` is not', () => {
		const annotated = '<beast><newick>((a:0.01[&amp;rate=0.1],b:0.02{FG}):0.05);</newick></beast>';
		expect(parseBeastXml(annotated).tree_newick).toBe('((a:0.01,b:0.02):0.05);');
		const plainComment = '<beast><newick>((a:0.01[note],b:0.02):0.05);</newick></beast>';
		expect(parseBeastXml(plainComment).tree_newick).toBe('((a:0.01[note],b:0.02):0.05);');
	});

	it('QUIRK — the tree is taken from ANY element whose text starts `(` and ends `;`', () => {
		const fromComment = '<beast><comment>(a:1,b:2);</comment></beast>';
		const r = parseBeastXml(fromComment);
		expect(r.tree_newick).toBe('(a:1,b:2);');
		expect(r.provenance.tree_from).toBe('<comment> text');
	});

	it('QUIRK — a namespaced document reads as EMPTY and is labelled BEAST 1', () => {
		const xml = '<beast xmlns="http://beast2.org" version="2.6"><data><sequence taxon="a" value="ATG"/></data></beast>';
		const r = parseBeastXml(xml);
		expect(r.version).toBe('BEAST 1');
		expect(r.sequences.size).toBe(0);
		expect(r.dates.size).toBe(0);
		expect(r.tree_newick).toBeNull();
		expect(r.provenance.namespaced).toBe(true);
	});

	it('QUIRK — the BEAST 2 pass runs after the BEAST 1 pass and overwrites it', () => {
		const xml =
			'<beast><taxa><taxon id="a"><date value="1980"/></taxon></taxa>' +
			'<trait traitname="date" value="a=2020"/></beast>';
		expect(parseBeastXml(xml).dates.get('a')).toBe(2020);
	});

	it('`<taxon date="…">` is read too, and a <date> child\'s TEXT when it has no value', () => {
		expect(parseBeastXml('<beast><taxa><taxon id="a" date="1980"/></taxa></beast>').dates.get('a')).toBe(1980);
		expect(
			parseBeastXml('<beast><taxa><taxon id="a"><date>1980</date></taxon></taxa></beast>').dates.get('a')
		).toBe(1980);
	});
});

// =================================================================================================
// The reader: hostile documents, and the policy that is ours
// =================================================================================================

suite('the XML reader refuses what the reference refuses, and fetches nothing, ever', () => {
	const refusal = (xml, options) => {
		try {
			parseBeastXml(xml, options);
			return null;
		} catch (err) {
			expect(err).toBeInstanceOf(XmlReadError);
			return err.reason;
		}
	};

	it('malformed: mismatched tags and a half-truncated upload are REFUSED, never half-read', () => {
		// This is the whole reason a strict parser was required: the tolerant one already in the web
		// bundle returned 973 of 2,000 sequences from a truncated file with no error at all.
		expect(refusal('<beast><alignment><sequence taxon="a" value="ATG"/></align></beast>')).toBe('malformed');
		expect(refusal('<beast><alignment><sequence taxon="a" value="ATG"/><sequence taxon="b" val')).toBe('malformed');
		expect(refusal('')).toBe('malformed');
		expect(refusal('not xml at all')).toBe('malformed');
	});

	it('a raw `&` in a Newick annotation refuses the whole document, exactly as the reference does', () => {
		// Measured, Python: "not well-formed (invalid token): line 1, column 29".
		expect(refusal('<beast><newick>((a:0.01[&rate=0.1],b:0.02):0.05);</newick></beast>')).toBe('malformed');
	});

	it('XXE: a SYSTEM entity is never resolved, by file or by http, and the file is refused', () => {
		expect(refusal('<?xml version="1.0"?><!DOCTYPE r [ <!ENTITY xxe SYSTEM "file:///etc/passwd"> ]><beast><alignment><sequence taxon="a" value="&xxe;"/></alignment></beast>')).toBe('malformed');
		expect(refusal('<?xml version="1.0"?><!DOCTYPE r [ <!ENTITY xxe SYSTEM "http://127.0.0.1:9713/canary"> ]><beast><alignment><sequence taxon="a" value="&xxe;"/></alignment></beast>')).toBe('malformed');
	});

	it('an external DTD that is DECLARED but never used parses, because the reference parses it', () => {
		const xml = '<?xml version="1.0"?><!DOCTYPE beast SYSTEM "http://127.0.0.1:9713/dtd"><beast><alignment><sequence taxon="a" value="ATG"/></alignment></beast>';
		expect(parseBeastXml(xml).sequences.get('a')).toBe('ATG');
	});

	it('a LEGITIMATE internal entity is expanded, because the reference expands it', () => {
		const xml = '<?xml version="1.0"?>\n<!DOCTYPE beast [ <!ENTITY taxonA "SeqAlpha"> ]>\n<beast><alignment><sequence taxon="&taxonA;" value="ATG"/></alignment></beast>';
		const r = parseBeastXml(xml);
		expect(Object.fromEntries(r.sequences)).toEqual({ SeqAlpha: 'ATG' });
		expect(r.provenance.doctype_entities.declared).toEqual(['taxonA']);
	});

	it('billion laughs is refused by the entity budget, as expat refuses it upstream', () => {
		let xml = '<?xml version="1.0"?>\n<!DOCTYPE lolz [\n<!ENTITY lol "lol">\n';
		for (let i = 1; i < 10; i++) {
			const prev = i === 1 ? 'lol' : `lol${i - 1}`;
			xml += `<!ENTITY lol${i} "${`&${prev};`.repeat(10)}">\n`;
		}
		xml += ']>\n<beast><alignment><sequence taxon="a" value="&lol9;"/></alignment></beast>';
		expect(refusal(xml)).toBe('entity_expansion');
	});

	it('QUADRATIC BLOWUP is refused too — the budget charges RESOLUTIONS, not declarations', () => {
		// The probe's own bug, kept as a test forever: one 100 KB entity is inside any DECLARATION
		// budget, and referencing it 10,000 times produced a V8 "Invalid string length" crash rather
		// than a refusal until every resolution was charged.
		const body = Array.from({ length: 10000 }, (_, i) => `<sequence taxon="t${i}" value="&big;"/>`).join('');
		const xml = `<?xml version="1.0"?>\n<!DOCTYPE q [ <!ENTITY big "${'A'.repeat(100000)}"> ]>\n<beast><alignment>${body}</alignment></beast>`;
		expect(refusal(xml)).toBe('entity_expansion');
	});

	it('the reader holds no filesystem and no network, which is why none of the above can fetch', () => {
		const sources = ['xml.js', 'beast.js'].map((f) => readFileSync(join(RUNTIME, 'src', 'dates', f), 'utf8'));
		for (const text of sources) {
			const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
			expect(code).not.toMatch(/from\s+['"]node:/);
			expect(code).not.toMatch(/\bfetch\s*\(/);
			expect(code).not.toMatch(/XMLHttpRequest|require\(/);
		}
	});

	it('DIVERGENCE, ours: nesting deeper than the cap is refused where the reference reads it', () => {
		// Measured: ElementTree reads a 50,000-deep document in 37.8 ms. Under saxes's `xmlns: true`
		// namespace resolution is O(depth), so the same document costs 10.4 s here — a text file that
		// hangs a browser worker. BEAST XML nests under 30.
		const deep = `<beast>${'<n>'.repeat(600)}<alignment><sequence taxon="a" value="ATG"/></alignment>${'</n>'.repeat(600)}</beast>`;
		expect(refusal(deep)).toBe('too_deep');
		expect(XML_LIMITS.maxDepth).toBe(512);
	});

	it('DIVERGENCE, ours: a document larger than the cap is refused unread', () => {
		const big = `<beast>${' '.repeat(XML_LIMITS.maxChars)}</beast>`;
		expect(refusal(big)).toBe('too_large');
	});

	it('DIVERGENCE, ours: a parameter-entity reference is refused where the reference reads it empty', () => {
		// Measured, Python: ok, 0 sequences, 0 dates — the taxon the entity named is silently
		// dropped. Both sides end with no data; ours says why.
		const xml = '<?xml version="1.0"?>\n<!DOCTYPE beast [ <!ENTITY % p "<!ENTITY inner \'SeqP\'>"> %p; ]>\n<beast><alignment><sequence taxon="&inner;" value="ATG"/></alignment></beast>';
		expect(refusal(xml)).toBe('malformed');
	});

	it('CDATA, a BOM, CRLF and a `__proto__` taxon are all read the way the reference reads them', () => {
		const cdata = '<beast><alignment><sequence><taxon idref="a"/><![CDATA[ATG GCC]]></sequence></alignment></beast>';
		expect(parseBeastXml(cdata).sequences.get('a')).toBe('ATGGCC');

		const bom = '﻿<?xml version="1.0"?>\r\n<beast>\r\n<alignment><sequence taxon="a" value="ATG"/></alignment>\r\n</beast>\r\n';
		expect(parseBeastXml(bom).sequences.get('a')).toBe('ATG');

		// Python counted 1 date for a taxon literally named `__proto__`; a plain `{}` on this side
		// counted 0, because the prototype setter swallowed it.
		const proto = '<beast><__proto__><alignment><sequence taxon="__proto__" value="ATG"/></alignment></__proto__><taxa><taxon id="__proto__"><date value="1999"/></taxon></taxa></beast>';
		const r = parseBeastXml(proto);
		expect(r.sequences.size).toBe(1);
		expect(r.dates.size).toBe(1);
		expect(r.dates.get('__proto__')).toBe(1999);
		expect(Object.getPrototypeOf({}).polluted).toBeUndefined();
	});

	it('the node shape is ElementTree\'s: tag, attrib, text, tail, children, and {uri}local', () => {
		const doc = parseXmlDocument('<a xmlns:x="http://x" id="1"><b/>tail<x:c y="2"/></a>');
		expect(doc.root.tag).toBe('a');
		expect(doc.root.attrib.id).toBe('1');
		expect(doc.root.attrib.xmlns).toBeUndefined();
		expect(doc.root.children[0].tail).toBe('tail');
		expect(doc.root.children[1].tag).toBe('{http://x}c');
		expect(doc.root.children[1].attrib.y).toBe('2');
		expect(doc.depth).toBe(2);
		expect(doc.elements).toBe(3);
	});
});

// =================================================================================================
// The ingest path: what a BEAST XML does to a run, and the refusals that replace the blanket one
// =================================================================================================

suite('ingestDates reads a BEAST XML, and refuses four narrower things instead of all of them', () => {
	it('DATES_BEAST_XML_UNSUPPORTED is gone from the vocabulary, in favour of the narrow codes', () => {
		expect(DATE_DIAGNOSTIC_CODES).not.toContain('DATES_BEAST_XML_UNSUPPORTED');
		for (const code of [
			'DATES_XML_UNPARSABLE',
			'DATES_XML_UNSAFE',
			'DATES_BEAST_NOT_BEAST',
			'DATES_BEAST_NO_DATES'
		]) {
			expect(DATE_DIAGNOSTIC_CODES).toContain(code);
		}
	});

	it('not XML: DATES_XML_UNPARSABLE, with the parser\'s own line and column', () => {
		const ing = ingestDates({ taxa: ['a', 'b', 'c'], source: '<beast><taxa></beast>', sourceName: 'run.xml' });
		expect(ing.ok).toBe(false);
		expect(codes(ing)).toContain('DATES_XML_UNPARSABLE');
		const w = pick(ing, 'DATES_XML_UNPARSABLE');
		expect(w.severity).toBe('refuse');
		expect(w.data.line).toBe(1);
		expect(w.message).toMatch(/gzipped/);
	});

	it('an entity bomb is DATES_XML_UNSAFE, and says nothing was fetched', () => {
		const body = Array.from({ length: 10000 }, (_, i) => `<sequence taxon="t${i}" value="&big;"/>`).join('');
		const xml = `<?xml version="1.0"?>\n<!DOCTYPE q [ <!ENTITY big "${'A'.repeat(100000)}"> ]>\n<beast><alignment>${body}</alignment></beast>`;
		const ing = ingestDates({ taxa: ['a', 'b', 'c'], source: xml, sourceName: 'bomb.xml' });
		expect(ing.ok).toBe(false);
		const w = pick(ing, 'DATES_XML_UNSAFE');
		expect(w.severity).toBe('refuse');
		expect(w.data.reason).toBe('entity_expansion');
		expect(w.message).toMatch(/fetched or opened/);
	});

	it('XML that is not BEAST: DATES_BEAST_NOT_BEAST, naming the namespace trap', () => {
		const ing = ingestDates({
			taxa: ['a', 'b', 'c'],
			source: '<?xml version="1.0"?><root><a/></root>',
			sourceName: 'other.xml'
		});
		expect(ing.ok).toBe(false);
		const w = pick(ing, 'DATES_BEAST_NOT_BEAST');
		expect(w.severity).toBe('refuse');
		expect(w.data.version).toBe('BEAST XML');
		expect(w.message).toMatch(/namespace/);
	});

	it('a BEAST XML with no dates refuses — unless the headers rescued the run', () => {
		const noDates = '<beast><alignment><sequence taxon="a" value="ATG"/></alignment></beast>';
		const alone = ingestDates({ taxa: ['a', 'b', 'c'], source: noDates, sourceName: 'nd.xml' });
		expect(alone.ok).toBe(false);
		expect(pick(alone, 'DATES_BEAST_NO_DATES').severity).toBe('refuse');

		const rescued = ingestDates({
			taxa: ['a|2019-01-02', 'b|2020-01-02', 'c|2021-01-02'],
			source: noDates,
			sourceName: 'nd.xml'
		});
		expect(rescued.ok).toBe(true);
		expect(pick(rescued, 'DATES_BEAST_NO_DATES').severity).toBe('warn');
		expect(rescued.coverage.from_header).toBe(3);
	});

	it('a namespaced BEAST file is refused, and told which line of the reference blinded it', () => {
		const ing = ingestDates({
			taxa: ['a', 'b', 'c'],
			source: '<beast xmlns="http://beast2.org"><data><sequence taxon="a" value="ATG"/></data></beast>',
			sourceName: 'ns.xml'
		});
		expect(ing.ok).toBe(false);
		expect(codes(ing)).toContain('DATES_BEAST_NOT_BEAST');
	});

	it('names that match nothing reuse DATES_TABLE_NO_MATCH rather than inventing a code', () => {
		const xml = '<beast><taxa><taxon id="x"><date value="1980"/></taxon><taxon id="y"><date value="1990"/></taxon></taxa></beast>';
		const ing = ingestDates({ taxa: ['a', 'b', 'c'], source: xml, sourceName: 'm.xml', headerFallback: false });
		expect(codes(ing)).toContain('DATES_TABLE_NO_MATCH');
		expect(pick(ing, 'DATES_TABLE_NO_MATCH').severity).toBe('refuse');
	});

	it('the seq_ tier matches in BOTH directions, and only for a BEAST source', () => {
		const xml = '<beast><taxa><taxon id="seq_a"><date value="1980"/></taxon><taxon id="b"><date value="1990"/></taxon><taxon id="c"><date value="2000"/></taxon></taxa></beast>';
		const ing = ingestDates({ taxa: ['a', 'seq_b', 'c'], source: xml, sourceName: 's.xml' });
		expect(ing.coverage.dated).toBe(3);
		expect(ing.rows.map((r) => r.value)).toEqual([1980, 1990, 2000]);
		expect(ing.match_tiers.seq_prefix_stripped).toBe(2);
		expect(BEAST_MATCH_TIERS).toContain('seq_prefix_stripped');
		expect(DATE_MATCH_TIERS).not.toContain('seq_prefix_stripped');
	});

	it('the warnings name every quirk the document actually carries', () => {
		const xml =
			'<beast version="1.10.4">' +
			'<taxa><taxon id="a"><date value="2019-03-31" direction="backwards" units="days"/></taxon>' +
			'<taxon id="b"><date value="1799"/></taxon><taxon id="c"><date value="nan"/></taxon></taxa>' +
			'<alignment><sequence taxon="a" value="ATG"/></alignment>' +
			'<alignment><sequence taxon="b" value="ATG"/><sequence taxon="c" value="ATG"/></alignment>' +
			'<trait traitname="dateBackward" value="d=2001"/>' +
			'<newick>((a:1,b:1):1,c:1);</newick></beast>';
		const ing = ingestDates({ taxa: ['a', 'b', 'c'], source: xml, sourceName: 'quirky.xml' });
		const raised = codes(ing);
		expect(raised).toContain('DATES_BEAST_MULTIPLE_ALIGNMENTS');
		expect(raised).toContain('DATES_BEAST_DIRECTION_IGNORED');
		expect(raised).toContain('DATES_BEAST_TRAIT_NOT_DATE');
		expect(raised).toContain('DATES_BEAST_DATE_SCALE');
		expect(raised).toContain('DATES_BEAST_DATE_UNGATED');
		expect(raised).toContain('DATES_BEAST_CARRIES_INPUTS');
		expect(pick(ing, 'DATES_BEAST_DATE_SCALE').message).toMatch(/2\.815 days/);
		expect(pick(ing, 'DATES_BEAST_DATE_UNGATED').data.ungated).toEqual(['b']);
		expect(ing.beast.tree_present).toBe(true);
		// the `nan` date is stored by the reference (dataset.py:172's guard is `is not None`, which
		// NaN passes) and is unusable here: the taxon is undated and says which rule read it, rather
		// than vanishing the way it does upstream
		const c = ing.rows.find((r) => r.taxon === 'c');
		expect(c.value).toBeNaN();
		expect(c.rule).toBe('beast_float');
		expect(ing.beast.nonfinite).toEqual(['c']);
	});

	it('a row says the date came from the XML, and carries the string it was read from', () => {
		const ing = ingestDates({ taxa: ['taxon_A', 'taxon_B', 'taxon_C'], source: BEAST1_XML, sourceName: 'b.xml' });
		for (const r of ing.rows) {
			expect(r.source).toBe('beast');
			expect(r.match_tier).toBe('exact');
			expect(typeof r.raw).toBe('string');
			expect(r.rule).toBe(BEAST_DATE_RULES.FLOAT);
		}
	});

	it('a `YYYY-MM` date is marked imputed, because dataset.py:79 invents the day as half a month', () => {
		const xml = '<beast><taxa><taxon id="a"><date value="2021-04"/></taxon><taxon id="b"><date value="2020-01"/></taxon><taxon id="c"><date value="2019-06"/></taxon></taxa></beast>';
		const ing = ingestDates({ taxa: ['a', 'b', 'c'], source: xml, sourceName: 'ym.xml' });
		expect(ing.rows[0].value).toBe(2021.2916666666667);
		expect(ing.rows[0].imputed).toBe(true);
		expect(ing.rows[0].imputations.day).toBe(true);
		expect(ing.by_rule).toEqual({ beast_year_month: 3 });
	});

	it('an already-parsed document may be passed in, so a page parses once rather than per keystroke', () => {
		const parsed = parseBeastXml(BEAST1_XML);
		const ing = ingestDates({
			taxa: ['taxon_A', 'taxon_B', 'taxon_C', 'taxon_D'],
			source: parsed,
			sourceKind: 'beast',
			sourceName: 'b.xml'
		});
		expect(ing.coverage.dated).toBe(4);
	});

	it('the source kind is sniffed from the CONTENT now, and the name is only a tie-break', () => {
		expect(detectDateSourceKind('<?xml version="1.0"?><beast/>', 'a.xml')).toBe('beast');
		expect(detectDateSourceKind('<beast/>', 'no-extension')).toBe('beast');
		// a metadata export named `.xml` that is actually a CSV is now READ, not refused unread
		expect(detectDateSourceKind('strain,date\na,2001\n', 'dates.xml')).toBe('table');
		// and a file whose content matches nothing, named `.xml`, still comes back as XML so it
		// refuses as unreadable XML rather than as an unknown kind
		expect(detectDateSourceKind('anything at all', 'run.xml')).toBe('beast');
	});

	it('beastToFasta hands the rest of the app a normal alignment, in taxa order', () => {
		const parsed = parseBeastXml(BEAST1_XML);
		const fasta = beastToFasta(parsed);
		expect(fasta).toBe(
			'>taxon_A\nATGGCC\n>taxon_B\nATGGCA\n>taxon_C\nATGGTA\n>taxon_D\nTTGGTA\n'
		);
		expect(taxaForDates(fasta)).toEqual(parsed.taxa);
	});
});

// =================================================================================================
// The 98-taxon equivalence: the same dataset, two file formats, one answer
// =================================================================================================

withExamples('a BEAST XML built from H5N1 dates the same 98 taxa as its own CSV', () => {
	const fasta = readFileSync(join(EXAMPLES, 'H5N1_HA_geo.fasta'), 'utf8');
	const csv = readFileSync(join(EXAMPLES, 'H5N1_HA_metadata.csv'), 'utf8');

	/** The FASTA as records, in file order. */
	const records = [];
	{
		let cur = null;
		for (const line of fasta.split('\n')) {
			if (line.startsWith('>')) {
				cur = { name: line.slice(1).trim(), seq: '' };
				records.push(cur);
			} else if (cur) cur.seq += line.trim();
		}
	}
	const lines = csv.trim().split('\n');
	const header = lines[0].split(',');
	const dateCol = header.findIndex((h) => /date/i.test(h));
	const dateOf = new Map(lines.slice(1).map((l) => [l.split(',')[0], l.split(',')[dateCol]]));
	const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

	/** The BEAST 1 shape: `<taxon id><date value>` and a tail-text `<sequence>`. */
	const beast1 = [
		'<?xml version="1.0" standalone="yes"?>',
		'<beast version="1.10.4">',
		'<taxa id="taxa">',
		...records.map(
			(r) => `<taxon id="${esc(r.name)}"><date value="${dateOf.get(r.name)}" direction="forwards" units="years"/></taxon>`
		),
		'</taxa>',
		'<alignment id="alignment" dataType="nucleotide">',
		...records.map((r) => `<sequence><taxon idref="${esc(r.name)}"/>${r.seq}</sequence>`),
		'</alignment>',
		'</beast>'
	].join('\n');

	/** The BEAST 2 shape: `value=` attributes and one TraitSet. */
	const beast2 = [
		'<beast version="2.6" namespace="beast.evolution.alignment">',
		'<data id="h5n1" name="alignment">',
		...records.map((r) => `<sequence id="seq_${esc(r.name)}" taxon="${esc(r.name)}" value="${r.seq}"/>`),
		'</data>',
		'<trait id="dateTrait" spec="beast.evolution.tree.TraitSet" traitname="date" value="',
		records.map((r) => `${esc(r.name)}=${dateOf.get(r.name)}`).join(',\n'),
		'"/>',
		'</beast>'
	].join('\n');

	it('both shapes read 98 sequences and 98 dates, equal to the FASTA and the CSV', () => {
		for (const [label, xml, version] of [
			['BEAST 1', beast1, 'BEAST 1'],
			['BEAST 2', beast2, 'BEAST 2']
		]) {
			const r = parseBeastXml(xml);
			expect(r.version, label).toBe(version);
			expect(r.sequences.size, label).toBe(98);
			expect(r.dates.size, label).toBe(98);
			for (const rec of records) {
				expect(r.sequences.get(rec.name), `${label} ${rec.name}`).toBe(
					rec.seq.toUpperCase().replace(/U/g, 'T')
				);
				expect(r.dates.get(rec.name), `${label} ${rec.name}`).toBe(Number(dateOf.get(rec.name)));
			}
		}
	});

	it('and the resulting DateIngest is value for value the CSV path\'s', () => {
		const taxa = taxaForDates(fasta);
		const fromCsv = ingestDates({ taxa, source: csv, sourceName: 'H5N1_HA_metadata.csv' });
		const values = (ing) => ing.rows.map((r) => r.value);
		expect(fromCsv.coverage.dated).toBe(98);
		for (const [label, xml] of [
			['BEAST 1', beast1],
			['BEAST 2', beast2]
		]) {
			const ing = ingestDates({ taxa, source: xml, sourceName: 'h5n1.xml' });
			expect(ing.ok, label).toBe(true);
			expect(ing.coverage.dated, label).toBe(98);
			expect(values(ing), label).toEqual(values(fromCsv));
			expect(ing.source, label).toBe('beast');
		}
	});
});


// =================================================================================================
// THE WORK BOUND: size and shape are not cost
//
// `parse_beast_xml` collects every `<alignment>` and every `<data>` in the document
// (dataset.py:123) and then runs a DESCENDANT search from each one (dataset.py:126). Nest those
// elements inside one another and every ancestor re-reads the whole subtree below it — the
// reference's own loop is quadratic in nesting depth, and the reference has no bound on it at all.
// `maxChars` bounded the bytes and `maxDepth` bounded the nesting; neither bounded the WORK, so a
// 14.3 MiB document that passes both froze the reader for sixteen seconds. Every number below was
// measured with this reader; the A/B timings are min-of-7 in one process against the same file.
// =================================================================================================

/** A chain of `<alignment>` elements `depth` deep with the sequences at the very bottom. */
function nestedAlignments(depth, nSeq, siteLen) {
	const seqs = [];
	for (let i = 0; i < nSeq; i++) {
		seqs.push(`<sequence><taxon idref="T${i}"/>${'ACGT'.repeat(siteLen / 4)}</sequence>`);
	}
	return `<beast>${'<alignment>'.repeat(depth)}${seqs.join('')}${'</alignment>'.repeat(depth)}</beast>`;
}

suite('the work a document costs is bounded, which its size and its depth never were', () => {
	/** The reader's own verdict on a document, or `null` when it reads it. */
	const refusedAs = (xml, options) => {
		try {
			parseBeastXml(xml, options);
			return null;
		} catch (err) {
			expect(err).toBeInstanceOf(XmlReadError);
			return err.reason;
		}
	};

	it("DIVERGENCE, ours: the reviewer's depth-500 chain with a real payload is REFUSED", () => {
		// 500 nested <alignment> under the 512 depth cap, 500 sequences x 30,000 bases at the
		// bottom: 14.3 MiB, under `maxChars`. MEASURED before this bound: accepted, 15,964 ms. The
		// 20-second timeout on this test is itself part of the guard — the unbounded reader spent
		// sixteen of them on this one document.
		const attack = nestedAlignments(500, 500, 30000);
		expect(attack.length).toBeLessThan(XML_LIMITS.maxChars);
		expect(refusedAs(attack)).toBe('too_much_work');
	}, 20000);

	it('and so is the same shape at a fifth of the size, where the amplification is the cost', () => {
		// 2.9 MiB, 100 x 30,000 at depth 500. MEASURED before this bound: accepted, 3,689 ms.
		expect(refusedAs(nestedAlignments(500, 100, 30000))).toBe('too_much_work');
	}, 20000);

	it('the bound is on WORK, so the same nesting with a small payload is still READ', () => {
		// Depth 500 is not by itself an attack and is not refused as one: 20 x 400 bases is
		// 20,325 characters and 5,273,984 units, 8.2% of the budget. MEASURED: 629.0 ms before the
		// traversal rewrite, 10.5 ms after it.
		const parsed = parseBeastXml(nestedAlignments(500, 20, 400));
		expect(parsed.sequences.size).toBe(20);
		expect(parsed.provenance.work.spent).toBe(5273984);
		expect(parsed.provenance.work.max).toBe(XML_LIMITS.maxWork);
	});

	it('the meter grows LINEARLY with depth now, where the clock grew quadratically before', () => {
		// The numbers on the right are this file's record of the measured wall clock BEFORE the
		// traversal rewrite and the budget (min-of-7, one process, same file): 3.0 / 11.3 / 54.5 /
		// 629.0 ms for these four documents, against 1.3 / 1.9 / 4.2 / 10.5 ms after. A `yield*`
		// chain costs O(depth) per element YIELDED, so the old reader paid the document's depth
		// again on every element anyone looked at; an explicit stack pays it once.
		const spent = [50, 100, 200, 500].map(
			(d) => parseBeastXml(nestedAlignments(d, 20, 400)).provenance.work.spent
		);
		expect(spent).toEqual([483284, 975584, 1990184, 5273984]);
		// linear: each step in depth moves the meter by that ratio, never by its square
		const ratios = [100 / 50, 200 / 100, 500 / 200];
		for (let i = 1; i < spent.length; i++) {
			expect(spent[i] / spent[i - 1]).toBeLessThan(ratios[i - 1] * 1.1);
		}
	});

	it('a VISIT-dominated document is refused too, which no character cap would have caught', () => {
		// 509 nested <alignment> over 140,000 elements that carry almost no text: 571,756
		// characters, of which 2,036 are sequence. A cap on characters alone, or on the NUMBER of
		// alignment nodes (509, a plausible partition count), lets this through. MEASURED: 8.2 s
		// when a visit and a character cost the same unit; 0.7 s at the weight this reader uses.
		const bomb =
			`<beast>${'<alignment>'.repeat(509)}<sequence taxon="A" value="ACGT"/>` +
			`${'<x/>'.repeat(140000)}${'</alignment>'.repeat(509)}</beast>`;
		expect(refusedAs(bomb)).toBe('too_much_work');
	}, 20000);

	it('the refusal is typed, listed, and says what to do about it', () => {
		let err = null;
		try {
			parseBeastXml(nestedAlignments(500, 100, 30000));
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(XmlReadError);
		expect(err.reason).toBe('too_much_work');
		expect(XML_REFUSALS).toContain('too_much_work');
		// `ingest.js` turns any reason but `malformed` into DATES_XML_UNSAFE, which prints the
		// reader's own sentence, so the sentence has to carry the hint itself.
		expect(err.message).toMatch(/NESTED/);
		expect(err.message).toMatch(/separate FASTA file/);
		expect(err.message).toContain(String(XML_LIMITS.maxWork));
	}, 20000);

	it('a LEGITIMATE document spends a rounding error of the budget', () => {
		const parsed = parseBeastXml(BEAST1_XML);
		expect(parsed.provenance.work.spent).toBeLessThan(XML_LIMITS.maxWork / 1000);
	});

	it("and BEAST 2's FilteredAlignment — <data> legitimately inside <data> — is admitted", () => {
		// The one real shape that pays the nesting factor: the inner block holds the sequences and
		// the outer one re-reads them, so a 500 x 3,000 document costs twice its characters.
		// MEASURED: 1,516,492 characters, 3,078,076 units, 4.8% of the budget, 7.1 ms. This is why
		// the budget is 4x `maxChars` and not 2x — halving it would refuse a 16 MiB one.
		const seqs = [];
		for (let i = 0; i < 500; i++) seqs.push(`<sequence taxon="T${i}" value="${'ACGT'.repeat(750)}"/>`);
		const xml =
			`<beast spec="Beast"><data spec="FilteredAlignment" filter="1::3">` +
			`<data id="raw">${seqs.join('')}</data></data></beast>`;
		const parsed = parseBeastXml(xml);
		expect(parsed.sequences.size).toBe(500);
		expect(parsed.provenance.work.spent).toBe(3078076);
		expect(parsed.provenance.work.spent).toBeLessThan(XML_LIMITS.maxWork);
	});

	it("the budget is a plain meter a caller can narrow, and refuses with the reader's own error", () => {
		const budget = createWorkBudget({ maxWork: 100 });
		expect(budget.max).toBe(100);
		chargeWork(budget, 99);
		expect(budget.spent).toBe(99);
		expect(() => chargeWork(budget, 2)).toThrow(XmlReadError);
		// a nonsense limit falls back to the documented one rather than disabling the bound
		expect(createWorkBudget({ maxWork: 0 }).max).toBe(XML_LIMITS.maxWork);
		expect(createWorkBudget({ maxWork: Number.NaN }).max).toBe(XML_LIMITS.maxWork);
		expect(createWorkBudget().max).toBe(XML_LIMITS.maxWork);
		// and a traversal with NO budget is still a traversal
		expect(() => [...iterElements(parseXmlDocument('<a><b/></a>').root)]).not.toThrow();
	});

	it('a caller may lower the bound through `limits`, exactly as it may lower the others', () => {
		expect(refusedAs(BEAST1_XML, { limits: { maxWork: 100 } })).toBe('too_much_work');
		expect(refusedAs(BEAST1_XML)).toBeNull();
	});

	it("the iterative walk yields the same elements, in the same order, as ElementTree's iter()", () => {
		// The rewrite that removed the O(depth)-per-yield cost must not have changed the ORDER, on
		// which dataset.py:204-225's starting-tree search depends entirely.
		const xml = '<beast><a><b/><c><d/><e/></c></a><f><g><h/></g></f><i/></beast>';
		const root = parseXmlDocument(xml).root;
		const recursive = (el) => [el, ...el.children.flatMap(recursive)];
		expect([...iterElements(root)]).toEqual(recursive(root));
		expect([...iterElements(root)].map((e) => e.tag)).toEqual([
			'beast', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'
		]);
	});
});

// =================================================================================================
// A BEAST TAXON ID IS NOT A FASTA NAME
//
// `beastToFasta` is the app's own function and mirrors nothing: it exists because every surface
// here speaks FASTA and the library's `parseAlignmentSequences` has no XML branch. A BEAST id is a
// free string; a FASTA name is the first whitespace token of a `>` line with its quotes stripped.
// Writing one as the other silently loses sequences, and — once XML character references are in
// play — silently INVENTS them.
// =================================================================================================

/** A BEAST 1 document with the given `[id, date]` taxa, ids written into the XML as-is. */
function beastWithIds(pairs) {
	const taxa = pairs.map(([id, d]) => `<taxon id="${id}"><date value="${d}"/></taxon>`).join('');
	const seqs = pairs
		.map(([id], i) => `<sequence><taxon idref="${id}"/>${'ACGT'.repeat(3)}${'AC'.repeat(i)}</sequence>`)
		.join('');
	return `<beast version="1.10.4"><taxa>${taxa}</taxa><alignment>${seqs}</alignment></beast>`;
}

suite('a taxon id that FASTA cannot carry back is refused, not written', () => {
	it('THE INJECTION: a character reference puts a newline and a ">" inside a taxon NAME', () => {
		// MEASURED before this refusal: this document produced a FASTA the library read back as
		// FOUR sequences from a three-taxon XML — `A` empty, `INJECTED` holding A's bases — because
		// `&#10;` is resolved by the parser and `>` then opens a record. The reference stores the
		// same name (it never writes FASTA), so the port is unchanged and the refusal is ours.
		const parsed = parseBeastXml(beastWithIds([['A&#10;&gt;INJECTED', 2001], ['B', 2002], ['C', 2003]]));
		expect(parsed.taxa).toEqual(['A\n>INJECTED', 'B', 'C']);
		expect(parsed.provenance.names_unsafe_for_fasta).toEqual([
			{ name: 'A\n>INJECTED', hazard: FASTA_NAME_HAZARDS.WHITESPACE }
		]);
		expect(() => beastToFasta(parsed)).toThrow(BeastFastaError);
	});

	it('and the refusal names the taxon, shows the character, and says what would have happened', () => {
		const parsed = parseBeastXml(beastWithIds([['A&#10;&gt;INJECTED', 2001], ['B', 2002]]));
		let err = null;
		try {
			beastToFasta(parsed);
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(BeastFastaError);
		expect(err.code).toBe('BEAST_NAME_NOT_FASTA');
		expect(err.names).toEqual([{ name: 'A\n>INJECTED', hazard: 'whitespace' }]);
		expect(err.message).toContain('"A\\n>INJECTED"'); // the newline is SHOWN, not printed
		expect(err.message).toMatch(/1 of 2 taxon id/);
		expect(err.message).toMatch(/start a whole new sequence/);
		expect(err.message).toMatch(/own FASTA file/);
	});

	it('THE SILENT LOSS: two ids differing only after a space collide, and one sequence vanishes', () => {
		// MEASURED before this refusal: a three-taxon XML produced a FASTA the library read back as
		// TWO sequences — `A seq1` was overwritten by `A seq2` under the name `A` — and
		// `beastDatesForTaxa` then dated ONE of the three, because the dates are keyed on the full
		// id and the run's taxa are the truncated one.
		const parsed = parseBeastXml(beastWithIds([['A seq1', 2001], ['A seq2', 2002], ['B', 2003]]));
		expect(parsed.taxa).toEqual(['A seq1', 'A seq2', 'B']);
		expect(unsafeFastaNames(parsed.taxa).map((u) => u.name)).toEqual(['A seq1', 'A seq2']);
		let err = null;
		try {
			beastToFasta(parsed);
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(BeastFastaError);
		expect(err.names.map((n) => n.name)).toEqual(['A seq1', 'A seq2']);
		expect(err.message).toMatch(/merged into one another/);
	});

	it('every Python whitespace character is a hazard, not only the space', () => {
		// `pySplitLines` and `pySplit` are Python's, and Python's whitespace is not JavaScript's.
		// U+0085 and U+001C-U+001F are whitespace to Python and NOT to `/\s/`; U+FEFF is the
		// reverse. The FASTA reader is the library's, so Python's set is the one that decides.
		// The 29 code points `str.isspace()` accepts, which is what `library.js`'s `PY_WS` spells.
		const PY_SPACES = [
			0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20,
			0x85, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006,
			0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000
		].map((cp) => String.fromCodePoint(cp));
		for (const c of PY_SPACES) {
			expect(fastaNameHazard(`A${c}B`), JSON.stringify(c)).toBe(FASTA_NAME_HAZARDS.WHITESPACE);
		}
		// U+FEFF is not Python whitespace, so the reader keeps it and the name round-trips
		expect(fastaNameHazard('A\ufeffB')).toBeNull();
	});

	it('a quote on either end is a hazard, and reconciliation can produce one', () => {
		expect(fastaNameHazard("'A")).toBe(FASTA_NAME_HAZARDS.QUOTED);
		expect(fastaNameHazard('A"')).toBe(FASTA_NAME_HAZARDS.QUOTED);
		expect(fastaNameHazard("A'B")).toBeNull(); // inside is fine; the reader strips only the ends
		expect(fastaNameHazard('')).toBe(FASTA_NAME_HAZARDS.EMPTY);
		// Neither is reachable through `parseBeastXml` TODAY, and the reason is worth pinning: every
		// key it stores went through `pyStripQuotes` at collection (dataset.py:150) and every date
		// key through the same at dataset.py:161, so no name it returns can begin or end with a
		// quote — including the ones dataset.py:190-202 rebuilds by slicing `seq_` off the front.
		const quoted = parseBeastXml(
			'<beast><taxa><taxon id="&apos;A&apos;"><date value="2001"/></taxon></taxa>' +
				'<alignment><sequence><taxon idref="&apos;A&apos;"/>ACGT</sequence>' +
				'<sequence><taxon idref="seq_&apos;B&apos;"/>ACGT</sequence></alignment></beast>'
		);
		expect(quoted.taxa).toEqual(['A', "seq_'B"]);
		expect(unsafeFastaNames(quoted.taxa)).toEqual([]);
		// The guard stands anyway: `beastToFasta` is exported, the reader's quote strip is real, and
		// a caller that builds its own `{sequences, taxa}` gets the same refusal rather than a name
		// the alignment reader would quietly shorten.
		const handmade = { taxa: ["'A", 'B'], sequences: new Map([["'A", 'ACGT'], ['B', 'ACGT']]) };
		expect(() => beastToFasta(handmade)).toThrow(BeastFastaError);
	});

	it("THE PREDICATE IS THE LIBRARY'S OWN BEHAVIOUR, asserted against it name by name", () => {
		// `fastaNameHazard` is a claim about what `parse_alignment_sequences` (dataset.py:302-315)
		// does to a `>` line. The claim is checked here rather than trusted: a name is safe if and
		// only if a one-record FASTA written under it reads back as exactly that one name.
		const names = [
			'taxon_A', 'A', 'A.1', 'A|2001-05-06', 'seq_A', 'A(x,y):1', 'A;B', 'A[1]', 'A>B',
			'A_B', 'A-B', '__proto__', '\u03a9', 'A\ufeffB', '999',
			'A B', 'A\tB', 'A\nB', 'A\n>INJECTED', 'A\r\nB', 'A\u001cB', 'A\u00a0B', ' A', 'A ',
			"'A", 'A"', "'A'", '"A"', ''
		];
		for (const name of names) {
			const hazard = fastaNameHazard(name);
			let readBack = null;
			try {
				readBack = [...parseAlignmentSequences(`>${name}\nACGT\n`).keys()];
			} catch {
				readBack = 'threw'; // the empty name: dataset.py:312 raises IndexError
			}
			const roundTrips = Array.isArray(readBack) && readBack.length === 1 && readBack[0] === name;
			expect(hazard === null, `${JSON.stringify(name)} -> ${JSON.stringify(readBack)}`).toBe(
				roundTrips
			);
		}
	});

	it('a clean document is untouched, and its FASTA reads back as exactly its taxa', () => {
		const parsed = parseBeastXml(BEAST1_XML);
		expect(parsed.provenance.names_unsafe_for_fasta).toEqual([]);
		expect(taxaForDates(beastToFasta(parsed))).toEqual(parsed.taxa);
		expect(beastToFasta(parsed, { lineWidth: 3 })).toBe(
			'>taxon_A\nATG\nGCC\n>taxon_B\nATG\nGCA\n>taxon_C\nATG\nGTA\n>taxon_D\nTTG\nGTA\n'
		);
	});

	it('an XML dropped for its DATES alone is never refused for a name it will never write', () => {
		// The reader's own alignment supplies the names; the XML only has to match them. Refusing at
		// parse time would take a usable date source away over a hazard that never arises.
		const xml = beastWithIds([['A seq1', 2001], ['B', 2002]]);
		expect(() => parseBeastXml(xml)).not.toThrow();
		const ing = ingestDates({ taxa: ['A seq1', 'B'], source: xml, sourceName: 'dates.xml' });
		expect(ing.coverage.dated).toBe(2);
	});

	it('a name with no sequence cannot lose one, so it does not make the alignment refuse', () => {
		// `taxa` may carry a name the alignment does not: only what is WRITTEN is checked.
		const parsed = parseBeastXml(BEAST1_XML);
		const withGhost = { ...parsed, taxa: [...parsed.taxa, 'ghost taxon'] };
		expect(() => beastToFasta(withGhost)).not.toThrow();
		expect(beastToFasta(withGhost)).toBe(beastToFasta(parsed));
	});

	it('THE SECOND FORMAT: the Newick writer quotes what FASTA lets through, and is not changed', () => {
		// A taxon id carrying Newick metacharacters round-trips through FASTA unharmed — `A(x,y):1`
		// has no whitespace — so `beastToFasta` has no business refusing it. The hazard is one
		// format further on, and `nj.js` already closes it: every display tree this app writes goes
		// through `newickLabel`, which quotes a label with a metacharacter and doubles inner quotes.
		const parsed = parseBeastXml(beastWithIds([['A(x,y):1', 2001], ['B;C', 2002], ['D,E', 2003]]));
		expect(parsed.provenance.names_unsafe_for_fasta).toEqual([]);
		const names = [...parseAlignmentSequences(beastToFasta(parsed)).keys()];
		expect(names).toEqual(['A(x,y):1', 'B;C', 'D,E']);
		expect(names.map(newickLabel)).toEqual(["'A(x,y):1'", "'B;C'", "'D,E'"]);
		expect(newickLabel("A'B")).toBe("'A''B'");
	});
});

// =================================================================================================
// A NON-FINITE DATE IS THE REFERENCE'S OWN, AND IT REACHES NOTHING THAT COULD USE IT
// =================================================================================================

suite('nan and inf parse upstream, are stored as the reference stores them, and date nobody', () => {
	it('`float()` takes them, so the port takes them, and the provenance names every one', () => {
		const parsed = parseBeastXml(
			beastWithIds([['A', 'nan'], ['B', 'inf'], ['C', '-inf'], ['D', '2001.5']])
		);
		expect(parsed.dates.get('A')).toBeNaN();
		expect(parsed.dates.get('B')).toBe(Number.POSITIVE_INFINITY);
		expect(parsed.dates.get('C')).toBe(Number.NEGATIVE_INFINITY);
		expect(parsed.dates.get('D')).toBe(2001.5);
		expect(parsed.provenance.nonfinite).toEqual(['A', 'B', 'C']);
		expect(parsed.provenance.ungated).toEqual([]); // the range gate is finite-only, by construction
	});

	it('and none of the three survives into a value a clock fit or an axis could read', () => {
		const xml = beastWithIds([
			['A', 'nan'], ['B', 'inf'], ['C', '-inf'],
			['D', '2001.5'], ['E', '2003.25'], ['F', '2005.0']
		]);
		const ing = ingestDates({ taxa: ['A', 'B', 'C', 'D', 'E', 'F'], source: xml, sourceName: 'nf.xml' });
		// Infinity is normalised away too, so nothing downstream can see an infinite year.
		for (const t of ['A', 'B', 'C']) expect(ing.rows.find((r) => r.taxon === t).value).toBeNaN();
		expect(ing.coverage.dated).toBe(3);
		expect(ing.coverage.undated).toBe(3);
		// the span that becomes the plot axis is finite on both ends and counts only the three
		expect(ing.span).toMatchObject({ min: 2001.5, max: 2005, finite: 3 });
		expect(Number.isFinite(ing.span.min) && Number.isFinite(ing.span.max)).toBe(true);
	});

	it('the reader is TOLD, twice: the values are named as non-finite and the taxa as undated', () => {
		const xml = beastWithIds([['A', 'nan'], ['B', 'inf'], ['C', '2001.5'], ['D', '2003.0']]);
		const ing = ingestDates({ taxa: ['A', 'B', 'C', 'D'], source: xml, sourceName: 'nf.xml' });
		const raised = codes(ing);
		expect(raised).toContain('DATES_BEAST_DATE_UNGATED');
		expect(raised).toContain('DATES_PARTIAL_COVERAGE');
		expect(pick(ing, 'DATES_BEAST_DATE_UNGATED').message).toMatch(/2 are not finite at all/);
		expect(ing.beast.nonfinite).toEqual(['A', 'B']);
		expect(pick(ing, 'DATES_PARTIAL_COVERAGE').message).toMatch(/2 of 4 sequences carry a date/);
	});
});
