/**
 * session-node.js — loading and running a HyphAeon ONNX graph under Node.
 *
 * WHY THIS FILE EXISTS. Ported from datamonkey-js-server/lib/axomeme/session.js (main@1e84d6f),
 * CommonJS → ESM, with the model path and the expected hash arriving as ARGUMENTS instead of a
 * constant path and a hash pinned in source (the manifest names both now; see manifest.js).
 * Every POLICY is that file's, which in turn carried DM3's; only the transport differs from the
 * browser module: fs.readFile for fetch, node:crypto for Web Crypto, onnxruntime-node for
 * onnxruntime-web.
 *
 * THE LAZY IMPORT IS LOAD-BEARING — DO NOT HOIST IT TO MODULE SCOPE. `import('onnxruntime-node')`
 * lives inside loadSession()'s async body. That package dlopens ~100 MB of native ONNX Runtime on
 * first load, and the MCP stdio server is spawned once per client session: hoisting it would make
 * every tool call — list_models, job_status, hyphaeon_validate — pay that cost before doing
 * anything. Importing this module costs nothing; calling loadSession() is what costs the runtime.
 *
 * MEMOISATION. Only a production call is cached, keyed by modelPath + expectedSha256 + threads, and
 * "production" is decided by an allow-list over the option KEYS: anything beyond those —
 * `ort`, `readFileImpl`, `verifyHash`, any future option — bypasses the cache in both directions.
 * A failed load is never memoised: a transient read error must not disable the feature for the
 * life of the process.
 *
 * INTEGRITY. The sha256 is computed BEFORE InferenceSession.create and a mismatch is refused, not
 * scored. node:crypto is always present, so verification is unconditional unless a test passes
 * verifyHash: false explicitly.
 *
 * THREADS. Single-threaded and sequential by default: this process is one worker among many on a
 * shared box, and a batch of sites is already wide enough to keep one core busy. ORT's own
 * 0 = "all cores" is deliberately not exposed.
 *
 * THE onnxruntime-node RANGE. ^1.23 rather than an exact pin: datamonkey-js-server pins 1.23.2
 * because it is the last release with darwin/x64 bindings and that project has Intel-Mac
 * developers. This package's optionalDependency lets npm pick what installs on the host; the
 * MCP and server workspaces pin what they ship.
 */

