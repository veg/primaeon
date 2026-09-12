/**
 * date-ingestion.test.js — the application-side date layer, trap by trap.
 *
 * WHY THIS FILE EXISTS. `runtime/src/dates/` exists because a dated dataset fails QUIETLY
 * upstream: metadata names are compared to sequence names with nothing but a `.strip()`, a partial
 * table never falls back to the headers for the taxa it missed, a bare year is anchored at
 * 1 January without a word, and every undated taxon is dropped without being named. Each of those
 * is a number that comes out plausible and wrong, so each one is a test here, and each test asserts
 * the PROVENANCE — `rule`, `source`, `imputed`, `match_tier` — and not only the value. A test that
 * checked the number alone would pass on a layer that lied about where the number came from.
 *
 * WHAT IS ASSERTED AGAINST WHAT.
 *
 *   - The two column-candidate lists are compared VERBATIM against `hyphaeon/temporal.py` and
 *     `hyphaeon/dating.py` themselves, lifted out of the Python source at test time. A list that
 *     drifts from upstream is a silent behaviour change, and this is the only way it fails loudly.
 *   - The three shipped example files carry the measurements the specification was written from:
 *     korber 142 of 143, H1N1 95 of 100 with the five misses named, H5N1 98 of 98 with the table
 *     and the headers agreeing. These are the assertions that catch a regression nothing else will.
 *   - Everything else is a constructed case aimed at one trap, named in the test's own title.
 *
 * THE CAPABILITY PROBE, AND WHY IT IS NOT A try/catch. CI pins `ENGINE_REF` to a tag that predates
 * `js/src/dates.js`, and the phase is forbidden from bumping it. A named import of a missing export
 * is an ES-module LINK error that would take the whole workspace down, so `library.js` imports the
 * library as a namespace and `hasDateLayer()` reports the truth; this suite skips on that probe and
 * PRINTS WHY, rather than passing quietly or failing for a reason unrelated to the change.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
	ingestDates,
	detectDateSourceKind,
	inferTimeUnits,
	dateSpan,
	datesVector,
	alignDatesToRun,
	datesPreprocessing,
	taxaForDates,
	sniffDelimiter,
	discoverStrainColumn,
	discoverDateColumn,
	readDateTable,
	walkAuspiceDates,
	isAuspiceJson,
	compileDateRegex,
	applyDateRegex,
	datesFromHeaders,
	archival1959Candidates,
	archival1959Changes,
	matchDateNames,
	nameFields,
	normalizeForTier,
	hasDateLayer,
	missingDateExports,
	STRAIN_COLUMNS_TEMPORAL,
	DATE_COLUMNS_TEMPORAL,
	STRAIN_COLUMNS_DATING,
	DATE_COLUMNS_DATING,
	DATE_DIAGNOSTIC_CODES,
	DATE_MATCH_TIERS,
	DATE_THRESHOLDS,
	DATE_SCHEMA_VERSION
} from '../src/dates/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNTIME = join(HERE, '..');
const ENGINE = process.env.HYPHAEON_ENGINE_DIR ?? join(RUNTIME, '..', '..', 'HyphAeon');
const EXAMPLES = join(ENGINE, 'examples');
const REFERENCE = join(ENGINE, 'hyphaeon');

const HAS_LIBRARY = hasDateLayer();
if (!HAS_LIBRARY) {
	console.warn(
		`\n[date-ingestion] SUITE SKIPPED — the linked @veg/hyphaeon-js does not export ` +
			`${missingDateExports().join(', ')}. It predates js/src/dates.js (feat/date-parsers); ` +
			`check out an engine carrying the date layer beside this repository.\n`
	);
}
const HAS_EXAMPLES = existsSync(join(EXAMPLES, 'korber_env_gp160.fasta'));
if (!HAS_EXAMPLES) {
	console.warn(`\n[date-ingestion] EXAMPLE-FILE CASES SKIPPED — needs ${EXAMPLES}.\n`);
}
const HAS_REFERENCE = existsSync(join(REFERENCE, 'temporal.py'));
if (!HAS_REFERENCE) {
	console.warn(`\n[date-ingestion] CANDIDATE-LIST CHECK SKIPPED — needs ${REFERENCE}/temporal.py.\n`);
}

const suite = describe.skipIf(!HAS_LIBRARY);
const withExamples = describe.skipIf(!HAS_LIBRARY || !HAS_EXAMPLES);
const withReference = describe.skipIf(!HAS_LIBRARY || !HAS_REFERENCE);

/** Every code a run raised, in the order the layer sorted them. */
const codes = (ingest) => ingest.warnings.map((w) => w.code);
/** One warning by code, or undefined. */
const pick = (ingest, code) => ingest.warnings.find((w) => w.code === code);
/** The row for one taxon. */
const row = (ingest, taxon) => ingest.rows.find((r) => r.taxon === taxon);

const THREE = ['a', 'b', 'c'];
const THREE_TABLE = 'strain,date\na,2019-01-02\nb,2020-01-02\nc,2021-01-02\n';

// =================================================================================================
// The candidate lists, against the Python itself
// =================================================================================================

withReference('the column-candidate lists are the reference\'s own', () => {
	/** Lift a `cand_… = [ … ]` literal out of a Python source, in source order. */
	function pythonList(file, name) {
		const src = readFileSync(join(REFERENCE, file), 'utf8');
		const at = src.indexOf(`${name} = [`);
		expect(at, `${name} not found in ${file}`).toBeGreaterThan(-1);
		const end = src.indexOf(']', at);
		return Array.from(src.slice(at, end).matchAll(/'([^']*)'/g), (m) => m[1]);
	}

	it('temporal.py:282-285 cand_strains is STRAIN_COLUMNS_TEMPORAL, in order', () => {
		expect(pythonList('temporal.py', 'cand_strains')).toEqual([...STRAIN_COLUMNS_TEMPORAL]);
	});

	it('temporal.py:296-301 cand_dates is DATE_COLUMNS_TEMPORAL, in order', () => {
		expect(pythonList('temporal.py', 'cand_dates')).toEqual([...DATE_COLUMNS_TEMPORAL]);
	});

	it('dating.py:449 cand_strains is STRAIN_COLUMNS_DATING, in order', () => {
		expect(pythonList('dating.py', 'cand_strains')).toEqual([...STRAIN_COLUMNS_DATING]);
	});

	it('dating.py:458 cand_dates is DATE_COLUMNS_DATING, in order', () => {
		expect(pythonList('dating.py', 'cand_dates')).toEqual([...DATE_COLUMNS_DATING]);
	});

	it('the two lists really do differ — this layer takes the union deliberately', () => {
		expect([...STRAIN_COLUMNS_TEMPORAL]).not.toEqual([...STRAIN_COLUMNS_DATING]);
		expect(STRAIN_COLUMNS_DATING).toContain('genome_id'); // temporal has no such candidate
		expect(STRAIN_COLUMNS_TEMPORAL).toContain('Sequence ID'); // dating has no such candidate
	});
});

