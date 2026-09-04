/**
 * hyphy/index.js - HyPhy compiled to WebAssembly, driven the way axomeme3 and DataMonkey 3 drive
 * it, in a browser worker and under Node.
 *
 * WHY THIS FILE EXISTS. Three of the app's tree tools are HyPhy batch scripts, not JavaScript
 * (PLAN.md D5, D6, section 4.2): HKY85 branch-length estimation for a topology-only tree, an NJ
 * tree when there is none, and a format-conversion fallback for alignments the FASTA parser
 * rejects. axomeme3/index.html:3176-3290 runs the first and third by writing an HBL script and the
 * data into the Emscripten file system and calling `callMain(['ENV=NORMALIZE_SEQUENCE_NAMES=0;',
 * '/script.bf'])` on a fresh module per run; DataMonkey 3 runs NJ.bf through @biowasm/aioli
 * (+page.svelte:580-600, :929-945). This module is those two drivers merged, with the scripts in
 * ./hbl and the binary vendored in runtime/vendor/hyphy/<version>/ (copied by
 * scripts/copy-assets.mjs to web/static/wasm/hyphy/ for the browser).
 *
 * THE BINARY (see vendor/hyphy/PROVENANCE.md). DataMonkey 3's build of HyPhy 2.5.98, Emscripten
 * `-sMODULARIZE=1 -sENVIRONMENT=web,worker -sASSERTIONS=1 -sINVOKE_RUN=0 -sEXIT_RUNTIME=0
 * -sFORCE_FILESYSTEM=1 --preload-file res@/res` (hyphy/build-wasm/CMakeCache.txt). Three
 * consequences shape this file:
 *
 *   1. hyphy.js is a classic script, not an ES module: it declares a global `Module` factory and
 *      assigns `module.exports` only when a CommonJS `module` is in scope. A classic worker gets
 *      it with importScripts(); a module worker or the main thread cannot import() it (no
 *      `export`), so there the source text is fetched and evaluated with `new Function` (needs
 *      'unsafe-eval' in the CSP, which DataMonkey's _headers, copied by copy-assets, already
 *      grant for the same reason). `glueStrategy` picks; 'auto' uses importScripts when it exists.
 *
 *   2. ENVIRONMENT=web,worker means the glue refuses Node three times: a version-check IIFE
 *      throws "not compiled for this environment" when a bare `process.versions.node` exists,
 *      `assert(!ENVIRONMENT_IS_NODE)` fires on `globalThis.process`, and the worker branch throws
 *      unless `globalThis.window || globalThis.WorkerGlobalScope`. None of that is load-bearing:
 *      with `wasmBinary`/`instantiateWasm` and `getPreloadedPackage` supplied, the glue never
 *      touches fetch, XMLHttpRequest or the file system. So under Node the source is evaluated
 *      with `new Function('globalThis', 'self', 'process', 'window', 'navigator', ...)` and handed
 *      an `Object.create(globalThis, {process: undefined, window: undefined, WorkerGlobalScope: fn})`
 *      as its `globalThis`, `{location: {href}}` as `self`, and `undefined` for the rest. The glue
 *      then believes it is in a worker. Verified on Node 22.22 x64 (this machine, Rosetta) and
 *      23.11: `--version` prints "HYPHY 2.5.98(MP) for Emscripten on wasm32", HKY85 on
 *      examples/camelid (212 taxa) takes ~2.8 s, NJ on bat_oas1 43 ms. The exact incantation is
 *      `evaluateGlue()` below.
 *
 *   3. The C++ side calls a bare `postMessage({type: 'biowasm', value: {text, type:
 *      'print'|'update'}})` (hyphy src/utils/hyphyunixutils.cpp:182-188, src/mains/unix.cpp:726)
 *      for every status line, the channel @biowasm/aioli reads. In a real worker that message goes
 *      to the worker's owner, who did not ask for it; under Node there is no postMessage at all
 *      (ReferenceError mid-run, measured). Both paths therefore intercept it: the eval path passes
 *      a `postMessage` sink as a shadowing parameter, the importScripts path shadows
 *      `self.postMessage` with an own property for the duration of a run and forwards anything
 *      that is not a biowasm message. The text becomes the `progress` callback's message.
 *
 * ONE MODULE INSTANCE PER RUN, as axomeme3 does. A second callMain on the same instance works
 * (measured) but HBL globals, the working directory and errors.log would carry over; a fresh
 * instance costs ~120 ms when the WebAssembly.Module is compiled once and reused through
 * `instantiateWasm` and the 4.9 MB data package is handed over through `getPreloadedPackage`
 * (copied per instance, because MEMFS keeps the buffer it is given and could write into it).
 * `callMain` is synchronous and blocks the thread for the whole optimisation: call this from a
 * worker in the browser; under Node it blocks the event loop (worker_threads if that matters).
 *
 * ERRORS. HyPhy prints HBL errors to stdout ("Error:\n<text>\nFunction call stack..."), writes
 * "Check errors.log" to stderr and returns exit status 1 from main (measured on a missing data
 * file, a syntax error and a tree/filter tip-count mismatch). `run()` turns a non-zero status
 * into a HyPhyError carrying the exit code, stdout and stderr; the message is the first "Error:"
 * block when there is one.
 *
 * WHAT THIS FILE DOES NOT DO: parse or sanitise the trees it returns. NJ.bf can emit negative
 * lengths and the 1000 saturation sentinel (runtime/src/treeSanitation.js documents both and
 * `inspectBranchLengths` is the check); HKY85 can return branches of exactly 0 (73 of 421 on
 * camelid, identically under native HyPhy 2.5.65). The library's loadAlignmentAndTree applies the
 * reference's enforce_nonzero_branch_lengths afterwards. Callers decide; this module reports.
 */

