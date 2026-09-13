/**
 * beast.spec.ts — a BEAST XML dropped on `/time` in a real browser.
 *
 * WHY THIS FILE EXISTS. Every other document the date layer reads answers one question: this is
 * the alignment, or the tree, or the dates. A BEAST XML can answer all three from one file
 * (`parse_beast_xml`, dataset.py:84-233, returns `sequences`, `dates` AND `tree_newick`), and that
 * is the only thing about this feature a unit test cannot check. Four claims live only here:
 *
 *   1. ONE FILE FILLS THREE SLOTS, AND THE PAGE SAYS SO. `beast1FromH5N1()` folds the three files
 *      `time.spec.ts` flow 2 drops — `H5N1_HA_geo.fasta`, `H5N1_HA_metadata.csv`, `H5N1_HA.nwk` —
 *      into one BEAST 1.x document with nothing added. Dropping it must produce the SAME review as
 *      dropping the three: 98 of 98, the same per-taxon values, the same clock preview off the same
 *      tree. That equivalence is asserted by reading both loads in the same browser and comparing
 *      the two stored records row by row, which is the strongest statement available that the XML
 *      path is not a second, slightly different date layer.
 *   2. THE PRECEDENCE RULE SURVIVES DROP ORDER. `dating.py:2467-2471` fills each slot from the XML
 *      only `if <slot> is None`; a drop zone has no argument names, only the order the browser
 *      enumerated the files in. Both orders are dropped here and must give the same answer, with
 *      the XML's alignment declared unused in the reader's own words.
 *   3. THE REFERENCE'S OWN TWO DOCUMENTS READ AS ITS OWN TESTS SAY. `REFERENCE_BEAST1` and
 *      `REFERENCE_BEAST2` are the XML literals of tests/test_dating.py:119-134 and :152-167; the
 *      numbers asserted are those tests' assertions, reached through a browser, a worker and a
 *      store instead of through `parse_beast_xml`.
 *   4. IT STILL COSTS NO MODEL BYTE. The date stage never loads a graph; an XML that carries an
 *      alignment is the input most likely to break that, so the request log is checked.
 *
 * The documents are generated in `beastFixtures.ts` and dropped as buffers
 * (`setInputFiles({name, mimeType, buffer})`) — nothing is written to disk.
 */

import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import {
	H5N1_FASTA,
	H5N1_META,
	H5N1_TREE,
	REFERENCE_BEAST1,
	REFERENCE_BEAST2,
	beast1FromH5N1,
	haveH5N1
} from './beastFixtures';
import { HEAVY_ASSET, HYPHY_ANY, trackRequests } from './helpers';

const READY = /review|ready/;

async function dropXml(page: Page, name: string, xml: string): Promise<void> {
	await page.locator('#dates input[type="file"]').first().setInputFiles({
		name,
		mimeType: 'application/xml',
		buffer: Buffer.from(xml, 'utf8')
	});
}

/**
 * The review table's cells, one array per row, in page order. `DateReviewTable.svelte` renders nine
 * columns and the first is the row NUMBER, so the named indices below are how a cell is addressed.
 */
const COL = { taxon: 1, value: 2, readsAs: 3, source: 4, rule: 5, readFrom: 6 } as const;

async function reviewRows(page: Page): Promise<string[][]> {
	return page.locator('#dates .table table tbody tr').evaluateAll((rows) =>
		rows.map((r) => Array.from(r.querySelectorAll('td')).map((c) => (c.textContent ?? '').trim()))
	);
}

