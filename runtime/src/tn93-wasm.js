/**
 * WHY THIS FILE EXISTS
 *
 * The tree-free path (PLAN.md D22) needs pairwise TN93 distances. `@veg/hyphaeon-js` computes them
 * in pure JavaScript, mirroring the `tn93` PyPI package the reference falls back to; this file runs
 * veg/tn93's own compiled code instead, through the WebAssembly build published as a release asset
 * from v1.0.17 onwards. It exists because the distances the product ships should come from the
 * lab's own tool rather than from a second implementation of it — the same reason the reference
 * prefers the binary whenever `shutil.which("tn93")` finds one (dataset.py:505-537).
 *
 * WHAT THIS FILE OWNS, AND WHAT IT DOES NOT. It owns everything the library must not: locating and
 * verifying bytes, instantiating a module, a virtual filesystem, an argv. It returns nothing but
 * RAW pairwise distances. The sentinel, the float32 rounding and dataset.py's imputation stay in
 * `tn93DistanceMatrix`, which takes these numbers through its `pairwiseDistances` hook, so the two
 * engines cannot drift in how a distance is USED — only in what it is.
 *
 * THE ARGV is the reference's own: `-t 1.0 -l 1 -q -o <csv> <fasta>` (dataset.py:507-537) — a 1.0
 * threshold, a one-nucleotide minimum overlap, quiet, CSV out with the binary's default `-a resolve`
 * ambiguity handling, which is the mode the library reproduces.
 *
 * SATURATION IS A REFUSAL, NOT A NUMBER, AND THAT IS WHY THIS FILE RAISES. At threshold 1.0 the
 * tool does not WRITE a pair whose distance reaches it. dataset.py leaves those entries at 0.0 and
 * its imputation then rewrites a 0.0 between two DISTINCT sequences to 1e-4 (dataset.py:559-568) —
 * so the most distant pair in an alignment would enter the MDS as the closest, silently. The
 * package branch, which every fixture and the whole parity surface are built from (fixtures are
 * generated with the binary forced off PATH), instead RAISES on such a pair: `math.log` of a
 * non-positive number, which the library reproduces as `tn93: ValueError: ...`, `prepareRun`
 * catches by that prefix, and the surfaces report as TN93_UNCOMPUTABLE — a refusal telling the
 * reader their alignment is saturated. This file keeps that behaviour: a pair the tool declined to
 * write raises the same prefixed error, so the two engines refuse the same alignments rather than
 * one of them scoring a matrix of garbage. Measured on the five bundled examples: no pair reaches
 * the threshold, so no example is affected.
 *
 * IDENTITY, MEASURED (2026-09-07, tn93 v1.0.17 wasm vs the library's JavaScript, all five bundled
 * examples through `prepareRun`): every matrix entry identical after float32 rounding. Against the
 * native tn93 1.0.15 binary: identical rows and values, differing only in row order, which the
 * binary's threading makes arbitrary and this single-threaded build makes deterministic.
 *
 * SEQUENCE NAMES ARE NOT SENT. The FASTA handed to the module names its records s0..s(n-1) in taxa
 * order, and the CSV is mapped back by index. A taxon name carrying a comma or a quote would
 * otherwise corrupt the CSV the tool writes, and duplicate names would silently collide.
 *
 * LOADING. Node reads `runtime/vendor/tn93/` directly. The browser is handed URLs by the caller
 * (web/scripts/copy-assets.mjs copies the same two files under `static/tn93/` and writes an ES
 * module wrapper around the CommonJS glue). Both verify the sha256 in `vendor/tn93/MANIFEST.json`
 * before the module is created, and a failed verification is never memoised — the model sessions'
 * rule, for the same reason. The glue contains no `eval` and no `new Function`, so a page needs
 * 'wasm-unsafe-eval' in script-src and nothing wider.
 */

import { tn93DistanceMatrix } from '@veg/hyphaeon-js';

import { sha256Hex } from './manifest.js';

/** The reference's own argv for the compiled tool (dataset.py:507-537). */
export const TN93_ARGV = Object.freeze(['-t', '1.0', '-l', '1', '-q']);

/** One instantiated module per resolved source; a failed load is never kept. */
const modules = new Map();

/**
 * Read the vendored manifest and the two files under Node.
 *
 * @param {string} [dir] vendor directory; defaults to `runtime/vendor/tn93` beside this file
 */
async function nodeSources(dir) {
	const fsSpecifier = 'node:fs/promises';
	const urlSpecifier = 'node:url';
	const pathSpecifier = 'node:path';
	const [fs, { fileURLToPath }, path] = await Promise.all([
		import(/* @vite-ignore */ fsSpecifier),
		import(/* @vite-ignore */ urlSpecifier),
		import(/* @vite-ignore */ pathSpecifier)
	]);
	const base = dir ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'vendor', 'tn93');
	const manifest = JSON.parse(await fs.readFile(path.join(base, 'MANIFEST.json'), 'utf8'));
	return {
		manifest,
		dir: base,
		glueUrl: path.join(base, 'tn93.cjs'),
		wasmUrl: path.join(base, 'tn93.wasm'),
		readBytes: async (p) => new Uint8Array(await fs.readFile(p))
	};
}

