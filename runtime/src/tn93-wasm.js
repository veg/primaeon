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
 * WHY 1.0 AND NOT dataset.py's OWN DEFAULT OF 100.0. `compute_tn93_distance_matrix` and
 * `compute_tn93_cross_distance_matrix` both take `threshold: float = 100.0` and both say why —
 * "set to a high value so that no divergent pairwise distances are prematurely omitted" — and both
 * carry a RETRY: "if the installed tn93 binary strictly bounds distance to [0, 1] (e.g. stock
 * <= v1.0.15), it automatically retries with threshold=1.0" (dataset.py:715-731, :824-876).
 * MEASURED on the vendored v1.0.17 build: `-t 100.0` exits 1 and writes no CSV, so this build IS
 * the bounded one and 1.0 is the branch the reference itself would take. The argv below is
 * therefore the reference's effective command, not a narrowing of it.
 *
 * TWO SHAPES, TWO PROVIDERS, AND WHY CONFUSING THEM WOULD BE SILENT. The library's square
 * `tn93DistanceMatrix` calls the hook as `(seqs, taxa, threshold)` and reads `[i*n + j]`; the
 * RECTANGULAR `tn93CrossDistanceMatrix` — the one the dating pillar's root-to-tip divergences go
 * through — calls it as `(allSeqs, landmarkSeqs, taxaAll, taxaLandmarks, threshold)` and reads
 * `[i*m + j]`. Handing the square provider to the cross matrix produces no error at all: with one
 * landmark it would read `out[i]`, which is row 0 of the square matrix — every taxon's distance to
 * whichever sequence happened to be first, returned as its distance to the root. `tn93Provider` and
 * `tn93CrossProvider` therefore each REFUSE the other's call shape, and refuse any shape that is
 * neither, by the whole signature rather than by argument count alone (`tn93HookShape`).
 *
 * THE LIBRARY'S HOOK HAS EXACTLY TWO CALL SITES AND NO OTHERS, checked in the tag this repository
 * links: `preprocess/tn93.js:674` (square, three arguments, from `tn93DistanceMatrix`) and `:769`
 * (rectangular, five, from `tn93CrossDistanceMatrix`). Those two functions are called from six
 * places: `dating.js:1049` (root case 1), `:1066` (case 2), `:1087` (case 3, small cohort), `:1107`
 * (case 3, cohort > 10 — the SQUARE one), `:1136` (case 4) and `preprocess/assemble.js:283`, the
 * square matrix every model-level load computes. Four cross, two square, one options object each.
 *
 * ONE APP PATH REACHES assemble.js:283 AND CANNOT BE GIVEN THE HOOK, and it is recorded here rather
 * than quietly left out of the enumeration above. The report's alignment-artifact FILTER section
 * (`analyze.js`, the `runAlignmentFilter` call) re-loads the CLEANED alignment when it masks a patch
 * — `filter.js:608` -> `loadAlignmentAndTree` -> `tn93Assembly` -> `tn93DistanceMatrix` — and the
 * library's `runAlignmentFilter` destructures its options at `filter.js:453-465` with no
 * `tn93Options` among them, so there is no argument to forward. A tree-free report that finds an
 * artifact therefore computes its SECOND full N x N matrix on the library's JavaScript port while
 * `preprocessing.tn93_engine` says `wasm` for the first. MEASURED with the library's two matrix
 * functions instrumented: on camelid `runEverything` makes exactly two 212-taxon square calls, the
 * first hooked (one compiled `main()`) and the second not. It costs time and nothing else — the two
 * engines are bit-identical, worst |delta| exactly 0 at 20, 143, 212 and 476 taxa — and the time is
 * small where N is (camelid 38.4 ms ported against 22.9 compiled, warm) and not where it is not
 * (HIV1_RT 476 taxa: 835.4 ms against 177.8, with the module already loaded and warm). Closing it
 * needs a `tn93Options` parameter on `runAlignmentFilter` upstream; it is FLAGGED here, not worked
 * around, because the fix belongs in @veg/hyphaeon-js. This predates the hook work on both sides.
 *
 * ONE OPTIONS OBJECT REACHES BOTH HOOKS, WHICH IS WHY THE CROSS OPTIONS ANSWER BOTH SHAPES.
 * `computeTreeFreeDivergences` (dating.js:1035) hands its `options` — ours — to whichever library
 * function its root case selects, and case 3 (`--root-taxon earliest`) selects between TWO of them
 * on the size of the earliest cohort: the RECTANGULAR `tn93CrossDistanceMatrix` at dating.js:1087
 * when `datedTaxa.length > 2500 || earliest.length <= 10`, and the SQUARE `tn93DistanceMatrix` at
 * dating.js:1107 otherwise. A cohort of more than ten sequences sharing the earliest date is
 * ordinary — year-granularity dates make it the common case, not the exotic one — so a provider
 * that answered only the rectangular shape crashed that branch with the arity guard below.
 * MEASURED on examples/H5N1_HA_geo.fasta with the single 1996 sequence excluded, which makes the
 * 1997 cohort of 20 the earliest: the port fits a clock (t_mrca 1994.83) and a cross-only provider
 * threw `tn93CrossProvider was called with the SQUARE hook signature` straight out of `runDating`,
 * uncaught, because `isTn93Refusal` matches the prefix `tn93:` and that message does not.
 * `tn93DualProvider` therefore DISPATCHES ON THE RECOGNISED SHAPE to the right single-shape provider
 * instead of refusing. The guards stay exactly as strict where they belong — a square call is still
 * answered with a real square matrix and never with row 0 of the wrong one — and `tn93Provider` /
 * `tn93CrossProvider` keep refusing the other's shape, so wiring one of them in directly is still
 * an error rather than a silent wrong answer. `resolveTn93Options` hands out the DUAL provider
 * whenever the library honours both hooks, so no surface can pick the narrow one and meet the
 * branch that crashed this round.
 *
 * THE CROSS ARGV adds `-s <landmark fasta>`, which is dataset.py:862's own: it compares the two
 * files pairwise rather than within one, so the tool computes exactly n*m distances instead of the
 * (n+m)^2/2 a single-file run would. A pair the tool omits at its threshold is left UNWRITTEN here,
 * which is what dataset.py's binary branch does (`dist_mat` stays at -1.0 and :922-925 imputes it
 * to `max(1.0, max_d)`); the square provider raises instead, because THAT path's refusal is a
 * pinned contract. The two engines can then differ on one thing only: a pair whose true distance
 * exceeds the tool's 1.0 ceiling, where the port returns the number and the compiled engine's
 * omission is imputed to 1.0 — the same disagreement the reference has between its own two
 * branches. `tn93CrossWasmOptions` exposes a `tn93Stats` counter so a caller can say whether that
 * happened rather than assume it did not. MEASURED: 0 omitted pairs on korber_env_gp160 (143 taxa)
 * and H5N1_HA_geo (98) across all four of `computeTreeFreeDivergences`'s root cases.
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
 * IDENTITY AND COST ON BOTH SHAPES, MEASURED 2026-09-13 (Node 22, darwin/x64 under Rosetta, one
 * thread). WARM first — the same matrix computed repeatedly in one process, median of 7, through
 * `tn93DistanceMatrix` / `tn93CrossDistanceMatrix`, one landmark on the cross:
 *
 *                                 pairs    compiled       port     worst |Δ|
 *   korber_env_gp160  square     10,153     53.9 ms   196.7 ms           0
 *   korber_env_gp160  cross         142     13.2 ms     4.2 ms           0
 *   H5N1_HA_geo       square       4,753    15.5 ms    39.0 ms           0
 *   H5N1_HA_geo       cross          97      4.8 ms     1.6 ms           0
 *
 * AND NOW COLD, WHICH IS WHAT A READER PAYS — one call in a fresh process, the engine's load and
 * first-call warm-up included, because a worker, an MCP call and a job all start cold:
 *
 *                                 pairs    compiled       port    compiled costs
 *   korber_env_gp160  square     10,153    168.6 ms   266.0 ms      -97.4 ms
 *   korber_env_gp160  cross         142     94.6 ms    45.4 ms      +49.2 ms
 *   H5N1_HA_geo       square       4,753   119.5 ms    80.3 ms      +39.2 ms
 *   H5N1_HA_geo       cross          97     94.7 ms    27.9 ms      +66.8 ms
 *
 * READ THE CROSS ROWS PLAINLY: on the RECTANGULAR shape the compiled engine is the WRONG CHOICE.
 * It is slower warm (13.2 ms against 4.2 on korber — round one's table said 6.1 ms and concluded
 * "about 2 ms", which is not what this machine measures) and it is two to three times slower cold,
 * because that shape is n comparisons, not n²/2, against a ~90 ms fixed cost: 24 ms to read, hash
 * and instantiate, ~22 ms for the module's first `callMain`, and another 30-45 ms before the real
 * call runs at warm speed. End to end that is a korber dating run of 181-188 ms against 100-101 ms
 * (dating/run.js's header has the runs).
 *
 * THE SHAPE CANNOT DECIDE THE ENGINE, THOUGH, which is why this file does not simply refuse the
 * compiled engine on the cross hook: `computeTreeFreeDivergences` picks its shape AT RUNTIME from
 * the data (case 3's cohort, dating.js:1087 vs :1107), so one options object must answer both, and
 * the square branch at 2,500 dated taxa is three million pairs — 60 s ported against 13 s compiled,
 * extrapolated from the korber rate. So one options object answers both shapes, and the ENGINE is
 * not chosen by shape or by size at all: `auto` is the compiled build everywhere, for the
 * single-source-of-truth reason in the cost section below. The matrices are identical to the last
 * bit in every row above, on both shapes and at every n measured, which is the number that matters.
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

import { tn93CrossDistanceMatrix, tn93DistanceMatrix } from '@veg/hyphaeon-js';

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

/**
 * One FASTA for the tool, names `<prefix>0..<prefix>(n-1)` and every sequence padded to `longest`.
 *
 * RAGGED INPUT: PAD, BECAUSE THE TWO ENGINES DISAGREE ABOUT IT.
 *
 * The library's JavaScript, mirroring the tn93 package, compares a pair over `min(len(a), len(b))`
 * and simply ignores the tail of the longer one. The compiled tool refuses the whole run instead:
 * "All sequences must have the same length (2943), but sequence 's16' had length 2939", exit 1.
 * Every bundled example is uniform, so nothing caught this until a real alignment arrived —
 * examples/korber_env_gp160.fasta, where one of 143 sequences is four bases short, and the
 * selection report failed with a bare "tn93 exited 1".
 *
 * Padding with gaps is what the reference itself does on this path: dataset.py warns "Unequal
 * sequence lengths detected in alignment ... Padding shorter sequences with gaps" before it
 * computes anything. It is also numerically identical to the truncation the library performs,
 * because in resolve mode a gap carries resolution weight 0 and adds nothing to the counts for that
 * position. MEASURED on the Korber alignment: padded here against the library's own matrix, every
 * one of the 20,449 entries is identical.
 *
 * Synthetic names (see the header): the CSV maps back by index, never by taxon name.
 */
function toolFasta(seqs, prefix, longest) {
	let fasta = '';
	for (let i = 0; i < seqs.length; i++) {
		fasta += `>${prefix}${i}\n${seqs[i].replace(TOOL_ALPHABET, '?').padEnd(longest, '-')}\n`;
	}
	return fasta;
}

/** The longest sequence across every list handed to one invocation; the tool wants one width. */
function longestOf(...lists) {
	let longest = 0;
	for (const list of lists) for (const s of list) if (s.length > longest) longest = s.length;
	return longest;
}

/**
 * Write the inputs, run the tool, read the CSV back, and clean the virtual filesystem either way.
 *
 * @param {object} module the module from `loadTn93Wasm`
 * @param {Array<[string, string]>} inputs `[path, contents]` pairs
 * @param {string[]} argv everything after `-o <out>`; the positional FASTA must be LAST, because
 *   the tool's own option parser stops at the first non-option argument (measured: a run with the
 *   input file before `-o` exits 1 and writes nothing)
 * @param {string} outPath
 * @returns {string} the CSV the tool wrote
 */
function runTool(module, inputs, argv, outPath) {
	for (const [path, contents] of inputs) module.FS.writeFile(path, contents);
	try {
		const rc = module.callMain([...TN93_ARGV, '-o', outPath, ...argv]);
		if (rc !== 0 && rc !== undefined) throw new Error(`tn93 exited ${rc}`);
		return module.FS.readFile(outPath, { encoding: 'utf8' });
	} finally {
		for (const p of [...inputs.map(([path]) => path), outPath]) {
			try {
				module.FS.unlink(p);
			} catch {
				// The tool may not have written the output at all; nothing to clean up then.
			}
		}
	}
}

/**
 * Every CSV row as `[i, j, distance]` with the synthetic-name prefixes stripped.
 *
 * @param {string} csv
 * @returns {Generator<[number, number, number]>}
 */
function* csvPairs(csv) {
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
		yield [i, j, d];
	}
}

/**
 * WHICH OF THE LIBRARY'S TWO HOOK SHAPES THIS CALL IS — by the whole signature, not by its length.
 *
 * The library has exactly two call sites and they are both literal (checked at phase-4b+:
 * `preprocess/tn93.js:674` `pairwiseDistances(seqs, taxa, threshold)` and `:769`
 * `pairwiseDistances(allSeqs, lmSeqs, taxaAll, taxaLandmarks, threshold)`), so THREE arguments and
 * FIVE are the only shapes that exist and each is fully determined. Arity alone would route them,
 * and round one's guards tested nothing else — but arity alone also silently accepts a shape that
 * does not exist yet: a four-argument call, or a five-argument call whose second argument became
 * something other than the landmark SEQUENCES, would be answered with a matrix of the wrong shape
 * and no error. The failure mode this whole module guards against is the silent wrong answer, so the
 * structure is checked too: the two sequence lists and the two taxon lists must be string arrays of
 * matching lengths. Anything else is refused by name rather than guessed at.
 *
 * THE THRESHOLD MAY BE OMITTED on the square shape, and only there. It is the LAST argument, it
 * cannot change how the result is indexed, and callers in this repository's own suites hand a
 * provider `(seqs, taxa)` directly; a two-argument call is square or it is nothing, since no cross
 * call site drops three arguments. The cross shape is required whole, because that is the one that
 * can be confused with a square call in a way that reads a real matrix the wrong way round.
 *
 * @param {unknown[]} args the arguments the library passed
 * @returns {'square'|'cross'|null} null for a shape this module does not recognise
 */
export function tn93HookShape(args) {
	const strings = (/** @type {unknown} */ v) => Array.isArray(v) && v.every((s) => typeof s === 'string');
	if ((args.length === 3 || args.length === 2) && strings(args[0]) && strings(args[1]) && args[0].length === args[1].length) return 'square';
	if (
		args.length === 5 &&
		strings(args[0]) &&
		strings(args[1]) &&
		strings(args[2]) &&
		strings(args[3]) &&
		args[2].length === args[0].length &&
		args[3].length === args[1].length
	) {
		return 'cross';
	}
	return null;
}

/** The one message for a shape no provider here recognises; refusing is the point (see above). */
function unknownShape(who, args) {
	return new Error(
		`${who} was called with an unrecognised pairwiseDistances signature (${args.length} argument(s): ` +
			`${args.map((a) => (Array.isArray(a) ? `array[${a.length}]` : typeof a)).join(', ')}). The library's ` +
			'hook has exactly two shapes — (seqs, taxa, threshold) for tn93DistanceMatrix and (allSeqs, ' +
			'landmarkSeqs, taxaAll, taxaLandmarks, threshold) for tn93CrossDistanceMatrix — and answering ' +
			'anything else would return a matrix of the wrong shape with no error. Refusing instead. If ' +
			'@veg/hyphaeon-js has changed how it calls the hook, tn93HookShape() in this file is what must ' +
			'be taught the new shape.'
	);
}

/**
 * A `pairwiseDistances` provider for the library's SQUARE `tn93DistanceMatrix`: raw distances only.
 *
 * @param {object} module the module from `loadTn93Wasm`
 * @returns {(seqs: string[], taxa: string[], threshold?: number) => Float64Array} n*n raw
 *   distances, read at [i*n + j]
 */
export function tn93Provider(module) {
	return (...args) => {
		// The library calls the square hook with exactly three arguments and the RECTANGULAR one with
		// five. Refusing the wrong shape here is the whole guard against the failure described in the
		// header: a square provider silently answers a cross call with row 0 of the wrong matrix.
		const shape = tn93HookShape(args);
		if (shape === 'cross') {
			throw new Error(
				'tn93Provider was called with the RECTANGULAR hook signature (allSeqs, landmarkSeqs, ' +
					'taxaAll, taxaLandmarks, threshold). It answers only tn93DistanceMatrix; pass ' +
					'tn93DualProvider / tn93CrossWasmOptions to tn93CrossDistanceMatrix. Answering this ' +
					'call would return row 0 of the square matrix as every taxon\'s landmark distance.'
			);
		}
		if (shape !== 'square') throw unknownShape('tn93Provider', args);
		const [seqs] = args;
		const n = seqs.length;
		const out = new Float64Array(n * n);
		if (n <= 1) return out;

		const csv = runTool(module, [['/hyphaeon_in.fa', toolFasta(seqs, 's', longestOf(seqs))]], ['/hyphaeon_in.fa'], '/hyphaeon_out.csv');

		// Every off-diagonal entry must come back written; anything still missing is a pair the tool
		// dropped at its threshold, which is saturation (see the header).
		const written = new Uint8Array(n * n);
		for (const [i, j, d] of csvPairs(csv)) {
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
 * A `pairwiseDistances` provider for the library's RECTANGULAR `tn93CrossDistanceMatrix` — the
 * shape the dating pillar's root-to-tip divergences go through (dating.py:624-698 through
 * `computeTreeFreeDivergences`).
 *
 * `-s <landmark fasta>` is dataset.py:862's own argument: the tool compares the two files pairwise,
 * so it computes n*m distances rather than the (n+m)^2/2 a single-file run would. An omitted pair
 * is left UNWRITTEN (a hole in the returned array, which the library reads as `undefined`) exactly
 * as dataset.py's binary branch leaves it at -1.0 for :922-925 to impute; see the header for the one
 * case in which that can differ from the port, and for `stats`.
 *
 * @param {object} module the module from `loadTn93Wasm`
 * @param {{pairs: number, omitted: number, calls: number}} [stats] mutated in place, so a caller can
 *   report whether the tool declined to write anything rather than assuming it did not
 * @returns {(allSeqs: string[], lmSeqs: string[], taxaAll: string[], taxaLandmarks: string[],
 *   threshold?: number) => Array<number|undefined>} n*m raw distances, read at [i*m + j]
 */
export function tn93CrossProvider(module, stats = null) {
	return (...args) => {
		const shape = tn93HookShape(args);
		if (shape === 'square') {
			throw new Error(
				'tn93CrossProvider was called with the SQUARE hook signature (seqs, taxa, threshold). ' +
					'It answers only tn93CrossDistanceMatrix; pass tn93Provider / tn93WasmOptions to ' +
					'tn93DistanceMatrix, or tn93DualProvider where both shapes can arrive.'
			);
		}
		if (shape !== 'cross') throw unknownShape('tn93CrossProvider', args);
		const [allSeqs, lmSeqs] = args;
		const n = allSeqs.length;
		const m = lmSeqs.length;
		// A sparse Array, not a Float64Array: a hole reads back as `undefined`, which is the library's
		// documented "never written" and the only way to distinguish it from a measured 0.
		const out = new Array(n * m);
		if (n === 0 || m === 0) return out;

		const longest = longestOf(allSeqs, lmSeqs);
		const csv = runTool(
			module,
			[
				['/hyphaeon_all.fa', toolFasta(allSeqs, 'a', longest)],
				['/hyphaeon_lm.fa', toolFasta(lmSeqs, 'b', longest)]
			],
			['-s', '/hyphaeon_lm.fa', '/hyphaeon_all.fa'],
			'/hyphaeon_cross.csv'
		);

		let written = 0;
		for (const [i, j, d] of csvPairs(csv)) {
			if (out[i * m + j] === undefined) written += 1;
			out[i * m + j] = d;
		}
		if (stats) {
			stats.calls = (stats.calls ?? 0) + 1;
			stats.pairs = (stats.pairs ?? 0) + n * m;
			stats.omitted = (stats.omitted ?? 0) + (n * m - written);
		}
		return out;
	};
}

/**
 * The provider `computeTreeFreeDivergences` actually needs: ONE function that answers BOTH of the
 * library's hooks, dispatching on the call shape rather than refusing the one it did not expect.
 *
 * It exists because the library hands a single `options` object to whichever of its two distance
 * functions a root case selects, and case 3 selects between them at runtime on the size of the
 * earliest cohort (dating.js:1087 rectangular, :1107 square — see the header). Both calls must be
 * answered, and each must be answered with its OWN matrix.
 *
 * The test is `tn93HookShape` above — the library's own contract, checked by structure and not by
 * argument count alone: `tn93DistanceMatrix` calls the hook with exactly three arguments
 * `(seqs, taxa, threshold)`, `tn93CrossDistanceMatrix` with five `(allSeqs, lmSeqs, taxaAll,
 * taxaLandmarks, threshold)`. It is the same test the two single-shape providers use to refuse; here
 * it routes instead, and a shape that is NEITHER is refused here as well rather than guessed at,
 * because guessing is how row 0 of a square matrix becomes every taxon's root distance.
 *
 * @param {object} module the module from `loadTn93Wasm`
 * @param {{pairs: number, omitted: number, calls: number, squareCalls: number}} [stats] mutated in place
 * @returns {Function} a `pairwiseDistances` hook valid for both library call shapes
 */
export function tn93DualProvider(module, stats = null) {
	const square = tn93Provider(module);
	const cross = tn93CrossProvider(module, stats);
	return (...args) => {
		const shape = tn93HookShape(args);
		if (shape === 'cross') return cross(...args);
		if (shape !== 'square') throw unknownShape('tn93DualProvider', args);
		if (stats) {
			const n = args[0].length;
			stats.squareCalls = (stats.squareCalls ?? 0) + 1;
			// Unordered pairs, which is what the tool was asked for; a pair it declines to write on
			// this shape RAISES in `tn93Provider` rather than being imputed, so `omitted` cannot move.
			stats.pairs = (stats.pairs ?? 0) + (n * (n - 1)) / 2;
		}
		return square(...args);
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
 * The same question for the RECTANGULAR hook, asked separately because it is a separate call site
 * in the library and a tag could carry one without the other. The probe also pins the CALL SHAPE:
 * it returns its marker only for a five-argument call whose second argument is the LANDMARK
 * SEQUENCES, so a library that ever called this hook the square way would fail the probe here
 * rather than mis-index a real matrix.
 *
 * @returns {boolean}
 */
let crossProviderHonoured = null;
export function libraryHonoursCrossProvider() {
	if (crossProviderHonoured !== null) return crossProviderHonoured;
	const marker = 0.421875;
	let shape = false;
	const matrix = tn93CrossDistanceMatrix({ a: 'ACG', b: 'ACT', r: 'AGG' }, ['a', 'b'], ['r'], {
		pairwiseDistances: (allSeqs, lmSeqs, taxaAll, taxaLandmarks) => {
			shape =
				Array.isArray(lmSeqs) &&
				lmSeqs.length === 1 &&
				lmSeqs[0] === 'AGG' &&
				Array.isArray(taxaAll) &&
				taxaAll.length === 2 &&
				Array.isArray(taxaLandmarks) &&
				allSeqs.length === 2;
			return [marker, marker];
		}
	});
	crossProviderHonoured = shape && matrix[0] === Math.fround(marker) && matrix[1] === Math.fround(marker);
	return crossProviderHonoured;
}

/**
 * THE LABEL TRAVELS WITH THE OBJECT, because a label derived from the SHAPE of an object is a guess.
 *
 * `runDating` is synchronous and takes its options already resolved, so it cannot ask who made them.
 * Round one had it read `tn93Options?.pairwiseDistances ? 'wasm' : 'js'` — which calls ANY provider
 * `wasm`, including a caller's own, and would go on calling it `wasm` if this module ever handed
 * back the port. So every options object this file produces carries the engine that produced it
 * under this key, the library ignores it (it reads only `pairwiseDistances`, `matchMode`,
 * `maxAmbigFraction`, `ignoreGaps` and `threshold`), and a consumer reads the stamp rather than
 * inferring anything. An object with NO stamp and a provider is `custom` by definition: something
 * else made it, and this module will not vouch for it.
 */
export const TN93_ENGINE_KEY = 'tn93Engine';

/**
 * WHAT THE COMPILED ENGINE COSTS BEFORE IT COMPUTES ANYTHING, and the work that pays for it.
 *
 * MEASURED 2026-09-13 (Node 22.x, darwin/x64 under Rosetta, one thread, fresh process per row;
 * `runtime/src/tn93-wasm.js` loaded through `resolveTn93Options`, then ONE matrix):
 *
 *   fixed cost of the first use   load (read + sha256 + instantiate)  23.6-26.6 ms
 *                                 first callMain, 3 tiny sequences    20.3-24.9 ms
 *                                 warm-up of the real call path       ~30-45 ms
 *
 * so about 90 ms of a fresh process (or a fresh worker) goes on the engine before its first real
 * matrix, and that is per PROCESS: the browser's dating worker and model worker pay it separately.
 * Against it stands roughly 14 µs per pair on korber-length sequences (2,943 nt): the port's
 * square matrix is 19.4 µs/pair (196.7 ms / 10,153) and the compiled one 5.3 µs/pair (53.9 ms).
 *
 * COLD SQUARE MATRIX, korber_env_gp160 truncated to n taxa, load + matrix in a fresh process:
 *
 *        n     pairs   compiled      port    identical?
 *       60     1,770    107.8 ms   83.1 ms   yes (checksums equal at every n)
 *       75     2,775    123.3 ms  105.8 ms   yes
 *       85     3,570    121.5 ms  119.4 ms   yes  <- the crossover, near 3,500 pairs
 *      100     4,950    132.1 ms  153.2 ms   yes
 *      143    10,153    168.6 ms  266.0 ms   yes
 *   HIV1_RT 200  19,900 162.9 ms  198.0 ms   yes
 *   HIV1_RT 476 113,050 338.9 ms  865.1 ms   yes
 *
 * Below ~3,500 unordered pairs the compiled engine does not earn its ~90 ms of load back, and above
 * it the gap widens with N². THAT IS RECORDED HERE AS A COST AND IS NOT A SWITCH. An earlier draft
 * of this file turned it into one — `TN93_WASM_BREAK_EVEN_PAIRS` with a `tn93EngineForPairs` that
 * sent small jobs to the port — and that was wrong on a ground the timings cannot see.
 *
 * WHY THE COMPILED ENGINE IS NOT A PERFORMANCE CHOICE. veg/tn93 is a repository this project's
 * authors maintain, and the vendored build is how its updates arrive here: a fix or a change in the
 * tool lands as a new release we re-vendor, verified by MANIFEST.json's sha256. The JavaScript port
 * is a second implementation of the same arithmetic that has to be kept in step BY HAND, and every
 * code path still running it is a path where the two can silently diverge the day upstream changes.
 * Sergei asked for the compiled target for exactly that reason, and the decision was recorded as a
 * stakeholder directive that overrides the measurement.
 *
 * So `auto` means the compiled engine, on every job, whatever its size. The port remains as the
 * FALLBACK when the compiled build cannot load — and only then, loudly, with `TN93_ENGINE_FALLBACK`
 * and a reason. The ~90 ms on a small job is a price this project has decided to pay.
 */


/**
 * The whole thing in one call: `{ pairwiseDistances }` to hand the library as `tn93Options` for its
 * SQUARE `tn93DistanceMatrix`.
 *
 * @param {Parameters<typeof loadTn93Wasm>[0]} [args]
 * @returns {Promise<{pairwiseDistances: (seqs: string[], taxa: string[]) => Float64Array, tn93Engine: 'wasm'}>}
 */
export async function tn93WasmOptions(args = {}) {
	if (!libraryHonoursProvider()) {
		throw new Error(
			'@veg/hyphaeon-js does not support tn93Options.pairwiseDistances, so the compiled TN93 ' +
				'would be loaded and then ignored. Upgrade the library, or ask for tn93Engine: "js".'
		);
	}
	const module = await loadTn93Wasm(args);
	return { pairwiseDistances: tn93Provider(module), [TN93_ENGINE_KEY]: 'wasm' };
}

/**
 * The same, for the library's RECTANGULAR `tn93CrossDistanceMatrix` — `computeTreeFreeDivergences`,
 * and therefore every root-to-tip divergence the dating pillar fits a clock to.
 *
 * `tn93Stats` rides along on the returned object. The library reads only the keys it knows
 * (`pairwiseDistances`, `matchMode`, `maxAmbigFraction`, `ignoreGaps`, `threshold`) and ignores the
 * rest, so this is how a caller gets the omitted-pair count back out of a synchronous library call.
 *
 * @param {Parameters<typeof loadTn93Wasm>[0]} [args]
 * @returns {Promise<{pairwiseDistances: Function, tn93Stats: {pairs: number, omitted: number, calls: number}}>}
 */
export async function tn93CrossWasmOptions(args = {}) {
	// BOTH hooks are probed, because this object reaches both: `computeTreeFreeDivergences` sends it
	// to the square `tn93DistanceMatrix` on case 3's large-cohort branch (dating.js:1107). A library
	// that honoured only one of them would compute that branch in JavaScript while the record said
	// `wasm`, which is the exact failure this module exists to make impossible.
	if (!libraryHonoursCrossProvider() || !libraryHonoursProvider()) {
		throw new Error(
			'@veg/hyphaeon-js does not support both shapes of tn93Options.pairwiseDistances, so the ' +
				'compiled TN93 would be loaded and then ignored on at least one root case. Upgrade the ' +
				'library, or ask for tn93Engine: "js".'
		);
	}
	const module = await loadTn93Wasm(args);
	const tn93Stats = { pairs: 0, omitted: 0, calls: 0, squareCalls: 0 };
	return { pairwiseDistances: tn93DualProvider(module, tn93Stats), tn93Stats, [TN93_ENGINE_KEY]: 'wasm' };
}

/**
 * What engine an options object was made by, read from the stamp and NEVER inferred.
 *
 * `'custom'` is the honest answer for a provider this module did not make: it may be anyone's, and
 * round one's `pairwiseDistances ? 'wasm' : 'js'` would have called it — and a future fallback to
 * the port inside a stamped object — `wasm` in the record.
 *
 * @param {object|null|undefined} options
 * @returns {'wasm'|'js'|'custom'}
 */
export function tn93EngineOf(options) {
	const stamped = options?.[TN93_ENGINE_KEY];
	if (stamped === 'wasm' || stamped === 'js' || stamped === 'custom') return stamped;
	return options?.pairwiseDistances ? 'custom' : 'js';
}

/**
 * ONE PLACE THAT DECIDES WHO COMPUTES THE DISTANCES, because four call sites had to agree and three
 * of them silently did not (the dating pillar on every surface, and the dating model pass, all
 * computed their distances in JavaScript while the product's provenance claimed the compiled
 * engine). `pipeline.js`, `runDating`'s callers and `runDatingModelPass` all come through here.
 *
 * `'auto'` takes the compiled engine and falls back to the port, returning the error so the caller
 * can raise its own surface's TN93_ENGINE_FALLBACK note; `'wasm'` refuses to fall back; `'js'` does
 * not load anything. A caller that already holds a provider keeps it and is labelled `'custom'` —
 * provenance must not call someone else's engine one of ours.
 *
 * IT HANDS BACK THE DUAL-SHAPE PROVIDER WHENEVER THE LIBRARY HONOURS BOTH HOOKS, whatever `shape`
 * says. `shape` was round one's way of asking for a narrower object, and a narrower object is a
 * loaded gun: `computeTreeFreeDivergences` chooses its hook AT RUNTIME from the data (case 3's
 * cohort, dating.js:1087 vs :1107), so a square-only object handed to a dating run throws on three
 * of the four root cases and a cross-only one threw on the branch that crashed this round. The dual
 * provider answers each shape with its OWN matrix, so no caller can pick wrong. `shape` now says
 * only which hook the caller CANNOT do without, for the one case that still matters: a library tag
 * that carries one hook and not the other.
 *
 * `pairs` is the size of the job, when the caller knows it. It is RECORDED, not acted on: `'auto'`
 * is the compiled engine at every size. An earlier draft used it to send small jobs to the port and
 * that was wrong — see the cost section in this file's header for why the port is a fallback rather
 * than a fast path.
 *
 * @param {object} [args]
 * @param {'auto'|'wasm'|'js'} [args.engine]
 * @param {object} [args.wasm] loader arguments; Node finds its own vendored copy, a browser passes URLs
 * @param {object} [args.options] `tn93Options` the caller already has (matchMode, or its own provider)
 * @param {'square'|'cross'} [args.shape] the hook the caller must have; both are supplied when the
 *   library honours both
 * @param {number|null} [args.pairs] unordered pairs this run will compute, if known
 * @returns {Promise<{tn93Options: object|undefined, tn93Engine: 'wasm'|'js'|'custom',
 *   tn93EngineReason: string|null, error: Error|null}>}
 */
export async function resolveTn93Options({ engine = 'auto', wasm = {}, options = null, shape = 'square', pairs = null } = {}) {
	// A provider this module did not make is the caller's business, and its own stamp decides what it
	// is called: `tn93EngineOf` returns `custom` for anything unstamped.
	if (options?.pairwiseDistances) {
		return { tn93Options: options, tn93Engine: tn93EngineOf(options), tn93EngineReason: null, error: null };
	}
	const ported = (/** @type {string|null} */ reason, /** @type {Error|null} */ error) => ({
		tn93Options: { ...(options ?? {}), [TN93_ENGINE_KEY]: 'js' },
		tn93Engine: /** @type {'js'} */ ('js'),
		tn93EngineReason: reason,
		error
	});
	if (engine === 'js') return ported('requested', null);
	// `auto` is the compiled engine at every size. See the header: this is not a timing decision, and
	// a `pairs` hint does NOT send a small job to the port — the port is the fallback for a build that
	// will not load, not a fast path. `pairs` is still accepted and recorded, because the cost of the
	// choice is worth reporting even when it does not change it.
	try {
		// Both hooks when the library has both (the object may meet either shape at runtime); the one
		// the caller named when it has only that one, so an older library still runs rather than
		// refusing over a hook this call will never reach.
		const both = libraryHonoursProvider() && libraryHonoursCrossProvider();
		const resolved = both || shape === 'cross' ? await tn93CrossWasmOptions(wasm) : await tn93WasmOptions(wasm);
		return { tn93Options: { ...(options ?? {}), ...resolved }, tn93Engine: 'wasm', tn93EngineReason: null, error: null };
	} catch (err) {
		// An explicit request for the compiled engine is not a preference to be quietly downgraded.
		if (engine === 'wasm') throw err;
		return ported('load_failed', err instanceof Error ? err : new Error(String(err)));
	}
}
