/**
 * beast.test.ts — the page's half of the BEAST XML feature: which slots one file fills, what the
 * page says it took, and whether the date arithmetic is named rather than buried.
 *
 * The reference's own two acceptance documents (HyphAeon/tests/test_dating.py:119-134 and :152-167)
 * are inlined here verbatim, because everything this module does is downstream of what
 * `parse_beast_xml` returns for them, and a page test that invented its own XML would be testing a
 * document nobody ships.
 */

import { describe, expect, it } from 'vitest';
import { ingestDates, parseBeastXml, beastToFasta } from '@veg/hyphaeon-runtime/dates';
import type { BeastDocument } from '@veg/hyphaeon-runtime/dates';
import {
	beastCalendarOf,
	beastProvenanceLines,
	beastSummaryOfDocument,
	dateScaleLine,
	intake,
	noAlignmentRefusal,
	placeBeast
} from './beast';
import { classifyDropped, isDateSource, isMetadataSource } from './sources';
import { diagnosis, readsAs, reviewRows, unmatchedMetadataLine, type DateIngestLike } from './dateReview';
import { available, example } from './fixtures';

/** tests/test_dating.py:119-134 — BEAST 1: taxa with dates, sequences as taxon-child tails, a tree. */
const BEAST1 = `<?xml version="1.0" standalone="yes"?>
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
</beast>`;

/** tests/test_dating.py:152-167 — BEAST 2: a `<data>` block and a date TraitSet, and no tree. */
const BEAST2 = `<beast version="2.6" namespace="beast.evolution.alignment:beast.evolution.tree">
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
</beast>`;

/** The same shape, dated by calendar strings — the case where the two arithmetics diverge. */
const BEAST_CALENDAR = `<beast version="1.10.4">
    <taxa>
        <taxon id="a"><date value="2019-03-31"/></taxon>
        <taxon id="b"><date value="2021-04"/></taxon>
        <taxon id="c"><date value="2020-12-31"/></taxon>
    </taxa>
    <alignment>
        <sequence><taxon idref="a"/>ATGGCC</sequence>
        <sequence><taxon idref="b"/>ATGGCA</sequence>
        <sequence><taxon idref="c"/>ATGGTA</sequence>
    </alignment>
</beast>`;

const FASTA = '>taxon_A\nATGGCC\n>taxon_B\nATGGCA\n>taxon_C\nATGGTA\n>taxon_D\nTTGGTA\n';

function parse(xml: string, name = 'run.xml'): BeastDocument {
	return parseBeastXml(xml, { fileName: name });
}

function ingestOf(parsed: BeastDocument, name = 'run.xml'): DateIngestLike {
	const fasta = beastToFasta(parsed);
	const taxa = fasta
		.split('\n')
		.filter((l) => l.startsWith('>'))
		.map((l) => l.slice(1).trim());
	return ingestDates({ taxa, source: parsed, sourceKind: 'beast', sourceName: name }) as unknown as DateIngestLike;
}

describe('a BEAST XML is routed to the reader, and by its content', () => {
	it('classifies both reference documents as BEAST', () => {
		expect(classifyDropped(BEAST1, 'run.xml')).toBe('beast');
		// No `.xml` in the name at all: the bytes decide.
		expect(classifyDropped(BEAST2, 'dropped')).toBe('beast');
	});

	// This is the line that changed. A `.xml` name used to be sufficient on its own, so a metadata
	// CSV a reader had named `dates.xml` was routed to the XML reader and refused unread.
	it('reads a `.xml`-named CSV as the table it is', () => {
		expect(classifyDropped('taxon,date\na,2021\nb,2022\n', 'dates.xml')).toBe('table');
	});

	// …but a file that matched nothing and is NAMED `.xml` still reaches the reader, so the refusal
	// a reader sees is "this is not readable XML" rather than "this is not anything".
	it('keeps the name as the last resort, so unreadable XML is refused as XML', () => {
		expect(classifyDropped('anything at all', 'run.xml')).toBe('beast');
	});

	it('is a date source, but not one that fills only the metadata slot', () => {
		expect(isDateSource('beast')).toBe(true);
		expect(isMetadataSource('beast')).toBe(false);
		expect(isMetadataSource('table')).toBe(true);
	});
});