test.describe('a BEAST XML on /time — the reference’s own two documents', () => {
	test('BEAST 1: one file becomes an alignment, four dates and a starting tree, and the page says which', async ({
		page,
		baseURL
	}) => {
		const requests = trackRequests(page);
		const errors: string[] = [];
		page.on('pageerror', (e) => errors.push(String(e)));

		await page.goto('/time/');
		await dropXml(page, 'reference_beast1.xml', REFERENCE_BEAST1);
		await expect(page.locator('#dates .review')).toHaveAttribute('data-state', READY, { timeout: 20_000 });

		// tests/test_dating.py::test_parse_beast_1_xml — 4 sequences, 4 dates, a tree.
		const meta = page.locator('header.head p.meta');
		await expect(meta).toContainText('reference_beast1.xml');
		await expect(meta).toContainText('4 sequences');
		await expect(meta).toContainText('4 dated');

		// The intake note: the sentence nothing else on the page prints, naming all three slots.
		const intake = page.locator('p.note--intake');
		await expect(intake).toContainText('reference_beast1.xml was read as BEAST 1');
		await expect(intake).toContainText('three things came out of it');
		await expect(intake).toContainText('the alignment (4 sequences)');
		await expect(intake).toContainText('4 sampling dates');
		await expect(intake).toContainText('the starting tree');
		await expect(intake).toContainText('dating.py:2467-2471');

		// The provenance of the read, inside the strip: which element the tree came from, and the
		// eight attributes the reference converts with nothing.
		await page.locator('details.strip summary').click();
		const prov = page.locator('ul.beastprov li');
		await expect(prov.first()).toContainText('read as BEAST 1: 4 sequence(s), 4 date(s)');
		await expect(prov.first()).toContainText('starting tree from');
		await expect(page.locator('ul.beastprov')).toContainText('“direction” and 4 “units” attribute(s) were present and read by nothing');

		// Every row came from the XML, by the float rule — 1980.0 is a bare number, not a calendar
		// string, so the date-scale warning must NOT be printed for this document.
		const rows = await reviewRows(page);
		expect(rows).toHaveLength(4);
		expect(rows[0][COL.taxon]).toBe('taxon_A');
		expect(rows.every((r) => r.join(' ').includes('BEAST XML'))).toBe(true);
		expect(rows.every((r) => r.join(' ').includes('BEAST number'))).toBe(true);
		expect(rows[0].join(' ')).toContain('1980');
		expect(rows[3].join(' ')).toContain('2010');
		await expect(page.locator('p.note--warn', { hasText: 'own time axis' })).toHaveCount(0);

		// And the date stage cost nothing: no graph, no ORT WASM, nothing off-origin.
		const heavy = requests.matching(HEAVY_ASSET);
		expect(heavy, `heavy assets: ${heavy.join(', ')}`).toEqual([]);
		expect(requests.matching(HYPHY_ANY)).toEqual([]);
		expect(requests.offOrigin(new URL(baseURL!).origin)).toEqual([]);
		expect(errors, errors.join('\n')).toEqual([]);
	});

	test('BEAST 2: the TraitSet dates are read, and the document carries no tree', async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', (e) => errors.push(String(e)));
		await page.goto('/time/');
		await dropXml(page, 'reference_beast2.xml', REFERENCE_BEAST2);
		await expect(page.locator('#dates .review')).toHaveAttribute('data-state', READY, { timeout: 20_000 });

		// tests/test_dating.py::test_parse_beast_2_xml — 4 sequences, 4 dates, isolate_A 1990.25.
		await expect(page.locator('p.note--intake')).toContainText('reference_beast2.xml was read as BEAST 2');
		await expect(page.locator('p.note--intake')).toContainText('two things came out of it');
		await expect(page.locator('p.note--intake')).not.toContainText('starting tree');
		await page.locator('details.strip summary').click();
		await expect(page.locator('ul.beastprov li').first()).toContainText('4 sequence(s), 4 date(s), and no starting tree');

		const rows = await reviewRows(page);
		expect(rows).toHaveLength(4);
		expect(rows[0].join(' ')).toContain('isolate_A');
		expect(rows[0].join(' ')).toContain('1990.25');
		expect(rows[3].join(' ')).toContain('2020');
		expect(errors, errors.join('\n')).toEqual([]);
	});

	test('a well-formed XML that is not BEAST is refused in the date layer’s words, not read as empty', async ({ page }) => {
		// An alignment first, so the refusal under test is the DATE layer's and not the page's
		// "drop an alignment". The XML is well-formed and parses; it simply holds no BEAST element,
		// which upstream would read as an empty result with no error at all (dataset.py:123-186
		// searches unqualified tags and returns empty maps).
		const fasta = '>taxon_A_1980\nATGGCC\n>taxon_B_1990\nATGGCA\n>taxon_C_2000\nATGGTA\n>taxon_D_2010\nTTGGTA\n';
		await page.goto('/time/');
		await page.locator('#dates input[type="file"]').first().setInputFiles([
			{ name: 'four.fasta', mimeType: 'text/plain', buffer: Buffer.from(fasta, 'utf8') },
			{ name: 'nexml.xml', mimeType: 'application/xml', buffer: Buffer.from('<?xml version="1.0"?>\n<nexml version="0.9"><otus id="tax1"/></nexml>', 'utf8') }
		]);
		const refusal = page.locator('.notice--error').first();
		await expect(refusal).toBeVisible({ timeout: 20_000 });
		await expect(refusal).toContainText(/BEAST/);
		// The namespace trap is named in the same breath, because a VALID namespaced BEAST 2 file
		// lands on this same code.
		await expect(refusal).toContainText(/namespace/i);
		// Nothing was taken from it, so there is no intake note claiming otherwise.
		await expect(page.locator('p.note--intake')).toHaveCount(0);
	});

	/**
	 * B3: A NAMESPACED BEAST 2 DOCUMENT, DROPPED BY ITSELF.
	 *
	 * BEAUti writes `xmlns=` on the root of some BEAST 2 templates, so this is the common shape and
	 * not an edge one. The REFERENCE reads nothing out of such a file — `parse_beast_xml` searches
	 * for unqualified tags (dataset.py:123-127) while ElementTree names every element of a
	 * namespaced document `{uri}local` — so upstream returns 0 sequences and 0 dates, in silence.
	 * PrimAeon replicates the arithmetic and must not replicate the silence. Before this test the
	 * page did: with no alignment there is no ingest, every BEAST sentence hung off `ingest.beast`,
	 * and the reader got "Drop an alignment (FASTA, NEXUS or PHYLIP)" and nothing about their file.
	 */
	test('a namespaced BEAST 2 file dropped alone is diagnosed, not answered with “drop an alignment”', async ({
		page
	}) => {
		await page.goto('/time/');
		await dropXml(
			page,
			'beauti.xml',
			'<?xml version="1.0"?>\n' +
				'<beast xmlns="http://beast2.org" version="2.6" namespace="beast.evolution.alignment">\n' +
				'    <data id="aln" spec="Alignment">\n' +
				'        <sequence taxon="A" value="ATGGCC"/>\n' +
				'        <sequence taxon="B" value="ATGGCA"/>\n' +
				'    </data>\n' +
				'    <trait spec="beast.evolution.tree.TraitSet" traitname="date" value="A=2019-01-01,B=2020-06-15"/>\n' +
				'</beast>\n'
		);
		const refusal = page.locator('.notice--error').first();
		await expect(refusal).toBeVisible({ timeout: 20_000 });
		// The file is NAMED, read as what it is, and the namespace is given as the reason.
		await expect(refusal).toContainText('beauti.xml');
		await expect(refusal).toContainText('BEAST 2');
		await expect(refusal).toContainText(/XML NAMESPACE/);
		await expect(refusal).toContainText(/dataset\.py:123-127/);
		// And the way out, both halves of it.
		await expect(refusal).toContainText(/Remove the `xmlns` attribute/);
		await expect(refusal).toContainText(/export the alignment as FASTA/);
		// The generic line it used to print is gone.
		await expect(refusal).not.toContainText('Drop an alignment (FASTA, NEXUS or PHYLIP) — the review is one row per sequence');
		// The provenance lines are on the page even with no ingest to carry them.
		const prov = page.locator('ul.beastprov li');
		await expect(prov.first()).toBeVisible();
		await expect(prov.first()).toContainText('beauti.xml was read as BEAST 2: 0 sequence(s), 0 date(s)');
		await expect(page.locator('ul.beastprov')).toContainText(/declares an XML namespace/);
	});

	test('calendar dates get the reference’s own arithmetic, and the page says so beside the table', async ({ page }) => {
		// THE QUIRK A SCIENTIST HAS TO BE TOLD ABOUT. `_parse_numeric_or_calendar_date`
		// (dataset.py:71-80) converts "YYYY-MM-DD" as year + (month-1)/12 + (day-1)/365.25, which is
		// not a decimal year; 2019-03-31 is its measured worst case over 2019-2020 — 2019.2488021902807
		// against the decimal year's 2019.2410958904109, 2.815 days apart. The page must print the
		// divergence, and the "Reads as" column must invert the REFERENCE's formula so it shows the
		// day the reader wrote rather than one two days later.
		const calendar = [
			'<?xml version="1.0" standalone="yes"?>',
			'<beast version="1.10.4">',
			'  <taxa id="taxa">',
			'    <taxon id="cal_A"><date value="2019-03-31" direction="forwards" units="years"/></taxon>',
			'    <taxon id="cal_B"><date value="2021-04" direction="forwards" units="years"/></taxon>',
			'    <taxon id="cal_C"><date value="2020.5" direction="forwards" units="years"/></taxon>',
			'  </taxa>',
			'  <alignment id="alignment" dataType="nucleotide">',
			'    <sequence><taxon idref="cal_A"/>ATGGCC</sequence>',
			'    <sequence><taxon idref="cal_B"/>ATGGCA</sequence>',
			'    <sequence><taxon idref="cal_C"/>ATGGTA</sequence>',
			'  </alignment>',
			'</beast>'
		].join('\n');
		await page.goto('/time/');
		await dropXml(page, 'calendar.xml', calendar);
		await expect(page.locator('#dates .review')).toHaveAttribute('data-state', READY, { timeout: 20_000 });

		const scale = page.locator('p.note--warn', { hasText: 'own time axis' });
		await expect(scale).toBeVisible();
		await expect(scale).toContainText('2 of 3 dates came from a calendar string');
		await expect(scale).toContainText('year + (month−1)/12 + (day−1)/365.25');
		await expect(scale).toContainText('year + (month−0.5)/12');
		await expect(scale).toContainText('2.815 days at worst');
		await expect(scale).toContainText('hyphaeon dating --beast');

		// The table sorts itself, so rows are addressed by taxon and not by position.
		const rows = await reviewRows(page);
		expect(rows).toHaveLength(3);
		const byTaxon = new Map(rows.map((r) => [r[COL.taxon], r]));
		const a = byTaxon.get('cal_A')!;
		const b = byTaxon.get('cal_B')!;
		const c = byTaxon.get('cal_C')!;
		// The stored number is the reference's, and the rendered day is the one that was written.
		expect(a[COL.value]).toContain('2019.2488');
		expect(a[COL.readsAs]).toBe('2019-03-31');
		expect(a[COL.readFrom]).toBe('2019-03-31');
		expect(a[COL.rule]).toContain('BEAST calendar date');
		// YYYY-MM is a THIRD convention upstream and the missing day is declared imputed.
		expect(b[COL.value]).toContain('2021.2917');
		expect(b[COL.readsAs]).toBe('2021-04');
		expect(b[COL.rule]).toContain('BEAST year and month');
		expect(b.join(' ')).toContain('day');
		// A bare decimal year passes through both conventions unchanged and is ruled as a number.
		expect(c[COL.rule]).toContain('BEAST number');
	});

	test('an XML the parser cannot read is refused where it broke, with the line and column', async ({ page }) => {
		// The commonest way a real BEAST file fails: a Newick annotation pasted unescaped, so the
		// bare `&` is an undefined entity reference.
		const broken = '<?xml version="1.0"?>\n<beast version="1.10.4"><newick>((a:1[&rate=0.1],b:1):1);</newick></beast>';
		await page.goto('/time/');
		await dropXml(page, 'bad.xml', broken);
		const refusal = page.locator('.notice--error').first();
		await expect(refusal).toBeVisible({ timeout: 20_000 });
		await expect(refusal).toContainText('bad.xml');
		await expect(refusal).toContainText(/line 2|2:\d+|&amp;/);
	});
});

