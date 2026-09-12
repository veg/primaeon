import { describe, expect, it } from 'vitest';
import { alignmentHeaders, classifyDropped, isDateSource } from './sources';
import { available, example } from './fixtures';

describe('telling the dropped files apart', () => {
	it('recognises the three alignment formats', () => {
		expect(classifyDropped('>a\nATGATG\n>b\nATGATG\n', 'x.fasta')).toBe('alignment');
		expect(classifyDropped('#NEXUS\nBEGIN DATA;\n', 'x.nex')).toBe('alignment');
		expect(classifyDropped('3 9\na ATGATGATG\n', 'x.phy')).toBe('alignment');
	});

	it('recognises a Newick tree', () => {
		expect(classifyDropped('((a:0.1,b:0.2):0.3,c:0.4);', 'x.nwk')).toBe('tree');
		expect(classifyDropped('((a:0.1,b:0.2):0.3,c:0.4);', 'unnamed')).toBe('tree');
	});

	it('recognises an Auspice build and a flat name-to-date map as different things', () => {
		const auspice = JSON.stringify({ version: 'v2', tree: { name: 'root', children: [{ name: 'a' }] } });
		expect(classifyDropped(auspice, 'auspice.json')).toBe('auspice');
		expect(classifyDropped(JSON.stringify({ a: 2021.5, b: '2020-01-01' }), 'dates.json')).toBe('json-map');
	});

	// A JSON object with no `tree` key is the dating pillar's flat {name: date} shape
	// (dating.py:424-432), so the classifier hands it on as one rather than inventing a third kind.
	// A payload that is not actually a date map is then reported BY THE DATE LAYER — it produces no
	// dates and says so with DATES_TABLE_NO_MATCH — which is the right place for that diagnosis,
	// since only the date layer knows what the names in an alignment are.
	it('hands a non-Auspice JSON object on as a name-to-date map, and never guesses past that', () => {
		expect(classifyDropped(JSON.stringify({ some: { nested: { thing: 1 } } }), 'x.json')).toBe('json-map');
		expect(classifyDropped('plaintext', 'x.json')).toBe('unknown');
	});

	it('recognises a BEAST XML by name and by content, and never tries to parse it', () => {
		expect(classifyDropped('<?xml version="1.0"?><beast></beast>', 'run.xml')).toBe('beast');
		expect(classifyDropped('anything at all', 'run.xml')).toBe('beast');
	});

	// The two reference pillars disagree here — temporal.py:274 hands pandas the sniffer, dating.py:445
	// decides from the suffix alone — so a tab-separated `.csv` is read two ways in one release. The
	// content decides, and the name is a hint.
	it('recognises a tab-separated table named .csv', () => {
		expect(classifyDropped('Sample ID\tIsolation_Date\nA\t2021-01-01\nB\t2021-02-02\n', 'meta.csv')).toBe('table');
	});

	it('recognises a comma-separated table named .txt', () => {
		expect(classifyDropped('taxon,date\na,2021\nb,2022\n', 'meta.txt')).toBe('table');
	});

	it('names the three things dates can be read out of', () => {
		expect(isDateSource('table')).toBe(true);
		expect(isDateSource('auspice')).toBe(true);
		expect(isDateSource('json-map')).toBe(true);
		expect(isDateSource('alignment')).toBe(false);
		expect(isDateSource('tree')).toBe(false);
	});
});

describe('the key/header pair — the trap this module exists for', () => {
	// A FASTA name is the header up to the first whitespace, both here and in the library. But the
	// library's header patterns accept whitespace as a date delimiter, so in `>A/Darwin/6 2021` the
	// date lives in the part the NAME throws away. Feeding the date layer names would report "no
	// date found" on a file the command line dates correctly, and would do it silently.
	it('keeps the whole header beside the key when they differ', () => {
		const { keys, headerOf, headersDiffer } = alignmentHeaders('>A/Darwin/6 2021\nATG\n>B/Perth/9 2019\nATG\n');
		expect(keys).toEqual(['A/Darwin/6', 'B/Perth/9']);
		expect(headerOf.get('A/Darwin/6')).toBe('A/Darwin/6 2021');
		expect(headersDiffer).toBe(true);
	});

	it('reports no difference when every header is a single token', () => {
		const { keys, headerOf, headersDiffer } = alignmentHeaders('>A|2021-05-15\nATG\n>B|2020-01-01\nATG\n');
		expect(keys).toEqual(['A|2021-05-15', 'B|2020-01-01']);
		expect(headerOf.get('A|2021-05-15')).toBe('A|2021-05-15');
		expect(headersDiffer).toBe(false);
	});

	it('keeps the first of two records sharing a key, and does not duplicate it', () => {
		const { keys } = alignmentHeaders('>A one\nATG\n>A two\nATG\n');
		expect(keys).toEqual(['A']);
	});

	it('returns nothing for a non-FASTA alignment, where the name IS the whole record', () => {
		expect(alignmentHeaders('#NEXUS\nBEGIN DATA;\n').keys).toEqual([]);
	});
});

describe.skipIf(!available())('against the shipped examples', () => {
	it('reads 143 keys out of korber_env_gp160.fasta, none of them carrying whitespace', () => {
		const { keys, headersDiffer } = alignmentHeaders(example('korber_env_gp160.fasta'));
		expect(keys.length).toBe(143);
		expect(keys).toContain('Z59ZR.ZHU');
		expect(keys).toContain('CONSENSUS');
		expect(headersDiffer).toBe(false);
	});

	it('classifies the H5N1 metadata table as a table and its alignment as an alignment', () => {
		expect(classifyDropped(example('H5N1_HA_metadata.csv'), 'H5N1_HA_metadata.csv')).toBe('table');
		expect(classifyDropped(example('H5N1_HA_geo.fasta'), 'H5N1_HA_geo.fasta')).toBe('alignment');
		expect(classifyDropped(example('H5N1_HA.nwk'), 'H5N1_HA.nwk')).toBe('tree');
	});
});