import { CONVERT_BF, HKY85_BF, NJ_BF, NJ_DRIVER_BF } from './hbl.js';

/** The vendored build. Directory name under runtime/vendor/hyphy/ and web/static/wasm/hyphy/. */
export const HYPHY_WASM_VERSION = '2.5.98';

/** The three files of an Emscripten build with a preloaded data package. */
export const HYPHY_ASSETS = Object.freeze(['hyphy.js', 'hyphy.wasm', 'hyphy.data']);

/** What `--version` printed on this build; tests pin it, callers get it from `version()`. */
export const HYPHY_VERSION_STRING = 'HYPHY 2.5.98(MP) for Emscripten on wasm32';

/**
 * Arguments before the script path on every run. `LIBPATH=/res/` is where the preloaded
 * TemplateBatchFiles live (DataMonkey 3 passes it; the build's default resolves there too, as
 * the "Path stack: /res/" in HyPhy's own error output shows). `ENV=NORMALIZE_SEQUENCE_NAMES=0;`
 * is axomeme3's: keep sequence names exactly as uploaded so they still match the tree.
 */
export const HYPHY_BASE_ARGS = Object.freeze(['LIBPATH=/res/', 'ENV=NORMALIZE_SEQUENCE_NAMES=0;']);

/** Where the scripts put their inputs and outputs (the paths named in hbl/*.bf). */
const PATHS = Object.freeze({
	alignment: '/temp_align.fa',
	script: '/script.bf',
	tree: '/output.nwk',
	nj: '/NJ.bf',
	convertedFasta: '/output_align.fa'
});

const IS_NODE =
	typeof process !== 'undefined' &&
	!!process.versions?.node &&
	typeof importScripts === 'undefined' &&
	typeof window === 'undefined';

/** A HyPhy run that exited non-zero, with everything it printed. */
export class HyPhyError extends Error {
	/**
	 * @param {string} message
	 * @param {{exitCode: number, stdout: string, stderr: string, script?: string}} details
	 */
	constructor(message, { exitCode, stdout, stderr, script }) {
		super(message);
		this.name = 'HyPhyError';
		this.exitCode = exitCode;
		this.stdout = stdout;
		this.stderr = stderr;
		this.script = script;
	}
}

/**
 * The message to raise for a failed run: HyPhy's own "Error:" block from stdout when present
 * (it ends at the "-------" rule or at the end of the text), else the last non-empty line of
 * either stream, else the status.
 * @param {string} stdout
 * @param {string} stderr
 * @param {number} exitCode
 */
export function hyphyErrorMessage(stdout, stderr, exitCode) {
	const at = stdout.indexOf('Error:');
	if (at !== -1) {
		const block = stdout.slice(at);
		const end = block.indexOf('\n-------');
		const text = (end === -1 ? block : block.slice(0, end)).trim();
		return `HyPhy: ${text.replace(/^Error:\s*/, '')}`;
	}
	const lines = `${stdout}\n${stderr}`
		.split('\n')
		.map((l) => l.trim())
		.filter((l) => l && !l.startsWith('Check errors.log') && !l.startsWith('program exited'));
	return lines.length
		? `HyPhy exited with status ${exitCode}: ${lines[lines.length - 1]}`
		: `HyPhy exited with status ${exitCode}`;
}

