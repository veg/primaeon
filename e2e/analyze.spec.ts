/**
 * analyze.spec.ts — the /analyze flow end to end on two bundled demos, and the browser leg of
 * the parity harness.
 *
 * WHY THIS FILE EXISTS. PLAN.md §8 Phase 1 exit criterion: "the axomeme3 successor is live";
 * §4.4 and D13: the e2e asserts which assets the run fetches and that ORT threads engage.
 * Phase 0's suite covered the landing route only (PHASE0.md gap 6); this spec drives the run
 * path the web-analyze builder added and reads back what it stored:
 *
 *   bat_oas1 (18 taxa × 351 codons, chronogram tree in Mya)
 *     - the "Before you run" panel lists DISTANCE_RESCALED (the > 10 patristic rescale of
 *       dataset.py:678-681 that PHASE0.md measured as load-bearing on every chronogram);
 *     - Run navigates to /results/local/?id=<id> (lib/api.ts resultsPath: the prerendered local
 *       shell, since adapter-static cannot serve /results/<uuid>/ on the static host);
 *     - the stored record's six checklist steps are done or skipped, ORT ran multi-threaded under
 *       cross-origin isolation, the page renders the Manhattan canvas and the 351-row table, and
 *       the CSV download carries the CLI's header (cli.py:313-327);
 *     - during the run exactly one graph (general.onnx) and only the CPU SIMD-threaded ORT
 *       binary were requested, all same-origin (runtime/src/session-web.js's cost discipline);
 *     - PARITY (PLAN.md §5.4, PARITY.md): is_invariable exact and the site/taxa counts against
 *       fixtures/e2e/meme_bat_oas1.json; hyphaeon_lrt within the graph class against the node
 *       surface (parity/node/, the same library under onnxruntime-node); and against the Python
 *       reference the STRICT graph-class check is declared with test.fail(): the library's MDS
 *       (js/src/preprocess/mds.js) fixes eigenvector signs differently from LAPACK's ssyevd and
 *       the model is not sign-invariant (runtime builder's report: bat_oas1 columns 1 and 2
 *       flipped, median relative |ΔLRT| 7.0e-3, max 8.4e-2). When the upstream fix lands the
 *       strict test passes, Playwright reports the unexpected pass, and the annotation comes off.
 *       A separate test pins the measured envelope so a real regression still fails today.
 *     - the JSON download (the CLI document from the runtime writers, surface "browser") is
 *       written to <engine>/parity/browser/bat_oas1.meme.json for scripts/parity.py, and to
 *       parity/web/ as well because parity.py's KNOWN_SURFACES names that surface `web`.
 *
 *   camelid (212 taxa × 96 codons, tree WITHOUT branch lengths)
 *     - the panel marks BRANCH_LENGTHS_MISSING as handled and plans an HKY85 fit; the run's
 *       branch-lengths step completes in the tree worker (HyPhy WASM 2.5.98, tree-tools report:
 *       real in the browser via the module-worker eval glue), the record says
 *       tree_source 'hyphy-hky85' / branch_lengths_estimated true, and hyphy.wasm + hyphy.data
 *       were fetched from this origin.
 *
 * The bat_oas1 group shares one browser context across its tests (serial mode) because the
 * parity tests read the record the first test stored: a fresh context per test would have an
 * empty IndexedDB. Timeouts are generous: the first run downloads 21 MB of runtime and graph
 * and the WASM path is slower than onnxruntime-node (PLAN.md §1 measured costs).
 */

import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
	HEAVY_ASSET,
	HYPHY_ASSET,
	ONNX,
	ORT_FORBIDDEN,
	ORT_LOADER,
	ORT_WASM,
	PARITY_DIR,
	beforeYouRun,
	compareLrt,
	loadDemo,
	readStoredRun,
	referenceMeme,
	runDemo,
	surfaceMeme,
	trackRequests,
	type RequestLog,
	type StoredRun
} from './helpers';

/** The CLI's CSV header (cli.py:313-327 row_dict keys; js/src/writers.js MEME_CSV_BASE). */
const CLI_CSV_HEADER = 'site,hyphaeon_lrt,p_value,q_value,is_invariable';

/** Measured envelope of the MDS-sign residual on bat_oas1 (runtime builder's report): max relative 8.4e-2. */
const MDS_SIGN_ENVELOPE_REL = 0.1;
const MDS_SIGN_ENVELOPE_SPEARMAN = 0.99;