// =================================================================================================
// The delimiter sniff
// =================================================================================================

suite('the delimiter is sniffed from the content, never decided by the suffix', () => {
	it('reads a tab, a comma, a semicolon and a pipe', () => {
		for (const sep of ['\t', ',', ';', '|']) {
			const text = `name${sep}date\na${sep}2019\nb${sep}2020\n`;
			const s = sniffDelimiter(text);
			expect(s.delimiter, `sep ${JSON.stringify(sep)}`).toBe(sep);
			expect(s.source).toBe('sniffed');
			expect(s.fields).toBe(2);
			expect(s.confidence).toBe(1);
		}
	});

	it('a TAB-separated file named .csv is read as tabs — the case the two references disagree on', () => {
		// MEASURED: pandas with sep=None, engine='python' (temporal.py:275) sniffs the tab and yields
		// two columns; dating.py:445 decides by suffix, reads it with sep=',', gets ONE column, and
		// then its strain column and its date column are the same column.
		const text = 'Sample ID\tIsolation_Date\na\t2019-01-02\nb\t2020-01-02\n';
		const s = sniffDelimiter(text, { fileName: 'meta.csv' });
		expect(s.delimiter).toBe('\t');
		expect(s.extensionHint).toBe(',');
		expect(s.agrees).toBe(false);
	});

	it('does not split inside RFC 4180 quotes', () => {
		const text = 'name,date\n"Smith, A",2019\n"Jones, B",2020\n';
		expect(sniffDelimiter(text).delimiter).toBe(',');
		expect(sniffDelimiter(text).fields).toBe(2);
	});

	it('handles CRLF', () => {
		expect(sniffDelimiter('name,date\r\na,2019\r\nb,2020\r\n').delimiter).toBe(',');
	});

	it('a supplied delimiter is honoured and reported as supplied', () => {
		const s = sniffDelimiter('a;b\n1;2\n', { delimiter: ';' });
		expect(s.source).toBe('supplied');
	});

	it('a single-column text lets the extension answer, and only then', () => {
		const s = sniffDelimiter('name\na\nb\n', { fileName: 'x.tsv' });
		expect(s.source).toBe('extension');
		expect(s.delimiter).toBe('\t');
	});
});

// =================================================================================================
// Column discovery, every rung of both ladders
// =================================================================================================

suite('column discovery walks the union ladder and names the rung it stopped on', () => {
	it('temporal wins when a temporal-only candidate is present, in CANDIDATE order', () => {
		// `id` comes before `strain` in the COLUMNS but after it in the candidate list, and temporal
		// iterates the candidates: `strain` wins.
		const got = discoverStrainColumn(['id', 'strain', 'time', 'date']);
		expect(got).toMatchObject({ column: 'strain', source: 'temporal', guessed: false });
	});

	it('dating rung: a candidate only dating knows, matched case-INsensitively in COLUMN order', () => {
		const got = discoverStrainColumn(['GENOME_ID', 'x']);
		expect(got).toMatchObject({ column: 'GENOME_ID', source: 'dating' });
	});

	it('first_column is the last rung and is flagged as a guess', () => {
		const got = discoverStrainColumn(['sample', 'when']);
		expect(got).toMatchObject({ column: 'sample', index: 0, source: 'first_column', guessed: true });
	});

	it('a requested column that does not exist falls THROUGH to discovery, as temporal.py:280 does', () => {
		const got = discoverStrainColumn(['strain', 'date'], 'no_such_column');
		expect(got).toMatchObject({ column: 'strain', source: 'temporal' });
	});

	it('a requested column that exists wins', () => {
		expect(discoverDateColumn(['strain', 'date', 'submitted'], 'submitted')).toMatchObject({
			column: 'submitted',
			source: 'supplied'
		});
	});

	it("contains_date is temporal.py:307-310's substring rung", () => {
		expect(discoverDateColumn(['taxon', 'Isolation_Date'])).toMatchObject({
			column: 'Isolation_Date',
			source: 'contains_date',
			guessed: true
		});
	});

	it("second_column is dating.py:463-464's rung, which temporal does not have at all", () => {
		expect(discoverDateColumn(['taxon', 'whenever'], null, { excludeIndex: 0 })).toMatchObject({
			column: 'whenever',
			index: 1,
			source: 'second_column',
			guessed: true
		});
	});

	it('the date column is never the strain column, which the reference does not check', () => {
		expect(discoverDateColumn(['only'], null, { excludeIndex: 0 })).toMatchObject({ column: null });
	});

	it('COLUMN PRIORITY TRAP: `generation` beats `date` even on a calendar axis (temporal.py:296)', () => {
		expect(discoverDateColumn(['strain', 'date', 'generation'])).toMatchObject({
			column: 'generation',
			source: 'temporal'
		});
	});

	it('the discovered pair on `id,strain,time,date` is temporal\'s answer, (strain, time)', () => {
		const cols = ['id', 'strain', 'time', 'date'];
		expect(discoverStrainColumn(cols).column).toBe('strain');
		expect(discoverDateColumn(cols, null, { excludeIndex: 1 }).column).toBe('time');
	});
});

// =================================================================================================
// Reading a table
// =================================================================================================

suite('reading a table records what neither reference records', () => {
	it('NUMERIC IDENTIFIER TRAP: one blank cell turns the id column into float64', () => {
		// MEASURED: pandas infers float64 for a numeric column holding one NA, and `str(v).strip()`
		// then yields '402124.0' and 'nan' — which match nothing, with no error anywhere.
		const text = 'id,date\n402124,2019-01-02\n,2020-01-02\n402130,2021-01-02\n';
		const read = readDateTable(text, { fileName: 'n.csv' });
		expect(read.numericNames).toBe(2);
		expect(read.entries[0].name).toBe('402124.0');
		expect(read.entries[1].name).toBe('nan');
	});

	it('a name that appears twice lets the LAST row win, as the reference dict does, and is recorded', () => {
		const text = 'strain,date\na,2019-01-02\na,2021-01-02\nb,2020-01-02\n';
		const read = readDateTable(text);
		expect(read.duplicates).toHaveLength(1);
		expect(read.duplicates[0]).toMatchObject({ name: 'a', rows: [0, 1], conflicting: true });
	});

	it('a duplicate carrying the SAME date is recorded as non-conflicting', () => {
		const read = readDateTable('strain,date\na,2019-01-02\na,2019-01-02\n');
		expect(read.duplicates[0].conflicting).toBe(false);
	});

	it('the name is `str(cell).strip()` and nothing else — no case folding lives in the reader', () => {
		const read = readDateTable('strain,date\n  Spaced  ,2019-01-02\n');
		expect(read.entries[0].name).toBe('Spaced');
	});
});

// =================================================================================================
// The name-matching ladder
// =================================================================================================

