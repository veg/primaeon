/**
 * beastFixtures.ts — the BEAST XML documents the delivery tests drop and post.
 *
 * WHY THIS FILE EXISTS. Two specs read BEAST XML from opposite ends of the product — `beast.spec.ts`
 * drops one on `/time` in a real browser, `server.spec.ts` posts one to the Node server over HTTP —
 * and they must agree with each other, and with the unit suites, about what a correct read is.
 * Sharing one module is how that is enforced: change a document here and both surfaces move
 * together.
 *
 * THE TWO SMALL DOCUMENTS ARE THE REFERENCE'S OWN, character for character.
 * `REFERENCE_BEAST1` is the XML literal of `tests/test_dating.py::test_parse_beast_1_xml`
 * (tests/test_dating.py:119-134) and `REFERENCE_BEAST2` that of `test_parse_beast_2_xml`
 * (tests/test_dating.py:152-167), in the engine checkout. Their expected reads are the assertions
 * of those two tests: 4 sequences, 4 dates, `taxon_A` at 1980.0 and `taxon_D` at 2010.0 with a
 * starting tree for BEAST 1; 4 sequences, 4 dates, `isolate_A` at 1990.25 and `isolate_D` at
 * 2020.00 and no tree for BEAST 2. `runtime/test/beast-xml.test.js` holds the same two literals,
 * so an XML the Python reference reads one way cannot be read another way here without three
 * suites failing at once.
 *
 * THE REALISTIC DOCUMENT IS GENERATED, NOT TRACKED, and generated from files that already ship.
 * `beast1FromH5N1()` reads the engine's `examples/H5N1_HA_geo.fasta` (98 sequences x 1,698 nt),
 * `examples/H5N1_HA_metadata.csv` (the `taxon,date` columns of its 98 rows) and
 * `examples/H5N1_HA.nwk`, and writes the BEAST 1.x shape BEAUti produces: one
 * `<taxon id><date value direction units>` per row inside `<taxa>`, one tail-text `<sequence>` per
 * record inside `<alignment>`, and the tree in a `<newick id="startingTree">` element. Nothing is
 * invented — every name, every base, every date and every branch length is the example's own — so
 * the one file is exactly the three files flow 2 of `time.spec.ts` drops, and the two loads can be
 * asserted to produce the same review. Generating rather than tracking also keeps a 200 KB
 * derived file out of the repository and keeps it honest if the example ever changes.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ENGINE_DIR } from './helpers';

export const EXAMPLES = resolve(ENGINE_DIR, 'examples');
export const H5N1_FASTA = resolve(EXAMPLES, 'H5N1_HA_geo.fasta');
export const H5N1_META = resolve(EXAMPLES, 'H5N1_HA_metadata.csv');
export const H5N1_TREE = resolve(EXAMPLES, 'H5N1_HA.nwk');

export function haveH5N1(): boolean {
	return existsSync(H5N1_FASTA) && existsSync(H5N1_META) && existsSync(H5N1_TREE);
}

/** tests/test_dating.py:119-134 — the reference's own BEAST 1 acceptance document, verbatim. */
export const REFERENCE_BEAST1 = `<?xml version="1.0" standalone="yes"?>
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

/** tests/test_dating.py:152-167 — the reference's own BEAST 2 acceptance document, verbatim. */
export const REFERENCE_BEAST2 = `<beast version="2.6" namespace="beast.evolution.alignment:beast.evolution.tree">
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

/** The FASTA as `{name, seq}` records, in file order; the name is the header's first word. */
function fastaRecords(text: string): Array<{ name: string; seq: string }> {
	const records: Array<{ name: string; seq: string }> = [];
	let cur: { name: string; seq: string } | null = null;
	for (const line of text.split(/\r?\n/)) {
		if (line.startsWith('>')) {
			cur = { name: line.slice(1).trim().split(/\s+/)[0], seq: '' };
			records.push(cur);
		} else if (cur) cur.seq += line.trim();
	}
	return records;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

export interface GeneratedBeast {
	xml: string;
	/** Taxon name → the date string the CSV carried, in the CSV's own text. */
	dates: Map<string, string>;
	records: Array<{ name: string; seq: string }>;
	newick: string;
}

/**
 * The H5N1 example as one BEAST 1.x XML: its alignment, its metadata dates and its tree.
 *
 * The point of the document is that it is not a new dataset. The three files `time.spec.ts` flow 2
 * drops are folded into one, so the review the page builds from the XML can be compared with the
 * review it builds from the files — same 98 taxa, same values, same clock preview.
 */
export function beast1FromH5N1(): GeneratedBeast {
	const records = fastaRecords(readFileSync(H5N1_FASTA, 'utf8'));
	const csv = readFileSync(H5N1_META, 'utf8').trim().split(/\r?\n/);
	const header = csv[0].split(',');
	const dateCol = header.findIndex((h) => /^date$/i.test(h));
	const dates = new Map<string, string>(csv.slice(1).map((l) => [l.split(',')[0], l.split(',')[dateCol]] as [string, string]));
	const newick = readFileSync(H5N1_TREE, 'utf8').trim();
	const xml = [
		'<?xml version="1.0" standalone="yes"?>',
		'<beast version="1.10.4">',
		'    <taxa id="taxa">',
		...records.map(
			(r) => `        <taxon id="${esc(r.name)}"><date value="${dates.get(r.name)}" direction="forwards" units="years"/></taxon>`
		),
		'    </taxa>',
		'    <alignment id="alignment" dataType="nucleotide">',
		...records.map((r) => `        <sequence><taxon idref="${esc(r.name)}"/>${r.seq}</sequence>`),
		'    </alignment>',
		`    <newick id="startingTree">${newick}</newick>`,
		'</beast>',
		''
	].join('\n');
	return { xml, dates, records, newick };
}