test.describe('a BEAST XML on /time — the H5N1 example, folded into one file', () => {
	test.skip(!haveH5N1(), 'the engine examples are not checked out beside this repository');

	test('the one XML gives the same review as the three files it was built from', async ({ page, baseURL }) => {
		test.setTimeout(120_000);
		const requests = trackRequests(page);
		const errors: string[] = [];
		page.on('pageerror', (e) => errors.push(String(e)));
		const { xml, records } = beast1FromH5N1();

		// ---- the three files, as flow 2 of time.spec.ts drops them ------------------------------
		await page.goto('/time/');
		await page.locator('#dates input[type="file"]').first().setInputFiles([H5N1_FASTA, H5N1_META, H5N1_TREE]);
		await expect(page.locator('#dates .review')).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
		await expect(page.locator('.table .count')).toHaveText('98 of 98 sequences');
		const fromFiles = await reviewRows(page);
		const filesClock = (await page.locator('#coverage').innerText()).trim();

		// ---- the same data, as one BEAST XML ----------------------------------------------------
		await page.goto('/time/');
		await dropXml(page, 'H5N1_HA.xml', xml);
		await expect(page.locator('#dates .review')).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
		await expect(page.locator('.table .count')).toHaveText('98 of 98 sequences');

		const meta = page.locator('header.head p.meta');
		await expect(meta).toContainText('H5N1_HA.xml');
		await expect(meta).toContainText('98 sequences');
		await expect(meta).toContainText('98 dated');
		// Deduplicated: one file named once, though it filled three slots.
		expect((await meta.innerText()).match(/H5N1_HA\.xml/g)).toHaveLength(1);

		await expect(page.locator('p.note--intake')).toContainText('three things came out of it');
		await expect(page.locator('p.note--intake')).toContainText('the alignment (98 sequences)');
		await expect(page.locator('p.note--intake')).toContainText('98 sampling dates');
		await expect(page.locator('details.strip summary')).toContainText('98 dated');
		await expect(page.locator('details.strip summary')).toContainText('from the BEAST XML');

		// THE EQUIVALENCE. Same taxa, same order, same values, same rendered dates — only the source
		// and rule columns differ, because they are what the two paths disagree about by design.
		const fromXml = await reviewRows(page);
		expect(fromXml).toHaveLength(fromFiles.length);
		expect(fromXml.map((r) => r[COL.taxon])).toEqual(fromFiles.map((r) => r[COL.taxon]));
		expect(fromXml.map((r) => r[COL.value])).toEqual(fromFiles.map((r) => r[COL.value]));
		expect(fromXml.map((r) => r[COL.readsAs])).toEqual(fromFiles.map((r) => r[COL.readsAs]));
		expect(fromXml.map((r) => r[COL.taxon])).toEqual(records.map((r) => r.name).slice(0, fromXml.length));
		// Every row came from the XML by the reference's float rule; the CSV path used its own.
		expect(fromXml.every((r) => r.join(' ').includes('BEAST XML'))).toBe(true);
		expect(fromFiles.every((r) => r.join(' ').includes('BEAST XML'))).toBe(false);

		// The tree came out of the XML too: section 2 draws the same clock preview, off the same tree.
		// MEASURED: the two renderings of section 2 are identical character for character except for
		// the file the caption names — same rate, same interval, same flagged count, same span — so
		// the comparison normalises the name and asserts the rest whole.
		const xmlClock = (await page.locator('#coverage').innerText()).trim();
		const unname = (s: string) => s.replace(/H5N1_HA\.(nwk|xml)/g, '<tree file>');
		expect(unname(xmlClock)).toBe(unname(filesClock));
		expect(xmlClock).toContain('from H5N1_HA.xml as supplied');
		await expect(page.locator('#coverage')).toContainText('carries no clock signal in this direction');
		await expect(page.locator('#coverage svg[aria-label="Root-to-tip divergence against sampling date"]')).toBeVisible();

		// The dates are bare decimal years in the CSV, so no calendar conversion happened and the
		// scale warning is correctly absent — the trigger is the conversion, not the source.
		await expect(page.locator('p.note--warn', { hasText: 'own time axis' })).toHaveCount(0);

		// Still no model byte, on the input most likely to cost one.
		const heavy = requests.matching(HEAVY_ASSET);
		expect(heavy, `heavy assets: ${heavy.join(', ')}`).toEqual([]);
		expect(requests.offOrigin(new URL(baseURL!).origin)).toEqual([]);
		expect(errors, errors.join('\n')).toEqual([]);
	});

	test('an explicitly supplied alignment beats the XML’s, in either drop order', async ({ page }) => {
		test.setTimeout(120_000);
		const { xml } = beast1FromH5N1();
		const fasta = readFileSync(H5N1_FASTA, 'utf8');
		const xmlFile = { name: 'H5N1_HA.xml', mimeType: 'application/xml', buffer: Buffer.from(xml, 'utf8') };
		const fastaFile = { name: 'H5N1_HA_geo.fasta', mimeType: 'text/plain', buffer: Buffer.from(fasta, 'utf8') };

		for (const [label, files] of [
			['fasta first', [fastaFile, xmlFile]],
			['xml first', [xmlFile, fastaFile]]
		] as const) {
			await page.goto('/time/');
			await page.locator('#dates input[type="file"]').first().setInputFiles([...files]);
			await expect(page.locator('#dates .review'), label).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
			// The alignment is the FASTA, named as such; the dates and the tree are the XML's.
			await expect(page.locator('header.head p.meta'), label).toContainText('H5N1_HA_geo.fasta');
			const intake = page.locator('p.note--intake');
			await expect(intake, label).toContainText('98 sampling dates');
			await expect(intake, label).toContainText('the starting tree');
			await expect(intake, label).toContainText('The alignment in it was not used, because you supplied one yourself.');
			await expect(page.locator('.table .count'), label).toHaveText('98 of 98 sequences');
		}
	});
});