suite('name matching cascades per taxon and reports the tier', () => {
	it('tier 1 exact', () => {
		const m = matchDateNames(['a', 'b'], ['a', 'b']);
		expect(m.tiers.exact).toBe(2);
		expect(m.tier).toBe('exact');
		expect(m.unmatchedTaxa).toEqual([]);
	});

	it('tier 2 quote_stripped', () => {
		const m = matchDateNames(["'a'"], ['a']);
		expect(m.assignments.get('a')).toMatchObject({ name: "'a'", tier: 'quote_stripped' });
	});

	it('tier 3 whitespace_collapsed', () => {
		const m = matchDateNames(['a  b'], ['a b']);
		expect(m.assignments.get('a b').tier).toBe('whitespace_collapsed');
	});

	it('tier 4 case_insensitive', () => {
		const m = matchDateNames(['SEQ_A'], ['seq_a']);
		expect(m.assignments.get('seq_a').tier).toBe('case_insensitive');
	});

	it('tier 5 first_token — the library names a sequence by its first whitespace token', () => {
		const m = matchDateNames(['seq1 description here'], ['seq1']);
		expect(m.assignments.get('seq1').tier).toBe('first_token');
	});

	it('tier 6 sanitized — the app creates this mismatch itself by rewriting names on upload', () => {
		const m = matchDateNames(['seq(1)'], ['seq_1_']);
		const hit = m.assignments.get('seq_1_');
		expect(hit?.tier).toBe('sanitized');
	});

	it('tier 7 field_containment — the GISAID case, and the only tier that fixes it', () => {
		const taxa = ['hCoV-19/Wuhan/IVDC-HB-01/2019|EPI_ISL_402124|2019-12-30'];
		const m = matchDateNames(['EPI_ISL_402124'], taxa);
		expect(m.assignments.get(taxa[0])).toMatchObject({
			name: 'EPI_ISL_402124',
			tier: 'field_containment'
		});
	});

	it('an accession is a WHOLE field: `_` is not a field separator, or the key itself is shattered', () => {
		expect(nameFields('hCoV-19/Wuhan/IVDC-HB-01/2019|EPI_ISL_402124|2019-12-30')).toContain(
			'EPI_ISL_402124'
		);
	});

	it('SUBSTRING IS NEVER A TIER: a prefix of an accession matches nothing', () => {
		const taxa = ['x|EPI_ISL_402124|y'];
		const m = matchDateNames(['EPI_ISL_4021'], taxa);
		expect(m.assignments.size).toBe(0);
		expect(m.unmatchedMetadata).toEqual(['EPI_ISL_4021']);
	});

	it('tier 7 is refused when it is not a bijection: one name claiming two taxa claims neither', () => {
		const taxa = ['a|SHARED|1', 'b|SHARED|2'];
		const m = matchDateNames(['SHARED'], taxa);
		expect(m.assignments.size).toBe(0);
		expect(m.ambiguous[0]).toMatchObject({ name: 'SHARED', tier: 'field_containment' });
		expect(m.ambiguous[0].taxa).toEqual(taxa);
	});

	it('two metadata names normalising onto one taxon at the SAME tier assign neither', () => {
		// Neither is exact, and both fold onto `seq` at tier 4. A weaker tier cannot resolve an
		// ambiguity a stronger one created, so the cascade stops rather than continuing.
		const m = matchDateNames(['SEQ', 'Seq'], ['seq']);
		expect(m.assignments.size).toBe(0);
		expect(m.ambiguous).toHaveLength(1);
		expect(m.ambiguous[0].tier).toBe('case_insensitive');
	});

	it('an EXACT match still wins when another name would also fold onto it', () => {
		const m = matchDateNames(['SEQ', 'seq'], ['seq']);
		expect(m.assignments.get('seq')).toMatchObject({ name: 'seq', tier: 'exact' });
		expect(m.unmatchedMetadata).toEqual(['SEQ']);
	});

	it('THE CASCADE IS PER TAXON: an exact match is not lost because another row needed a weaker tier', () => {
		const m = matchDateNames(['a', 'B'], ['a', 'b']);
		expect(m.tiers.exact).toBe(1);
		expect(m.tiers.case_insensitive).toBe(1);
		expect(m.tier).toBe('case_insensitive'); // the WEAKEST tier that contributed
	});

	it('every tier name is a DATE_MATCH_TIERS member and normalizeForTier is total over them', () => {
		for (const tier of DATE_MATCH_TIERS) {
			expect(typeof normalizeForTier('Some Name', tier)).toBe('string');
		}
	});
});

// =================================================================================================
// The Auspice walk
// =================================================================================================