describe('placing what one file carries — the reference’s own precedence rule', () => {
	it('fills all three slots when the page is empty', () => {
		const p = placeBeast(parse(BEAST1), { alignment: false, tree: false, dates: false }, 'run.xml');
		expect(p.version).toBe('BEAST 1');
		expect(p.alignment).toBe('taken');
		expect(p.dates).toBe('taken');
		expect(p.tree).toBe('taken');
		expect(p.sequences).toBe(4);
		expect(p.dateCount).toBe(4);
	});

	// dating.py:2467-2471 takes each slot only `if … is None`. An explicitly-typed file is the drop
	// zone's analogue of a named argument, so it wins whatever order the browser enumerated in.
	it('never overwrites a slot an explicitly-typed file already filled', () => {
		const p = placeBeast(parse(BEAST1), { alignment: true, tree: true, dates: false }, 'run.xml');
		expect(p.alignment).toBe('already-supplied');
		expect(p.tree).toBe('already-supplied');
		expect(p.dates).toBe('taken');
	});

	it('says "not offered" for what the file does not carry, rather than "not used"', () => {
		const p = placeBeast(parse(BEAST2), { alignment: false, tree: false, dates: false }, 'h1n1.xml');
		expect(p.version).toBe('BEAST 2');
		expect(p.treePresent).toBe(false);
		expect(p.tree).toBe('not-offered');
		expect(p.alignment).toBe('taken');
		expect(p.dates).toBe('taken');
	});
});

describe('what the page SAYS it took — the review strip’s intake note', () => {
	it('names all three things a single dropped file became', () => {
		const note = intake(placeBeast(parse(BEAST1), { alignment: false, tree: false, dates: false }, 'run.xml'));
		expect(note).not.toBeNull();
		expect(note!.lead).toContain('run.xml');
		expect(note!.lead).toContain('BEAST 1');
		expect(note!.lead).toContain('three things');
		expect(note!.rest).toContain('the alignment (4 sequences)');
		expect(note!.rest).toContain('4 sampling dates');
		expect(note!.rest).toContain('the starting tree');
		// The rule is the reference's, and the note says where it comes from.
		expect(note!.rest).toContain('dating.py:2467-2471');
		expect(note!.notTaken).toEqual([]);
	});

	it('says which slots it offered and did not get, and why', () => {
		const note = intake(placeBeast(parse(BEAST1), { alignment: true, tree: false, dates: false }, 'run.xml'));
		expect(note!.lead).toContain('two things');
		expect(note!.notTaken).toHaveLength(1);
		// A whole sentence, capitalised and stopped: the page prints it verbatim, and a markup that had
		// to punctuate it produced "The the alignment in it was not used" (caught in the browser).
		expect(note!.notTaken[0]).toBe('The alignment in it was not used, because you supplied one yourself.');
	});

	it('remembers a slot the reader cleared rather than pretending the file never carried it', () => {
		const placement = placeBeast(parse(BEAST1), { alignment: false, tree: false, dates: false }, 'run.xml');
		const note = intake({ ...placement, dates: 'discarded', dateSource: false });
		expect(note!.notTaken.some((c) => c.includes('cleared by you'))).toBe(true);
		expect(note!.rest).not.toContain('4 sampling dates');
	});

	it('is nothing at all when no XML was dropped', () => {
		expect(intake(null)).toBeNull();
	});
});

