/**
 * session-node.test.js — the loading policy of session-node.js, with the native runtime faked.
 *
 * Mirrors session-web.test.js case for case where the policy is shared (DM3's
 * axomeme-session.test.js lineage), plus the Node-only behaviours: ENOENT is distinguishable from
 * a hash failure, the session options pin one intra-op thread, and node:crypto verification is
 * unconditional. The real runtime and the real graph are exercised by pipeline.test.js.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { loadSession, resetSession, isSessionLoaded, runSites, sha256HexSync } from '../src/session-node.js';

const BYTES = Buffer.from([1, 2, 3, 4]);
const BYTES_SHA256 = createHash('sha256').update(BYTES).digest('hex');
const OTHER_SHA256 = 'ab'.repeat(32);
const MODEL_PATH = '/nonexistent/models/viral.onnx';

function fakeOrt(inputNames = ['msa_codons', 'msa_aas', 'dist_matrix', 'mds_coords'], outputNames = ['lrt']) {
	return {
		Tensor: class {
			constructor(type, data, dims) {
				this.type = type;
				this.data = data;
				this.dims = dims;
			}
		},
		InferenceSession: {
			create: vi.fn(async (buffer, opts) => ({
				inputNames,
				outputNames,
				opts,
				bytes: buffer.byteLength,
				run: vi.fn(async (feeds) => ({ lrt: { data: new Float32Array(feeds.msa_codons.dims[0]).fill(2) } }))
			}))
		}
	};
}

const readOk = () => vi.fn(async () => BYTES);
const seam = (extra = {}) => ({
	modelPath: MODEL_PATH,
	expectedSha256: BYTES_SHA256,
	ort: fakeOrt(),
	readFileImpl: readOk(),
	...extra
});

describe('loadSession (node)', () => {
	beforeEach(() => resetSession());

	it('does not load anything just by importing the module', () => {
		expect(isSessionLoaded()).toBe(false);
	});

	it('requires a model path and an expected hash', () => {
		expect(() => loadSession({})).toThrow(/modelPath/);
		expect(() => loadSession({ modelPath: MODEL_PATH })).toThrow(/expectedSha256/);
		expect(() => loadSession(seam({ threads: 0 }))).toThrow(/threads/);
	});

	it('loads, verifies with node:crypto, and pins one intra-op thread by default', async () => {
		const ort = fakeOrt();
		const r = await loadSession(seam({ ort }));
		expect(r.bytes).toBe(4);
		expect(r.sha256).toBe(BYTES_SHA256);
		expect(r.verified).toBe(true);
		expect(r.threads).toBe(1);
		expect(r.ort).toBe(ort);
		expect(sha256HexSync(BYTES)).toBe(BYTES_SHA256);
		const opts = ort.InferenceSession.create.mock.calls[0][1];
		expect(opts).toMatchObject({ intraOpNumThreads: 1, interOpNumThreads: 1, executionMode: 'sequential' });
	});

	it('passes a requested thread count through', async () => {
		const ort = fakeOrt();
		const r = await loadSession(seam({ ort, threads: 3 }));
		expect(r.threads).toBe(3);
		expect(ort.InferenceSession.create.mock.calls[0][1].intraOpNumThreads).toBe(3);
	});

	it('REFUSES a model whose hash is not the expected one, before creating a session', async () => {
		const ort = fakeOrt();
		const err = await loadSession(seam({ ort, expectedSha256: OTHER_SHA256 })).catch((e) => e);
		expect(err.message).toMatch(/hash mismatch/);
		expect(err.message).toContain(OTHER_SHA256);
		expect(err.message).toContain(BYTES_SHA256);
		expect(ort.InferenceSession.create).not.toHaveBeenCalled();
	});

	it('keeps ENOENT distinguishable from every other failure', async () => {
		const enoent = Object.assign(new Error('no such file'), { code: 'ENOENT' });
		const readFileImpl = vi.fn(async () => {
			throw enoent;
		});
		const err = await loadSession(seam({ readFileImpl })).catch((e) => e);
		expect(err.code).toBe('ENOENT');
		expect(err.message).toContain(MODEL_PATH);
		expect(err.cause).toBe(enoent);
	});

	it('refuses a graph missing a contract input or the lrt output', async () => {
		let err = await loadSession(seam({ ort: fakeOrt(['msa_codons']) })).catch((e) => e);
		expect(err.message).toMatch(/missing expected inputs/);
		err = await loadSession(seam({ ort: fakeOrt(undefined, ['other']) })).catch((e) => e);
		expect(err.message).toMatch(/missing expected outputs/);
	});

	it('memoises the PRODUCTION path and drops a failed load', async () => {
		// Production options only, so this reaches the real onnxruntime-node import and then fails
		// at the read (the path does not exist). The memo must be shared while pending and gone
		// after the rejection.
		const opts = { modelPath: MODEL_PATH, expectedSha256: OTHER_SHA256 };
		const a = loadSession(opts);
		const b = loadSession({ ...opts });
		expect(a).toBe(b);
		expect(isSessionLoaded()).toBe(true);
		expect(isSessionLoaded(opts)).toBe(true);
		const err = await a.catch((e) => e);
		expect(err).toBeInstanceOf(Error);
		expect(isSessionLoaded()).toBe(false);
	});

	it('bypasses the memo when seams are supplied', async () => {
		const readFileImpl = readOk();
		await loadSession(seam({ readFileImpl }));
		await loadSession(seam({ readFileImpl }));
		expect(readFileImpl).toHaveBeenCalledTimes(2);
		expect(isSessionLoaded()).toBe(false);
	});
});

describe('runSites (node)', () => {
	it('feeds int64 token streams and float32 phylo tensors', async () => {
		const ort = fakeOrt();
		const { session } = await loadSession(seam({ ort }));
		const B = 3;
		const N = 2;
		const out = await runSites(
			session,
			{
				msa_codons: { data: new BigInt64Array(B * N), dims: [B, N, 1] },
				msa_aas: { data: new BigInt64Array(B * N), dims: [B, N, 1] },
				dist_matrix: { data: new Float32Array(B * N * N), dims: [B, N, N] },
				mds_coords: { data: new Float32Array(B * N * 4), dims: [B, N, 4] }
			},
			ort
		);
		const feeds = session.run.mock.calls[0][0];
		expect(feeds.msa_codons.type).toBe('int64');
		expect(feeds.dist_matrix.type).toBe('float32');
		expect(out.lrt).toHaveLength(B);
	});
});

// releaseSessions needs a MEMOISED session, and every seam above bypasses the memo, so this one
// loads the real general graph from the engine checkout (as pipeline.test.js does) and skips
// when it is absent. What it pins: the release goes through the memo (isSessionLoaded flips),
// the ORT session is really disposed (a second release rejects with ORT's own message), and a second call is a no-op.
describe('releaseSessions (node, real onnxruntime-node)', () => {
	it('releases every memoised session and forgets it, so the process can exit', async (ctxt) => {
		const { existsSync } = await import('node:fs');
		const { join, dirname } = await import('node:path');
		const { fileURLToPath } = await import('node:url');
		const { loadManifest, pickVariant } = await import('../src/manifest.js');
		const { releaseSessions } = await import('../src/session-node.js');
		const engine = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'HyphAeon');
		const modelPath = join(engine, 'models', 'general.onnx');
		const manifestPath = join(engine, 'models', 'manifest.json');
		if (!existsSync(modelPath) || !existsSync(manifestPath)) {
			ctxt.skip(`engine models not found under ${engine}`);
			return;
		}
		resetSession();
		const manifest = await loadManifest(manifestPath);
		const variant = pickVariant(manifest, 'general');
		const handle = await loadSession({ modelPath, expectedSha256: variant.onnxSha256, threads: 1 });
		expect(isSessionLoaded()).toBe(true);
		expect(await releaseSessions()).toBe(1);
		expect(isSessionLoaded()).toBe(false);
		await expect(handle.session.release()).rejects.toThrow(/disposed/i);
		expect(await releaseSessions()).toBe(0);
	});
});
