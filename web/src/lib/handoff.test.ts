/**
 * handoff.test.ts — the dataset must reach the analysis page at any size.
 *
 * WHY THIS FILE EXISTS. A reader reported that the deployed site refused every upload with "this
 * browser blocks session storage", and checked, reasonably, whether their browser was blocking it.
 * It was not. The hand-off wrote the whole alignment into `sessionStorage`, which is capped near
 * five megabytes, and reported the resulting `QuotaExceededError` as a browser problem. Measured
 * against the deployed site on 2026-09-11: 3.69 MB ran, 5.08 MB and 7.39 MB were refused.
 *
 * These tests pin the two things that fix it: the hand-off travels in memory, so size cannot refuse
 * it, and a storage failure is silent because storage is only the fallback.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { clearHandoff, HANDOFF_KEY, setHandoff, takeHandoff, type Handoff } from './handoff';

const sample = (alignmentText: string): Handoff => ({
	alignmentText,
	alignmentName: 'big.fasta',
	treeText: null,
	treeName: null
});

/** A minimal in-memory sessionStorage with a quota, which is what a browser actually gives us. */
function installStorage(quotaChars: number) {
	const map = new Map<string, string>();
	const store = {
		getItem: (k: string) => map.get(k) ?? null,
		removeItem: (k: string) => void map.delete(k),
		setItem: (k: string, v: string) => {
			let total = v.length;
			for (const [key, value] of map) if (key !== k) total += value.length;
			if (total > quotaChars) {
				const err = new Error('quota');
				err.name = 'QuotaExceededError';
				throw err;
			}
			map.set(k, v);
		}
	};
	vi.stubGlobal('sessionStorage', store);
	return map;
}

beforeEach(() => {
	clearHandoff();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('the hand-off from the landing page to the analysis page', () => {
	it('delivers an alignment far larger than the storage quota', () => {
		const map = installStorage(5 * 1024 * 1024);
		// Eight megabytes of sequence: over the ceiling that refused the reporter's upload.
		const big = sample('>a\n' + 'ACGT'.repeat(2 * 1024 * 1024));
		expect(() => setHandoff(big)).not.toThrow();
		// Storage could not take it, and that is fine: it is not the channel.
		expect(map.has(HANDOFF_KEY)).toBe(false);
		expect(takeHandoff()?.alignmentText).toBe(big.alignmentText);
	});

	it('is silent when storage is unavailable altogether', () => {
		vi.stubGlobal('sessionStorage', {
			getItem: () => {
				throw new Error('blocked');
			},
			setItem: () => {
				throw new Error('blocked');
			},
			removeItem: () => {
				throw new Error('blocked');
			}
		});
		const h = sample('>a\nACGTACGT');
		expect(() => setHandoff(h)).not.toThrow();
		expect(takeHandoff()).toEqual(h);
	});

	it('still uses storage for a small dataset, so a reload of the analysis page recovers it', () => {
		const map = installStorage(5 * 1024 * 1024);
		const h = sample('>a\nACGTACGT');
		setHandoff(h);
		expect(map.has(HANDOFF_KEY)).toBe(true);
		// A reload loses the module state but not the stored copy.
		clearMemoryOnly(map);
		expect(takeHandoff()).toEqual(h);
	});

	it('hands over once, then reports nothing', () => {
		installStorage(5 * 1024 * 1024);
		const h = sample('>a\nACGTACGT');
		setHandoff(h);
		expect(takeHandoff()).toEqual(h);
		expect(takeHandoff()).toBeNull();
	});

	it('reports nothing when the page was opened without a hand-off', () => {
		installStorage(5 * 1024 * 1024);
		expect(takeHandoff()).toBeNull();
	});

	it('ignores a stored value that is not a hand-off', () => {
		const map = installStorage(5 * 1024 * 1024);
		map.set(HANDOFF_KEY, '{"alignmentName":"x"}');
		expect(takeHandoff()).toBeNull();
	});
});

/**
 * Simulate a page reload: the module-scoped hand-off is gone, the stored copy is not. `clearHandoff`
 * would clear both, so the stored value is put back after it.
 */
function clearMemoryOnly(map: Map<string, string>) {
	const kept = map.get(HANDOFF_KEY);
	clearHandoff();
	if (kept !== undefined) map.set(HANDOFF_KEY, kept);
}
