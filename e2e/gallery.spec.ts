/**
 * gallery.spec.ts — the prebaked gallery: five cards on /gallery/, and a prebaked record
 * rendering on /results/gallery/<id>/ without any model or runtime bytes.
 *
 * WHY THIS FILE EXISTS. PLAN.md §4.1: "/gallery — bundled examples with prebaked results", and
 * §4.4: the lazy assets are fetched on first use from /analyze, never elsewhere. The gallery
 * cards come from static/gallery/index.json (web/scripts/prebake-gallery.mjs) and the results
 * page reads static/gallery/<id>.json, so neither route has a reason to touch the 21 MB of ORT
 * and graph or the 6.4 MB of HyPhy WASM; a request for any of them here would be a wrong import
 * in the results bundle (downloads.ts imports the writers lazily, on click, for that reason).
 * The five names are the README examples the prebake enumerates (gallery-prebake report).
 */

import { expect, test } from '@playwright/test';
import { HEAVY_ASSET, trackRequests } from './helpers';

const EXAMPLES = ['Smc6', 'bat_oas1', 'camelid', 'HIV1_RT', 'RHO'];

test.describe('gallery', () => {
	test('/gallery/ lists five cards linking to prebaked results, fetching no heavy asset', async ({ page, baseURL }) => {
		const requests = trackRequests(page);
		await page.goto('/gallery/');
		await page.waitForLoadState('networkidle');

		const cards = page.locator('ul[aria-label="Examples"] > li.card');
		await expect(cards).toHaveCount(5);
		for (const id of EXAMPLES) {
			const link = page.locator(`ul[aria-label="Examples"] a.button[href$="/results/gallery/${id}/"]`);
			await expect(link, `View results link for ${id}`).toHaveCount(1);
		}
		await expect(page.locator('ul[aria-label="Examples"] li.card--unavailable')).toHaveCount(0);

		const origin = new URL(baseURL!).origin;
		expect(requests.offOrigin(origin)).toEqual([]);
		expect(requests.matching(HEAVY_ASSET)).toEqual([]);
	});

	test('/results/gallery/Smc6/ renders the plot and the table from the prebaked JSON', async ({ page, baseURL }) => {
		const requests = trackRequests(page);
		await page.goto('/results/gallery/Smc6/');
		await expect(page.locator('canvas[aria-label^="Predicted LRT by codon site"]')).toBeVisible({ timeout: 30_000 });
		await expect(page.locator('.table .count')).toHaveText('1097 of 1097 sites');
		expect(await page.locator('table tbody tr.row').count()).toBe(25);
		await expect(page.locator('dl.tiles .tile--accent dd strong')).toHaveText(/^\d[\d,]*$/);
		await expect(page.getByRole('heading', { level: 1 })).toContainText(/Smc6/i);
		await page.waitForLoadState('networkidle');

		const origin = new URL(baseURL!).origin;
		expect(requests.offOrigin(origin)).toEqual([]);
		expect(requests.matching(/\/gallery\/Smc6\.json(\?|$)/).length, 'the prebaked record was fetched').toBeGreaterThanOrEqual(1);
		expect(requests.matching(HEAVY_ASSET)).toEqual([]);
	});
});
