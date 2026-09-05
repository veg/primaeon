/**
 * gallery.spec.ts — the prebaked examples: five chips on `/`, a prebaked report rendering every
 * section on /report/gallery/<id>/ without any model or runtime bytes, the retired routes
 * redirecting, and the gallery Smc6 record's epistasis against the CLI fixture.
 *
 * WHY THIS FILE EXISTS. PLAN.md §4.1 (D21): "`/analyze` and `/gallery` from Phase 1 fold into `/`
 * and `/report/gallery/…`; `/results/…` redirects to `/report/…`". The chips come from
 * lib/gallery/examples.json (the README's five datasets) and the report page reads
 * static/gallery/<id>.json (web/scripts/prebake-gallery.mjs, a ReportRecord v2 baked under
 * onnxruntime-node), so neither route has a reason to touch the 21 MB of ORT and graph; a request
 * for either here would be a wrong import in the report bundle (downloads are imported lazily, on
 * click, for that reason).
 *
 * D22 REACHES THE PREBAKE TOO. camelid and HIV1_RT carry topology-only trees, and until Phase 3 the
 * prebake fitted HKY85 branch lengths for them in HyPhy WASM before handing the tree to the
 * orchestrator. That fit is gone: the tree file is handed over as it is and the runtime takes the
 * library's tree-free path, so those two records now say `tree_source: 'tn93'` with the library's
 * reason and a neighbour-joining display tree. A record still claiming an estimated tree would mean
 * a stale bake, which is exactly the failure that would otherwise pass every other assertion here.
 *
 * PARITY (PLAN.md §5.4). The prebaked Smc6 record was produced by the same `runEverything` the
 * browser runs, under onnxruntime-node; its epistasis section is compared against
 * fixtures/e2e/epistasis_Smc6_n_permutations_1000.json exactly on edges and sectors (graph class on
 * the ORT-derived fields, statistical class on `p_perm`). report.spec.ts makes the same
 * comparison on a record the BROWSER produced and writes the surface file for scripts/parity.py.
 */

import { expect, test } from '@playwright/test';
import { COMPUTED_SECTIONS, HEAVY_ASSET, HYPHY_ANY, compareEpistasis, referenceEpistasis, section, trackRequests, type CliEpistasis } from './helpers';

const EXAMPLES = ['Smc6', 'bat_oas1', 'camelid', 'HIV1_RT', 'RHO'];
/** D22: the two bundled examples whose tree file carries no branch lengths. */
const TREE_FREE_EXAMPLES = ['camelid', 'HIV1_RT'];