describe('the date arithmetic is named, not buried', () => {
	// dataset.py:71-80. THIS is the thing a reader comparing the page with `hyphaeon dating --beast`
	// has to be able to find, and the runtime's measured divergence is what it has to say.
	it('prints the BEAST scale line whenever a calendar string was read, with the measurement', () => {
		const ingest = ingestOf(parse(BEAST_CALENDAR, 'cal.xml'), 'cal.xml');
		const line = dateScaleLine(ingest.beast);
		expect(line).not.toBeNull();
		expect(line!).toContain('3 of 3 dates');
		expect(line!).toContain('(month−1)/12');
		expect(line!).toContain('(month−0.5)/12');
		expect(line!).toContain('0.73 days');
		expect(line!).toContain('2.815 days');
		expect(line!).toContain('hyphaeon dating --beast');
	});

	// A file of bare decimal years round-trips through both conventions unchanged, so there is no
	// divergence to warn about and the page does not invent one.
	it('says nothing about the scale when every date was a bare number', () => {
		const ingest = ingestOf(parse(BEAST1));
		expect(ingest.beast!.calendar_dates).toBe(0);
		expect(dateScaleLine(ingest.beast)).toBeNull();
		expect(dateScaleLine(null)).toBeNull();
	});

	// MEASURED against the reference: 2019-03-31 -> 2019.2488021902807 under BEAST's formula, where
	// the library's decimal year is 2019.2410958904109. Inverting the value with the LIBRARY's rule
	// renders 2019-04-01 — a day the reader never wrote, printed beside the string they did.
	it('renders a BEAST calendar date by inverting the formula it came from', () => {
		expect(beastCalendarOf(2019.2488021902807, 'beast_ymd')).toBe('2019-03-31');
		expect(beastCalendarOf(2020.9988021902807, 'beast_ymd')).toBe('2020-12-31');
		expect(beastCalendarOf(2021.2916666666667, 'beast_year_month')).toBe('2021-04');
		// `beast_float` has no calendar meaning upstream — `float(s)` and nothing else — so the column
		// falls back to the ordinary rendering rather than inventing a month and a day.
		expect(beastCalendarOf(1980, 'beast_float')).toBeNull();
		expect(beastCalendarOf(Number.NaN, 'beast_ymd')).toBeNull();
	});

	it('uses it in the "Reads as" column, so column 4 agrees with the string in column 7', () => {
		const rows = reviewRows(ingestOf(parse(BEAST_CALENDAR, 'cal.xml'), 'cal.xml'), true);
		const a = rows.find((r) => r.taxon === 'a')!;
		expect(a.raw).toBe('2019-03-31');
		expect(a.readsAs).toBe('2019-03-31');
		expect(a.rule).toBe('beast_ymd');
		// The library's inverse says 2019-04-02, two days from the string the reader wrote — measured
		// here so the fallback cannot creep back into the column without a failure.
		expect(readsAs(a.value, 'years')).toBe('2019-04-02');
	});
});

describe('the review reads a BEAST document as a document, not as a stray map', () => {
	it('dates every taxon, sourced to the XML, with a BEAST rule id on every row', () => {
		const ingest = ingestOf(parse(BEAST1));
		expect(ingest.coverage.taxa_total).toBe(4);
		expect(ingest.coverage.dated).toBe(4);
		expect(ingest.coverage.from_beast).toBe(4);
		const rows = reviewRows(ingest, true);
		expect(rows.map((r) => r.source)).toEqual(['beast', 'beast', 'beast', 'beast']);
		expect(rows.map((r) => r.rule)).toEqual(['beast_float', 'beast_float', 'beast_float', 'beast_float']);
		expect(rows.map((r) => r.sourceText)).toEqual(['BEAST XML', 'BEAST XML', 'BEAST XML', 'BEAST XML']);
		expect(rows.map((r) => r.ruleText)).toEqual(Array(4).fill('BEAST number, no gate'));
	});

	// The rank the table sorts by is "a document is loaded and this row did not come from it". Before
	// the document was generalised past the word `table`, every BEAST row ranked as a match failure.
	it('ranks an exactly-matched BEAST row as clean, not as a matching failure', () => {
		const rows = reviewRows(ingestOf(parse(BEAST1)), true);
		expect(rows.map((r) => r.rank)).toEqual([3, 3, 3, 3]);
		expect(rows.map((r) => r.matchText)).toEqual(['exact', 'exact', 'exact', 'exact']);
	});

	it('counts the BEAST dates in the one-sentence diagnosis', () => {
		expect(diagnosis(ingestOf(parse(BEAST1))).sentence).toContain('4 from the BEAST XML');
	});

	// dataset.py:194-200 renames a `seq_`-prefixed sequence to the dated name, so the BEAST 2 fixture
	// — whose sequences are `seq_A`… and whose trait names `isolate_A`… — matches on the taxon
	// attribute, and the review has to show every one of its taxa dated.
	it('reads the BEAST 2 TraitSet document the same way', () => {
		const ingest = ingestOf(parse(BEAST2, 'h1n1.xml'), 'h1n1.xml');
		expect(ingest.coverage.dated).toBe(4);
		expect(ingest.rows.map((r) => r.value)).toEqual([1990.25, 2000.5, 2010.75, 2020.0]);
		expect(diagnosis(ingest).sentence).toContain('4 from the BEAST XML');
	});

	// The unmatched line is the most important one under the table, and an XML has no "rows".
	it('counts unmatched BEAST taxa in the file’s own unit', () => {
		const parsed = parse(BEAST1);
		const ingest = ingestDates({
			taxa: ['taxon_A', 'taxon_B'],
			source: parsed,
			sourceKind: 'beast',
			sourceName: 'run.xml'
		}) as unknown as DateIngestLike;
		const line = unmatchedMetadataLine(ingest, 'run.xml');
		expect(line).not.toBeNull();
		expect(line!.lead).toBe('2 of 4 dated taxa in run.xml name no sequence in this alignment');
	});
});

