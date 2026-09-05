/**
 * treefree.spec.ts — D22 in the browser: a tree without branch lengths and no tree at all both run,
 * both say so on the report, and the topology the reader sees is never the one the model was given.
 *
 * WHY THIS FILE EXISTS. PLAN.md D22 (and §4.2's Tree row) replaced HyPhy WASM with the library's
 * own tree-free path: a tree WITH branch lengths is used as is; no tree, or a tree whose branch
 * lengths are unusable, sends pairwise TN93 distances straight into the MDS, which is the
 * reference's `--use-tn93` (`dataset.py:493-571`, `598-636`). Phase 2's report spec covered only
 * the first case (bat_oas1 ships a chronogram), so nothing until now drove the two cases D22 is
 * about, and nothing checked the claim that makes D22 safe: that the neighbour-joining tree the
 * app draws is display-only.
 *
 *   camelid — `?demo=camelid&autorun=1`. camelid.nwk is a TOPOLOGY: no branch lengths anywhere.
 *     Phase 2 fitted HKY85 for it in HyPhy WASM; now the runtime reports `tree_free.reason =
 *     'no_branch_lengths'`, the strip says so in the reader's words, and the run is the analysis
 *     `hyphaeon meme -a camelid.fasta --use-tn93` produces — so the parity comparison is against
 *     fixtures/e2e/meme_camelid_tn93.json, STRICT, in the graph class. This is the example whose
 *     Phase 2 parity gap (WASM HyPhy 2.5.98 vs native 2.5.65) D22 exists to close, and the file it
 *     writes, parity/browser/camelid.meme.json, is the browser leg of that closure (PLAN.md §5.4).
 *
 *   Smc6 pasted with no tree — the landing page's paste box, which is the only hand-off that can
 *     produce a run with NO tree (every bundled example ships one or embeds one). The reason is
 *     then 'no_tree', the display tree is the runtime's neighbour-joining tree on the TN93
 *     distances (`source: 'nj'`), and the site-tree modal — which draws parsimony substitutions on
 *     whatever topology it is handed — says in its caption that the model never saw it.
 *
 * AND NO HYPHY, ANYWHERE. Both flows are also the strongest place to assert the removal: they are
 * exactly the two inputs that used to load 6.4 MB of HyPhy WASM. `HYPHY_ANY` matches the substring
 * in any URL, so a leftover import, a leftover vendored file or a stale `static/wasm/hyphy/` would
 * show up here rather than as a number that quietly changed.
 */

import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	GALLERY_INPUTS,
	HYPHY_ANY,
	ONNX,
	compareLrt,
	downloadText,
	readStoredReport,
	referenceMeme,
	section,
	startDemoReport,
	startPastedReport,
	trackRequests,
	waitForSectionState,
	writeBrowserParityFile,
	type RequestLog,
	type StoredReport
} from './helpers';

/** lib/api.ts `treeFreeLabel`, as DataStrip.svelte prints it in `.strip .tree`. */
const TREE_FREE_NO_LENGTHS = 'tree-free (TN93) — no branch lengths';
const TREE_FREE_NO_TREE = 'tree-free (TN93) — no tree';

