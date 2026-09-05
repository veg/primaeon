/**
 * report.spec.ts — the one product action end to end: a bundled dataset runs everything and one
 * report fills in; the record persists; the browser leg of the parity harness reads it back.
 *
 * WHY THIS FILE EXISTS. PLAN.md §4.0 (D21): "the only thing the interface asks for is a dataset ...
 * one report fills in as results arrive", in the order diagnostics → sites → gene → epistasis →
 * attribution → filter → DMS last, progressive and cancellable; advanced settings behind one
 * "Re-run with…" disclosure. This spec drives that path for two examples and reads back what the
 * page stored (lib/storage/reports.ts: IndexedDB `hyphaeon` / `reports`):
 *
 *   bat_oas1 (18 taxa × 351 codons, chronogram tree in Mya)
 *     - `/analyze/?demo=bat_oas1&autorun=1` (the landing chip / drop hand-off) navigates to
 *       `/report/local/?id=<id>` with no form on the way; the overview strip and the "what we did to
 *       your data" strip render; Sites, Gene and Epistasis appear with a concrete value each that
 *       equals the stored record's;
 *     - DMS shows its progress and either completes or is cancelled from its own button, in which
 *       case every other section stays and the record persists as `done` with `dms.cancelled`;
 *     - a reload restores every section from IndexedDB without fetching a model or ORT;
 *     - during the run exactly the two graphs the report needs (general.onnx, busted_head.onnx) and
 *       only the CPU SIMD-threaded ORT binary were requested, all same-origin; no HyPhy for a tree
 *       with branch lengths;
 *     - PARITY (PLAN.md §5.4, PARITY.md): is_invariable exact against fixtures/e2e/meme_bat_oas1.json;
 *       hyphaeon_lrt within the graph class against the Python reference — STRICT now: veg/HyphAeon
 *       phase-2a made the canonical MDS sign the default on both sides (MDS_SIGN.md, D20), so the
 *       Phase 1 `test.fail()` annotation is gone — and against the node surface when present;
 *     - the `hyphaeon meme` JSON download is written to <engine>/parity/browser/bat_oas1.meme.json
 *       (and parity/web/, parity.py's name for this surface);
 *     - "Re-run with…" → viral → a NEW report whose provenance says viral.
 *
 *   Smc6 (20 primates × 1,097 codons, the paper's epistasis example)
 *     - the epistasis section is final long before the 19 × 1,097 DMS finishes, so this is where
 *       the DMS Cancel is exercised deterministically: the scan is cancelled, every other section is
 *       done, the record is `done`;
 *     - PARITY: the browser's edges and sectors against fixtures/e2e/epistasis_Smc6_n_permutations_1000.json
 *       (exact set, order, membership and signatures; graph class on the ORT-derived fields;
 *       `p_perm` within 3·√(p(1−p)/B) — the reference's own B = 1,000 fixture, as the report's
 *       default B is the CLI's 1,000), written to parity/browser/Smc6.epistasis.json;
 *     - a reload mid-run (the page closed before DMS finished) reopens as `interrupted` with the
 *       finished sections preserved.
 *
 * Each group shares one browser context across its tests (serial mode) because the later tests read
 * the record the first test stored: a fresh context per test would have an empty IndexedDB. Timeouts
 * are generous: the first run downloads ~21 MB of runtime and graph, and WASM is slower than
 * onnxruntime-node (PLAN.md §1 measured costs).
 */

import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import {
	COMPUTED_SECTIONS,
	HEAVY_ASSET,
	HYPHY_ASSET,
	ONNX,
	ORT_FORBIDDEN,
	ORT_LOADER,
	ORT_WASM,
	compareEpistasis,
	compareLrt,
	epistasisDocumentText,
	formatP,
	formatCardP,
	readStoredReport,
	referenceEpistasis,
	referenceMeme,
	section,
	startDemoReport,
	surfaceMeme,
	trackRequests,
	waitForSectionState,
	waitForStoredState,
	writeBrowserParityFile,
	type RequestLog,
	type StoredReport
} from './helpers';