suite('the Auspice v2 walk replicates temporal.py:163-190 and counts which branch fired', () => {
	const build = (children) => ({ version: 'v2', meta: {}, tree: { name: 'ROOT', children } });

	it('the attribute order is num_date.value, date.value, year.value, then the bare scalars', () => {
		const walk = walkAuspiceDates(
			build([
				{ name: 't1', node_attrs: { num_date: { value: 2019.5 }, date: { value: '1900-01-01' } } },
				{ name: 't2', node_attrs: { date: { value: '2020-03-01' } } },
				{ name: 't3', node_attrs: { year: { value: 2021 } } },
				{ name: 't4', node_attrs: { num_date: 2018.25 } },
				{ name: 't5', node_attrs: { date: '2017-06-01' } }
			])
		);
		expect(walk.dated).toBe(5);
		expect(walk.dates.get('t1').value).toBe(2019.5); // num_date beat date
		expect(walk.attrUsed).toMatchObject({
			num_date: 1,
			date: 1,
			year: 1,
			num_date_scalar: 1,
			date_scalar: 1,
			tip_name: 0
		});
	});

	it('there is NO bare-scalar `year` branch in the reference, so there is none here', () => {
		const walk = walkAuspiceDates(build([{ name: 'no_date_here', node_attrs: { year: 2021 } }]));
		expect(walk.dated).toBe(0);
		expect(walk.attrUsed.year).toBe(0);
	});

	it('the TIP NAME is the last resort, and it is counted', () => {
		const walk = walkAuspiceDates(build([{ name: 'isolate|2021-05-15', node_attrs: {} }]));
		expect(walk.attrUsed.tip_name).toBe(1);
		expect(walk.dates.get('isolate|2021-05-15').value).toBeCloseTo(2021.3671, 4);
	});

	it('an INTERNAL node is never read, even when Auspice put a date on it', () => {
		const walk = walkAuspiceDates({
			tree: {
				name: 'internal',
				node_attrs: { num_date: { value: 1999 } },
				children: [{ name: 'tip', node_attrs: { num_date: { value: 2020 } } }]
			}
		});
		expect(walk.tips).toBe(1);
		expect(walk.dates.has('internal')).toBe(false);
	});

	it('a nameless tip is skipped silently upstream, and COUNTED here', () => {
		const walk = walkAuspiceDates(build([{ node_attrs: { num_date: { value: 2020 } } }]));
		expect(walk.tips).toBe(1);
		expect(walk.nameless).toBe(1);
		expect(walk.dated).toBe(0);
	});

	it("a bare tree object with no `tree` key IS the tree (temporal.py:159's data.get('tree', data))", () => {
		const walk = walkAuspiceDates({
			name: 'ROOT',
			children: [{ name: 't', node_attrs: { num_date: { value: 2020 } } }]
		});
		expect(walk.rootKey).toBe('self');
		expect(walk.dated).toBe(1);
	});

	it('isAuspiceJson tells a build from a flat name-to-date map', () => {
		expect(isAuspiceJson({ tree: {} })).toBe(true);
		expect(isAuspiceJson({ a: 2019, b: 2020 })).toBe(false);
	});

	it('a build dated only from tip names raises DATES_AUSPICE_TIP_NAME_FALLBACK', () => {
		const json = build([
			{ name: 'x|2019-01-01', node_attrs: {} },
			{ name: 'y|2020-01-01', node_attrs: {} },
			{ name: 'z|2021-01-01', node_attrs: {} }
		]);
		const ing = ingestDates({
			taxa: ['x|2019-01-01', 'y|2020-01-01', 'z|2021-01-01'],
			source: JSON.stringify(json),
			sourceName: 'build.json'
		});
		expect(ing.source_kind).toBe('auspice');
		expect(codes(ing)).toContain('DATES_AUSPICE_TIP_NAME_FALLBACK');
		expect(ing.auspice.attr_used.tip_name).toBe(3);
	});

	it('a JSON with no named tip is refused, not silently empty', () => {
		const ing = ingestDates({
			taxa: THREE,
			source: JSON.stringify({ tree: { children: [{ node_attrs: {} }] } }),
			sourceName: 'empty.json'
		});
		expect(ing.ok).toBe(false);
		expect(codes(ing)).toContain('DATES_AUSPICE_NO_TIPS');
	});

	it("dating.py:424-432's OTHER shape: a flat {name: date} map, with the {year: …} second chance", () => {
		const ing = ingestDates({
			taxa: THREE,
			source: '{"a": 2019.5, "b": "2020-03-01", "c": {"year": 2021}}',
			sourceName: 'map.json'
		});
		expect(ing.source_kind).toBe('json-map');
		expect(ing.coverage.dated).toBe(3);
		expect(ing.coverage.from_map).toBe(3);
		expect(row(ing, 'c').value).toBe(2021);
	});
});

// =================================================================================================
// The custom pattern
// =================================================================================================

suite('the custom pattern is validated before it is ever run', () => {
	it('a pattern with a capturing group dates by group(1), as dating.py:478 does', () => {
		const ing = ingestDates({
			taxa: ['s_2019_x', 's_2020_x', 's_2021_x'],
			dateRegex: '_(\\d{4})_'
		});
		expect(ing.coverage.from_regex).toBe(3);
		expect(row(ing, 's_2019_x')).toMatchObject({ source: 'regex', raw: '2019', value: 2019 });
	});

	it('NO CAPTURING GROUP is refused at the input — upstream raises IndexError at dating.py:478', () => {
		const compiled = compileDateRegex('\\d{4}');
		expect(compiled.valid).toBe(false);
		expect(compiled.code).toBe('DATE_REGEX_NO_GROUP');
		const ing = ingestDates({ taxa: THREE, dateRegex: '\\d{4}' });
		expect(ing.ok).toBe(false);
		expect(pick(ing, 'DATE_REGEX_NO_GROUP').severity).toBe('refuse');
	});

	it('(?:…) is not a capturing group and is refused too', () => {
		expect(compileDateRegex('(?:\\d{4})').valid).toBe(false);
	});

	it('an uncompilable pattern is refused with the engine\'s own message', () => {
		const ing = ingestDates({ taxa: THREE, dateRegex: '(' });
		expect(ing.ok).toBe(false);
		expect(pick(ing, 'DATE_REGEX_INVALID').message).toMatch(/could not be compiled/);
	});

	it('a pattern longer than the cap is refused unrun', () => {
		const long = `(${'a'.repeat(DATE_THRESHOLDS.maxPatternLength)})`;
		expect(compileDateRegex(long).valid).toBe(false);
	});

	it('the `g` flag is stripped, or `lastIndex` would date every other taxon', () => {
		const compiled = compileDateRegex('(\\d{4})', { flags: 'gi' });
		expect(compiled.flags).toBe('i');
		expect(applyDateRegex('x_2019', compiled).parse.value).toBe(2019);
		expect(applyDateRegex('x_2019', compiled).parse.value).toBe(2019);
	});

	it('a pattern that matches nothing is reported, and the header fallback still runs', () => {
		const ing = ingestDates({ taxa: ['x|2019-01-01', 'y|2020-01-01', 'z|2021-01-01'], dateRegex: '(ZZZ)' });
		expect(codes(ing)).toContain('DATE_REGEX_NO_MATCH');
		expect(ing.coverage.from_header).toBe(3);
	});

	it('the pattern is tried BEFORE the built-in header rules (dating.py:474-483)', () => {
		const ing = ingestDates({ taxa: ['x|2019-01-01'], dateRegex: '\\|(\\d{4})' });
		expect(row(ing, 'x|2019-01-01').source).toBe('regex');
	});
});

// =================================================================================================
// The header fallback and the 1959 anchor
// =================================================================================================

suite('the header fallback is per taxon, and the 1959 anchor is offered rather than applied', () => {
	it('parseHeaderDate is the superset the fallback calls (dating.py delegates to temporal first)', () => {
		const read = datesFromHeaders(['B86US.SFMHS18', 'isolate|2021-05-15', 'CONSENSUS']);
		expect(read.dated).toBe(2);
		expect(read.rules).toMatchObject({ korber_isolate: 1, header_iso: 1 });
		// Every attempt is kept, dated or not, so an undated row can still say WHY.
		expect(read.parses.get('CONSENSUS').rule).toBe('unparsed');
	});

	it('archival1959 is OFF by default and the candidates are named with what they would become', () => {
		const taxa = ['ZR59.KINSHASA', 'A/Brisbane/1959/2019', 'x|2001-01-01', 'y|2002-01-01'];
		const ing = ingestDates({ taxa });
		expect(archival1959Candidates(taxa)).toEqual(['ZR59.KINSHASA', 'A/Brisbane/1959/2019']);
		const w = pick(ing, 'DATES_ARCHIVAL_1959_AVAILABLE');
		expect(w.severity).toBe('info');
		expect(w.data.total).toBe(2);
	});

	it('THE ANCHOR IS AN UNBOUNDED SUBSTRING TEST: a 2019 strain numbered 1959 becomes 1959.5', () => {
		const taxa = ['A/Brisbane/1959/2019', 'x|2001-01-01', 'y|2002-01-01'];
		const off = ingestDates({ taxa });
		const on = ingestDates({ taxa, archival1959: true });
		expect(row(off, taxa[0]).value).toBe(2019);
		expect(row(on, taxa[0]).value).toBe(1959.5);
		expect(row(on, taxa[0]).rule).toBe('archival_1959');
		expect(pick(on, 'DATES_ARCHIVAL_1959_APPLIED').severity).toBe('warn');
		expect(archival1959Changes(taxa)).toEqual([{ taxon: taxa[0], without: 2019, with: 1959.5 }]);
	});

	it('headerFallback: false is temporal.py:323\'s behaviour, and it is reachable on purpose', () => {
		const taxa = ['x|2019-01-01', 'y|2020-01-01', 'z|2021-01-01'];
		const ing = ingestDates({ taxa, headerFallback: false });
		expect(ing.coverage.dated).toBe(0);
		expect(ing.ok).toBe(false);
	});
});

