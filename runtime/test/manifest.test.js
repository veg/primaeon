/**
 * manifest.test.js — the one reader of models/manifest.json.
 *
 * The manifest is where the artifact hashes live now (DM3 pinned one in source), so a malformed
 * or half-written manifest must be refused loudly rather than yield a session that verifies
 * against `undefined`.
 */
import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	parseManifest,
	loadManifest,
	pickVariant,
	listVariants,
	modelLocation,
	inputNames,
	outputNames,
	sha256Hex,
	verifySha256,
	isSha256Hex,
	hashMismatchError,
	DEFAULT_INPUT_NAMES,
	DEFAULT_OUTPUT_NAMES,
	DEFAULT_VARIANT
} from '../src/manifest.js';

const VIRAL = 'de765904107ba436c6ad6abbecb8af54962abd8444e1b5044947bb945d8ccda3';
const GENERAL = '11'.repeat(32);
const HEAD = '22'.repeat(32);

const doc = () => ({
	model_version: 'v1',
	variants: {
		general: { safetensors_sha256: '33'.repeat(32), onnx_sha256: GENERAL, busted_head_onnx_sha256: HEAD, trained_on: 'TOGA mammalian', regime: 'deep' },
		viral: { onnx_sha256: VIRAL, trained_on: 'base + viral', regime: 'viral / shallow' }
	},
	taxon_cap: 512,
	default_taxon_cap: 256,
	dropped_heads_policy: 'omit',
	onnx: { opset: 17, inputs: ['msa_codons', 'msa_aas', 'dist_matrix', 'mds_coords'], outputs: ['lrt', 'mean_root_attns', 'root_repr'] },
	prng: { algorithm: 'xoshiro256**', default_seed: 42 }
});

describe('parseManifest', () => {
	it('accepts the PLAN.md §3.3 shape, from an object or from text', () => {
		expect(parseManifest(doc()).model_version).toBe('v1');
		expect(parseManifest(JSON.stringify(doc())).variants.viral.onnx_sha256).toBe(VIRAL);
	});

	it('refuses a manifest a session could not act on', () => {
		expect(() => parseManifest(null)).toThrow(/not an object/);
		expect(() => parseManifest({ variants: doc().variants })).toThrow(/model_version/);
		expect(() => parseManifest({ model_version: 'v1', variants: {} })).toThrow(/no variants/);
		const bad = doc();
		bad.variants.viral.onnx_sha256 = 'DE7659';
		expect(() => parseManifest(bad)).toThrow(/viral.*onnx_sha256/);
		const badHead = doc();
		badHead.variants.general.busted_head_onnx_sha256 = 'nope';
		expect(() => parseManifest(badHead)).toThrow(/busted_head_onnx_sha256/);
	});
});

describe('pickVariant', () => {
	it('defaults to general (D10) and exposes file names and hashes', () => {
		const m = parseManifest(doc());
		expect(DEFAULT_VARIANT).toBe('general');
		const g = pickVariant(m);
		expect(g.name).toBe('general');
		expect(g.onnxSha256).toBe(GENERAL);
		expect(g.onnxFile).toBe('general.onnx');
		expect(g.bustedHeadSha256).toBe(HEAD);
		expect(g.bustedHeadFile).toBe('busted_head.onnx');
		const v = pickVariant(m, 'viral');
		expect(v.onnxSha256).toBe(VIRAL);
		expect(v.bustedHeadSha256).toBeNull();
		expect(v.bustedHeadFile).toBeNull();
		expect(v.regime).toBe('viral / shallow');
	});

	it('honours an explicit file name and names the available variants on a miss', () => {
		const m = doc();
		m.variants.viral.onnx_file = 'model.viral.onnx';
		expect(pickVariant(parseManifest(m), 'viral').onnxFile).toBe('model.viral.onnx');
		expect(() => pickVariant(parseManifest(doc()), 'mammal')).toThrow(/general, viral/);
		expect(listVariants(parseManifest(doc()))).toEqual(['general', 'viral']);
	});

	it('builds a model location under any base', () => {
		const m = parseManifest(doc());
		expect(modelLocation('/models', m, 'viral')).toBe('/models/viral.onnx');
		expect(modelLocation('/hyphaeon/models/', m, 'viral')).toBe('/hyphaeon/models/viral.onnx');
		expect(modelLocation('https://x.org/m', m)).toBe('https://x.org/m/general.onnx');
		expect(modelLocation('', m, 'viral')).toBe('viral.onnx');
	});

	it('reads the graph contract from the manifest, with defaults when it is silent', () => {
		const m = parseManifest(doc());
		expect(inputNames(m)).toEqual([...DEFAULT_INPUT_NAMES]);
		expect(outputNames(m)).toEqual([...DEFAULT_OUTPUT_NAMES]);
		const silent = doc();
		delete silent.onnx;
		expect(inputNames(parseManifest(silent))).toEqual(['msa_codons', 'msa_aas', 'dist_matrix', 'mds_coords']);
		expect(outputNames(parseManifest(silent))).toEqual(['lrt', 'mean_root_attns', 'root_repr']);
	});
});

describe('loadManifest', () => {
	it('reads a file under Node', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'hyphaeon-manifest-'));
		const p = join(dir, 'manifest.json');
		await writeFile(p, JSON.stringify(doc()));
		const m = await loadManifest(p);
		expect(pickVariant(m, 'viral').onnxSha256).toBe(VIRAL);
	});

	it('fetches a URL and reports a failed fetch', async () => {
		const fetchImpl = async (url) => ({ ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({ ...doc(), model_version: url }) });
		const m = await loadManifest('https://example.org/models/manifest.json', { fetchImpl });
		expect(m.model_version).toBe('https://example.org/models/manifest.json');
		const bad = async () => ({ ok: false, status: 404, statusText: 'Not Found' });
		await expect(loadManifest('https://example.org/nope.json', { fetchImpl: bad })).rejects.toThrow(/404/);
	});

	it('passes an object straight through the validator', async () => {
		await expect(loadManifest({ model_version: 'v1' })).rejects.toThrow(/no variants/);
		expect((await loadManifest(doc())).model_version).toBe('v1');
	});
});

describe('sha256', () => {
	it('digests to the known vector and verifies', async () => {
		const abc = new TextEncoder().encode('abc');
		const expected = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
		expect(await sha256Hex(abc)).toBe(expected);
		expect(await sha256Hex(abc.buffer)).toBe(expected);
		expect(await verifySha256(abc, expected)).toEqual({ ok: true, verified: true, actual: expected, expected });
		const wrong = await verifySha256(abc, '00'.repeat(32));
		expect(wrong.ok).toBe(false);
		expect(wrong.verified).toBe(true);
		expect(isSha256Hex(expected)).toBe(true);
		expect(isSha256Hex(expected.toUpperCase())).toBe(false);
	});

	it('writes a mismatch message that names both hashes and the remedy', () => {
		const err = hashMismatchError('HyphAeon model', 'aa'.repeat(32), 'bb'.repeat(32));
		expect(err.message).toMatch(/hash mismatch/);
		expect(err.message).toContain('aa'.repeat(32));
		expect(err.message).toContain('bb'.repeat(32));
		expect(err.message).toMatch(/manifest\.json/);
	});
});