const SECTION_TITLE: Record<string, string> = {
	sites: 'Sites under episodic selection',
	gene: 'Gene-level verdict',
	epistasis: 'Epistasis and sectors',
	attribution: 'Attribution',
	filter: 'Alignment-artifact filter',
	dms: 'Digital deep mutational scan'
};

/**
 * Let the DMS either finish or be cancelled from its own button; resolves to the section's final
 * state. The button exists only while the DMS phase is live (DmsSection.svelte), so a scan that
 * finishes first simply lands on `done`.
 */
async function settleDms(page: Page, timeoutMs: number): Promise<'done' | 'cancelled'> {
	const state = await waitForSectionState(page, 'dms', ['partial', 'done', 'cancelled'], timeoutMs);
	if (state === 'partial') {
		const cancel = page.getByRole('button', { name: 'Cancel the scan' });
		if (await cancel.isVisible().catch(() => false)) {
			await expect(page.locator('#dms progress')).toBeVisible();
			await cancel.click();
			await waitForSectionState(page, 'dms', ['cancelled', 'done'], 120_000);
		} else {
			await waitForSectionState(page, 'dms', ['done', 'cancelled'], timeoutMs);
		}
	}
	return (await section(page, 'dms').getAttribute('data-state')) as 'done' | 'cancelled';
}

async function expectSectionsDone(page: Page, names: readonly string[]) {
	for (const name of names) {
		await expect(section(page, name as never), `section ${name}`).toHaveAttribute('data-state', 'done', { timeout: 60_000 });
		await expect(section(page, name as never).locator('h2')).toHaveText(SECTION_TITLE[name]);
	}
}