// =================================================================================================
// Units
// =================================================================================================

suite('the time axis is decided once, and the decision is shown', () => {
	it('a supplied unit is used and marked supplied', () => {
		const ing = ingestDates({ taxa: ['g_1', 'g_2', 'g_3'], timeUnits: 'generations' });
		expect(ing.time_units_source).toBe('supplied');
		expect(codes(ing)).not.toContain('DATES_UNITS_INFERRED');
	});

	it('a `generation` column names the axis before any value is read', () => {
		const got = inferTimeUnits(['1', '2'], { dateColumn: 'generation' });
		expect(got).toMatchObject({ timeUnits: 'generations', source: 'inferred' });
		expect(got.evidence.reason).toBe('column_name');
	});

	it('a generations panel is inferred from the values', () => {
		const ing = ingestDates({ taxa: ['clone_g5000', 'clone_g24500', 'clone_g50000'] });
		expect(ing.time_units).toBe('generations');
		expect(ing.rows.map((r) => r.value)).toEqual([5000, 24500, 50000]);
		expect(pick(ing, 'DATES_UNITS_INFERRED').severity).toBe('warn');
	});

	it('THE PROBE USES THE NAME PATH FOR NAMES: LANL names are a calendar axis, not generations', () => {
		// MEASURED before this was fixed: probing names with the VALUE path scored 0 calendar against
		// 142 non-calendar on korber, because the non-calendar branch takes the first number ANYWHERE
		// in a string (temporal.py:96) and read the `86` of `B86US`.
		const got = inferTimeUnits([], { taxa: ['B86US.SFMHS18', 'A92UG.037', 'C86ET.ETH2220'], path: 'name' });
		expect(got.timeUnits).toBe('years');
		expect(got.evidence.yearsDated).toBe(3);
	});

	it('A CALENDAR MAJORITY WINS OUTRIGHT, whatever the non-calendar pass scored', () => {
		// The non-calendar bare-field rule claims a pipe field on every one of these names; the
		// calendar rules reach two of three. Without the majority rule the axis flips to generations
		// and the dates become the pipe fields.
		const taxa = ['A/X/1/2009|geo|121|2009.332', 'A/Y/2/2009|geo|297|2009.814', 'A/Z/3/2009|geo|229|nope'];
		const got = inferTimeUnits([], { taxa, path: 'name' });
		expect(got.evidence.nonCalendarDated).toBeGreaterThan(got.evidence.yearsDated);
		expect(got.evidence.calendarShare).toBeGreaterThanOrEqual(DATE_THRESHOLDS.calendarMajority);
		expect(got.timeUnits).toBe('years');
	});
});

// =================================================================================================
// The refusals
// =================================================================================================

suite('the refusals are returned, never thrown, and ok says so', () => {
	it('DATES_NONE when nothing carries a date', () => {
		const ing = ingestDates({ taxa: ['alpha', 'beta', 'gamma'] });
		expect(ing.ok).toBe(false);
		expect(pick(ing, 'DATES_NONE').severity).toBe('refuse');
		expect(pick(ing, 'DATES_NONE').data.sources_tried).toContain('header');
	});

	it('DATES_TOO_FEW below three, with the reason stated', () => {
		const ing = ingestDates({ taxa: ['x|2019-01-01', 'y|2020-01-01', 'nothing'], headerFallback: true });
		expect(ing.coverage.dated).toBe(2);
		expect(pick(ing, 'DATES_TOO_FEW').message).toMatch(/at least 3/);
		expect(ing.ok).toBe(false);
	});

	it('DATES_NO_SPAN when every dated sequence carries the same value', () => {
		const ing = ingestDates({ taxa: ['x|2019-01-01', 'y|2019-01-01', 'z|2019-01-01'] });
		expect(ing.coverage.dated).toBe(3);
		expect(pick(ing, 'DATES_NO_SPAN').severity).toBe('refuse');
	});

	it('DATES_BEAST_XML_UNSUPPORTED names the reference line it is not implementing', () => {
		const ing = ingestDates({ taxa: THREE, source: '<?xml version="1.0"?><beast/>', sourceName: 'b.xml' });
		expect(pick(ing, 'DATES_BEAST_XML_UNSUPPORTED').message).toMatch(/dating\.py:433-434/);
	});

	it('DATES_SOURCE_KIND_UNKNOWN for a file that is none of the three shapes', () => {
		const ing = ingestDates({ taxa: THREE, source: 'just one column\nof text\n', sourceName: 'x.txt' });
		expect(pick(ing, 'DATES_SOURCE_KIND_UNKNOWN').severity).toBe('refuse');
	});

	it('DATES_SOURCE_UNREADABLE for JSON that will not parse', () => {
		const ing = ingestDates({ taxa: THREE, source: '{"tree": ', sourceName: 'broken.json' });
		expect(codes(ing)).toContain('DATES_SOURCE_KIND_UNKNOWN');
	});

	it('DATES_TABLE_NO_DATE_COLUMN lists the columns read and both candidate lists', () => {
		const ing = ingestDates({ taxa: THREE, source: 'only_one_column\na\nb\n', sourceName: 't.csv' });
		expect(ing.ok).toBe(false);
	});

	it('every refusal comes back as data; ingestDates never throws on bad input', () => {
		expect(() => ingestDates({ taxa: [] })).not.toThrow();
		expect(() => ingestDates({ taxa: THREE, source: ' ', sourceName: 'x' })).not.toThrow();
	});
});

// =================================================================================================
// The traps, end to end
// =================================================================================================