// Glue evaluation ------------------------------------------------------------------------------

/**
 * Evaluate hyphy.js's source and return its `Module` factory, without letting it see the
 * identifiers that make it refuse Node or post to a worker's owner. The parameter list is the
 * whole point: every name the glue reads bare is a parameter, so what the caller passes is what
 * the glue sees, and `globalThis` itself is one of them (it is not a reserved word).
 *
 * @param {string} source            text of hyphy.js
 * @param {object} env
 * @param {(msg: unknown) => void} env.postMessage   receives the biowasm status messages
 * @param {boolean} env.hideNode     true under Node: present a fake worker environment
 * @param {string} [env.scriptUrl]   what `self.location.href` should be under Node (messages only)
 * @returns {(moduleArg?: object) => Promise<any>}
 */
export function evaluateGlue(source, { postMessage, hideNode, scriptUrl }) {
	const g = /** @type {any} */ (globalThis);
	const fakeGlobal = hideNode
		? Object.create(globalThis, {
				process: { value: undefined },
				window: { value: undefined },
				WorkerGlobalScope: { value: function WorkerGlobalScope() {} }
			})
		: globalThis;
	const selfValue = hideNode
		? { location: { href: scriptUrl ?? 'file:///hyphy.js' } }
		: typeof self !== 'undefined'
			? self
			: undefined;
	const pick = (name) => (hideNode ? undefined : g[name]);
	const factory = new Function(
		'globalThis',
		'self',
		'process',
		'window',
		'navigator',
		'document',
		'location',
		'module',
		'exports',
		'define',
		'importScripts',
		'postMessage',
		`${source}\n;return Module;`
	)(
		fakeGlobal,
		selfValue,
		undefined,
		pick('window'),
		pick('navigator'),
		pick('document'),
		pick('location'),
		undefined,
		undefined,
		undefined,
		undefined,
		postMessage
	);
	if (typeof factory !== 'function') {
		throw new Error('hyphy.js did not define a Module factory; is this the MODULARIZE build?');
	}
	return factory;
}

// Asset loading --------------------------------------------------------------------------------

/**
 * Is this a classic worker, where importScripts() actually works? A module worker (Vite's dev
 * server, `new Worker(url, {type: 'module'})`) still DEFINES importScripts, so `typeof` says
 * "function" there too; calling it throws "Module scripts don't support importScripts()". The
 * HTML spec makes that check before it looks at the argument list, and an empty list is a no-op
 * in a classic worker, so a call with no URLs is a side-effect-free probe.
 */
function canImportScripts() {
	if (typeof importScripts !== 'function') return false;
	try {
		importScripts();
		return true;
	} catch {
		return false;
	}
}

/**
 * Default locations: the vendored directory under Node; in a browser the caller must say
 * (there is no sensible default for a URL under `paths.base`).
 * @param {string} name
 * @returns {string}
 */
function defaultLocateFile(name) {
	if (!IS_NODE) {
		throw new Error(
			`createHyPhy: locateFile is required in a browser (where is ${name} served from?)`
		);
	}
	return new URL(`../../vendor/hyphy/${HYPHY_WASM_VERSION}/${name}`, import.meta.url).href;
}

/**
 * Load the three assets once. Under Node from the file system; in a browser with fetch (the
 * glue text only when it will be evaluated). The WebAssembly.Module is compiled here, once, and
 * every instance is built from it.
 */
async function loadAssets({ locateFile, glueStrategy, progress }) {
	const urls = Object.fromEntries(HYPHY_ASSETS.map((n) => [n, String(locateFile(n))]));
	const report = (done, message) => progress?.('load', done, HYPHY_ASSETS.length, message);

	let readText, readBytes;
	if (IS_NODE) {
		const fsName = 'node:fs/promises';
		const { readFile } = await import(/* @vite-ignore */ fsName);
		const urlName = 'node:url';
		const { fileURLToPath } = await import(/* @vite-ignore */ urlName);
		const toPath = (u) => (u.startsWith('file:') ? fileURLToPath(u) : u);
		readText = (u) => readFile(toPath(u), 'utf8');
		readBytes = async (u) => {
			const b = await readFile(toPath(u));
			return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
		};
	} else {
		const get = async (u) => {
			const r = await fetch(u, { credentials: 'same-origin' });
			if (!r.ok) throw new Error(`createHyPhy: ${u} -> HTTP ${r.status}`);
			return r;
		};
		readText = async (u) => (await get(u)).text();
		readBytes = async (u) => (await get(u)).arrayBuffer();
	}

	const useImportScripts =
		glueStrategy === 'importScripts' || (glueStrategy === 'auto' && canImportScripts());
	if (useImportScripts && !canImportScripts()) {
		throw new Error("createHyPhy: glueStrategy 'importScripts' outside a classic worker");
	}

	report(0, 'loading HyPhy');
	const glueText = useImportScripts ? null : await readText(urls['hyphy.js']);
	report(1, 'compiling hyphy.wasm');
	const wasmBytes = await readBytes(urls['hyphy.wasm']);
	const compiled = await WebAssembly.compile(wasmBytes);
	report(2, 'loading hyphy.data');
	const data = await readBytes(urls['hyphy.data']);
	report(3, 'HyPhy ready');

	return {
		urls,
		glueText,
		useImportScripts,
		compiled,
		data,
		bytes: { wasm: wasmBytes.byteLength, data: data.byteLength, glue: glueText?.length ?? null }
	};
}