import { readFile as fsReadFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

import { BUSTED_HEAD_INPUT_NAMES, BUSTED_HEAD_OUTPUT_NAMES } from '@veg/hyphaeon-js';

import { DEFAULT_INPUT_NAMES, REQUIRED_OUTPUT_NAMES, isSha256Hex, hashMismatchError } from './manifest.js';

export { runSites, buildFeeds, runBustedHead, buildBustedHeadFeeds } from './feeds.js';

/** Option keys a PRODUCTION call may carry; anything else is a seam and bypasses the memo. */
const MEMO_KEYS = new Set(['modelPath', 'expectedSha256', 'threads', 'expectedInputs', 'expectedOutputs', 'kind']);

/** Memoised session promises keyed by modelPath|expectedSha256|threads. */
const sessions = new Map();

/** Hex sha256 of a buffer. node:crypto is always available, so this never degrades to null. */
export function sha256HexSync(buffer) {
	return createHash('sha256').update(buffer).digest('hex');
}

function cacheKey(modelPath, expectedSha256, threads) {
	return `${modelPath}|${expectedSha256}|${threads}`;
}

/**
 * onnxruntime-node is CommonJS compiled from TypeScript with `__exportStar`, which Node's
 * CJS-to-ESM named-export detection does not always see through. Accept either shape.
 */
function normaliseOrt(mod) {
	if (mod && typeof mod.InferenceSession?.create === 'function') return mod;
	if (mod?.default && typeof mod.default.InferenceSession?.create === 'function') return mod.default;
	throw new Error('onnxruntime-node did not expose InferenceSession');
}

/**
 * Load the ONNX session, importing the native runtime and reading the graph on first call.
 *
 * @param {{modelPath: string, expectedSha256?: string, threads?: number,
 *   expectedInputs?: readonly string[], expectedOutputs?: readonly string[], kind?: string,
 *   verifyHash?: boolean, ort?: any,
 *   readFileImpl?: (p: string) => Promise<Buffer|Uint8Array>}} options
 *   `modelPath` is required; `expectedSha256` is required unless `verifyHash` is explicitly false.
 *   `expectedInputs` / `expectedOutputs` default to the backbone contract (the four inputs, `lrt`);
 *   `loadBustedHead` below sets them for the head graph. `kind` ('backbone' | 'busted_head') is
 *   recorded on the handle. `ort` and `readFileImpl` are test seams; production passes neither.
 * @returns {Promise<{session: any, ort: any, sha256: string|null, verified: boolean,
 *   bytes: number, threads: number, modelPath: string, kind: string, inputNames: string[],
 *   outputNames: string[]}>}
 */
export function loadSession(options = {}) {
	const {
		modelPath,
		expectedSha256,
		threads = 1,
		expectedInputs = DEFAULT_INPUT_NAMES,
		expectedOutputs = REQUIRED_OUTPUT_NAMES,
		kind = 'backbone'
	} = options;
	if (typeof modelPath !== 'string' || !modelPath) {
		throw new Error('loadSession: modelPath is required');
	}
	if (options.verifyHash !== false && !isSha256Hex(expectedSha256)) {
		throw new Error(
			'loadSession: expectedSha256 (64 hex chars, from the manifest) is required unless verifyHash is false'
		);
	}
	if (!Number.isInteger(threads) || threads < 1) {
		throw new Error(`loadSession: threads must be a positive integer, got ${JSON.stringify(threads)}`);
	}
	const key = cacheKey(modelPath, expectedSha256, threads);

	const cacheable = Object.keys(options).every((k) => MEMO_KEYS.has(k));
	if (cacheable && sessions.has(key)) return sessions.get(key);

	const promise = (async () => {
		const readFile = options.readFileImpl ?? fsReadFile;

		// The lazy import is the whole point — see the header. Do not hoist it.
		const ort = options.ort ?? normaliseOrt(await import('onnxruntime-node'));

		const buffer = await readFile(modelPath).catch((err) => {
			// Wrap for context but keep the original reachable: `cause` preserves the chain, and
			// copying `code` up lets a caller distinguish ENOENT (model not installed) from an I/O
			// failure without parsing the message.
			const wrapped = new Error(`HyphAeon model read failed: ${modelPath}: ${err.message}`, {
				cause: err
			});
			if (err && err.code !== undefined) wrapped.code = err.code;
			throw wrapped;
		});

		const sha256 = options.verifyHash === false ? null : sha256HexSync(buffer);
		if (sha256 && sha256 !== expectedSha256) {
			throw hashMismatchError('HyphAeon model', expectedSha256, sha256);
		}

		const session = await ort.InferenceSession.create(buffer, {
			intraOpNumThreads: threads,
			interOpNumThreads: 1,
			executionMode: 'sequential',
			graphOptimizationLevel: 'all'
		});

		const missing = expectedInputs.filter((n) => !session.inputNames.includes(n));
		if (missing.length) {
			throw new Error(`HyphAeon model is missing expected inputs: ${missing.join(', ')}`);
		}
		const missingOut = expectedOutputs.filter((n) => !session.outputNames?.includes(n));
		if (missingOut.length) {
			throw new Error(`HyphAeon model is missing expected outputs: ${missingOut.join(', ')}`);
		}

		return {
			session,
			ort,
			sha256,
			verified: sha256 !== null,
			bytes: buffer.byteLength,
			threads,
			modelPath,
			kind,
			inputNames: Array.from(session.inputNames ?? []),
			outputNames: Array.from(session.outputNames ?? [])
		};
	})();

	if (cacheable) {
		sessions.set(key, promise);
		promise.catch(() => {
			if (sessions.get(key) === promise) sessions.delete(key);
		});
	}
	return promise;
}

/**
 * Load `busted_head.onnx`: the same policy as `loadSession` with the head's contract —
 * inputs `root_repr` [1, L, 384] float32 and `mask` [1, L] bool (all false; feeds.js enforces
 * it), outputs `cls_prob`, `pred_gene_lrt`, `omega_prop`, `syn_var`, `pred_omega3`, `pred_logp`
 * (export.py BUSTED_*_NAMES via the library's BUSTED_HEAD_*_NAMES). The hash comes from the
 * manifest's `busted_head_onnx_sha256`.
 *
 * @param {{modelPath: string, expectedSha256?: string, threads?: number, verifyHash?: boolean,
 *   ort?: any, readFileImpl?: (p: string) => Promise<Buffer|Uint8Array>}} options
 */
export function loadBustedHead(options = {}) {
	return loadSession({
		...options,
		expectedInputs: BUSTED_HEAD_INPUT_NAMES,
		expectedOutputs: BUSTED_HEAD_OUTPUT_NAMES,
		kind: 'busted_head'
	});
}

/** Drop every memoised session. Tests use this; production has no reason to. */
export function resetSession() {
	sessions.clear();
}

/**
 * Release every memoised ORT session and forget it. This is what a process must call before it
 * exits: onnxruntime-node 1.23.2 aborts at exit ("libc++abi: terminating due to uncaught
 * exception of type std::__1::system_error: mutex lock failed: Invalid argument", SIGABRT) when
 * an InferenceSession is still alive on its thread pool — measured in Phase 1b on the MCP stdio
 * server at 1 and 4 intra-op threads and in scripts/parity-node.mjs. A caller that releases a
 * handle by hand must also drop it from the memo, or the next `loadSession` returns a disposed
 * session ("Session already disposed"); doing both here keeps the two in step. Loads still in
 * flight are awaited and released; a failed load has nothing to release. After this call
 * `process.exit()` is safe, though draining the loop (`process.exitCode`) is preferred.
 *
 * @returns {Promise<number>} how many sessions were released
 */
export async function releaseSessions() {
	const pending = [...sessions.values()];
	sessions.clear();
	let released = 0;
	for (const promise of pending) {
		let handle;
		try {
			handle = await promise;
		} catch {
			continue;
		}
		const release = handle?.session?.release;
		if (typeof release === 'function') {
			await release.call(handle.session);
			released += 1;
		}
	}
	return released;
}

/**
 * True once a session is loaded or loading. With no arguments it reports whether ANY session is
 * memoised; with options it narrows to that cache entry (threads defaults to 1).
 */
export function isSessionLoaded(options) {
	if (!options) return sessions.size > 0;
	return sessions.has(cacheKey(options.modelPath, options.expectedSha256, options.threads ?? 1));
}