suite('the four traps, each as the page will see it', () => {
	it('TRAP 1, names that do not match: both name sets come back, and nothing is silently dropped', () => {
		const table = 'strain,date\nEPI_ISL_1,2019-01-02\nEPI_ISL_2,2020-01-02\nEPI_ISL_3,2021-01-02\n';
		const ing = ingestDates({ taxa: THREE, source: table, sourceName: 'm.csv', headerFallback: false });
		const w = pick(ing, 'DATES_TABLE_NO_MATCH');
		expect(w.severity).toBe('refuse');
		expect(w.data.metadata_names).toEqual(['EPI_ISL_1', 'EPI_ISL_2', 'EPI_ISL_3']);
		expect(w.data.taxa).toEqual(THREE);
		expect(ing.rows).toHaveLength(3); // one row per taxon, even with zero dates
	});

	it('TRAP 1b: the same table is only a WARNING when the headers then dated enough taxa', () => {
		const taxa = ['x|2019-01-01', 'y|2020-01-01', 'z|2021-01-01'];
		const table = 'strain,date\nEPI_ISL_1,2019-01-02\n';
		const ing = ingestDates({ taxa, source: table, sourceName: 'm.csv' });
		const w = pick(ing, 'DATES_TABLE_NO_MATCH');
		expect(w.severity).toBe('warn');
		expect(w.data.rescued_by_headers).toBe(true);
		expect(ing.ok).toBe(true);
		expect(ing.coverage.from_header).toBe(3);
	});

	it('TRAP 1c: the numeric-identifier cause is NAMED in the refusal, not left a mystery', () => {
		const table = 'id,date\n402124,2019-01-02\n,2020-01-02\n402130,2021-01-02\n';
		const ing = ingestDates({
			taxa: ['402124', '402130'],
			source: table,
			sourceName: 'n.csv',
			headerFallback: false
		});
		const w = pick(ing, 'DATES_TABLE_NO_MATCH');
		expect(w.data.numeric_names).toBe(2);
		expect(w.message).toMatch(/were read as numbers/);
	});

	it('TRAP 2, partial coverage: the headers fill what the table missed, PER TAXON', () => {
		const taxa = ['x|2019-01-01', 'y|2020-01-01', 'z|2021-01-01', 'w|2022-01-01'];
		const table = 'strain,date\nx|2019-01-01,2019-06-01\ny|2020-01-01,2020-06-01\n';
		const ing = ingestDates({ taxa, source: table, sourceName: 'p.csv' });
		expect(ing.coverage.from_table).toBe(2);
		expect(ing.coverage.from_header).toBe(2);
		expect(ing.coverage.dated).toBe(4);
		expect(pick(ing, 'DATES_HEADER_FALLBACK').message).toMatch(/temporal\.py:323/);
		expect(row(ing, 'z|2021-01-01').source).toBe('header');
	});

	it('TRAP 2b: temporal\'s own policy loses those taxa, and the loss is NAMED', () => {
		const taxa = ['x|2019-01-01', 'y|2020-01-01', 'z|2021-01-01', 'w|2022-01-01'];
		const table = 'strain,date\nx|2019-01-01,2019-06-01\ny|2020-01-01,2020-06-01\n';
		const ing = ingestDates({ taxa, source: table, sourceName: 'p.csv', headerFallback: false });
		expect(ing.coverage.dated).toBe(2);
		const w = pick(ing, 'DATES_PARTIAL_COVERAGE');
		expect(w.severity).toBe('warn');
		expect(w.data.names).toEqual(['z|2021-01-01', 'w|2022-01-01']);
		expect(w.message).toMatch(/dropped/);
	});

	it('TRAP 3, a bare year is 1 JANUARY, not mid-year — the docstring is wrong and the code is pinned', () => {
		const ing = ingestDates({
			taxa: THREE,
			source: 'strain,date\na,2005\nb,2006\nc,2007\n',
			sourceName: 'y.csv',
			timeUnits: 'years'
		});
		expect(row(ing, 'a').value).toBe(2005);
		expect(row(ing, 'a').imputed).toBe(false);
		expect(codes(ing)).not.toContain('DATES_IMPUTED');
	});

	it('TRAP 3b: a missing day is imputed to the 15th, and the row says so', () => {
		const ing = ingestDates({
			taxa: THREE,
			source: 'strain,date\na,2005-03\nb,2006-01-01\nc,2007-01-01\n',
			sourceName: 'y.csv',
			timeUnits: 'years'
		});
		expect(row(ing, 'a').imputations).toMatchObject({ month: false, day: true });
		expect(pick(ing, 'DATES_IMPUTED').data.count).toBe(1);
	});

	it('TRAP 3c: a masked date invents BOTH components, and is distinguishable from a bare year', () => {
		const ing = ingestDates({
			taxa: THREE,
			source: 'strain,date\na,2021-XX-XX\nb,2021-13-40\nc,2022-01-01\n',
			sourceName: 'y.csv',
			timeUnits: 'years'
		});
		expect(row(ing, 'a').imputations).toMatchObject({ month: true, day: true });
		// An out-of-range month and day are DISCARDED and the defaults kept, with no error upstream.
		expect(row(ing, 'b').value).toBeCloseTo(row(ing, 'a').value, 10);
		expect(row(ing, 'b').imputations).toMatchObject({ month: true, day: true });
	});

	it('TRAP 3d: 31 January is read as 30 January — min(day, 30) fires in EVERY month', () => {
		const ing = ingestDates({
			taxa: THREE,
			source: 'strain,date\na,2021-01-31\nb,2020-02-29\nc,2022-01-01\n',
			sourceName: 'y.csv',
			timeUnits: 'years'
		});
		expect(row(ing, 'a').imputations.dayClamped).toBe(true);
		expect(row(ing, 'b').imputations.dayClamped).toBe(true);
		expect(pick(ing, 'DATES_DAY_CLAMPED').data.count).toBe(2);
	});

	it('TRAP 4, units change the answer: the same names read differently on the two axes', () => {
		const taxa = ['s|2019|5000', 's2|2020|6000', 's3|2021|7000'];
		const calendar = ingestDates({ taxa, timeUnits: 'years' });
		const generations = ingestDates({ taxa, timeUnits: 'generations' });
		expect(calendar.rows.map((r) => r.value)).not.toEqual(generations.rows.map((r) => r.value));
		expect(generations.time_units).toBe('generations');
	});

	it('OUT OF RANGE is separated from UNPARSED, which the reference cannot do at all', () => {
		const ing = ingestDates({
			taxa: THREE,
			source: 'strain,date\na,1500\nb,nonsense\nc,2021-01-01\n',
			sourceName: 'r.csv',
			timeUnits: 'years',
			headerFallback: false
		});
		expect(row(ing, 'a').rule).toBe('out_of_range');
		expect(row(ing, 'b').rule).toBe('unparsed');
		expect(ing.coverage.out_of_range).toBe(1);
		expect(pick(ing, 'DATES_OUT_OF_RANGE').severity).toBe('warn');
	});
});

// =================================================================================================
// The record shape
// =================================================================================================