// The handle -----------------------------------------------------------------------------------

/**
 * Load HyPhy WASM once and return the tree tools. Everything heavy (the fetches, the compile) is
 * awaited here so the first run pays only the instantiation.
 *
 * @param {object} [options]
 * @param {(name: string) => string|URL} [options.locateFile]
 *        maps 'hyphy.js' | 'hyphy.wasm' | 'hyphy.data' to where it is served from. Required in a
 *        browser; defaults to runtime/vendor/hyphy/<version>/ under Node.
 * @param {'auto'|'importScripts'|'eval'} [options.glueStrategy='auto']
 *        how hyphy.js is loaded in a browser: importScripts() in a classic worker (no eval needed),
 *        or fetch + `new Function` (module workers, main thread; needs 'unsafe-eval'). Node always
 *        evaluates. 'auto' uses importScripts when it exists.
 * @param {(phase: string, done: number, total: number, message: string) => void} [options.progress]
 *        the pipeline's progress signature, phases 'load' (per asset) and, per run, 'run'/'done'.
 * @returns {Promise<HyPhy>}
 */
export async function createHyPhy(options = {}) {
	const locateFile = options.locateFile ?? defaultLocateFile;
	const glueStrategy = options.glueStrategy ?? 'auto';
	const assets = await loadAssets({ locateFile, glueStrategy, progress: options.progress });

	/** The status sink the glue posts to; `run()` points it at the current run. */
	let statusSink = /** @type {(value: {text: string, type: string}) => void} */ (() => {});
	const onPost = (msg) => {
		if (msg && typeof msg === 'object' && msg.type === 'biowasm') statusSink(msg.value);
		else if (!IS_NODE && typeof self !== 'undefined' && !assets.useImportScripts) {
			// Not ours and we shadowed the real one: forward it.
			self.postMessage(msg);
		}
	};

	let factory;
	if (assets.useImportScripts) {
		importScripts(assets.urls['hyphy.js']);
		factory = /** @type {any} */ (globalThis).Module;
		if (typeof factory !== 'function') {
			throw new Error('importScripts(hyphy.js) did not define a global Module factory');
		}
	} else {
		factory = evaluateGlue(assets.glueText, {
			postMessage: onPost,
			hideNode: IS_NODE,
			scriptUrl: assets.urls['hyphy.js']
		});
	}

	/** A fresh Emscripten module: own memory, own MEMFS with /res unpacked, nothing run yet. */
	async function instantiate(io) {
		let failInstantiate;
		const failed = new Promise((_, reject) => {
			failInstantiate = reject;
		});
		const created = factory({
			locateFile: (path) => assets.urls[path] ?? path,
			instantiateWasm: (imports, done) => {
				WebAssembly.instantiate(assets.compiled, imports)
					.then((instance) => done(instance, assets.compiled))
					.catch(failInstantiate);
				return {};
			},
			getPreloadedPackage: () => assets.data.slice(0),
			print: io.print,
			printErr: io.printErr,
			noInitialRun: true
		});
		return Promise.race([created, failed]);
	}

	/**
	 * Run one HBL script in a fresh instance.
	 * @param {object} job
	 * @param {string} job.script            HBL text, written to /script.bf
	 * @param {Record<string, string|Uint8Array>} [job.files]  path -> content to write first
	 * @param {string[]} [job.outputs]       paths to read back after a successful run
	 * @param {string[]} [job.args]          full argv (default HYPHY_BASE_ARGS + '/script.bf')
	 * @param {(phase: string, done: number, total: number, message: string) => void} [job.progress]
	 * @returns {Promise<{outputs: Record<string, string>, stdout: string, stderr: string,
	 *   status: string[], exitCode: number, elapsedMs: number, instantiateMs: number}>}
	 */
	async function run({ script, files = {}, outputs = [], args, progress }) {
		const t0 = now();
		const out = [];
		const err = [];
		const status = [];
		const report = (phase, message) => progress?.(phase, 0, 0, message);

		report('run', 'starting HyPhy');
		const M = await instantiate({ print: (t) => out.push(t), printErr: (t) => err.push(t) });
		const instantiateMs = now() - t0;

		for (const [path, content] of Object.entries(files)) M.FS.writeFile(path, content);
		M.FS.writeFile(PATHS.script, script);

		statusSink = ({ text, type }) => {
			const line = String(text).trim();
			if (!line) return;
			status.push(line);
			report('run', type === 'update' ? line : line.split('\n')[0]);
		};
		const restorePost = assets.useImportScripts ? shadowWorkerPostMessage(onPost) : () => {};

		let exitCode;
		try {
			exitCode = M.callMain(args ?? [...HYPHY_BASE_ARGS, PATHS.script]);
		} finally {
			restorePost();
			statusSink = () => {};
		}

		const stdout = out.join('\n');
		const stderr = err.join('\n');
		if (exitCode !== 0) {
			throw new HyPhyError(hyphyErrorMessage(stdout, stderr, exitCode), {
				exitCode,
				stdout,
				stderr,
				script
			});
		}
		const read = {};
		for (const path of outputs) {
			try {
				read[path] = M.FS.readFile(path, { encoding: 'utf8' });
			} catch (e) {
				throw new HyPhyError(`HyPhy finished but did not write ${path}: ${e?.message ?? e}`, {
					exitCode,
					stdout,
					stderr,
					script
				});
			}
		}
		const elapsedMs = now() - t0;
		report('done', `HyPhy finished in ${(elapsedMs / 1000).toFixed(1)} s`);
		return { outputs: read, stdout, stderr, status, exitCode, elapsedMs, instantiateMs };
	}

	let versionCache = null;

	/** @type {HyPhy} */
	const api = {
		version: HYPHY_WASM_VERSION,
		assets: { urls: assets.urls, bytes: assets.bytes, glueStrategy: assets.useImportScripts ? 'importScripts' : 'eval' },

		/** What the binary says of itself (`hyphy --version`), cached after the first call. */
		async hyphyVersion(progress) {
			if (versionCache) return { ...versionCache };
			const r = await run({ script: '', args: ['--version'], progress });
			const result = r.stdout.trim().split('\n').find((l) => l.startsWith('HYPHY')) ?? r.stdout.trim();
			versionCache = { result, stderr: r.stderr, elapsedMs: r.elapsedMs };
			return { ...versionCache };
		},

		/**
		 * HKY85 branch lengths for a fixed topology (axomeme3). `newick` may carry lengths; they
		 * are starting values. Returns HyPhy's Format(T, 1, 1): unrooted, internal nodes named
		 * NodeN, a ';' appended (HyPhy omits it).
		 * @param {string} alignmentFasta
		 * @param {string} newick
		 * @param {object} [opts]
		 * @param {(phase: string, done: number, total: number, message: string) => void} [opts.progress]
		 * @returns {Promise<{result: string, stderr: string, stdout: string, elapsedMs: number}>}
		 */
		async estimateBranchLengths(alignmentFasta, newick, { progress } = {}) {
			const cleanTreeStr = String(newick).trim().replace(/;$/, '');
			if (!cleanTreeStr) throw new Error('estimateBranchLengths: empty tree');
			if (cleanTreeStr.includes('"')) {
				throw new Error(
					'estimateBranchLengths: the tree contains a double quote, which cannot be embedded in the HBL string literal'
				);
			}
			const script = HKY85_BF.replaceAll('${cleanTreeStr}', cleanTreeStr);
			const r = await run({
				script,
				files: { [PATHS.alignment]: alignmentFasta },
				outputs: [PATHS.tree],
				progress
			});
			return {
				result: terminated(r.outputs[PATHS.tree]),
				stderr: r.stderr,
				stdout: r.stdout,
				elapsedMs: r.elapsedMs
			};
		},

		/**
		 * Neighbour joining on TN93 distances (DataMonkey 3's NJ.bf). Unrooted, with lengths, a ';'
		 * appended. Inspect with treeSanitation.inspectBranchLengths before use.
		 * @param {string} alignmentFasta
		 * @param {object} [opts]
		 * @param {(phase: string, done: number, total: number, message: string) => void} [opts.progress]
		 * @returns {Promise<{result: string, stderr: string, stdout: string, elapsedMs: number}>}
		 */
		async njTree(alignmentFasta, { progress } = {}) {
			const r = await run({
				script: NJ_DRIVER_BF,
				files: { [PATHS.nj]: NJ_BF, [PATHS.alignment]: alignmentFasta },
				outputs: [PATHS.tree],
				progress
			});
			return {
				result: terminated(r.outputs[PATHS.tree]),
				stderr: r.stderr,
				stdout: r.stdout,
				elapsedMs: r.elapsedMs
			};
		},

		/**
		 * Any alignment format HyPhy reads (NEXUS, PHYLIP, MEGA, CLUSTAL, ...) to sequential FASTA
		 * (axomeme3's fallback). The extension of `fileName` names the input in the virtual FS;
		 * "phy" when absent.
		 * @param {string} text
		 * @param {object} [opts]
		 * @param {string} [opts.fileName]
		 * @param {(phase: string, done: number, total: number, message: string) => void} [opts.progress]
		 * @returns {Promise<{result: string, stderr: string, stdout: string, elapsedMs: number}>}
		 */
		async convertAlignment(text, { fileName, progress } = {}) {
			let extension = 'phy';
			if (fileName) {
				const parts = String(fileName).split('.');
				if (parts.length > 1) extension = parts[parts.length - 1].toLowerCase();
			}
			const inputPath = `/input_align.${extension.replace(/[^a-z0-9]/g, '') || 'phy'}`;
			const script = CONVERT_BF.replaceAll('${inputPath}', inputPath);
			const r = await run({
				script,
				files: { [inputPath]: text },
				outputs: [PATHS.convertedFasta],
				progress
			});
			return {
				result: r.outputs[PATHS.convertedFasta],
				stderr: r.stderr,
				stdout: r.stdout,
				elapsedMs: r.elapsedMs
			};
		},

		run
	};
	return api;
}