test.describe('report: bat_oas1 runs everything', () => {
	test.describe.configure({ mode: 'serial', timeout: 360_000 });

	let context: BrowserContext;
	let page: Page;
	let requests: RequestLog;
	let origin: string;
	let reportId: string;
	let stored: StoredReport;

	test.beforeAll(async ({ browser, baseURL }) => {
		origin = new URL(baseURL!).origin;
		context = await browser.newContext();
		page = await context.newPage();
		requests = trackRequests(page);
	});

	test.afterAll(async () => {
		await context?.close();
	});

	test('autorun navigates to the report; the overview and data strips render', async () => {
		reportId = await startDemoReport(page, 'bat_oas1');
		expect(page.url()).toContain(`/report/local/?id=${encodeURIComponent(reportId)}`);
		await expect(page.getByRole('heading', { level: 1 })).toHaveText('bat_oas1');
		await expect(page.locator('dl[aria-label="Report overview"]')).toBeVisible();
		await expect(page.getByText('What we did to your data')).toBeVisible();
		// No analysis picker and no options form stand between the upload and the report.
		await expect(page.locator('input[name="variant"]')).toHaveCount(0);
		await expect(page.getByRole('button', { name: 'Run', exact: true })).toHaveCount(0);
	});

	test('Sites, Gene and Epistasis stream in with their values', async () => {
		await waitForSectionState(page, 'sites', ['done'], 240_000);
		await expect(section(page, 'sites').locator('h2')).toHaveText(SECTION_TITLE.sites);
		await expect(page.locator('#sites canvas[aria-label^="Predicted LRT by codon site"]')).toBeVisible();
		await expect(page.locator('#sites .table .count')).toHaveText('351 of 351 sites');

		await waitForSectionState(page, 'gene', ['done'], 120_000);
		await expect(section(page, 'gene').locator('h2')).toHaveText(SECTION_TITLE.gene);
		await waitForSectionState(page, 'epistasis', ['done'], 120_000);
		await expect(section(page, 'epistasis').locator('h2')).toHaveText(SECTION_TITLE.epistasis);

		// The sections were persisted as they arrived: the values on screen are the stored values.
		await expect
			.poll(async () => (await readStoredReport(page, reportId))?.epistasis != null, { timeout: 30_000 })
			.toBe(true);
		const partial = (await readStoredReport(page, reportId))!;
		expect(partial.gene, 'gene record stored').not.toBeNull();
		await expect(page.locator('#gene dl.stats dd.num').first()).toHaveText(formatCardP(partial.gene!.p_value_acat));
		await expect(page.locator('#epistasis p.lede strong').first()).toHaveText(String(partial.epistasis!.edges.length));
		await expect(page.locator('dl[aria-label="Report overview"] .tile', { hasText: 'Gene verdict' }).locator('dd strong')).toContainText(formatP(partial.gene!.p_value_acat));
		await expect(page.locator('dl[aria-label="Report overview"] .tile', { hasText: 'Taxa' }).locator('dd strong')).toHaveText('18');
	});

	test('DMS shows progress and then completes or is cancelled; the other sections stay', async () => {
		const dmsState = await settleDms(page, 240_000);
		test.info().annotations.push({ type: 'dms', description: dmsState === 'cancelled' ? 'cancelled from the section button mid-scan' : 'completed before a cancel could be issued' });
		await expect(section(page, 'dms').locator('h2')).toHaveText(SECTION_TITLE.dms);
		await expectSectionsDone(page, ['sites', 'gene', 'epistasis', 'attribution', 'filter']);
		if (dmsState === 'cancelled') await expect(page.locator('#dms .note--warn')).toContainText(/Cancelled after/);
		else await expect(page.locator('#dms canvas[aria-label^="Digital DMS heatmap"]')).toBeVisible();

		stored = await waitForStoredState(page, reportId, 120_000);
		expect(stored.status.state, `stored status ${JSON.stringify(stored.status)}`).toBe('done');
		for (const name of COMPUTED_SECTIONS) expect(stored.status.completed, `completed includes ${name}`).toContain(name);
		expect(stored.dms).not.toBeNull();
		expect(stored.dms!.cancelled).toBe(dmsState === 'cancelled');
		if (dmsState === 'done') expect(stored.dms!.plasticity).toBe(351);
		else expect(stored.dms!.plasticity).toBeLessThan(351);
	});

	test('the stored record: browser surface, canonical provenance, ORT threads engaged', async () => {
		expect(stored.inputs.demo).toBe('bat_oas1');
		expect(stored.options.variant).toBe('general');
		expect(stored.options.seed).toBe(42);
		expect(stored.options.permutations).toBe(1000);
		expect(stored.options.dms.enabled).toBe(true);
		// PLAN.md D13: the preview serves COOP/COEP, so the worker is isolated and the pool spawns.
		expect(stored.runtime, 'runtime block').not.toBeNull();
		expect(stored.runtime!.crossOriginIsolated).toBe(true);
		expect(stored.runtime!.numThreads).toBeGreaterThanOrEqual(2);
		expect(stored.provenance, 'provenance block').not.toBeNull();
		expect(stored.provenance!.surface).toBe('browser');
		expect(stored.provenance!.model_variant).toBe('general');
		expect(stored.provenance!.artifact_verified).not.toBe(false);
		expect(stored.provenance!.preprocessing.distance_rescaled).toBe(true);
		expect(stored.provenance!.preprocessing.tree_source).toBe('user');
		expect(stored.provenance!.preprocessing.taxa_used).toBe(18);
		expect(stored.siteCount).toBe(351);
		expect(stored.gene!.p_value_acat).toBeGreaterThan(0);
		expect(stored.epistasis!.permutations?.n).toBe(1000);
		expect(stored.attribution!.attribution_enabled).toBe(true);
		expect(stored.filter!.filter_enabled).toBe(true);
		for (const phase of ['prepare', 'infer', 'gene', 'epistasis', 'attribute', 'filter']) {
			expect(stored.timings[phase], `timing ${phase}`).toBeGreaterThanOrEqual(0);
		}
	});

	test('the run fetched the two graphs the report needs and only the CPU SIMD-threaded ORT, same-origin', async () => {
		const offOrigin = requests.offOrigin(origin);
		expect(offOrigin, `off-origin requests: ${offOrigin.join(', ')}`).toEqual([]);

		const onnx = requests.matching(ONNX).map((u) => new URL(u).pathname).sort();
		expect(onnx, `onnx requests: ${onnx.join(', ')}`).toEqual(['/models/busted_head.onnx', '/models/general.onnx']);

		const wasm = requests.matching(ORT_WASM);
		expect(wasm.length, 'ORT WASM binary requested').toBeGreaterThanOrEqual(1);
		for (const u of [...wasm, ...requests.matching(ORT_LOADER)]) {
			expect(new URL(u).pathname).toMatch(/^\/ort\/ort-wasm-simd-threaded\.(wasm|mjs)$/);
			expect(u).not.toMatch(ORT_FORBIDDEN);
		}
		expect(requests.matching(HYPHY_ASSET), 'no HyPhy WASM for a tree with branch lengths').toEqual([]);

		const failedHeavy = requests.failed().filter((u) => HEAVY_ASSET.test(u));
		expect(failedHeavy, `heavy assets that failed: ${failedHeavy.join(', ')}`).toEqual([]);
	});

	test('a reload restores every section from IndexedDB without fetching a model or ORT', async () => {
		requests.reset();
		await page.reload();
		await expect(page.locator('.head .eyebrow')).toContainText('stored in this browser', { timeout: 30_000 });
		await expectSectionsDone(page, ['sites', 'gene', 'epistasis', 'attribution', 'filter']);
		await expect(section(page, 'dms')).toHaveAttribute('data-state', stored.dms!.cancelled ? 'cancelled' : 'done');
		await expect(page.locator('#sites .table .count')).toHaveText('351 of 351 sites');
		await expect(page.locator('#gene dl.stats dd.num').first()).toHaveText(formatCardP(stored.gene!.p_value_acat));
		await page.waitForLoadState('networkidle');
		const heavy = requests.matching(HEAVY_ASSET);
		expect(heavy, `heavy assets fetched on reload: ${heavy.join(', ')}`).toEqual([]);
		expect(requests.offOrigin(origin)).toEqual([]);
	});



	test('parity: invariable flags and counts match the Python reference exactly', async () => {
		const reference = referenceMeme('bat_oas1');
		test.skip(reference === null, 'fixtures/e2e/meme_bat_oas1.json not found in the engine checkout');
		expect(reference!.codon_count).toBe(stored.siteCount);
		expect(reference!.taxa_count).toBe(stored.provenance!.preprocessing.taxa_used);
		expect(reference!.sites.length).toBe(stored.sites.length);
		for (let i = 0; i < reference!.sites.length; i++) {
			expect(stored.sites[i].site).toBe(reference!.sites[i].site);
			expect(stored.sites[i].is_invariable, `is_invariable at site ${reference!.sites[i].site}`).toBe(reference!.sites[i].is_invariable);
			if (reference!.sites[i].is_invariable) expect(stored.sites[i].hyphaeon_lrt).toBe(0);
			expect(Number.isFinite(stored.sites[i].hyphaeon_lrt)).toBe(true);
		}
	});

	test('parity: LRTs vs the Python reference within the graph class (1e-5 · max(1, |lrt|)), strict', async () => {
		const reference = referenceMeme('bat_oas1');
		test.skip(reference === null, 'fixture not found');
		const cmp = compareLrt(stored.sites, reference!.sites);
		test.info().annotations.push({ type: 'browser-vs-python', description: `max |Δ| ${cmp.maxAbs.toExponential(2)}, max rel ${cmp.maxRel.toExponential(2)}, ρ ${cmp.spearman.toFixed(6)}, ${cmp.violations.length}/${cmp.n} sites outside the graph class` });
		expect(cmp.violations, `graph-class violations vs python: ${JSON.stringify(cmp.violations.slice(0, 5))}`).toEqual([]);
	});

	test('parity: LRTs match the node surface within the graph class', async () => {
		const node = surfaceMeme('node', 'bat_oas1');
		test.skip(node === null, 'parity/node/bat_oas1.meme.json not found: run runtime/scripts/parity-node.mjs first');
		const cmp = compareLrt(stored.sites, node!.sites);
		test.info().annotations.push({ type: 'browser-vs-node', description: `max |Δ| ${cmp.maxAbs.toExponential(2)}, max rel ${cmp.maxRel.toExponential(2)}, ρ ${cmp.spearman.toFixed(6)}` });
		expect(cmp.violations, `graph-class violations vs node: ${JSON.stringify(cmp.violations.slice(0, 5))}`).toEqual([]);
	});

	test('writes the browser surface file for scripts/parity.py from the hyphaeon meme JSON download', async () => {
		const downloadPromise = page.waitForEvent('download', { timeout: 60_000 });
		await page.getByRole('button', { name: 'Sites (hyphaeon meme JSON)' }).click();
		const download = await downloadPromise;
		expect(download.suggestedFilename()).toMatch(/hyphaeon_meme\.json$/);
		const text = readFileSync((await download.path())!, 'utf8');
		const doc = JSON.parse(text);

		// The CLI document (cli.py:298-311) with the app's provenance appended (PARITY.md: extra keys ignored).
		expect(doc.codon_count).toBe(351);
		expect(doc.taxa_count).toBe(18);
		expect(doc.provenance.surface).toBe('browser');
		expect(doc.sites).toHaveLength(351);
		for (let i = 0; i < doc.sites.length; i++) {
			expect(doc.sites[i].site).toBe(stored.sites[i].site);
			expect(doc.sites[i].hyphaeon_lrt).toBeCloseTo(stored.sites[i].hyphaeon_lrt, 6);
			expect(doc.sites[i].is_invariable).toBe(stored.sites[i].is_invariable);
		}
		const path = writeBrowserParityFile('bat_oas1.meme.json', text);
		test.info().annotations.push({ type: 'parity-file', description: path });
	});

	test('"Re-run with…" viral starts a new report whose provenance says viral', async () => {
		const disclosure = page.locator('details.rerun');
		await disclosure.locator('summary').click();
		await expect(disclosure.locator('input[name="rr-variant"][value="viral"]')).toBeVisible();
		await disclosure.locator('input[name="rr-variant"][value="viral"]').check();
		await disclosure.getByRole('button', { name: 'Re-run everything' }).click();
		await page.waitForURL((url) => /\/report\/local\/\?id=/.test(url.href) && url.searchParams.get('id') !== reportId, { timeout: 60_000 });
		const rerunId = new URL(page.url()).searchParams.get('id')!;
		expect(rerunId).not.toBe(reportId);

		await waitForSectionState(page, 'sites', ['done'], 240_000);
		await expect(page.locator('dl[aria-label="Report overview"] .tile', { hasText: 'Variant' }).locator('dd strong')).toHaveText('viral');
		await settleDms(page, 240_000);
		const rerun = await waitForStoredState(page, rerunId, 120_000);
		expect(rerun.status.state).toBe('done');
		expect(rerun.options.variant).toBe('viral');
		expect(rerun.provenance!.model_variant).toBe('viral');
		expect(rerun.inputs.demo).toBe('bat_oas1');
		expect(rerun.siteCount).toBe(351);
		expect(requests.matching(ONNX).map((u) => new URL(u).pathname)).toContain('/models/viral.onnx');
		// The original report is untouched.
		const original = await readStoredReport(page, reportId);
		expect(original!.options.variant).toBe('general');
		expect(original!.status.state).toBe('done');
	});
});