/**
 * Instantiate the tn93 module, verifying both files against the vendored manifest first.
 *
 * @param {object} [args]
 * @param {string} [args.vendorDir] Node: the directory holding tn93.cjs, tn93.wasm and MANIFEST.json
 * @param {string} [args.glueUrl] browser: URL of the ES module wrapper around the glue
 * @param {string} [args.wasmUrl] browser: URL of tn93.wasm
 * @param {object} [args.manifest] browser: MANIFEST.json already parsed (else give manifestUrl)
 * @param {string} [args.manifestUrl] browser: where to fetch MANIFEST.json from; strings only, so the
 *   whole options object can be structured-cloned into a worker and stored with the record
 * @param {boolean} [args.verifyHash] set false only in a test that means to skip verification
 * @returns {Promise<object>} the Emscripten module, with FS and callMain
 */
export async function loadTn93Wasm(args = {}) {
	const key = args.vendorDir ?? args.glueUrl ?? 'default';
	const memo = modules.get(key);
	if (memo) return memo;

	const promise = (async () => {
		const isNode = typeof process !== 'undefined' && process.versions?.node && !args.glueUrl;
		const src = isNode
			? await nodeSources(args.vendorDir)
			: {
					// Everything a browser caller passes must survive structuredClone — these options
					// travel to a worker inside the run's `options` and are stored with the record —
					// so the manifest is named by URL and fetched HERE, not handed over as an object
					// or a promise. (A promise in that payload fails as "could not be cloned", which
					// is how this was found.)
					manifest: args.manifest ?? (args.manifestUrl ? await (await fetch(args.manifestUrl)).json() : null),
					glueUrl: args.glueUrl,
					wasmUrl: args.wasmUrl,
					readBytes: async (u) => new Uint8Array(await (await fetch(u)).arrayBuffer())
				};
		if (!src.glueUrl || !src.wasmUrl) {
			throw new Error('loadTn93Wasm: glueUrl and wasmUrl are required outside Node');
		}

		const wasmBytes = await src.readBytes(src.wasmUrl);
		if (args.verifyHash !== false) {
			const expected = src.manifest?.files?.['tn93.wasm']?.sha256;
			if (!expected) throw new Error('loadTn93Wasm: MANIFEST.json names no sha256 for tn93.wasm');
			const got = await sha256Hex(wasmBytes);
			if (got !== expected) {
				throw new Error(
					`tn93 WebAssembly integrity check failed: expected sha256 ${expected}, got ${got}. ` +
						'Re-vendor from the release named in vendor/tn93/MANIFEST.json.'
				);
			}
		}

		const factory = isNode
			? (await import(/* @vite-ignore */ 'node:module')).createRequire(import.meta.url)(src.glueUrl)
			: (await import(/* @vite-ignore */ src.glueUrl)).default;

		return await factory({
			noInitialRun: true,
			print: () => {},
			printErr: () => {},
			// The glue would otherwise resolve tn93.wasm beside the SCRIPT, which under Vite is a
			// hashed bundle path; hand it the verified bytes we already read.
			instantiateWasm: (imports, done) =>
				WebAssembly.instantiate(wasmBytes, imports).then((out) => done(out.instance, out.module))
		});
	})();

	modules.set(key, promise);
	try {
		return await promise;
	} catch (err) {
		modules.delete(key);
		throw err;
	}
}

/** Forget every instantiated module (tests, and a surface that wants the memory back). */
export function resetTn93Wasm() {
	modules.clear();
}

/**
 * A `pairwiseDistances` provider for the library's `tn93DistanceMatrix`: raw distances only.
 *
 * @param {object} module the module from `loadTn93Wasm`
 * @returns {(seqs: string[], taxa: string[]) => Float64Array} n*n raw distances, read at [i*n + j]
 */
