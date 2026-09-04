/**
 * create-session.test.js — createSession's policy with the session modules FAKED: manifest
 * loading, variant choice, the hash handed to loadSession, the provenance stamp on the handle,
 * the lazy head, and the node/web argument shapes. The real load under Node is exercised by
 * parity-fixtures.test.js (createSession over ../HyphAeon/models).
 */
import { describe, it, expect, vi } from 'vitest';

import { createSession, detectRuntime } from '../src/createSession.js';

const MANIFEST = {
	model_version: 'v1',
	reference_version: '1.0.0',
	variants: {
		general: { onnx_sha256: 'aa'.repeat(32), busted_head_onnx_sha256: 'bb'.repeat(32) },
		viral: { onnx_sha256: 'cc'.repeat(32), onnx_file: 'viral-3out.onnx' }
	},
	prng: { algorithm: 'xoshiro256**', default_seed: 42 }
};

function fakeModule() {
	return {
		loadSession: vi.fn(async (opts) => ({ session: {}, ort: {}, sha256: opts.expectedSha256, verified: true, outputNames: ['lrt'], opts })),
		loadBustedHead: vi.fn(async (opts) => ({ session: {}, ort: {}, sha256: opts.expectedSha256, verified: true, kind: 'busted_head', opts }))
	};
}

describe('createSession', () => {
	it('detects Node here', () => {
		expect(detectRuntime()).toBe('node');
	});

	it('loads the default variant by path under Node, stamps the handle, and loads the head lazily', async () => {
		const mod = fakeModule();
		const s = await createSession({ modelsBase: '/models/', manifest: MANIFEST, runtime: 'node', threads: 3, sessionModule: mod, libraryVersion: '1.0.0-test' });
		expect(s.runtime).toBe('node');
		expect(s.variant.name).toBe('general');
		expect(mod.loadSession).toHaveBeenCalledWith({ modelPath: '/models/general.onnx', expectedSha256: 'aa'.repeat(32), threads: 3 });
		expect(s.backbone).toMatchObject({
			variant: 'general',
			modelVersion: 'v1',
			referenceVersion: '1.0.0',
			defaultSeed: 42,
			libraryVersion: '1.0.0-test',
			expectedSha256: 'aa'.repeat(32),
			exportSeed: null
		});
		expect(s.head).toBeNull();
		expect(mod.loadBustedHead).not.toHaveBeenCalled();
		const head = await s.loadHead();
		expect(mod.loadBustedHead).toHaveBeenCalledWith({ modelPath: '/models/busted_head.onnx', expectedSha256: 'bb'.repeat(32), threads: 3 });
		expect(head.variant).toBe('general');
		expect(s.head).toBe(head);
		// Memoised on the factory.
		expect(await s.loadHead()).toBe(head);
		expect(mod.loadBustedHead).toHaveBeenCalledTimes(1);
	});

	it('uses URLs, numThreads and the ORT WASM path for the web runtime, and honours onnx_file', async () => {
		const mod = fakeModule();
		const s = await createSession({
			modelsBase: 'https://example.org/app/models',
			manifest: MANIFEST,
			variant: 'viral',
			runtime: 'web',
			threads: 4,
			ortWasmPath: '/app/ort/',
			sessionModule: mod,
			libraryVersion: null,
			bustedHead: true
		});
		expect(mod.loadSession).toHaveBeenCalledWith({
			modelUrl: 'https://example.org/app/models/viral-3out.onnx',
			expectedSha256: 'cc'.repeat(32),
			numThreads: 4,
			ortWasmPath: '/app/ort/'
		});
		// The viral variant declares no head: loading it is a no-op that returns null.
		expect(s.head).toBeNull();
		expect(await s.loadHead()).toBeNull();
		expect(mod.loadBustedHead).not.toHaveBeenCalled();
		expect(s.backbone.libraryVersion).toBeNull();
	});

	it('refuses an unknown variant, runtime or missing base', async () => {
		const mod = fakeModule();
		await expect(createSession({ modelsBase: '/m', manifest: MANIFEST, variant: 'nope', sessionModule: mod, libraryVersion: null })).rejects.toThrow(/no variant "nope"/);
		await expect(createSession({ modelsBase: '/m', manifest: MANIFEST, runtime: 'deno', sessionModule: mod, libraryVersion: null })).rejects.toThrow(/runtime/);
		await expect(createSession({ manifest: MANIFEST, sessionModule: mod })).rejects.toThrow(/modelsBase/);
	});

	it('reads the library version from the installed package under Node', async () => {
		const mod = fakeModule();
		const s = await createSession({ modelsBase: '/m', manifest: MANIFEST, runtime: 'node', sessionModule: mod });
		expect(typeof s.libraryVersion).toBe('string');
		expect(s.libraryVersion).toMatch(/^\d+\.\d+\.\d+/);
	});
});