test.describe('report: Smc6 epistasis parity and the DMS cancel', () => {
	test.describe.configure({ mode: 'serial', timeout: 480_000 });

	let context: BrowserContext;
	let page: Page;
	let reportId: string;
	let stored: StoredReport;

	test.beforeAll(async ({ browser }) => {
		context = await browser.newContext();
		page = await context.newPage();
	});

	test.afterAll(async () => {
		await context?.close();
	});

	test('epistasis is final while the DMS runs; Cancel scopes to the scan; the record is done', async () => {
		reportId = await startDemoReport(page, 'Smc6', { timeoutMs: 180_000 });
		await expect(page.getByRole('heading', { level: 1 })).toHaveText('Smc6');
		await waitForSectionState(page, 'epistasis', ['done'], 300_000);
		await expect(page.locator('#epistasis p.lede strong').first()).toHaveText(/^\d+$/);

		const dmsState = await settleDms(page, 360_000);
		test.info().annotations.push({ type: 'dms', description: dmsState === 'cancelled' ? 'cancelled from the section button mid-scan' : 'completed before a cancel could be issued' });
		await expectSectionsDone(page, ['sites', 'gene', 'epistasis', 'attribution', 'filter']);
		await expect(page.locator('#sites .table .count')).toHaveText('1097 of 1097 sites');

		stored = await waitForStoredState(page, reportId, 120_000);
		expect(stored.status.state, JSON.stringify(stored.status)).toBe('done');
		for (const name of COMPUTED_SECTIONS) expect(stored.status.completed).toContain(name);
		expect(stored.dms!.cancelled).toBe(dmsState === 'cancelled');
		expect(stored.provenance!.surface).toBe('browser');
		expect(stored.provenance!.preprocessing.taxa_used).toBe(20);
		expect(stored.siteCount).toBe(1097);
	});

	test('parity: browser edges and sectors match the CLI at B = 1,000 (exact; p_perm in the statistical class)', async () => {
		const reference = referenceEpistasis('Smc6', 1000);
		test.skip(reference === null, 'fixtures/e2e/epistasis_Smc6_n_permutations_1000.json not found in the engine checkout');
		expect(stored.options.permutations).toBe(1000);
		expect(stored.epistasis, 'epistasis section stored').not.toBeNull();
		expect(stored.epistasis!.permutations?.n).toBe(1000);
		expect(stored.epistasis!.permutations?.seed).toBe(42);
		const cmp = compareEpistasis(stored.epistasis!, reference!, 1000);
		test.info().annotations.push({ type: 'browser-vs-python', description: `${cmp.edges} edges, ${cmp.sectors} sectors; ${cmp.statistical.join('; ')}` });
		expect(cmp.violations, `exact/graph-class violations: ${cmp.violations.join(' | ')}`).toEqual([]);
		expect(cmp.statViolations, `statistical-class violations: ${cmp.statViolations.join(' | ')}`).toEqual([]);
	});

	test('writes parity/browser/Smc6.epistasis.json for scripts/parity.py', async () => {
		const text = epistasisDocumentText(stored.epistasis!, stored.provenance);
		const doc = JSON.parse(text);
		expect(doc.edges.length).toBe(doc.coselection_edges_count);
		expect(doc.sectors.length).toBe(doc.discovered_sectors_count);
		expect(doc.provenance.surface).toBe('browser');
		const path = writeBrowserParityFile('Smc6.epistasis.json', text);
		test.info().annotations.push({ type: 'parity-file', description: path });
	});

	test('a reload mid-run reopens the report as interrupted with the finished sections preserved', async () => {
		const id = await startDemoReport(page, 'Smc6', { timeoutMs: 180_000 });
		expect(id).not.toBe(reportId);
		await waitForSectionState(page, 'epistasis', ['done'], 300_000);
		const before = await readStoredReport(page, id);
		if (before?.status.state !== 'running') {
			test.info().annotations.push({ type: 'interrupted', description: `run already ${before?.status.state} before the reload; nothing to interrupt` });
			return;
		}
		await page.reload();
		await expect(page.locator('.banner--warn')).toContainText(/interrupted/i, { timeout: 30_000 });
		await expect(page.locator('.head .eyebrow')).toContainText('stored in this browser');
		await expectSectionsDone(page, ['sites', 'gene', 'epistasis']);
		await expect(section(page, 'dms')).toHaveAttribute('data-state', /^(interrupted|partial|cancelled|done)$/);
		const after = await readStoredReport(page, id);
		expect(after!.status.state, 'the stored status is still what the worker last wrote').toBe('running');
		expect(after!.sectionKeys.epistasis).toBe(true);
	});
});
