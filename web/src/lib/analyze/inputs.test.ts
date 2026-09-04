/**
 * inputs.test.ts — the upload card's non-parsing helpers.
 *
 * WHY THIS FILE EXISTS. `chooseReference` is app policy (DM3's hg38/hg/human rule) that no
 * library test covers; `loadDemo` decides from HTTP status and content whether an example
 * carries a tree; `digest` is what the record stores instead of the sequences, so its hash must
 * be the SHA-256 of the UTF-8 text and nothing else.
 */

import { describe, expect, it } from 'vitest';
import { chooseReference, digest, loadDemo, looksLikeGzip, sha256Text } from './inputs';

describe('chooseReference', () => {
	it('prefers hg38, hg, human, then a prefix, then the first name', () => {
		expect(chooseReference(['panTro4', 'hg38', 'human'])).toBe('hg38');
		expect(chooseReference(['panTro4', 'Human_1'])).toBe('Human_1');
		expect(chooseReference(['panTro4', 'HG'])).toBe('HG');
		expect(chooseReference(['R_ferr', 'M_lyra'])).toBe('R_ferr');
		expect(chooseReference([])).toBeNull();
	});
});

describe('digest', () => {
	it('hashes the UTF-8 bytes', async () => {
		// SHA-256("abc") from FIPS 180-2 Appendix B.1.
		expect(await sha256Text('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
		const d = await digest('x.fasta', 'é');
		expect(d).toEqual({ name: 'x.fasta', size: 2, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
	});

	it('recognises the gzip magic', () => {
		expect(looksLikeGzip(new Uint8Array([0x1f, 0x8b, 8]))).toBe(true);
		expect(looksLikeGzip(new Uint8Array([0x3e, 0x68]))).toBe(false);
	});
});

describe('loadDemo', () => {
	const files: Record<string, string> = {
		'/base/gallery/inputs/bat_oas1.fasta': '>a\nATG\n',
		'/base/gallery/inputs/bat_oas1.nwk': '(a:0.1,b:0.1);',
		'/base/gallery/inputs/RHO.fasta': '#NEXUS\n'
	};
	const fetchImpl = (async (url: string | URL | Request) => {
		const key = String(url);
		const body = files[key];
		if (body === undefined) return new Response('<html>404</html>', { status: 404 });
		return new Response(body, { status: 200 });
	}) as typeof fetch;

	it('loads an alignment and its tree', async () => {
		const demo = await loadDemo('bat_oas1', '/base', fetchImpl);
		expect(demo).toEqual({
			id: 'bat_oas1',
			alignmentName: 'bat_oas1.fasta',
			alignmentText: '>a\nATG\n',
			treeName: 'bat_oas1.nwk',
			treeText: '(a:0.1,b:0.1);'
		});
	});

	it('reports no tree when the .nwk is missing', async () => {
		const demo = await loadDemo('RHO', '/base', fetchImpl);
		expect(demo.treeText).toBeNull();
		expect(demo.treeName).toBeNull();
	});

	it('refuses unknown examples and unsafe ids', async () => {
		await expect(loadDemo('nope', '/base', fetchImpl)).rejects.toThrow(/not bundled/);
		await expect(loadDemo('../x', '/base', fetchImpl)).rejects.toThrow(/Not a demo id/);
	});
});
