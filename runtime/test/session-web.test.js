/**
 * session-web.test.js — ported from datamonkey3/src/test/axomeme-session.test.js (main@fac1330)
 * and adapted to session-web.js's argument-driven signature: the URL, the expected hash and the
 * WASM path arrive as options instead of constants, and "production call" is now decided by an
 * allow-list over the option keys rather than by "no options at all".
 *
 * The load path is where ~21 MB of runtime and graph either does or does not reach a user, and
 * where a swapped artifact either is or is not caught. Both failure modes are silent — the wrong
 * model still returns a plausible number per site — so every guard here is exercised in both
 * directions. The ONNX runtime is faked; the real graph is exercised by pipeline.test.js under
 * onnxruntime-node and by the web e2e in a browser.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
	loadSession,
	resetSession,
	isSessionLoaded,
	runSites,
	resolveThreads,
	DEFAULT_ORT_WASM_PATH
} from '../src/session-web.js';
import { DEFAULT_INPUT_NAMES } from '../src/manifest.js';

/** Four bytes; their sha256 is below. Tests either pin that hash or bypass the check. */
const SOME_BYTES = new Uint8Array([1, 2, 3, 4]).buffer;
const SOME_BYTES_SHA256 = '9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a';
const OTHER_SHA256 = 'ab'.repeat(32);
const MODEL_URL = '/models/viral.onnx';

function fakeOrt(
	inputNames = ['msa_codons', 'msa_aas', 'dist_matrix', 'mds_coords'],
	outputNames = ['lrt', 'alpha', 'beta_neg', 'beta_pos', 'p_neg']
) {
	const created = [];
	return {
		created,
		env: { wasm: {} },
		Tensor: class {
			constructor(type, data, dims) {
				this.type = type;
				this.data = data;
				this.dims = dims;
			}
		},
		InferenceSession: {
			create: vi.fn(async (bytes) => {
				created.push(bytes.byteLength ?? bytes.length);
				return {
					inputNames,
					outputNames,
					run: vi.fn(async (feeds) => {
						const n = feeds.msa_codons.dims[0];
						const species = feeds.msa_codons.dims[1];
						const f = (len = n) => ({ data: new Float32Array(len).fill(1) });
						const out = {};
						for (const name of outputNames) {
							out[name] = name === 'mean_root_attns' ? f(n * species) : f();
						}
						return out;
					})
				};
			})
		}
	};
}

const okFetch = (buffer = SOME_BYTES) =>
	vi.fn(async () => ({ ok: true, status: 200, statusText: 'OK', arrayBuffer: async () => buffer }));

/** A seam call: verified against the real digest of SOME_BYTES, so verification is exercised. */
const seam = (extra = {}) => ({
	modelUrl: MODEL_URL,
	expectedSha256: SOME_BYTES_SHA256,
	ort: fakeOrt(),
	fetchImpl: okFetch(),
	...extra
});

