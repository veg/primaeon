import { describe, expect, it } from 'vitest';
import { shannonEntropy, siteCompositions, translateCodon } from './entropy';

describe('entropy', () => {
	it('translates and rejects gapped codons', () => {
		expect(translateCodon('ATG')).toBe('M');
		expect(translateCodon('TAA')).toBe('*');
		expect(translateCodon('A-G')).toBe('?');
		expect(translateCodon('AT')).toBe('?');
		expect(translateCodon('ANN')).toBe('?');
	});

	it('computes Shannon entropy in bits', () => {
		expect(shannonEntropy([])).toBe(0);
		expect(shannonEntropy(['A', 'A'])).toBe(0);
		expect(shannonEntropy(['A', 'B'])).toBeCloseTo(1, 12);
		expect(shannonEntropy(['A', 'B', 'C', 'D'])).toBeCloseTo(2, 12);
	});

	it('separates codon from amino-acid entropy and skips gaps', () => {
		// Site 1: TTT / TTC (both F) -> codon entropy 1 bit, AA entropy 0; site 2: one gap column.
		const seqs = ['TTTATG', 'TTC---', 'TTTATG'];
		const comp = siteCompositions(seqs, 2);
		expect(comp[0].codonEntropy).toBeCloseTo(0.918, 3);
		expect(comp[0].aaEntropy).toBe(0);
		expect(comp[0].aaCounts.get('F')).toBe(3);
		expect(comp[1].total).toBe(2);
		expect(comp[1].codons).toEqual(['ATG', '---', 'ATG']);
	});
});
