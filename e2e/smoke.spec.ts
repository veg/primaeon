/**
 * smoke.spec.ts — the landing page renders, and it fetches nothing it should not.
 *
 * WHY THIS FILE EXISTS. Every bug found while wiring AxoMEME into DataMonkey was in what the page
 * fetched, not in what it computed (datamonkey3/e2e/19-axomeme.spec.js): a CDN URL for the ORT
 * WASM, the wrong ORT variant, the model requested where it was not needed. So this suite asserts
 * WHICH URLS THE PAGE REQUESTS, per route, starting with the landing page (analyze.spec.ts and
 * gallery.spec.ts cover the run path and the prebaked gallery):
 *
 *   1. It renders (title and heading), so the build is a working site and not an empty shell.
 *   2. Every request during load is same-origin (PLAN.md D8: no CDNs; fonts included).
 *   3. No model (*.onnx) and no ORT binary (ort-*.wasm / .mjs) is requested. PLAN.md §4.4: the
 *      landing page requests none of the lazy assets; 13 MB of WASM and 7.8 MB of graph are
 *      fetched on first use from /analyze, never on arrival.
 *   4. The response carries COOP/COEP (D13) on every route's document, so SharedArrayBuffer and
 *      multi-threaded ORT are available on this origin. Here they come from vite.config.ts's preview headers; in
 *      production from static/_headers or the vhost. A missing header is a silent fall back to one
 *      thread, which no other test would notice.
 */

import { expect, test, type Page } from '@playwright/test';

/** Model graphs and any ONNX Runtime WASM artefact (binary or loader, any variant). */
const HEAVY_ASSET = /\.onnx(\?|$)|ort-wasm[^/]*\.(wasm|mjs)(\?|$)|ort-[^/]*\.wasm(\?|$)/i;

/** Record every http(s) request the page makes, from before navigation. */
function trackRequests(page: Page): () => string[] {
	const urls: string[] = [];
	page.on('request', (request) => {
		const url = request.url();
		if (/^https?:/i.test(url)) urls.push(url);
	});
	return () => urls;
}

test.describe('landing page', () => {
	test('renders the title and heading', async ({ page }) => {
		await page.goto('/');
		await expect(page).toHaveTitle(/HyphAeon/);
		await expect(page.getByRole('heading', { level: 1, name: 'HyphAeon' })).toBeVisible();
		// The framing is part of the product (PLAN.md §2.1, §2.8): both promises are on the page.
		const body = await page.locator('body').innerText();
		expect(body).toMatch(/surrogate/i);
		expect(body).toMatch(/stay in this browser/i);
	});

	test('requests nothing from another origin', async ({ page, baseURL }) => {
		const requests = trackRequests(page);
		await page.goto('/');
		await page.waitForLoadState('networkidle');

		const origin = new URL(baseURL!).origin;
		const offOrigin = requests().filter((u) => new URL(u).origin !== origin);
		expect(offOrigin, `off-origin requests: ${offOrigin.join(', ')}`).toEqual([]);
		expect(requests().length, 'no requests were recorded at all').toBeGreaterThan(0);
	});

	test('does not fetch a model or the ORT runtime', async ({ page }) => {
		const requests = trackRequests(page);
		await page.goto('/');
		await page.waitForLoadState('networkidle');

		const heavy = requests().filter((u) => HEAVY_ASSET.test(u));
		expect(heavy, `heavy assets requested on the landing route: ${heavy.join(', ')}`).toEqual([]);
	});

	// The document of every route carries the headers, not just the landing page: a worker
	// inherits its document's isolation, so /analyze/ is the one that matters for the thread pool.
	for (const route of ['/', '/analyze/', '/gallery/']) {
		test(`${route} is served cross-origin isolated (COOP/COEP)`, async ({ page }) => {
			const response = await page.goto(route);
			expect(response, `no response for ${route}`).not.toBeNull();
			const headers = response!.headers();
			expect(headers['cross-origin-opener-policy']).toBe('same-origin');
			expect(headers['cross-origin-embedder-policy']).toBe('require-corp');
			// And the browser agrees, which is the property the ORT thread pool actually depends on.
			expect(await page.evaluate(() => globalThis.crossOriginIsolated)).toBe(true);
		});
	}
});
