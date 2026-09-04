/**
 * createSession.js — one call that reads the manifest, picks a variant, and loads the verified
 * backbone (and, on request, the busted head) on whichever runtime this code is running in.
 *
 * WHY THIS FILE EXISTS. The web worker, the MCP server and the job server each need the same
 * four steps before they can score anything: load `models/manifest.json`, pick a variant
 * (PLAN.md D10: `general` by default), resolve `<variant>.onnx` beside the manifest, and hand
 * the path or URL plus the manifest's sha256 to `loadSession`. Three copies of that sequence is
 * three places to get the hash source wrong. This is the one copy; it decides between
 * session-web.js and session-node.js at call time and stamps the handle with what the
 * provenance block needs (`model_version`, `model_variant`, `artifact_sha256`,
 * `reference_version`, the manifest's default seed), so `runMeme` / `runBusted` can fill
 * PLAN.md §3.5's block without a second look at the manifest.
 *
 * THE RUNTIME CHOICE IS A DYNAMIC IMPORT WITH A VARIABLE SPECIFIER. session-node.js statically
 * imports `node:fs/promises` and `node:crypto`; a browser bundler that saw a static import of it
 * would try to resolve those and fail. Holding the specifier in a variable keeps Vite/Rollup from
 * following it, the same trick manifest.js uses for its `node:` reads. Detection: Node when
 * `process.versions.node` exists AND there is no `window`/`self` with an `importScripts`-style
 * worker global — a Vitest run under Node is Node; a browser worker is web. `runtime: 'node' |
 * 'web'` overrides the detection for callers who know.
 *
 * THE LIBRARY VERSION is read under Node from the installed package's package.json (the library
 * exports only `.`, so it cannot be imported; `createRequire` resolves the entry and the
 * package.json sits beside `src/`). The browser build passes it in (`libraryVersion`), because
 * the bundler can inline it at build time and a fetch for it would be a second request nobody
 * needs.
 */

import { DEFAULT_VARIANT, loadManifest, pickVariant, modelLocation } from './manifest.js';

/** Which runtime this process is: 'node' or 'web'. */
export function detectRuntime() {
	const hasNode = typeof process !== 'undefined' && !!process.versions?.node;
	const isBrowserLike = typeof window !== 'undefined' || typeof importScripts === 'function';
	return hasNode && !isBrowserLike ? 'node' : 'web';
}

/** Join a base and a file name without caring about a trailing slash on the base. */
function joinLocation(base, file) {
	const prefix = String(base ?? '').replace(/\/+$/, '');
	return prefix ? `${prefix}/${file}` : file;
}

async function libraryVersionUnderNode() {
	try {
		const moduleName = 'node:module';
		const { createRequire } = await import(/* @vite-ignore */ moduleName);
		const require = createRequire(import.meta.url);
		const entry = require.resolve('@veg/hyphaeon-js');
		const pathName = 'node:path';
		const fsName = 'node:fs/promises';
		const path = await import(/* @vite-ignore */ pathName);
		const fs = await import(/* @vite-ignore */ fsName);
		let dir = path.dirname(entry);
		for (let i = 0; i < 4; i++) {
			try {
				const pkg = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8'));
				if (pkg.name === '@veg/hyphaeon-js') return pkg.version ?? null;
			} catch {
				// keep climbing
			}
			dir = path.dirname(dir);
		}
	} catch {
		// not resolvable (bundled, or a test seam) — reported as null
	}
	return null;
}

/**
 * Load the manifest, pick a variant and load the backbone session; optionally the busted head.
 *
 * @param {{
 *   modelsBase: string,                 directory (Node) or URL prefix (web) holding manifest.json and the graphs
 *   manifest?: object|string|URL,        an already-loaded manifest, or its path/URL; default `<modelsBase>/manifest.json`
 *   variant?: string,                    default 'general'
 *   runtime?: 'node'|'web',              default detected
 *   threads?: number,                    intra-op threads (Node) / numThreads (web, honoured only when crossOriginIsolated)
 *   ortWasmPath?: string,                web only: where the vendored ORT WASM lives
 *   bustedHead?: boolean,                also load busted_head.onnx now (default false; `loadHead()` does it lazily)
 *   libraryVersion?: string|null,        the @veg/hyphaeon-js version to record (web passes it; Node reads it)
 *   sessionModule?: object,              test seam: an object with loadSession / loadBustedHead
 *   loadOptions?: object                 extra options passed through to loadSession (test seams)
 * }} args
 * @returns {Promise<{
 *   runtime: 'node'|'web', manifest: object, variant: ReturnType<typeof pickVariant>,
 *   backbone: object, head: object|null, loadHead: () => Promise<object|null>,
 *   libraryVersion: string|null
 * }>} `backbone` and `head` are loadSession handles, each stamped with `variant`, `modelVersion`,
 *   `referenceVersion`, `defaultSeed` and `libraryVersion` for the provenance block.
 */