test.describe('analyze: bat_oas1 demo', () => {
	test.describe.configure({ mode: 'serial', timeout: 300_000 });

	let context: BrowserContext;
	let page: Page;
	let requests: RequestLog;
	let origin: string;
	let runId: string;
	let stored: StoredRun;

	test.beforeAll(async ({ browser, baseURL }) => {
		origin = new URL(baseURL!).origin;
		context = await browser.newContext();
		page = await context.newPage();
		requests = trackRequests(page);
	});

	test.afterAll(async () => {
		await context?.close();
	});

	test('diagnostics list DISTANCE_RESCALED and the run navigates to the stored result', async () => {
		await loadDemo(page, 'bat_oas1');
		const panel = await beforeYouRun(page);
		await expect(panel.locator('table.warnings code', { hasText: 'DISTANCE_RESCALED' })).toBeVisible();
		await expect(panel.getByText(/Tree:\s*Uploaded tree with branch lengths/)).toBeVisible();

		runId = await runDemo(page, { variant: 'general' });
		expect(page.url()).toContain(`/results/local/?id=${encodeURIComponent(runId)}`);
	});

	test('the stored record has every progress step complete and ORT threads engaged', async () => {
		const record = await readStoredRun(page, runId);
		expect(record, `record ${runId} in IndexedDB`).not.toBeNull();
		stored = record!;
		expect(stored.inputs.demo).toBe('bat_oas1');
		expect(stored.options.variant).toBe('general');

		const byId = Object.fromEntries(stored.steps.map((s) => [s.id, s]));
		expect(Object.keys(byId).sort()).toEqual(['branch-lengths', 'infer', 'parse', 'postprocess', 'prepare', 'tree']);
		for (const s of stored.steps) {
			expect(['done', 'skipped'], `step ${s.id} status ${s.status}: ${s.message}`).toContain(s.status);
		}
		expect(byId['branch-lengths'].status).toBe('skipped');
		expect(byId.infer.status).toBe('done');
		expect(byId.infer.elapsedMs).toBeGreaterThan(0);

		// PLAN.md D13: the preview serves COOP/COEP, so the worker is isolated and the pool spawns.
		expect(stored.runtime.crossOriginIsolated).toBe(true);
		expect(stored.runtime.numThreads).toBeGreaterThanOrEqual(2);
		expect(stored.provenance.surface).toBe('browser');
		expect(stored.provenance.model_variant).toBe('general');
		expect(stored.provenance.artifact_verified).not.toBe(false);
		expect(stored.provenance.preprocessing.distance_rescaled).toBe(true);
		expect(stored.provenance.preprocessing.tree_source).toBe('user');
		expect(stored.siteCount).toBe(351);
		// Informational: lib/analyze/record.ts does not carry runMeme's `arrays`, so the downloads
		// take lib/results/downloads.ts's library-writer path over `cliDocument` (same CLI shape).
		test.info().annotations.push({ type: 'record-arrays', description: stored.hasArrays ? 'present' : 'absent (library writers path)' });
	});

	test('the results page renders the Manhattan canvas, the paginated table and the called count', async () => {
		await expect(page.locator('canvas[aria-label^="Predicted LRT by codon site"]')).toBeVisible();
		await expect(page.locator('.table .count')).toHaveText('351 of 351 sites');
		await expect(page.locator('.pager__page')).toHaveText('Page 1 of 15');
		expect(await page.locator('table tbody tr.row').count()).toBe(25);

		const called = page.locator('dl.tiles .tile--accent dd strong');
		await expect(called).toBeVisible();
		const text = (await called.innerText()).replace(/,/g, '');
		expect(text, `called-sites tile "${text}"`).toMatch(/^\d+$/);
		expect(Number(text)).toBeGreaterThanOrEqual(0);
		expect(Number(text)).toBeLessThanOrEqual(351);
	});

	test('the CSV download carries the CLI header', async () => {
		const downloadPromise = page.waitForEvent('download');
		await page.getByRole('button', { name: /^CSV/ }).click();
		const download = await downloadPromise;
		expect(download.suggestedFilename()).toMatch(/hyphaeon_meme\.csv$/);
		const text = readFileSync((await download.path())!, 'utf8');
		const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
		expect(lines[0]).toBe(CLI_CSV_HEADER);
		expect(lines.length - 1, 'one row per codon site').toBe(351);
		expect(lines[1]).toMatch(/^1,0\.0,0\.\d+,0\.\d+,True$/);
	});

	test('the run fetched one graph (general) and only the CPU SIMD-threaded ORT, same-origin', async () => {
		const offOrigin = requests.offOrigin(origin);
		expect(offOrigin, `off-origin requests: ${offOrigin.join(', ')}`).toEqual([]);

		const onnx = requests.matching(ONNX);
		expect(onnx, `onnx requests: ${onnx.join(', ')}`).toHaveLength(1);
		expect(new URL(onnx[0]).pathname).toBe('/models/general.onnx');

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

	test('parity: invariable flags and counts match the Python reference exactly', async () => {
		const reference = referenceMeme('bat_oas1');
		test.skip(reference === null, 'fixtures/e2e/meme_bat_oas1.json not found in the engine checkout');
		expect(reference!.codon_count).toBe(stored.siteCount);
		expect(reference!.taxa_count).toBe(stored.provenance.preprocessing.taxa_used);
		expect(reference!.sites.length).toBe(stored.sites.length);
		for (let i = 0; i < reference!.sites.length; i++) {
			expect(stored.sites[i].site).toBe(reference!.sites[i].site);
			expect(stored.sites[i].is_invariable, `is_invariable at site ${reference!.sites[i].site}`).toBe(reference!.sites[i].is_invariable);
			if (reference!.sites[i].is_invariable) expect(stored.sites[i].hyphaeon_lrt).toBe(0);
			expect(Number.isFinite(stored.sites[i].hyphaeon_lrt)).toBe(true);
		}
	});

	test('parity: LRTs match the node surface within the graph class (1e-5 · max(1, |lrt|))', async () => {
		const node = surfaceMeme('node', 'bat_oas1');
		test.skip(node === null, 'parity/node/bat_oas1.meme.json not found: run runtime/scripts/parity-node.mjs first');
		const cmp = compareLrt(stored.sites, node!.sites);
		test.info().annotations.push({ type: 'browser-vs-node', description: `max |Δ| ${cmp.maxAbs.toExponential(2)}, max rel ${cmp.maxRel.toExponential(2)}, ρ ${cmp.spearman.toFixed(6)}` });
		expect(cmp.violations, `graph-class violations vs node: ${JSON.stringify(cmp.violations.slice(0, 5))}`).toEqual([]);
	});

	test('parity: LRTs vs the Python reference stay within the measured MDS-sign envelope', async () => {
		const reference = referenceMeme('bat_oas1');
		test.skip(reference === null, 'fixture not found');
		const cmp = compareLrt(stored.sites, reference!.sites);
		test.info().annotations.push({ type: 'browser-vs-python', description: `max |Δ| ${cmp.maxAbs.toExponential(2)}, max rel ${cmp.maxRel.toExponential(2)}, ρ ${cmp.spearman.toFixed(6)}, ${cmp.violations.length}/${cmp.n} sites outside the graph class` });
		expect(cmp.maxRel).toBeLessThanOrEqual(MDS_SIGN_ENVELOPE_REL);
		expect(cmp.spearman).toBeGreaterThanOrEqual(MDS_SIGN_ENVELOPE_SPEARMAN);
	});

	test('parity: LRTs vs the Python reference within the graph class (strict)', async () => {
		const reference = referenceMeme('bat_oas1');
		test.skip(reference === null, 'fixture not found');
		test.fail(
			true,
			'Known upstream gap: js/src/preprocess/mds.js eigenvector signs differ from LAPACK ssyevd on bat_oas1 (columns 1, 2) and the model is not sign-invariant; remove this annotation when the library fix lands and the fixture is regenerated (PLAN.md 5.3 rule 3).'
		);
		const cmp = compareLrt(stored.sites, reference!.sites);
		expect(cmp.violations, `graph-class violations vs python: ${cmp.violations.length}/${cmp.n}`).toEqual([]);
	});

	test('writes the browser surface file for scripts/parity.py', async () => {
		const downloadPromise = page.waitForEvent('download');
		await page.getByRole('button', { name: /^JSON/ }).click();
		const download = await downloadPromise;
		expect(download.suggestedFilename()).toMatch(/hyphaeon_meme\.json$/);
		const text = readFileSync((await download.path())!, 'utf8');
		const doc = JSON.parse(text);

		// The CLI document (cli.py:298-311) with the app's provenance appended (PARITY.md: extra keys ignored).
		expect(doc.codon_count).toBe(351);
		expect(doc.taxa_count).toBe(18);
		expect(doc.filter_enabled).toBe(false);
		expect(doc.attribution_enabled).toBe(false);
		expect(doc.provenance.surface).toBe('browser');
		expect(doc.sites).toHaveLength(351);
		for (let i = 0; i < doc.sites.length; i++) {
			expect(doc.sites[i].site).toBe(stored.sites[i].site);
			expect(doc.sites[i].hyphaeon_lrt).toBeCloseTo(stored.sites[i].hyphaeon_lrt, 6);
			expect(doc.sites[i].is_invariable).toBe(stored.sites[i].is_invariable);
		}

		for (const surface of ['browser', 'web']) {
			const dir = resolve(PARITY_DIR, surface);
			mkdirSync(dir, { recursive: true });
			writeFileSync(resolve(dir, 'bat_oas1.meme.json'), text.endsWith('\n') ? text : `${text}\n`);
		}
		test.info().annotations.push({ type: 'parity-file', description: resolve(PARITY_DIR, 'browser', 'bat_oas1.meme.json') });
	});
});

test.describe('analyze: camelid demo (tree without branch lengths)', () => {
	test.describe.configure({ mode: 'serial', timeout: 300_000 });

	let context: BrowserContext;
	let page: Page;
	let requests: RequestLog;
	let origin: string;

	test.beforeAll(async ({ browser, baseURL }) => {
		origin = new URL(baseURL!).origin;
		context = await browser.newContext();
		page = await context.newPage();
		requests = trackRequests(page);
	});

	test.afterAll(async () => {
		await context?.close();
	});

	test('HKY85 branch lengths are fitted in the HyPhy WASM tree worker before scoring', async () => {
		await loadDemo(page, 'camelid');
		const panel = await beforeYouRun(page);
		const row = panel.locator('table.warnings tr.row', { hasText: 'BRANCH_LENGTHS_MISSING' });
		await expect(row).toBeVisible();
		await expect(row.locator('.badge')).toHaveText('Handled');
		await expect(panel.getByText(/HKY85 lengths will be fitted in HyPhy WASM/)).toBeVisible();

		const id = await runDemo(page, { variant: 'general' });
		const record = await readStoredRun(page, id);
		expect(record).not.toBeNull();

		const step = record!.steps.find((s) => s.id === 'branch-lengths')!;
		expect(step.status).toBe('done');
		expect(step.message).toBe('HKY85 branch lengths fitted');
		expect(step.elapsedMs).toBeGreaterThan(0);
		for (const s of record!.steps) expect(['done', 'skipped'], `step ${s.id}: ${s.message}`).toContain(s.status);

		expect(record!.inputs.treeSource).toBe('hyphy-hky85');
		expect(record!.provenance.preprocessing.tree_source).toBe('hyphy-hky85');
		expect(record!.provenance.preprocessing.branch_lengths_estimated).toBe(true);
		expect(record!.siteCount).toBe(96);
		expect(record!.provenance.preprocessing.taxa_used).toBeGreaterThanOrEqual(3);

		const hyphy = requests.matching(HYPHY_ASSET).map((u) => new URL(u).pathname);
		expect(hyphy.some((p) => p.endsWith('/hyphy.wasm')), `hyphy assets: ${hyphy.join(', ')}`).toBe(true);
		expect(hyphy.some((p) => p.endsWith('/hyphy.data')), `hyphy assets: ${hyphy.join(', ')}`).toBe(true);
		for (const p of hyphy) expect(p).toMatch(/^\/wasm\/hyphy\/2\.5\.98\/hyphy\.(wasm|data|js)$/);

		const offOrigin = requests.offOrigin(origin);
		expect(offOrigin, `off-origin requests: ${offOrigin.join(', ')}`).toEqual([]);
		const failedHeavy = requests.failed().filter((u) => HEAVY_ASSET.test(u));
		expect(failedHeavy, `heavy assets that failed: ${failedHeavy.join(', ')}`).toEqual([]);

		await expect(page.locator('canvas[aria-label^="Predicted LRT by codon site"]')).toBeVisible();
		await expect(page.locator('.table .count')).toHaveText('96 of 96 sites');
	});
});