/**
 * @typedef {object} HyPhy
 * @property {string} version
 * @property {{urls: Record<string, string>, bytes: {wasm: number, data: number, glue: number|null}, glueStrategy: 'importScripts'|'eval'}} assets
 * @property {(progress?: Function) => Promise<{result: string, stderr: string, elapsedMs: number}>} hyphyVersion
 * @property {(alignmentFasta: string, newick: string, opts?: {progress?: Function}) => Promise<{result: string, stderr: string, stdout: string, elapsedMs: number}>} estimateBranchLengths
 * @property {(alignmentFasta: string, opts?: {progress?: Function}) => Promise<{result: string, stderr: string, stdout: string, elapsedMs: number}>} njTree
 * @property {(text: string, opts?: {fileName?: string, progress?: Function}) => Promise<{result: string, stderr: string, stdout: string, elapsedMs: number}>} convertAlignment
 * @property {(job: {script: string, files?: Record<string, string|Uint8Array>, outputs?: string[], args?: string[], progress?: Function}) => Promise<{outputs: Record<string, string>, stdout: string, stderr: string, status: string[], exitCode: number, elapsedMs: number, instantiateMs: number}>} run
 */

// Helpers --------------------------------------------------------------------------------------

const now = () =>
	typeof performance !== 'undefined' && typeof performance.now === 'function'
		? performance.now()
		: Date.now();

/** HyPhy's Format() and TreeMatrix2TreeString omit the newick terminator; add it once. */
function terminated(newick) {
	const t = String(newick).trim();
	return t.endsWith(';') ? t : `${t};`;
}

/**
 * In a classic worker the glue calls the real `postMessage`; give it ours for the duration of
 * a run by shadowing the prototype method with an own property, and remove it afterwards.
 * @param {(msg: unknown) => void} sink
 * @returns {() => void} restore
 */
function shadowWorkerPostMessage(sink) {
	if (typeof self === 'undefined') return () => {};
	const scope = /** @type {any} */ (self);
	const original = scope.postMessage;
	const hadOwn = Object.prototype.hasOwnProperty.call(scope, 'postMessage');
	scope.postMessage = (msg, ...rest) => {
		if (msg && typeof msg === 'object' && msg.type === 'biowasm') sink(msg);
		else original.call(scope, msg, ...rest);
	};
	return () => {
		if (hadOwn) scope.postMessage = original;
		else delete scope.postMessage;
	};
}