export async function createSession(args = {}) {
	const {
		modelsBase,
		variant: variantName = DEFAULT_VARIANT,
		runtime = detectRuntime(),
		threads = 1,
		ortWasmPath,
		bustedHead = false,
		sessionModule,
		loadOptions = {}
	} = args;
	if (typeof modelsBase !== 'string' || !modelsBase) {
		throw new Error('createSession: modelsBase (directory or URL prefix holding manifest.json) is required');
	}
	if (runtime !== 'node' && runtime !== 'web') {
		throw new Error(`createSession: runtime must be 'node' or 'web', got ${JSON.stringify(runtime)}`);
	}

	const manifest = await loadManifest(args.manifest ?? joinLocation(modelsBase, 'manifest.json'));
	const variant = pickVariant(manifest, variantName);
	const libraryVersion =
		args.libraryVersion !== undefined
			? args.libraryVersion
			: runtime === 'node'
				? await libraryVersionUnderNode()
				: null;

	// The specifier MUST stay in a variable (see the header): a literal './session-node.js' is
	// followed by Rollup despite the @vite-ignore comment, and its node: imports break every
	// browser bundle that imports the runtime's main entry (measured in Phase 1b: "createHash is
	// not exported by __vite-browser-external" in the analysis workers).
	const sessionSpecifier = runtime === 'node' ? './session-node.js' : './session-web.js';
	const mod = sessionModule ?? (await import(/* @vite-ignore */ sessionSpecifier));

	const stamp = (handle, sha) => {
		handle.variant = variant.name;
		handle.modelVersion = manifest.model_version;
		handle.referenceVersion = manifest.reference_version ?? null;
		handle.defaultSeed = manifest.prng?.default_seed ?? null;
		handle.libraryVersion = libraryVersion;
		handle.expectedSha256 = sha;
		// The head's export seed, if the manifest ever records it (export.py BUSTED_HEAD_INIT_SEED);
		// absent from the phase-1a manifest, so null there. runBusted reports it under
		// provenance.neural_head.export_seed.
		handle.exportSeed =
			variant.raw.busted_head_export_seed ??
			variant.raw.busted_head_init_seed ??
			manifest.busted_head_export_seed ??
			null;
		return handle;
	};

	const locate = (file) => joinLocation(modelsBase, file);
	const backboneLocation = modelLocation(modelsBase, manifest, variant.name);
	const backbone = stamp(
		await (runtime === 'node'
			? mod.loadSession({ modelPath: backboneLocation, expectedSha256: variant.onnxSha256, threads, ...loadOptions })
			: mod.loadSession({
					modelUrl: backboneLocation,
					expectedSha256: variant.onnxSha256,
					numThreads: threads,
					...(ortWasmPath ? { ortWasmPath } : {}),
					...loadOptions
				})),
		variant.onnxSha256
	);

	let head = null;
	const loadHead = async () => {
		if (head) return head;
		if (!variant.bustedHeadFile || !variant.bustedHeadSha256) return null;
		const location = locate(variant.bustedHeadFile);
		head = stamp(
			await (runtime === 'node'
				? mod.loadBustedHead({ modelPath: location, expectedSha256: variant.bustedHeadSha256, threads, ...loadOptions })
				: mod.loadBustedHead({
						modelUrl: location,
						expectedSha256: variant.bustedHeadSha256,
						numThreads: threads,
						...(ortWasmPath ? { ortWasmPath } : {}),
						...loadOptions
					})),
			variant.bustedHeadSha256
		);
		return head;
	};
	if (bustedHead) await loadHead();

	return {
		runtime,
		manifest,
		variant,
		backbone,
		get head() {
			return head;
		},
		loadHead,
		libraryVersion
	};
}