describe('loadSession', () => {
	beforeEach(() => resetSession());

	it('does not load anything just by importing the module', () => {
		expect(isSessionLoaded()).toBe(false);
	});

	it('requires a model URL and an expected hash', () => {
		expect(() => loadSession({})).toThrow(/modelUrl/);
		expect(() => loadSession({ modelUrl: MODEL_URL })).toThrow(/expectedSha256/);
		expect(() => loadSession({ modelUrl: MODEL_URL, expectedSha256: 'nope' })).toThrow(/expectedSha256/);
		// ...unless verification is explicitly waived, which is a test seam and never memoised.
		expect(() => loadSession({ modelUrl: MODEL_URL, verifyHash: false, ort: fakeOrt(), fetchImpl: okFetch() })).not.toThrow();
		expect(isSessionLoaded()).toBe(false);
	});

	it('loads, verifies the digest, and reports the byte count and the thread count', async () => {
		const ort = fakeOrt();
		const fetchImpl = okFetch();
		const r = await loadSession({ modelUrl: MODEL_URL, expectedSha256: SOME_BYTES_SHA256, ort, fetchImpl });
		expect(r.bytes).toBe(4);
		expect(r.sha256).toBe(SOME_BYTES_SHA256);
		expect(r.verified).toBe(true);
		expect(r.numThreads).toBe(1);
		expect(r.ort).toBe(ort);
		expect(r.outputNames).toContain('lrt');
		expect(fetchImpl).toHaveBeenCalledWith(MODEL_URL);
		expect(ort.InferenceSession.create).toHaveBeenCalledTimes(1);
	});

	it('points the runtime at the vendored WASM, never a CDN', async () => {
		const ort = fakeOrt();
		await loadSession(seam({ ort }));
		expect(ort.env.wasm.wasmPaths).toBe(DEFAULT_ORT_WASM_PATH);
		expect(ort.env.wasm.numThreads).toBe(1);
		const ort2 = fakeOrt();
		await loadSession(seam({ ort: ort2, ortWasmPath: '/hyphaeon/ort/' }));
		expect(ort2.env.wasm.wasmPaths).toBe('/hyphaeon/ort/');
	});

	it('REFUSES a model whose hash is not the expected one', async () => {
		// The graph contract was verified against the artifact the manifest names. A different one
		// may be fine; nothing here knows that, and guessing produces wrong numbers rather than an
		// error.
		const err = await loadSession(seam({ expectedSha256: OTHER_SHA256 })).catch((e) => e);
		expect(err).toBeInstanceOf(Error);
		expect(err.message).toMatch(/hash mismatch/);
		expect(err.message).toContain(OTHER_SHA256);
		expect(err.message).toContain(SOME_BYTES_SHA256);
		// And it must say what to do about it, not just that it failed.
		expect(err.message).toMatch(/manifest\.json/);
	});

	it('verifies BEFORE creating the session', async () => {
		const ort = fakeOrt();
		await loadSession(seam({ ort, expectedSha256: OTHER_SHA256 })).catch(() => {});
		expect(ort.InferenceSession.create).not.toHaveBeenCalled();
	});

	it('refuses a graph that is missing a contract input', async () => {
		const ort = fakeOrt(['msa_codons', 'msa_aas', 'dist_matrix']); // no mds_coords
		const err = await loadSession(seam({ ort })).catch((e) => e);
		expect(err.message).toMatch(/missing expected inputs/);
		expect(err.message).toMatch(/mds_coords/);
	});

	it('refuses a graph that does not return lrt', async () => {
		const ort = fakeOrt(undefined, ['something_else']);
		const err = await loadSession(seam({ ort })).catch((e) => e);
		expect(err.message).toMatch(/missing expected outputs/);
		expect(err.message).toMatch(/lrt/);
	});

	it('reports a failed fetch with its status and the URL', async () => {
		const fetchImpl = vi.fn(async () => ({ ok: false, status: 404, statusText: 'Not Found' }));
		const err = await loadSession(seam({ fetchImpl })).catch((e) => e);
		expect(err.message).toMatch(/404/);
		expect(err.message).toContain(MODEL_URL);
	});

	it('memoises the PRODUCTION path, so a second alignment does not re-download 21 MB', async () => {
		// The production path carries only allow-listed options, so it is driven here by stubbing the
		// global it reaches for. onnxruntime-web may or may not import under Node; either way the
		// assertion is on the FETCH count: one download no matter how many callers ask.
		let fetches = 0;
		const realFetch = globalThis.fetch;
		globalThis.fetch = async () => {
			fetches++;
			return { ok: true, status: 200, statusText: 'OK', arrayBuffer: async () => SOME_BYTES };
		};
		try {
			const opts = { modelUrl: MODEL_URL, expectedSha256: OTHER_SHA256 };
			const a = loadSession(opts);
			const b = loadSession({ ...opts });
			expect(a, 'a second call returned a different promise — the memo is not shared').toBe(b);
			expect(isSessionLoaded(), 'isSessionLoaded stayed false on the production path').toBe(true);
			expect(isSessionLoaded(opts)).toBe(true);
			await Promise.allSettled([a, b]);
			// It fails at the hash check or the ort import, but only ONE fetch may have happened.
			expect(fetches).toBeLessThanOrEqual(1);
		} finally {
			globalThis.fetch = realFetch;
		}
	});

	it('keys the memo on the options, so two graphs do not share one session', async () => {
		const realFetch = globalThis.fetch;
		globalThis.fetch = async () => ({ ok: true, status: 200, statusText: 'OK', arrayBuffer: async () => SOME_BYTES });
		try {
			const a = loadSession({ modelUrl: '/models/general.onnx', expectedSha256: OTHER_SHA256 });
			const b = loadSession({ modelUrl: '/models/viral.onnx', expectedSha256: OTHER_SHA256 });
			expect(a).not.toBe(b);
			await Promise.allSettled([a, b]);
		} finally {
			globalThis.fetch = realFetch;
		}
	});

	it('bypasses the memo when seams are supplied, so tests stay independent', async () => {
		const fetchImpl = okFetch();
		await loadSession(seam({ fetchImpl }));
		await loadSession(seam({ fetchImpl }));
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		// And a seam call must never populate the production memo — including verifyHash:false,
		// which would otherwise cache a session that was never checked against the manifest.
		await loadSession({ modelUrl: MODEL_URL, verifyHash: false, ort: fakeOrt(), fetchImpl: okFetch() });
		expect(isSessionLoaded()).toBe(false);
	});

	it('does not memoise a FAILURE, so a transient error is recoverable', async () => {
		const realFetch = globalThis.fetch;
		globalThis.fetch = async () => ({ ok: false, status: 503, statusText: 'Unavailable' });
		try {
			await loadSession({ modelUrl: MODEL_URL, expectedSha256: OTHER_SHA256 }).catch(() => {});
			expect(isSessionLoaded()).toBe(false);
		} finally {
			globalThis.fetch = realFetch;
		}
	});
});