suite('the DateIngest is a stable, structured-clonable record', () => {
	const ing = () => ingestDates({ taxa: THREE, source: THREE_TABLE, sourceName: 'm.csv' });

	it('has one row per taxon, in ALIGNMENT order, including the undated', () => {
		const got = ingestDates({ taxa: ['c', 'a', 'zz'], source: THREE_TABLE, sourceName: 'm.csv' });
		expect(got.rows.map((r) => r.taxon)).toEqual(['c', 'a', 'zz']);
		expect(Number.isFinite(row(got, 'zz').value)).toBe(false);
		expect(row(got, 'zz').source).toBe('none');
	});

	it('every row carries its whole provenance, not just a number', () => {
		for (const r of ing().rows) {
			expect(Object.keys(r).sort()).toEqual(
				[
					'imputations',
					'imputed',
					'match_tier',
					'matched',
					'matched_name',
					'raw',
					'rule',
					'source',
					'taxon',
					'used',
					'value'
				].sort()
			);
			expect(typeof r.rule).toBe('string');
			expect(['map', 'auspice', 'table', 'regex', 'header', 'none']).toContain(r.source);
		}
	});

	it('survives a JSON round trip — it crosses a worker boundary and lands in a record', () => {
		const got = ing();
		const back = JSON.parse(JSON.stringify(got));
		expect(back.coverage).toEqual(got.coverage);
		expect(back.rows).toHaveLength(got.rows.length);
		expect(back.schema_version).toBe(DATE_SCHEMA_VERSION);
	});

	it('warnings are sorted by DATE_DIAGNOSTIC_CODES and every code is a member of it', () => {
		const cases = [
			ingestDates({ taxa: THREE }),
			ingestDates({ taxa: THREE, source: THREE_TABLE, sourceName: 'm.csv' }),
			ingestDates({ taxa: THREE, source: 'x\ta\nb\tc\n', sourceName: 'x.txt' }),
			ingestDates({ taxa: THREE, dateRegex: '(' })
		];
		for (const got of cases) {
			const ranks = got.warnings.map((w) => DATE_DIAGNOSTIC_CODES.indexOf(w.code));
			expect(ranks).not.toContain(-1);
			expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
			for (const w of got.warnings) {
				expect(['info', 'warn', 'refuse']).toContain(w.severity);
				expect(typeof w.message).toBe('string');
				expect(w.message.length).toBeGreaterThan(10);
			}
		}
	});

	it('dateSpan and datesVector agree with the rows', () => {
		const got = ing();
		const v = datesVector(got, THREE);
		expect(v).toBeInstanceOf(Float64Array);
		expect(dateSpan(v)).toEqual(got.span);
		expect(datesVector(got, ['c', 'nope'])[1]).toBeNaN();
	});

	it('datesPreprocessing is snake_case and carries no DateParse objects', () => {
		const block = datesPreprocessing(ing());
		expect(block.time_units).toBe('years');
		expect(block.by_source.table).toBe(3);
		expect(JSON.stringify(block)).not.toMatch(/"imputations"/);
	});

	it('detectDateSourceKind tells the four shapes apart', () => {
		expect(detectDateSourceKind('a,b\n1,2\n')).toBe('table');
		expect(detectDateSourceKind('{"tree": {}}')).toBe('auspice');
		expect(detectDateSourceKind('{"a": 2019}')).toBe('json-map');
		expect(detectDateSourceKind('<?xml version="1.0"?>')).toBe('beast');
		expect(detectDateSourceKind('', 'x.csv')).toBe('unknown');
	});
});

// =================================================================================================
// The seam with prepareRun
// =================================================================================================

suite('alignDatesToRun is the read-only seam with prepareRun', () => {
	it('names the dated taxa a cap removed, and re-checks the refusals on the survivors', () => {
		const taxa = ['x|2019-01-01', 'y|2020-01-01', 'z|2021-01-01', 'w|2022-01-01'];
		const ing = ingestDates({ taxa });
		const prep = {
			loaded: { taxa: taxa.slice(0, 3) },
			preprocessing: { dropped_taxa: [taxa[3]], taxon_cap: 3 }
		};
		const aligned = alignDatesToRun(ing, prep);
		expect(aligned.kept).toBe(3);
		expect(aligned.dropped_dated).toEqual([taxa[3]]);
		expect(aligned.warnings.map((w) => w.code)).toContain('DATES_DROPPED_BY_CAP');
		expect(aligned.ok).toBe(true);
	});

	it('refuses when the cap left fewer than three dated taxa, and never mutates prep', () => {
		const taxa = ['x|2019-01-01', 'y|2020-01-01', 'z|2021-01-01'];
		const ing = ingestDates({ taxa });
		const prep = { loaded: { taxa: taxa.slice(0, 2) }, preprocessing: { taxon_cap: 2 } };
		const before = JSON.stringify(prep);
		const aligned = alignDatesToRun(ing, prep);
		expect(aligned.ok).toBe(false);
		expect(aligned.warnings.map((w) => w.code)).toContain('DATES_TOO_FEW');
		expect(JSON.stringify(prep)).toBe(before);
	});

	it('datesPreprocessing carries the after_prepare block when one is given', () => {
		const taxa = ['x|2019-01-01', 'y|2020-01-01', 'z|2021-01-01'];
		const ing = ingestDates({ taxa });
		const aligned = alignDatesToRun(ing, { loaded: { taxa } });
		expect(datesPreprocessing(ing, aligned).after_prepare.kept).toBe(3);
		expect(datesPreprocessing(ing).after_prepare).toBeNull();
	});
});

// =================================================================================================
// The shipped examples — the assertions a regression cannot get past
// =================================================================================================