export function tn93Provider(module) {
	return (seqs) => {
		const n = seqs.length;
		const out = new Float64Array(n * n);
		if (n <= 1) return out;

		// CHARACTERS THE TOOL DROPS AND THE LIBRARY KEEPS.
		//
		// The compiled tool parses a sequence by discarding anything outside its own alphabet, then
		// refuses the run if the surviving lengths differ. The library keeps those characters and
		// maps them to the same unknown slot as '?' (tn93.js MAP_CHARACTER: unmapped -> 16), so it
		// never notices. Found on examples/korber_env_gp160.fasta, where one of 143 sequences carries
		// four '*' marking stop codons: the tool reported it as 2939 against everyone else's 2943 and
		// exited 1, and the browser's selection report failed with a bare "tn93 exited 1".
		//
		// Rewriting them as '?' keeps the length and keeps the meaning, because that is the slot the
		// library already puts them in. MEASURED on that alignment: with this rewrite the compiled
		// matrix and the library's agree on all 20,449 entries.
		const TOOL_ALPHABET = /[^ACGTUacgtu?\-RYSWKMBDHVNryswkmbdhvn]/g;

		// RAGGED INPUT: PAD, BECAUSE THE TWO ENGINES DISAGREE ABOUT IT.
		//
		// The library's JavaScript, mirroring the tn93 package, compares a pair over
		// `min(len(a), len(b))` and simply ignores the tail of the longer one. The compiled tool
		// refuses the whole run instead: "All sequences must have the same length (2943), but
		// sequence 's16' had length 2939", exit 1. Every bundled example is uniform, so nothing
		// caught this until a real alignment arrived — examples/korber_env_gp160.fasta, where one of
		// 143 sequences is four bases short, and the selection report failed with a bare "tn93
		// exited 1".
		//
		// Padding with gaps is what the reference itself does on this path: dataset.py warns
		// "Unequal sequence lengths detected in alignment ... Padding shorter sequences with gaps"
		// before it computes anything. It is also numerically identical to the truncation the
		// library performs, because in resolve mode a gap carries resolution weight 0 and adds
		// nothing to the counts for that position. MEASURED on the Korber alignment: padded here
		// against the library's own matrix, every one of the 20,449 entries is identical.
		let longest = 0;
		for (let i = 0; i < n; i++) if (seqs[i].length > longest) longest = seqs[i].length;
		// Synthetic names (see the header): the CSV maps back by index, never by taxon name.
		let fasta = '';
		for (let i = 0; i < n; i++) {
			const seq = seqs[i].replace(TOOL_ALPHABET, '?').padEnd(longest, '-');
			fasta += `>s${i}\n${seq}\n`;
		}

		const inPath = '/hyphaeon_in.fa';
		const outPath = '/hyphaeon_out.csv';
		module.FS.writeFile(inPath, fasta);
		let csv;
		try {
			const rc = module.callMain([...TN93_ARGV, '-o', outPath, inPath]);
			if (rc !== 0 && rc !== undefined) throw new Error(`tn93 exited ${rc}`);
			csv = module.FS.readFile(outPath, { encoding: 'utf8' });
		} finally {
			for (const p of [inPath, outPath]) {
				try {
					module.FS.unlink(p);
				} catch {
					// The tool may not have written the output at all; nothing to clean up then.
				}
			}
		}

		// Every off-diagonal entry must come back written; anything still missing is a pair the tool
		// dropped at its threshold, which is saturation (see the header).
		const written = new Uint8Array(n * n);
		const lines = csv.split('\n');
		for (let r = 1; r < lines.length; r++) {
			const line = lines[r];
			if (!line) continue;
			const parts = line.split(',');
			if (parts.length < 3) continue;
			const i = Number(parts[0].slice(1));
			const j = Number(parts[1].slice(1));
			const d = Number(parts[2]);
			if (!Number.isInteger(i) || !Number.isInteger(j) || !Number.isFinite(d)) continue;
			out[i * n + j] = d;
			out[j * n + i] = d;
			written[i * n + j] = 1;
			written[j * n + i] = 1;
		}
		for (let i = 0; i < n; i++) {
			for (let j = i + 1; j < n; j++) {
				if (!written[i * n + j]) {
					// The prefix is what prepareRun matches to turn this into TN93_UNCOMPUTABLE, and the
					// wording mirrors what the library raises for the same pair (tn93.js pyLog).
					throw new Error(
						`tn93: ValueError: expected a positive input (sequences ${i} and ${j} are saturated: ` +
							`the compiled tn93 declined to write their distance at its ${TN93_ARGV[1]} threshold)`
					);
				}
			}
		}
		return out;
	};
}

/**
 * Does the linked library actually USE `pairwiseDistances`?
 *
 * WHY THIS EXISTS. The hook is newer than some tags of @veg/hyphaeon-js, and a library without it
 * ignores the option in silence: the distances would be computed in JavaScript while this module
 * reported that the compiled engine ran. Provenance that lies is worse than a slower run, so the
 * capability is probed once, on two three-base sequences, by handing the library a distance no
 * TN93 computation would produce and checking that it comes back.
 *
 * @returns {boolean}
 */
let providerHonoured = null;
export function libraryHonoursProvider() {
	if (providerHonoured !== null) return providerHonoured;
	const marker = 0.421875; // exactly representable in float32, so the round trip is lossless
	const matrix = tn93DistanceMatrix({ a: 'ACG', b: 'ACT' }, ['a', 'b'], {
		pairwiseDistances: () => Float64Array.from([0, marker, marker, 0])
	});
	providerHonoured = matrix[1] === Math.fround(marker);
	return providerHonoured;
}

/**
 * The whole thing in one call: `{ pairwiseDistances }` to hand the library as `tn93Options`.
 *
 * @param {Parameters<typeof loadTn93Wasm>[0]} [args]
 * @returns {Promise<{pairwiseDistances: (seqs: string[], taxa: string[]) => Float64Array}>}
 */
export async function tn93WasmOptions(args = {}) {
	if (!libraryHonoursProvider()) {
		throw new Error(
			'@veg/hyphaeon-js does not support tn93Options.pairwiseDistances, so the compiled TN93 ' +
				'would be loaded and then ignored. Upgrade the library, or ask for tn93Engine: "js".'
		);
	}
	const module = await loadTn93Wasm(args);
	return { pairwiseDistances: tn93Provider(module) };
}
