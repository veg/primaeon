/**
 * smoke.spec.ts — every static route renders, and none fetches what it should not.
 *
 * WHY THIS FILE EXISTS. Every bug found while wiring AxoMEME into DataMonkey was in what the page
 * fetched, not in what it computed (datamonkey3/e2e/19-axomeme.spec.js): a CDN URL for the ORT
 * WASM, the wrong ORT variant, the model requested where it was not needed. So this suite asserts
 * WHICH URLS THE PAGE REQUESTS, per route (report.spec.ts and gallery.spec.ts cover the run path
 * and the prebaked reports):
 *
 *   1. The landing page IS the drop zone (PLAN.md §4.0, D21): it renders the title, the heading and
 *      "Drop your alignment here"; the surrogate caveat lives in the report and on /methods, not in
 *      the hero; the privacy promise stays (footer). The primary navigation is Methods, Evaluate,
 *      MCP: /analyze and /gallery folded into `/` and `/report/gallery/…` (PLAN.md §4.1), so a nav
 *      link to either would be a leftover.
 *   2. Every request during load is same-origin (PLAN.md D8: no CDNs; fonts included).
 *   3. No model (*.onnx), no ORT binary (ort-*.wasm / .mjs) and no HyPhy WASM is requested on the
 *      landing route. PLAN.md §4.4: the lazy assets are fetched on first use from the run path.
 *   4. The response carries COOP/COEP (D13) on every route's document, so SharedArrayBuffer and
 *      multi-threaded ORT are available on this origin. Here they come from vite.config.ts's preview
 *      headers; in production from static/_headers or the vhost. A missing header is a silent fall
 *      back to one thread, which no other test would notice. The report shell is the one that
 *      matters (its worker inherits the document's isolation).
 *   5. /methods/ and /mcp/ render their content (the methods-caveats builder's follow-up): every
 *      pillar section is present with no placeholder text, and the MCP page leads with the
 *      `claude mcp add` line and `hyphaeon_analyze` as the first tool.
 */

import { expect, test } from '@playwright/test';
import { HEAVY_ASSET, trackRequests } from './helpers';

test.describe('landing page', () => {
	test('renders the drop zone, without the surrogate caveat and without Analyze/Gallery in the nav', async ({ page }) => {
		await page.goto('/');
		await expect(page).toHaveTitle(/HyphAeon/);
		await expect(page.getByRole('heading', { level: 1, name: 'HyphAeon' })).toBeVisible();
		await expect(page.locator('.dropzone')).toBeVisible();
		await expect(page.getByText(/drop your alignment here/i)).toBeVisible();

		const body = await page.locator('body').innerText();
		expect(body).not.toMatch(/surrogate/i);
		expect(body).toMatch(/stay in this browser/i);

		const nav = page.locator('nav[aria-label="Primary"] a');
		const labels = (await nav.allInnerTexts()).map((s) => s.trim());
		expect(labels).toEqual(['Methods', 'Evaluate', 'MCP']);
		for (const href of await nav.evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).getAttribute('href') ?? ''))) {
			expect(href, `nav href ${href}`).not.toMatch(/\/(analyze|gallery)\/?$/);
		}
	});

	test('requests nothing from another origin and no model, ORT or HyPhy bytes', async ({ page, baseURL }) => {
		const requests = trackRequests(page);
		await page.goto('/');
		await page.waitForLoadState('networkidle');

		const origin = new URL(baseURL!).origin;
		const offOrigin = requests.offOrigin(origin);
		expect(offOrigin, `off-origin requests: ${offOrigin.join(', ')}`).toEqual([]);
		expect(requests.urls().length, 'no requests were recorded at all').toBeGreaterThan(0);
		const heavy = requests.matching(HEAVY_ASSET);
		expect(heavy, `heavy assets requested on the landing route: ${heavy.join(', ')}`).toEqual([]);
	});

	// The document of every route carries the headers, not just the landing page: a worker
	// inherits its document's isolation, so the report shell is the one that matters for the pool.
	for (const route of ['/', '/report/local/', '/report/gallery/Smc6/', '/methods/', '/mcp/', '/evaluate/']) {
		test(`${route} is served cross-origin isolated (COOP/COEP)`, async ({ page }) => {
			const response = await page.goto(route);
			expect(response, `no response for ${route}`).not.toBeNull();
			expect(response!.status(), `HTTP status for ${route}`).toBe(200);
			const headers = response!.headers();
			expect(headers['cross-origin-opener-policy']).toBe('same-origin');
			expect(headers['cross-origin-embedder-policy']).toBe('require-corp');
			// And the browser agrees, which is the property the ORT thread pool actually depends on.
			expect(await page.evaluate(() => globalThis.crossOriginIsolated)).toBe(true);
		});
	}
});

test.describe('methods and mcp pages', () => {
	test('/methods/ has a section per pillar, the surrogate statement, and no placeholder text', async ({ page, baseURL }) => {
		const requests = trackRequests(page);
		await page.goto('/methods/');
		await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
		for (const id of ['model', 'sites', 'gene', 'epistasis', 'attribution', 'filter', 'dms', 'phenotype']) {
			await expect(page.locator(`section#${id}`), `section #${id}`).toHaveCount(1);
		}
		const body = await page.locator('body').innerText();
		expect(body).toMatch(/surrogate/i);
		expect(body).not.toMatch(/to be written|TODO|lorem ipsum/i);
		await page.waitForLoadState('networkidle');
		expect(requests.offOrigin(new URL(baseURL!).origin)).toEqual([]);
		expect(requests.matching(HEAVY_ASSET)).toEqual([]);
	});

	test('/mcp/ shows the install line and hyphaeon_analyze as the first tool', async ({ page, baseURL }) => {
		const requests = trackRequests(page);
		await page.goto('/mcp/');
		await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
		await expect(page.getByText('claude mcp add hyphaeon -- npx @veg/hyphaeon-mcp').first()).toBeVisible();
		const firstTool = page.locator('table.tools tbody tr').first();
		await expect(firstTool).toContainText('hyphaeon_analyze');
		await page.waitForLoadState('networkidle');
		expect(requests.offOrigin(new URL(baseURL!).origin)).toEqual([]);
		expect(requests.matching(HEAVY_ASSET)).toEqual([]);
	});
});
