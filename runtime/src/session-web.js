/**
 * session-web.js — loading and running a HyphAeon ONNX graph in the browser.
 *
 * WHY THIS FILE EXISTS. Ported from datamonkey3/src/lib/services/axomeme/session.js
 * (main@fac1330). Every POLICY below is that file's; what changed is that the model URL, the
 * expected hash and the ORT WASM path arrive as ARGUMENTS instead of constants, because this
 * package serves two variants named by a manifest (see manifest.js) and is mounted under a
 * configurable `paths.base`.
 *
 * THE COST DISCIPLINE THIS FILE ENFORCES. onnxruntime-web is ~13 MB of WASM and a graph is 7.8 MB.
 * The landing page must download none of it (PLAN.md §4.4). DM3 learned this the hard way: the
 * first version of its MEME hit-likelihood gate shipped 13.5 MB of ONNX Runtime to every method
 * and rendered nothing for fourteen of fifteen, and an "is the element absent?" test passed the
 * whole time because the element WAS absent. The bytes were the bug. So:
 *
 *   - The runtime is loaded by DYNAMIC import inside loadSession(), never at module scope.
 *     Importing this file costs nothing; calling loadSession() is what costs ~21 MB.
 *   - NOTE THE SUBPATH: 'onnxruntime-web/wasm', not 'onnxruntime-web'. The default entry is the
 *     full build, which resolves its binary to the JSEP (WebGPU) variant, a 26.8 MB wasm this
 *     feature has no use for; with it the runtime asks for ort-wasm-simd-threaded.jsep.mjs and
 *     aborts with "no available backend found", which reads like a broken model.
 *   - SERVE THE RUNTIME OURSELVES. With no wasmPaths set onnxruntime-web resolves its binary to a
 *     jsDelivr CDN. No CDNs, anywhere (PLAN.md D8): the web build vendors the WASM under
 *     `<base>/ort/` and passes that path in as `ortWasmPath`.
 *   - The graph is fetched from static/, never bundled, so the browser caches it independently of
 *     the JS.
 *   - Only a VERIFIED session is memoised, and only for a call made of production options — an
 *     allow-list over the option KEYS, not a deny-list of the seams. DM3's deny-list named
 *     url/ort/fetchImpl and left `verifyHash` out, so one `loadSession({ verifyHash: false })`
 *     could poison the memo with a session that was never checked and hand it to every later
 *     production caller with `sha256: null`, which the runner then stamped as the verified hash.
 *   - A failed load is never memoised: a transient fetch error must not disable the feature for
 *     the life of the page.
 *
 * INTEGRITY. The expected sha256 comes from the manifest and is verified after fetch and BEFORE
 * InferenceSession.create; a mismatch is refused, not scored. Verification is skipped only when
 * Web Crypto is unavailable (a non-secure context), and that is REPORTED (`verified: false`)
 * rather than hidden.
 *
 * THREADS. numThreads defaults to 1: multi-threaded ORT needs SharedArrayBuffer, which needs the
 * page to be cross-origin isolated (COOP/COEP headers), which DM3 could not set. This app can
 * (PLAN.md D13), so a caller may ask for more — and the request is honoured only when
 * `globalThis.crossOriginIsolated` is true, because asking for threads without it makes the
 * runtime fall back anyway, and the fallback path is slower than starting single-threaded. The
 * thread count actually used is returned so the UI and the e2e can assert that threads engaged.
 */

import { DEFAULT_INPUT_NAMES, REQUIRED_OUTPUT_NAMES, isSha256Hex, sha256Hex, hashMismatchError } from './manifest.js';

export { runSites, buildFeeds } from './feeds.js';

/** Where the vendored ORT WASM lives when the caller does not say (DM3's default). */
export const DEFAULT_ORT_WASM_PATH = '/ort/';

/**
 * Option keys a PRODUCTION call may carry. Any other key — `ort`, `fetchImpl`, `verifyHash`, or
 * anything added later — marks the call as a seam and bypasses the memo in both directions.
 */
const MEMO_KEYS = new Set(['modelUrl', 'expectedSha256', 'ortWasmPath', 'numThreads', 'expectedInputs']);

/** Memoised session promises, keyed by the production options. Empty until the first load. */
const sessions = new Map();

function cacheKey({ modelUrl, expectedSha256, ortWasmPath, numThreads }) {
	return [modelUrl, expectedSha256, ortWasmPath, numThreads].join('|');
}

/**
 * Threads the runtime will actually be asked for: the request, when the page is cross-origin
 * isolated; otherwise 1.
 * @param {number} requested
 */