describe('how the document was read, in the strip', () => {
	it('names the version, the counts and where the tree came from', () => {
		const lines = beastProvenanceLines(ingestOf(parse(BEAST1)).beast, 'run.xml');
		expect(lines[0]).toContain('run.xml was read as BEAST 1');
		expect(lines[0]).toContain('4 sequence(s), 4 date(s)');
		expect(lines[0]).toContain('starting tree');
	});

	// `grep -n direction hyphaeon/dataset.py` returns nothing: the attribute is decoration, and a
	// file written `direction="backwards"` has its ages stored as forward years. The strip says so.
	it('says the direction and units attributes were read by nothing', () => {
		const lines = beastProvenanceLines(ingestOf(parse(BEAST1)).beast, 'run.xml');
		const line = lines.find((l) => l.includes('direction'));
		expect(line).toBeTruthy();
		expect(line!).toContain('read by nothing');
		expect(line!).toContain('forward year');
	});

	it('says nothing at all when no BEAST document was read', () => {
		expect(beastProvenanceLines(null, 'x.csv')).toEqual([]);
	});
});

describe('a BEAST XML that carries no dates', () => {
	// dataset.py returns `{}` for the dates and says nothing; the date layer refuses, and the page's
	// intake note still reports the alignment the same file did supply.
	const NO_DATES = `<beast version="1.10.4"><alignment><sequence><taxon idref="a"/>ATGGCC</sequence>
		<sequence><taxon idref="b"/>ATGGCA</sequence></alignment></beast>`;

	it('refuses with a code and still says what the file gave', () => {
		const parsed = parse(NO_DATES, 'nodates.xml');
		const ingest = ingestOf(parsed, 'nodates.xml');
		expect(ingest.warnings.some((w) => w.code === 'DATES_BEAST_NO_DATES' && w.severity === 'refuse')).toBe(true);
		const placement = placeBeast(parsed, { alignment: false, tree: false, dates: false }, 'nodates.xml');
		expect(placement.dates).toBe('not-offered');
		expect(intake(placement)!.rest).toContain('the alignment (2 sequences)');
	});

	// `dateSource` is not `dates === 'taken'`, and the difference is a whole refusal. An XML holding
	// no date still occupies an empty dates slot, so the date layer gets to name it; without this the
	// page fell through to the generic "no sequence could be dated" and never mentioned the file at
	// all (measured in the browser, dropping a FASTA beside a non-BEAST XML).
	it('still claims the empty dates slot, so the layer is the one that says there are none', () => {
		const dateless = placeBeast(parse(NO_DATES, 'nodates.xml'), { alignment: false, tree: false, dates: false });
		expect(dateless.dates).toBe('not-offered');
		expect(dateless.dateSource).toBe(true);

		const notBeast = placeBeast(parse('<?xml version="1.0"?><root><a/></root>', 'other.xml'), {
			alignment: false,
			tree: false,
			dates: false
		});
		expect(notBeast.dateSource).toBe(true);
		expect(intake(notBeast)).toBeNull();

		// A named date file still wins the slot: the XML is then not the source of anything dated.
		expect(placeBeast(parse(NO_DATES), { alignment: false, tree: false, dates: true }).dateSource).toBe(false);
	});
});

describe('an XML that is not a BEAST file, and one that is not XML', () => {
	it('refuses a well-formed XML holding nothing a BEAST file holds', () => {
		const parsed = parse('<?xml version="1.0"?><root><a/></root>', 'other.xml');
		expect(parsed.version).toBe('BEAST XML');
		const ingest = ingestDates({
			taxa: ['a', 'b', 'c'],
			source: parsed,
			sourceKind: 'beast',
			sourceName: 'other.xml'
		}) as unknown as DateIngestLike;
		expect(ingest.warnings.some((w) => w.code === 'DATES_BEAST_NOT_BEAST' && w.severity === 'refuse')).toBe(true);
	});

	// A bare `&` is a hard XML error upstream too (dataset.py:109-110 turns it into a ValueError), and
	// it is the single commonest way a real BEAST file fails: `[&rate=…]` in a newick element.
	it('refuses malformed XML with the layer’s own code', () => {
		const bad = '<beast><newick>((a:1[&rate=0.1],b:2):0);</newick></beast>';
		expect(() => parse(bad, 'bad.xml')).toThrow();
		const ingest = ingestDates({
			taxa: ['a', 'b'],
			source: bad,
			sourceName: 'bad.xml'
		}) as unknown as DateIngestLike;
		expect(ingest.warnings.some((w) => w.code === 'DATES_XML_UNPARSABLE' && w.severity === 'refuse')).toBe(true);
		expect(ingest.ok).toBe(false);
	});
});

