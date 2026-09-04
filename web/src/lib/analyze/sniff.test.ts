/**
 * sniff.test.ts — unit tests for the upload card's header sniff.
 *
 * WHY THIS FILE EXISTS. The sniff is the only logic on /analyze in Phase 0, and its one job is to
 * not mis-read the bundled examples' headers: FASTA with descriptions after the name, NEXUS with
 * TAXLABELS and an embedded TREES block (RHO.fasta), PHYLIP with a dimensions line.
 */

import { describe, expect, it } from 'vitest';
import {
	approximateCodonLength,
	hasEmbeddedTree,
	looksLikeGzip,
	sequenceNames,
	sniffFormat
} from './sniff';

const FASTA = `>hg38 Homo sapiens
ATGAAACCC
GGG
>panTro4 Pan troglodytes
ATGAAACCCGGG
`;

const NEXUS = `#NEXUS

BEGIN TAXA;
	DIMENSIONS NTAX=2;
	TAXLABELS
		'turTru'
		balMus
	;
END;

BEGIN CHARACTERS;
END;

BEGIN TREES;
	TREE tree = ((turTru:0.1,balMus:0.2):0.0);
END;
`;

const PHYLIP = `2 12
hg38      ATGAAACCCGGG
panTro4   ATGAAACCCGGG
`;

describe('sniffFormat', () => {
	it('recognises FASTA, NEXUS and PHYLIP from the first line', () => {
		expect(sniffFormat(FASTA)).toBe('fasta');
		expect(sniffFormat(NEXUS)).toBe('nexus');
		expect(sniffFormat(PHYLIP)).toBe('phylip');
		expect(sniffFormat('hello')).toBe('unknown');
		expect(sniffFormat('')).toBe('unknown');
	});

	it('skips leading blank lines', () => {
		expect(sniffFormat(`\n\n${FASTA}`)).toBe('fasta');
	});
});

describe('sequenceNames', () => {
	it('takes FASTA names up to the first whitespace', () => {
		expect(sequenceNames(FASTA)).toEqual(['hg38', 'panTro4']);
	});

	it('reads NEXUS TAXLABELS and strips quotes', () => {
		expect(sequenceNames(NEXUS)).toEqual(['turTru', 'balMus']);
	});

	it('reads PHYLIP names from the body lines', () => {
		expect(sequenceNames(PHYLIP)).toEqual(['hg38', 'panTro4']);
	});

	it('returns [] for unknown input', () => {
		expect(sequenceNames('not an alignment')).toEqual([]);
	});
});

describe('hasEmbeddedTree', () => {
	it('is true only when a TREES block is present', () => {
		expect(hasEmbeddedTree(NEXUS)).toBe(true);
		expect(hasEmbeddedTree(FASTA)).toBe(false);
	});
});

describe('looksLikeGzip', () => {
	it('checks the RFC 1952 magic bytes', () => {
		expect(looksLikeGzip(new Uint8Array([0x1f, 0x8b, 0x08]))).toBe(true);
		expect(looksLikeGzip(new Uint8Array([0x3e, 0x68]))).toBe(false);
		expect(looksLikeGzip(new Uint8Array([]))).toBe(false);
	});
});

describe('approximateCodonLength', () => {
	it('counts the first FASTA record across wrapped lines', () => {
		expect(approximateCodonLength(FASTA)).toBe(4);
	});

	it('is null for non-FASTA input', () => {
		expect(approximateCodonLength(NEXUS)).toBeNull();
	});
});