export function resolveThreads(requested) {
	const n = Number.isInteger(requested) && requested > 0 ? requested : 1;
	if (n === 1) return 1;
	return globalThis.crossOriginIsolated === true ? n : 1;
}

/**
 * Load the ONNX session, downloading the runtime and the graph on first call.
 *
 * @param {{modelUrl: string, expectedSha256?: string, ortWasmPath?: string, numThreads?: number,
 *   expectedInputs?: readonly string[], verifyHash?: boolean, ort?: any,
 *   fetchImpl?: typeof fetch}} options
 *   `modelUrl` is required; `expectedSha256` is required unless `verifyHash` is explicitly false.
 *   `ort` and `fetchImpl` exist for tests; production passes neither.
 * @returns {Promise<{session: any, ort: any, sha256: string|null, verified: boolean,
 *   bytes: number, numThreads: number, modelUrl: string, outputNames: string[]}>}
 */
export function loadSession(options = {}) {
	const {
		modelUrl,
		expectedSha256,
		ortWasmPath = DEFAULT_ORT_WASM_PATH,
		numThreads = 1,
		expectedInputs = DEFAULT_INPUT_NAMES
	} = options;
	if (typeof modelUrl !== 'string' || !modelUrl) {
		throw new Error('loadSession: modelUrl is required');
	}
	if (options.verifyHash !== false && !isSha256Hex(expectedSha256)) {
		throw new Error(
			'loadSession: expectedSha256 (64 hex chars, from the manifest) is required unless verifyHash is false'
		);
	}
	if (!Number.isInteger(numThreads) || numThreads < 1) {
		throw new Error(`loadSession: numThreads must be a positive integer, got ${JSON.stringify(numThreads)}`);
	}

	const cacheable = Object.keys(options).every((k) => MEMO_KEYS.has(k));
	const key = cacheKey({ modelUrl, expectedSha256, ortWasmPath, numThreads });
	if (cacheable && sessions.has(key)) return sessions.get(key);

	const promise = (async () => {
		const doFetch = options.fetchImpl ?? globalThis.fetch;

		// The dynamic import is the whole point — see the header. Do not hoist it.
		const ort = options.ort ?? (await import('onnxruntime-web/wasm'));

		const threads = resolveThreads(numThreads);
		if (ort.env?.wasm) {
			ort.env.wasm.wasmPaths = ortWasmPath;
			ort.env.wasm.numThreads = threads;
		}

		const response = await doFetch(modelUrl);
		if (!response.ok) {
			throw new Error(`HyphAeon model fetch failed: ${response.status} ${response.statusText} (${modelUrl})`);
		}
		const buffer = await response.arrayBuffer();

		// BEFORE InferenceSession.create: refusing to hand a mismatched graph to the runtime at all
		// is the point, and creating it first would burn seconds of graph optimisation only to reach
		// the same throw.
		const sha256 = options.verifyHash === false ? null : await sha256Hex(buffer);
		if (sha256 && sha256 !== expectedSha256) {
			throw hashMismatchError('HyphAeon model', expectedSha256, sha256);
		}

		const session = await ort.InferenceSession.create(new Uint8Array(buffer));

		// The graph must expose exactly what the manifest says. A rename upstream would otherwise
		// surface as an opaque runtime error deep inside session.run.
		const missing = expectedInputs.filter((n) => !session.inputNames.includes(n));
		if (missing.length) {
			throw new Error(`HyphAeon model is missing expected inputs: ${missing.join(', ')}`);
		}
		const missingOut = REQUIRED_OUTPUT_NAMES.filter((n) => !session.outputNames?.includes(n));
		if (missingOut.length) {
			throw new Error(`HyphAeon model is missing expected outputs: ${missingOut.join(', ')}`);
		}

		return {
			session,
			ort,
			sha256,
			verified: sha256 !== null,
			bytes: buffer.byteLength,
			numThreads: threads,
			modelUrl,
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

/** Drop every memoised session. Tests use this; production has no reason to. */
export function resetSession() {
	sessions.clear();
}

/**
 * True once a session is loaded or loading — lets a caller avoid triggering a 21 MB download, and
 * say "downloading (first run only)" versus "preparing" honestly.
 *
 * With no arguments it reports whether ANY session is memoised; with options it narrows to that
 * cache entry.
 */
export function isSessionLoaded(options) {
	if (!options) return sessions.size > 0;
	const { modelUrl, expectedSha256, ortWasmPath = DEFAULT_ORT_WASM_PATH, numThreads = 1 } = options;
	return sessions.has(cacheKey({ modelUrl, expectedSha256, ortWasmPath, numThreads }));
}