describe.skipIf(!available())('against the shipped H5N1 example, 98 taxa', () => {
	/** The BEAST 1 form of the example pair: one `<taxon><date>` per row, sequences as taxon tails. */
	function beast1FromExample(): { xml: string; dates: Map<string, string> } {
		const fasta = example('H5N1_HA_geo.fasta');
		const csv = example('H5N1_HA_metadata.csv');
		const dates = new Map<string, string>();
		for (const line of csv.trim().split(/\r?\n/).slice(1)) {
			const [taxon, date] = line.split(',');
			dates.set(taxon, date);
		}
		const seqs: Array<[string, string]> = [];
		let name = '';
		let buf: string[] = [];
		for (const line of fasta.split(/\r?\n/)) {
			if (line.startsWith('>')) {
				if (name) seqs.push([name, buf.join('')]);
				name = line.slice(1).trim().split(/\s+/)[0];
				buf = [];
			} else if (line.trim()) buf.push(line.trim());
		}
		if (name) seqs.push([name, buf.join('')]);
		const taxa = seqs
			.map(([n]) => `<taxon id="${n}"><date value="${dates.get(n)}" direction="forwards" units="years"/></taxon>`)
			.join('\n');
		const alignment = seqs.map(([n, s]) => `<sequence><taxon idref="${n}"/>${s}</sequence>`).join('\n');
		return {
			xml: `<?xml version="1.0"?>\n<beast version="1.10.4">\n<taxa id="taxa">\n${taxa}\n</taxa>\n<alignment id="alignment" dataType="nucleotide">\n${alignment}\n</alignment>\n</beast>`,
			dates
		};
	}

	// The equivalence that makes this a feature and not a second format: the XML and the CSV path
	// must date the same 98 sequences with the same numbers. They do, because the example's dates are
	// bare decimal years, which both conventions return unchanged — which is also why the calendar
	// divergence above needs its own fixture.
	it('dates the same 98 sequences, with the same values, as the metadata CSV path', () => {
		const { xml } = beast1FromExample();
		expect(classifyDropped(xml, 'h5n1.xml')).toBe('beast');
		const parsed = parse(xml, 'h5n1.xml');
		expect(parsed.sequences.size).toBe(98);
		expect(parsed.dates.size).toBe(98);

		const fromXml = ingestOf(parsed, 'h5n1.xml');
		const fasta = example('H5N1_HA_geo.fasta');
		const taxa = fasta
			.split('\n')
			.filter((l) => l.startsWith('>'))
			.map((l) => l.slice(1).trim().split(/\s+/)[0]);
		const fromCsv = ingestDates({
			taxa,
			source: example('H5N1_HA_metadata.csv'),
			sourceName: 'H5N1_HA_metadata.csv'
		}) as unknown as DateIngestLike;

		expect(fromXml.coverage.taxa_total).toBe(98);
		expect(fromXml.coverage.dated).toBe(fromCsv.coverage.dated);
		expect(fromXml.coverage.dated).toBe(98);
		expect(fromXml.rows.map((r) => r.taxon)).toEqual(fromCsv.rows.map((r) => r.taxon));
		expect(fromXml.rows.map((r) => r.value)).toEqual(fromCsv.rows.map((r) => r.value));
		// The VALUES agree and the provenance does not, which is the honest result: the rule ids say
		// which parser produced them, and the page prints those words.
		expect(new Set(fromXml.rows.map((r) => r.rule))).toEqual(new Set(['beast_float']));
		expect(new Set(fromCsv.rows.map((r) => r.rule))).toEqual(new Set(['numeric']));
	});

	it('turns the XML back into an alignment the rest of the page can read', () => {
		const { xml } = beast1FromExample();
		const derived = beastToFasta(parse(xml, 'h5n1.xml'));
		expect(classifyDropped(derived, 'h5n1.xml')).toBe('alignment');
		expect(derived.split('\n').filter((l) => l.startsWith('>')).length).toBe(98);
	});
});

describe('the FASTA a BEAST XML is turned into', () => {
	it('is an alignment by the page’s own classifier, in taxa order', () => {
		const derived = beastToFasta(parse(BEAST1));
		expect(derived).toBe(FASTA);
		expect(classifyDropped(derived, 'run.xml')).toBe('alignment');
	});
});

