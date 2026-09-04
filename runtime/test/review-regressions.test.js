/**
 * review-regressions.test.js — ported from datamonkey3/src/test/axomeme-review-regressions.test.js
 * (main@fac1330), re-targeted in Phase 1b at the library that replaced DM3's `prepareAlignment`
 * (`loadAlignmentAndTree`, mirroring dataset.py). Both cases exercise the LIBRARY through the
 * package name the app consumes, so they double as a check that the file: link resolves and that
 * the two invariants the pipeline relies on still hold in the library the app is built against:
 * a duplicate FASTA header resolves the way dataset.py's dict does (the LAST record wins, and
 * the tokens come from that record), and batches can be too large to spread.
 */
import { describe, it, expect } from 'vitest';
import { loadAlignmentAndTree, batchSizeFor, parseAlignmentSequences, codonToken } from '@veg/hyphaeon-js';

describe('review regressions', () => {
	it('a duplicate FASTA header resolves to the LAST record, and the tokens come from that record', () => {
		// DM3's bug: names.indexOf() returned the FIRST match while the species order kept the LAST,
		// so variability flags came from a different sequence than the model was fed. dataset.py
		// parses into a dict, so the last record wins everywhere; the pipeline reads tokens and the
		// invariable mask from ONE loaded object and cannot disagree with itself.
		const alignment = '>dup\nATGAAA\n>other\nATGTTT\n>dup\nATGCCC\n';
		const parsed = parseAlignmentSequences(alignment);
		expect(parsed.size).toBe(2);
		expect(parsed.get('dup')).toBe('ATGCCC');
		const loaded = loadAlignmentAndTree(alignment, '((dup:0.1,other:0.2):0.05,dup:0.3);', { maxSpecies: 8 });
		expect(loaded.taxa).toEqual(['dup', 'other']);
		// Site 2 of `dup` is CCC, the last record's, not AAA.
		expect(loaded.c[1 * loaded.N + 0]).toBe(codonToken('CCC'));
		expect(loaded.c[1 * loaded.N + 1]).toBe(codonToken('TTT'));
	});

	it('batchSizeFor can exceed the argument-spread limit, so results must not be spread', () => {
		// The number that made `push(...batch)` throw "Maximum call stack size exceeded" at ~90%
		// progress. Pinned so nobody reintroduces the spread thinking the batches are small.
		expect(batchSizeFor(10)).toBeGreaterThan(125000);
		expect(batchSizeFor(4)).toBeGreaterThan(125000);
	});
});