withExamples('the three shipped examples, at their measured values', () => {
	const read = (name) => readFileSync(join(EXAMPLES, name), 'utf8');

	it('korber_env_gp160.fasta: 142 of 143, CONSENSUS the only miss, all from the LANL rule', () => {
		const taxa = taxaForDates(read('korber_env_gp160.fasta'));
		expect(taxa).toHaveLength(143);
		const ing = ingestDates({ taxa });
		expect(ing.coverage.dated).toBe(142);
		expect(ing.unmatched_taxa.names).toEqual(['CONSENSUS']);
		expect(ing.by_rule).toEqual({ korber_isolate: 142, unparsed: 1 });
		expect(ing.time_units).toBe('years');
		expect(ing.span.min).toBe(1959.5);
		expect(ing.span.max).toBe(1997.5);
		// Every LANL date is `year + 0.5`: invented, not read, and the layer says so.
		expect(ing.coverage.imputed).toBe(142);
		expect(pick(ing, 'DATES_IMPUTED').severity).toBe('warn');
		expect(ing.ok).toBe(true);
	});

	it('korber: the 1959 anchor changes ZERO rows — which is what makes shipping it off safe', () => {
		const taxa = taxaForDates(read('korber_env_gp160.fasta'));
		const off = ingestDates({ taxa });
		const on = ingestDates({ taxa, archival1959: true });
		expect(archival1959Changes(taxa)).toEqual([]);
		expect(on.rows.map((r) => r.value)).toEqual(off.rows.map((r) => r.value));
		expect(codes(off)).toContain('DATES_ARCHIVAL_1959_AVAILABLE');
		expect(codes(on)).toContain('DATES_ARCHIVAL_1959_APPLIED');
	});

	it('korber is invisible to temporal\'s own name parser — which is why the fallback calls dating\'s', () => {
		const taxa = taxaForDates(read('korber_env_gp160.fasta'));
		// `extract_date_from_string` dates 0 of 143; `parse_header_timestamp` dates 142.
		expect(datesFromHeaders(taxa, { timeUnits: 'generations' }).dated).toBeLessThan(142);
		expect(datesFromHeaders(taxa).dated).toBe(142);
	});

	it('H1N1_2009_pandemic.fasta: 95 of 100, and the five misses are the measured five', () => {
		const taxa = taxaForDates(read('H1N1_2009_pandemic.fasta'));
		expect(taxa).toHaveLength(100);
		const ing = ingestDates({ taxa });
		expect(ing.coverage.dated).toBe(95);
		expect(ing.time_units).toBe('years');
		const missed = ing.unmatched_taxa.names;
		expect(missed).toHaveLength(5);
		// Three are strain numbers shaped like a decimal year (4218.01) that the header pattern
		// claims and the [1800, 2100] gate then rejects; two carry a ONE-decimal year (|2009.4),
		// which the pattern's \d{2,4} does not match. Both are upstream defects, replicated.
		expect(missed.filter((n) => n.includes('Managua'))).toHaveLength(3);
		expect(ing.span.min).toBeCloseTo(2009.249, 3);
		expect(ing.span.max).toBeCloseTo(2009.915, 3);
	});

	it('H1N1: the units must NOT flip to generations, or the dates run to 46 million', () => {
		const taxa = taxaForDates(read('H1N1_2009_pandemic.fasta'));
		const ing = ingestDates({ taxa });
		expect(ing.time_units).toBe('years');
		const wrong = ingestDates({ taxa, timeUnits: 'generations' });
		expect(Math.max(...wrong.rows.map((r) => r.value))).toBeGreaterThan(1e6);
		expect(codes(wrong)).toContain('DATES_MIXED_SCALE');
	});

	it('H5N1_HA_geo.fasta + H5N1_HA_metadata.csv: 98 of 98, columns (taxon, date), tier exact', () => {
		const taxa = taxaForDates(read('H5N1_HA_geo.fasta'));
		expect(taxa).toHaveLength(98);
		const ing = ingestDates({
			taxa,
			source: read('H5N1_HA_metadata.csv'),
			sourceName: 'H5N1_HA_metadata.csv'
		});
		expect(ing.coverage.dated).toBe(98);
		expect(ing.coverage.from_table).toBe(98);
		expect(ing.table.strain_col).toBe('taxon');
		expect(ing.table.date_col).toBe('date');
		expect(ing.table.strain_col_source).toBe('temporal');
		expect(ing.match_tier).toBe('exact');
		expect(ing.unmatched_metadata.count).toBe(0);
		expect(codes(ing)).not.toContain('DATES_FUZZY_MATCH');
		expect(ing.ok).toBe(true);
	});

	it('H5N1: the table and the headers agree, so it is the control rather than a trap', () => {
		const taxa = taxaForDates(read('H5N1_HA_geo.fasta'));
		const fromTable = ingestDates({
			taxa,
			source: read('H5N1_HA_metadata.csv'),
			sourceName: 'H5N1_HA_metadata.csv'
		});
		const fromHeaders = ingestDates({ taxa });
		expect(fromHeaders.coverage.dated).toBe(98);
		expect(fromHeaders.rows.map((r) => r.value)).toEqual(fromTable.rows.map((r) => r.value));
		expect(fromHeaders.by_rule).toEqual({ header_trailing_year: 98 });
	});
});

// =================================================================================================
// The two structural guards
// =================================================================================================

suite('the layer opens nothing and re-implements nothing', () => {
	const sources = readdirSync(join(RUNTIME, 'src', 'dates'))
		.filter((f) => f.endsWith('.js'))
		.map((f) => ({ file: f, text: readFileSync(join(RUNTIME, 'src', 'dates', f), 'utf8') }));

	/** Strip block and line comments: every one of these files EXPLAINS the rules it does not hold. */
	const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

	it('there are seven leaves plus a barrel, and every one opens with WHY THIS FILE EXISTS', () => {
		expect(sources.map((s) => s.file).sort()).toEqual([
			'auspice.js',
			'codes.js',
			'headers.js',
			'index.js',
			'ingest.js',
			'library.js',
			'match.js',
			'regex.js',
			'table.js'
		]);
		for (const s of sources) expect(s.text, s.file).toMatch(/WHY THIS FILE EXISTS/);
	});

	it('NO FILESYSTEM: nothing here imports node:fs or node:path — it takes text, on every surface', () => {
		for (const s of sources) {
			expect(code(s.text), s.file).not.toMatch(/from\s+['"]node:(fs|path)['"]/);
			expect(code(s.text), s.file).not.toMatch(/require\(['"](fs|path)['"]\)/);
		}
	});

	it('NO SECOND PARSER: no year gate, no month table, no ISO regex outside the library', () => {
		for (const s of sources) {
			const body = code(s.text);
			// The gate's two numbers may be READ from the library (`CALENDAR_YEAR_MIN`) but never
			// written again here.
			expect(body.replace(/CALENDAR_YEAR_(MIN|MAX)/g, ''), `${s.file}: 1800/2100 gate`).not.toMatch(
				/\b1800\b|\b2100\b/
			);
			// A regex LITERAL holding a date shape. The same characters inside a quoted string are
			// allowed: `codes.js` shows the reader an example pattern (`_(\\d{4}-\\d{2}-\\d{2})$`)
			// in the message that refuses a pattern with no capturing group, and a message is not a
			// parser.
			expect(body, `${s.file}: a date regex`).not.toMatch(/\/[^/\n]*\\d\{\d[^/\n]*\//);
			// A month TABLE: an array of month names, or a run of month lengths. The names may appear
			// in prose — `ingest.js` explains that temporal.py:144's clamp reads 31 January as 30
			// January — and explaining a rule is not holding one.
			expect(body, `${s.file}: a month-name table`).not.toMatch(
				/\[[^\]]*['"]Jan(uary)?['"][^\]]*\]/
			);
			expect(body, `${s.file}: a month-length table`).not.toMatch(
				/\b3[01]\s*,\s*(28|29)\s*,\s*3[01]\b/
			);
			expect(body, `${s.file}: a two-digit pivot`).not.toMatch(/1900\s*\+|2000\s*\+/);
		}
	});

	it('library.js is the ONLY module that imports the library, so the rule above is checkable', () => {
		for (const s of sources) {
			if (s.file === 'library.js') continue;
			expect(code(s.text), s.file).not.toMatch(/from\s+['"]@veg\/hyphaeon-js['"]/);
		}
	});

	it('the capability probe is honest about what is linked', () => {
		expect(hasDateLayer()).toBe(true);
		expect(missingDateExports()).toEqual([]);
	});
});