/**
 * B3: A NAMESPACED BEAST 2 DOCUMENT, DROPPED ALONE, AND WHAT `/time` SAYS ABOUT IT.
 *
 * BEAUti writes `xmlns=` on the root of some BEAST 2 templates, so this is not an edge case. The
 * REFERENCE reads nothing out of such a file — `parse_beast_xml` searches for unqualified tags
 * (`root.findall('.//data')`, dataset.py:123-127) and ElementTree names every element of a
 * namespaced document `{uri}local` — and PrimAeon replicates that, because a port is a port.
 * The bug was the PAGE: with no alignment there is no ingest, and every BEAST sentence the page
 * knows how to say hung off `ingest.beast`, so the reader was shown "Drop an alignment (FASTA,
 * NEXUS or PHYLIP)" and nothing whatever about the file they had just dropped.
 */
describe('a namespaced BEAST 2 document dropped by itself', () => {
	const NAMESPACED = `<?xml version="1.0"?>
<beast xmlns="http://beast2.org" version="2.6" namespace="beast.evolution.alignment">
    <data id="aln" spec="Alignment">
        <sequence taxon="A" value="ATGGCC"/>
        <sequence taxon="B" value="ATGGCA"/>
    </data>
    <trait spec="beast.evolution.tree.TraitSet" traitname="date" value="A=2019-01-01,B=2020-06-15"/>
</beast>`;

	it('is still classified as a BEAST file: the namespace does not break the routing', () => {
		expect(classifyDropped(NAMESPACED, 'run.xml')).toBe('beast');
		// It is a DATE source and not a metadata-slot-only one, because it can fill three slots.
		expect(isDateSource(classifyDropped(NAMESPACED, 'run.xml'))).toBe(true);
		expect(isMetadataSource(classifyDropped(NAMESPACED, 'run.xml'))).toBe(false);
	});

	it('is read as the reference reads it — empty — and the emptiness is a recorded fact', () => {
		const doc = parse(NAMESPACED);
		expect(doc.version).toBe('BEAST 2');
		expect(doc.sequences.size).toBe(0);
		expect(doc.dates.size).toBe(0);
		expect(doc.provenance.namespaced).toBe(true);
	});

	it('projects into the summary the display helpers read, with no ingest in sight', () => {
		const summary = beastSummaryOfDocument(parse(NAMESPACED));
		expect(summary).not.toBeNull();
		expect(summary?.sequences).toBe(0);
		expect(summary?.dates).toBe(0);
		expect(summary?.namespaced).toBe(true);
		expect(summary?.version).toBe('BEAST 2');
		// The provenance block is spread whole, so a field the runtime adds arrives without an edit.
		expect(summary?.alignments.seen).toBe(0);
		expect(beastSummaryOfDocument(null)).toBeNull();
	});

	it('names the file, the namespace and the way out, instead of "drop an alignment"', () => {
		const refusal = noAlignmentRefusal(beastSummaryOfDocument(parse(NAMESPACED)), 'run.xml');
		expect(refusal).toContain('run.xml');
		expect(refusal).toContain('BEAST 2');
		expect(refusal).toMatch(/XML NAMESPACE/);
		expect(refusal).toMatch(/dataset\.py:123-127/);
		expect(refusal).toMatch(/Remove the `xmlns` attribute/);
	});

	it('and the provenance lines are available without an ingest, which is the whole fix', () => {
		const lines = beastProvenanceLines(beastSummaryOfDocument(parse(NAMESPACED)), 'run.xml');
		expect(lines.length).toBeGreaterThan(0);
		expect(lines[0]).toContain('run.xml was read as BEAST 2: 0 sequence(s), 0 date(s)');
		expect(lines.join(' ')).toMatch(/declares an XML namespace/);
	});

	it('says something different when the file is simply not a BEAST document', () => {
		const empty = noAlignmentRefusal(beastSummaryOfDocument(parse('<root><a/></root>', 'x.xml')), 'x.xml');
		expect(empty).toContain('carries no sequences');
		expect(empty).not.toMatch(/XML NAMESPACE/);
		expect(empty).toMatch(/Drop an alignment/);
	});

	it('stays silent when the XML did supply an alignment — then the date layer is the one voice', () => {
		expect(noAlignmentRefusal(beastSummaryOfDocument(parse(BEAST1)), 'run.xml')).toBeNull();
	});
});
