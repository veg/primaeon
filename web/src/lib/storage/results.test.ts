/**
 * results.test.ts — the parts of the IndexedDB store that run without a browser.
 *
 * WHY THIS FILE EXISTS. vitest runs under Node, which has no IndexedDB, so the store's
 * transactions are exercised by the Playwright run (the scratch driver in the Phase 1b report
 * reads the record back through `indexedDB.open('hyphaeon')`); what can be pinned here is the id
 * shape (128 bits, URL-safe, unique), `isAvailable()` answering false rather than throwing where
 * `indexedDB` is absent, and every call rejecting cleanly in that case instead of hanging.
 */

import { describe, expect, it } from 'vitest';
import { getResult, isAvailable, listResults, newRunId, saveResult } from './results';
import { resultsPath } from '$lib/api';

describe('newRunId', () => {
	it('is a UUID or 32 hex chars, unique, and URL-safe', () => {
		const ids = new Set(Array.from({ length: 200 }, () => newRunId()));
		expect(ids.size).toBe(200);
		for (const id of ids) {
			expect(id).toMatch(/^[0-9a-f-]{32,36}$/);
			expect(resultsPath(id)).toBe(`/results/local/?id=${id}`);
		}
	});
});

describe('without IndexedDB', () => {
	it('reports unavailable and rejects instead of hanging', async () => {
		expect(isAvailable()).toBe(false);
		await expect(getResult('x')).rejects.toThrow(/IndexedDB/);
		await expect(listResults()).rejects.toThrow(/IndexedDB/);
		await expect(saveResult({ id: 'x' } as never)).rejects.toThrow(/IndexedDB/);
	});
});