describe('threads', () => {
	const had = Object.getOwnPropertyDescriptor(globalThis, 'crossOriginIsolated');
	afterEach(() => {
		if (had) Object.defineProperty(globalThis, 'crossOriginIsolated', had);
		else delete globalThis.crossOriginIsolated;
	});

	it('runs single-threaded unless the page is cross-origin isolated', () => {
		delete globalThis.crossOriginIsolated;
		expect(resolveThreads(4)).toBe(1);
		expect(resolveThreads(1)).toBe(1);
		expect(resolveThreads(undefined)).toBe(1);
		Object.defineProperty(globalThis, 'crossOriginIsolated', { value: true, configurable: true });
		expect(resolveThreads(4)).toBe(4);
		Object.defineProperty(globalThis, 'crossOriginIsolated', { value: false, configurable: true });
		expect(resolveThreads(4)).toBe(1);
	});

	it('passes the resolved count to the runtime and reports it', async () => {
		Object.defineProperty(globalThis, 'crossOriginIsolated', { value: true, configurable: true });
		const ort = fakeOrt();
		const r = await loadSession(seam({ ort, numThreads: 3 }));
		expect(ort.env.wasm.numThreads).toBe(3);
		expect(r.numThreads).toBe(3);
	});

	it('rejects a nonsensical thread count', () => {
		expect(() => loadSession(seam({ numThreads: 0 }))).toThrow(/numThreads/);
		expect(() => loadSession(seam({ numThreads: 1.5 }))).toThrow(/numThreads/);
	});
});

describe('runSites', () => {
	const bundle = (B, N) => ({
		msa_codons: { data: new BigInt64Array(B * N), dims: [B, N, 1] },
		msa_aas: { data: new BigInt64Array(B * N), dims: [B, N, 1] },
		dist_matrix: { data: new Float32Array(B * N * N), dims: [B, N, N] },
		mds_coords: { data: new Float32Array(B * N * 4), dims: [B, N, 4] }
	});

	it('feeds every tensor with the dtype the graph expects, and reads back only lrt from a v1 graph', async () => {
		const ort = fakeOrt();
		const { session } = await loadSession(seam({ ort }));
		const out = await runSites(session, bundle(2, 3), ort);
		const feeds = session.run.mock.calls[0][0];
		// int64 for the token streams: passing float32 of the same values is a type error at
		// session.run, not a silent coercion.
		expect(feeds.msa_codons.type).toBe('int64');
		expect(feeds.msa_aas.type).toBe('int64');
		expect(feeds.dist_matrix.type).toBe('float32');
		expect(feeds.mds_coords.type).toBe('float32');
		// Four tensors, and no fifth: the graph has no padding_mask input, and feeding a tensor the
		// graph does not declare is an error at session.run rather than something it ignores.
		expect(Object.keys(feeds).sort()).toEqual(['dist_matrix', 'mds_coords', 'msa_aas', 'msa_codons']);
		expect(DEFAULT_INPUT_NAMES).toEqual(['msa_codons', 'msa_aas', 'dist_matrix', 'mds_coords']);
		// The fake returns the retired 2.0 heads too; they are not in the manifest's list and must
		// not leak into a result nobody has verified.
		expect(Object.keys(out).sort()).toEqual(['lrt']);
		expect(out.lrt).toHaveLength(2);
	});

	it('passes the attention and pooled heads through when the graph has them', async () => {
		const ort = fakeOrt(undefined, ['lrt', 'mean_root_attns', 'root_repr']);
		const { session } = await loadSession(seam({ ort }));
		const out = await runSites(session, bundle(5, 3), ort);
		expect(Object.keys(out).sort()).toEqual(['lrt', 'mean_root_attns', 'root_repr']);
		expect(out.mean_root_attns).toHaveLength(15);
	});

	it('runs ALL sites in one call, not one call per site', async () => {
		// The phylo tensors are per-alignment, so batching is nearly free. The reference driver loops
		// one forward pass per codon; for a 441-site alignment that is 441x the overhead.
		const ort = fakeOrt();
		const { session } = await loadSession(seam({ ort }));
		await runSites(session, bundle(441, 2), ort);
		expect(session.run).toHaveBeenCalledTimes(1);
	});
});
