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
 *   3. No model (*.onnx) and no ORT binary (ort-*.wasm / .mjs) is requested on the landing route.
 *      PLAN.md §4.4: the lazy assets are fetched on first use from the run path.
 *   3a. AND NOTHING HYPHY, ON ANY ROUTE OR IN THE BUILD (PLAN.md D22, Phase 3). HyPhy WASM was
 *      removed from the product: `runtime/src/hyphy/`, `runtime/vendor/hyphy/`, the browser's tree
 *      worker, the `./hyphy` export and `static/wasm/hyphy/` are all deleted, and the tree-free
 *      TN93 path replaced what they did. A removal is only real if nothing can still reach for it,
 *      so the check is on three surfaces at once: no request URL on any route mentions HyPhy
 *      (`HYPHY_ANY`, folded into `HEAVY_ASSET`), nothing named after it survives in the built site
 *      or in the sources it is built from, and the URL the old build served answers 404.
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
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { APP_DIR, HEAVY_ASSET, HYPHY_ANY, trackRequests } from './helpers';

/** Every path under `dir` (files and directories), relative to it. */
function walk(dir: string, prefix = ''): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		const rel = prefix ? `${prefix}/${name}` : name;
		out.push(rel);
		const full = join(dir, name);
		if (statSync(full).isDirectory()) out.push(...walk(full, rel));
	}
	return out;
}

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

	test('requests nothing from another origin and no model or ORT bytes', async ({ page, baseURL }) => {
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

test.describe('HyPhy is gone (D22)', () => {
	// The tree the model is given now comes from the library: branch lengths as supplied, or
	// pairwise TN93 distances. Nothing in the product loads a HyPhy build any more.
	test('nothing named after HyPhy is in the built site or the sources it is built from', async () => {
		for (const gone of ['web/static/wasm/hyphy', 'web/static/wasm', 'runtime/src/hyphy', 'runtime/vendor/hyphy', 'runtime/test/hyphy.test.js', 'web/src/lib/workers/tree.worker.ts']) {
			expect(existsSync(resolve(APP_DIR, gone)), `${gone} still exists`).toBe(false);
		}
		const build = resolve(APP_DIR, 'web/build');
		expect(existsSync(build), 'web/build exists: run `npm run build` in web/ first').toBe(true);
		const named = walk(build).filter((p) => HYPHY_ANY.test(p));
		expect(named, `built files named after HyPhy: ${named.join(', ')}`).toEqual([]);
	});

	test('the URL the old build served is a 404, on the served site', async ({ request }) => {
		for (const url of ['/wasm/hyphy/2.5.98/hyphy.js', '/wasm/hyphy/2.5.98/hyphy.wasm', '/wasm/hyphy/2.5.98/hyphy.data']) {
			const res = await request.get(url);
			expect(res.status(), `${url} is still served`).toBe(404);
		}
	});

	test('no route requests anything HyPhy', async ({ page, baseURL }) => {
		const requests = trackRequests(page);
		for (const route of ['/', '/methods/', '/mcp/', '/evaluate/', '/report/gallery/Smc6/', '/report/gallery/camelid/']) {
			await page.goto(route);
			await page.waitForLoadState('networkidle');
		}
		const hyphy = requests.matching(HYPHY_ANY);
		expect(hyphy, `HyPhy URLs requested: ${hyphy.join(', ')}`).toEqual([]);
		expect(requests.offOrigin(new URL(baseURL!).origin)).toEqual([]);
	});
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

	test('/mcp/ is current with the mcp/ workspace: its version and one row per registered tool, no bridge', async ({ page, baseURL }) => {
		// Phase 4: web/src/routes/mcp/+page.server.ts reads mcp/package.json and mcp/src/tools.js
		// TOOL_NAMES at build, so the page cannot describe a release other than the one beside it.
		// The same two sources are read here, independently, and held against the rendered page.
		const requests = trackRequests(page);
		const version = JSON.parse(readFileSync(resolve(APP_DIR, 'mcp/package.json'), 'utf8')).version as string;
		const toolsSource = readFileSync(resolve(APP_DIR, 'mcp/src/tools.js'), 'utf8');
		const block = toolsSource.match(/export const TOOL_NAMES = Object\.freeze\(\[([\s\S]*?)\]\)/);
		expect(block, 'mcp/src/tools.js exports TOOL_NAMES').not.toBeNull();
		const toolNames = [...block![1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
		expect(toolNames.length).toBeGreaterThanOrEqual(10);
		expect(toolNames[0]).toBe('hyphaeon_validate');

		await page.goto('/mcp/');
		await expect(page.getByText(`@veg/hyphaeon-mcp ${version}`).first()).toBeVisible();
		await expect(page.getByText(`with the ${toolNames.length} tools listed below`)).toBeVisible();
		// One tool per row; the "Job control" group heading is a `tr.tools__group` with no tool in it.
		const rows = page.locator('table.tools tbody tr:not(.tools__group)');
		await expect(rows).toHaveCount(toolNames.length);
		const rendered = (await rows.locator('td:first-child').allInnerTexts()).map((t) => t.trim());
		expect([...rendered].sort()).toEqual([...toolNames].sort());
		// The Phase 3 "Runs" column marked tools "bridged" to the Python reference; the table has
		// neither now (the prose may still say, historically, that nothing is marked so).
		const table = await page.locator('table.tools').innerText();
		expect(table).not.toMatch(/\bRuns\b|bridged|python/i);
		const body = await page.locator('body').innerText();
		expect(body).not.toMatch(/to be written|TODO|lorem ipsum/i);
		await page.waitForLoadState('networkidle');
		expect(requests.offOrigin(new URL(baseURL!).origin)).toEqual([]);
		expect(requests.matching(HEAVY_ASSET)).toEqual([]);
	});
});