test.describe('gallery', () => {
	test('/ lists five example chips linking to prebaked reports', async ({ page, baseURL }) => {
		const requests = trackRequests(page);
		await page.goto('/');
		await page.waitForLoadState('networkidle');

		const chips = page.locator('p.examples a.chip');
		await expect(chips).toHaveCount(5);
		for (const id of EXAMPLES) {
			const chip = page.locator(`p.examples a.chip[href$="/report/gallery/${id}/"]`);
			await expect(chip, `chip for ${id}`).toHaveCount(1);
			const title = await chip.getAttribute('title');
			expect(title, `chip ${id} carries the README description as its title`).toBeTruthy();
		}

		const origin = new URL(baseURL!).origin;
		expect(requests.offOrigin(origin)).toEqual([]);
		expect(requests.matching(HEAVY_ASSET)).toEqual([]);
	});

	test('/report/gallery/Smc6/ renders every section from the prebaked record, fetching no heavy asset', async ({ page, baseURL }) => {
		const requests = trackRequests(page);
		await page.goto('/report/gallery/Smc6/');
		await expect(page.getByRole('heading', { level: 1 })).toContainText(/Smc6/i, { timeout: 30_000 });
		await expect(page.locator('.head .eyebrow')).toContainText(/bundled example/i);
		await expect(page.locator('dl[aria-label="Report overview"]')).toBeVisible();

		for (const name of COMPUTED_SECTIONS) {
			await expect(section(page, name), `section ${name} is done`).toHaveAttribute('data-state', 'done', { timeout: 30_000 });
		}
		await expect(section(page, 'phenotype')).toContainText(/phenotype/i);

		await expect(page.locator('canvas[aria-label^="Predicted LRT by codon site"]')).toBeVisible();
		await expect(page.locator('.table .count')).toHaveText('1097 of 1097 sites');
		await expect(page.locator('#gene dl.stats dd.num').first()).toHaveText(/^\d\.\d{4}$|e-/);
		await expect(page.locator('#epistasis p.lede strong').first()).toHaveText(/^\d+$/);
		await expect(page.locator('canvas[aria-label^="Digital DMS heatmap"]')).toBeVisible();
		// Taxa tile: 20 primates (README).
		await expect(page.locator('dl[aria-label="Report overview"] .tile', { hasText: 'Taxa' }).locator('dd strong')).toHaveText('20');

		await page.waitForLoadState('networkidle');
		const origin = new URL(baseURL!).origin;
		expect(requests.offOrigin(origin)).toEqual([]);
		expect(requests.matching(/\/gallery\/Smc6\.json(\?|$)/).length, 'the prebaked record was fetched').toBeGreaterThanOrEqual(1);
		expect(requests.matching(HEAVY_ASSET)).toEqual([]);
	});

	test('every example baked, and the two without branch lengths baked tree-free (D22)', async ({ request }) => {
		const res = await request.get('/gallery/index.json');
		expect(res.ok()).toBe(true);
		const index = await res.json();
		expect(index.schema_version).toBe(3);
		const byId = Object.fromEntries(index.entries.map((e: any) => [e.id, e]));
		expect(Object.keys(byId).sort()).toEqual([...EXAMPLES].sort());
		for (const id of EXAMPLES) {
			const entry = byId[id];
			expect(entry.status, `${id}: ${entry.error ?? ''}`).toBe('ok');
			expect(entry.result, `${id} has a prebaked report`).toBeTruthy();
			expect(entry.branch_lengths_estimated, `${id} claims estimated branch lengths, which nothing does since D22`).toBe(false);
			const record = await (await request.get(`/gallery/${entry.result}`)).json();
			const pre = record.provenance.preprocessing;
			expect(['user', 'embedded', 'tn93'], `${id} tree_source ${pre.tree_source}`).toContain(pre.tree_source);
			if (TREE_FREE_EXAMPLES.includes(id)) {
				expect(pre.tree_source, `${id} carries a topology without branch lengths`).toBe('tn93');
				expect(pre.tree_free?.reason).toBe('no_branch_lengths');
				expect(entry.branch_length_method).toBe('tn93');
				// The report still has a tree to draw; it is the app's, on the same distances.
				expect(pre.display_tree_source).toBe('nj');
				expect(record.sections.sites.display_tree?.newick ?? '').toMatch(/^\(/);
			} else {
				expect(pre.tree_free ?? null, `${id} has usable branch lengths and must not be tree-free`).toBeNull();
			}
			expect(JSON.stringify(record)).not.toMatch(/hyphy/i);
		}
	});

	test('/report/gallery/camelid/ renders the tree-free record and says so on the strip', async ({ page, baseURL }) => {
		const requests = trackRequests(page);
		await page.goto('/report/gallery/camelid/');
		await expect(section(page, 'sites')).toHaveAttribute('data-state', 'done', { timeout: 30_000 });
		await expect(page.locator('.strip .tree')).toHaveText('tree-free (TN93) — no branch lengths');
		await expect(page.locator('.table .count')).toHaveText('96 of 96 sites');
		await page.waitForLoadState('networkidle');
		expect(requests.matching(HYPHY_ANY), 'a gallery report reached for HyPhy').toEqual([]);
		expect(requests.matching(HEAVY_ASSET)).toEqual([]);
		expect(requests.offOrigin(new URL(baseURL!).origin)).toEqual([]);
	});

	test('/gallery/ redirects to the landing page', async ({ page }) => {
		await page.goto('/gallery/');
		await page.waitForURL((url) => url.pathname === '/', { timeout: 15_000 });
		await expect(page.getByText(/drop your alignment here/i)).toBeVisible();
	});

	test('/results/gallery/Smc6/ redirects to /report/gallery/Smc6/', async ({ page }) => {
		await page.goto('/results/gallery/Smc6/');
		await page.waitForURL(/\/report\/gallery\/Smc6\/?$/, { timeout: 15_000 });
		await expect(page.getByRole('heading', { level: 1 })).toContainText(/Smc6/i, { timeout: 30_000 });
		await expect(section(page, 'sites')).toHaveAttribute('data-state', 'done', { timeout: 30_000 });
	});

	test('parity: the prebaked Smc6 epistasis matches the CLI fixture at B = 1,000', async ({ request }) => {
		const reference = referenceEpistasis('Smc6', 1000);
		test.skip(reference === null, 'fixtures/e2e/epistasis_Smc6_n_permutations_1000.json not found in the engine checkout');
		const res = await request.get('/gallery/Smc6.json');
		expect(res.ok()).toBe(true);
		const record = await res.json();
		expect(record.schema_version).toBe(2);
		expect(record.kind).toBe('report');
		expect(record.options.permutations).toBe(1000);
		expect(record.options.seed).toBe(42);
		const epi = record.sections.epistasis as CliEpistasis;
		expect(epi.permutations?.n).toBe(1000);
		const cmp = compareEpistasis(epi, reference!, 1000);
		test.info().annotations.push({ type: 'gallery-vs-python', description: `${cmp.edges} edges, ${cmp.sectors} sectors exact (surface ${record.provenance?.surface}); ${cmp.statistical.join('; ')}` });
		expect(cmp.violations, `exact/graph-class violations: ${cmp.violations.join(' | ')}`).toEqual([]);
		expect(cmp.statViolations, `statistical-class violations: ${cmp.statViolations.join(' | ')}`).toEqual([]);
	});
});