test.describe('tree-free: camelid, a topology without branch lengths', () => {
	test.describe.configure({ mode: 'serial', timeout: 360_000 });

	let context: BrowserContext;
	let page: Page;
	let requests: RequestLog;
	let reportId: string;
	let stored: StoredReport;

	test.beforeAll(async ({ browser }) => {
		context = await browser.newContext();
		page = await context.newPage();
		requests = trackRequests(page);
	});

	test.afterAll(async () => {
		await context?.close();
	});

	test('the run goes tree-free and the strip says which reason, in the reader’s words', async () => {
		reportId = await startDemoReport(page, 'camelid', { timeoutMs: 180_000 });
		await waitForSectionState(page, 'sites', ['done'], 240_000);
		await expect(page.locator('.strip .tree')).toHaveText(TREE_FREE_NO_LENGTHS);
		await expect(page.locator('#sites .table .count')).toHaveText('96 of 96 sites');
	});

	test('the stored record: tree_source tn93, the library’s reason, and a display tree beside it', async () => {
		await expect
			.poll(async () => (await readStoredReport(page, reportId))?.sectionKeys.sites === true, { timeout: 60_000 })
			.toBe(true);
		stored = (await readStoredReport(page, reportId))!;
		expect(stored.treeSource, 'the model was given TN93 distances').toBe('tn93');
		expect(stored.treeFree, 'the runtime recorded the library’s notice').not.toBeNull();
		expect(stored.treeFree!.reason).toBe('no_branch_lengths');
		expect(stored.preprocessing.branch_lengths_estimated, 'nothing estimates branch lengths any more (D22)').toBe(false);
		// The reader supplied a topology, but a tree-free run draws the neighbour-joining tree on the
		// distances the model actually saw (runtime `displayTreeFor`: a tree-free policy always
		// takes the NJ branch), so the picture and the numbers come from the same object.
		expect(stored.displayTree, 'a display tree is attached to the sites section').not.toBeNull();
		expect(stored.displayTree!.newick ?? '').toMatch(/^\(/);
		expect(stored.displayTreeSource).toBe('nj');
		expect(stored.displayTree!.source).toBe('nj');
		expect(stored.displayTree!.from).toBe('tn93');
		expect(stored.preprocessing.taxa_used).toBe(212);
		expect(stored.siteCount).toBe(96);
	});

	test('parity: LRTs match `hyphaeon meme --use-tn93` within the graph class, strict', async () => {
		const reference = referenceMeme('camelid', { tn93: true });
		test.skip(reference === null, 'fixtures/e2e/meme_camelid_tn93.json not found in the engine checkout');
		expect(reference!.taxa_count, 'the reference ran the same 212 taxa').toBe(stored.preprocessing.taxa_used);
		expect(reference!.codon_count).toBe(stored.siteCount);
		for (let i = 0; i < reference!.sites.length; i++) {
			expect(stored.sites[i].is_invariable, `is_invariable at site ${reference!.sites[i].site}`).toBe(reference!.sites[i].is_invariable);
		}
		const cmp = compareLrt(stored.sites, reference!.sites);
		test.info().annotations.push({
			type: 'browser-vs-python (tn93)',
			description: `max |Δ| ${cmp.maxAbs.toExponential(2)}, max rel ${cmp.maxRel.toExponential(2)}, ρ ${cmp.spearman.toFixed(6)}, ${cmp.violations.length}/${cmp.n} sites outside the graph class`
		});
		expect(cmp.violations, `graph-class violations vs python --use-tn93: ${JSON.stringify(cmp.violations.slice(0, 5))}`).toEqual([]);
	});

	test('writes parity/browser-tn93/camelid.meme.json from the report’s own download', async () => {
		const { filename, text } = await downloadText(page, 'Sites (hyphaeon meme JSON)');
		expect(filename).toMatch(/hyphaeon_meme\.json$/);
		const doc = JSON.parse(text);
		expect(doc.codon_count).toBe(96);
		expect(doc.taxa_count).toBe(212);
		expect(doc.provenance.surface).toBe('browser');
		expect(doc.provenance.preprocessing.tree_source).toBe('tn93');
		expect(doc.sites).toHaveLength(96);
		// Tree-free: the suffixed surface, because parity/python/camelid.meme.json is the TREE run.
		const path = writeBrowserParityFile('camelid.meme.json', text, { treeFree: true });
		test.info().annotations.push({ type: 'parity-file', description: path });
	});

	test('nothing HyPhy was requested — the input that used to need it most', async () => {
		const hyphy = requests.matching(HYPHY_ANY);
		expect(hyphy, `HyPhy URLs requested on the tree-free run: ${hyphy.join(', ')}`).toEqual([]);
		const onnx = requests.matching(ONNX).map((u) => new URL(u).pathname).sort();
		expect([...new Set(onnx)], `onnx requests: ${onnx.join(', ')}`).toEqual(['/models/busted_head.onnx', '/models/general.onnx']);
		const failed = requests.failed();
		expect(failed.filter((u) => HYPHY_ANY.test(u)), `failed HyPhy requests: ${failed.join(', ')}`).toEqual([]);
	});
});

test.describe('tree-free: an alignment pasted with no tree at all', () => {
	test.describe.configure({ mode: 'serial', timeout: 420_000 });

	let context: BrowserContext;
	let page: Page;
	let requests: RequestLog;
	let reportId: string;
	let stored: StoredReport;

	test.beforeAll(async ({ browser }) => {
		context = await browser.newContext();
		page = await context.newPage();
		requests = trackRequests(page);
	});

	test.afterAll(async () => {
		await context?.close();
	});

	test('pasting Smc6.fasta on the landing page runs it, tree-free, with reason “no tree”', async () => {
		const alignment = readFileSync(join(GALLERY_INPUTS, 'Smc6.fasta'), 'utf8');
		reportId = await startPastedReport(page, alignment, { timeoutMs: 240_000 });
		await waitForSectionState(page, 'sites', ['done'], 300_000);
		await expect(page.locator('.strip .tree')).toHaveText(TREE_FREE_NO_TREE);
		await expect(page.locator('#sites .table .count')).toHaveText('1097 of 1097 sites');
	});

	test('the display tree is the runtime’s neighbour-joining tree on the same distances', async () => {
		stored = (await readStoredReport(page, reportId))!;
		expect(stored.treeSource).toBe('tn93');
		expect(stored.treeFree!.reason).toBe('no_tree');
		expect(stored.displayTreeSource, 'built here, from the TN93 matrix (runtime/src/nj.js)').toBe('nj');
		expect(stored.displayTree!.source).toBe('nj');
		expect(stored.displayTree!.from).toBe('tn93');
		expect(stored.displayTree!.newick ?? '').toMatch(/^\(/);
		expect(stored.displayTree!.taxa).toBe(20);
		// The pasted input carried no tree, so nothing but the NJ tree can be on the record.
		expect(stored.inputs.tree ?? null, 'no tree was uploaded').toBeFalsy();
	});

	test('the site tree modal names the tree it is about to draw as display-only', async () => {
		await page.locator('#sites table tbody tr.row').first().click();
		const modal = page.locator('div.modal[role="dialog"]');
		await expect(modal).toBeVisible();
		await expect(modal.locator('p.treesource')).toContainText(/display only, built from the TN93 distances/i);
		await expect(modal.locator('p.treesource')).toContainText(/the model was given those distances and never this topology/i);
		await expect(modal.locator('.notice--error')).toHaveCount(0);
		// A LIVE run does not keep the alignment in IndexedDB (only the prebaked and server records
		// carry `sections.sites.alignment`), and the modal needs the sequences to label the tips, so
		// here it says so rather than drawing a bare topology. The drawing itself is asserted on the
		// gallery's tree-free record below, which does carry them.
		await expect(modal.locator('.tree svg, p.notice')).toBeVisible({ timeout: 30_000 });
		await modal.getByRole('button', { name: 'Close' }).click();
		await expect(modal).toHaveCount(0);
	});

	test('and it draws that tree on the gallery’s tree-free record, which carries its alignment', async () => {
		await page.goto('/report/gallery/camelid/');
		await expect(section(page, 'sites')).toHaveAttribute('data-state', 'done', { timeout: 60_000 });
		await page.locator('#sites table tbody tr.row').first().click();
		const modal = page.locator('div.modal[role="dialog"]');
		await expect(modal).toBeVisible();
		await expect(modal.locator('p.treesource')).toContainText(/display only, built from the TN93 distances/i);
		// phylotree draws into `.tree`; the substitution count beside it is Fitch on the states.
		await expect(modal.locator('.tree svg')).toBeVisible({ timeout: 30_000 });
		await expect(modal.locator('.notice--error')).toHaveCount(0);
		await expect(modal.locator('.facts')).toContainText(/Codon site/);
		await modal.getByRole('button', { name: 'Close' }).click();
	});

	test('no HyPhy on this flow either, and nothing off-origin', async ({ baseURL }) => {
		const hyphy = requests.matching(HYPHY_ANY);
		expect(hyphy, `HyPhy URLs requested on the no-tree run: ${hyphy.join(', ')}`).toEqual([]);
		expect(requests.offOrigin(new URL(baseURL!).origin)).toEqual([]);
	});
});
