/**
 * tn93-wasm.test.js — veg/tn93's compiled build is the ONLY TN93 in the product, and this is what
 * stands behind it.
 *
 * WHAT THIS FILE USED TO DO, AND WHY IT NO LONGER CAN. Until 2026-09-13 every case here compared
 * the compiled engine with @veg/hyphaeon-js's JavaScript port of the `tn93` PyPI package, entry for
 * entry, on all four bundled FASTA examples. That port is deleted — one implementation, maintained
 * in veg/tn93, rather than two kept in step by hand — so there is nothing left in this process to
 * compare against, and NO TEST IN THIS REPOSITORY REPLACES THAT COMPARISON. What stands behind a
 * TN93 number now is a chain that lives outside this repository's JavaScript:
 *
 *   - tn93 binary v1.0.15 == tn93 Python package 1.2.2, max |Δ| = 0.0 on bat_oas1 and HIV1_RT
 *     (measured 2026-09-05, both through `compute_tn93_distance_matrix`);
 *   - the vendored v1.0.17 WebAssembly build == native tn93 1.0.15, identical rows and values on
 *     bat_oas1 (153 pairs), Smc6 (190), camelid (22,366) and HIV1_RT (113,050) (measured
 *     2026-09-07, recorded in runtime/vendor/tn93/MANIFEST.json);
 *   - the `parity` CI job, which runs this engine against the Python reference on whole alignments.
 *
 * The practical consequence is worth stating plainly: if veg/tn93 changes an ambiguity or a gap
 * convention, nothing in THIS file will notice. The parity gate is the thing that will.
 *
 * WHAT IS STILL CHECKED HERE, and all of it is about this module rather than about arithmetic:
 *
 *   1. THE TWO ARGV PATHS AGREE. The square matrix is one FASTA and one `tn93` run; the rectangular
 *      one is two FASTAs and `-s`. Every landmark column of the rectangular result must equal the
 *      corresponding entry of the square matrix from the SAME engine, on all four examples. That is
 *      an independent check of the thing this module actually gets wrong — indexing — and it is
 *      stronger than the old port comparison on that one point, because a provider that returned
 *      row 0 of the wrong matrix passed neither but this one localises it.
 *   2. THE APP'S OWN PREPROCESSING IS A NO-OP ON THE NUMBERS. The compiled tool refuses a '*' and
 *      refuses a ragged alignment; `toolFasta` rewrites the first to '?' and pads the second with
 *      gaps. Each is checked against the SAME input pre-rewritten by hand, so the rewrite is proved
 *      not to move a distance rather than assumed to.
 *   3. THE LIBRARY'S WRAPPING IS STILL THE LIBRARY'S. dataset.py's 1e-4 for a zero distance between
 *      DISTINCT sequences, the zeroed diagonal and the symmetry, on engine numbers.
 *   4. SATURATION REFUSES RATHER THAN SCORING. The tool omits a pair at its 1.0 threshold; the
 *      provider turns that omission into the `tn93:`-prefixed error `prepareRun` converts to
 *      TN93_UNCOMPUTABLE, so a saturated alignment is refused and never scored on an imputed 1.0.
 *   5. THE BYTES ARE VERIFIED before the module is created, the refusal carries what a person needs
 *      (code, stage, release, both hashes), and a failed verification is NOT memoised.
 *   6. THE LIBRARY REFUSES WITHOUT AN ENGINE. `tn93DistanceMatrix` with no `pairwiseDistances`
 *      throws `Tn93EngineRequiredError` rather than computing something — the property that makes a
 *      forgotten wiring a loud failure instead of a silent second implementation.
 *
 * The alignments come from the engine checkout (HYPHAEON_ENGINE_DIR, default ../../HyphAeon), so
 * the suite skips rather than fails where that checkout is absent.
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { tn93CrossDistanceMatrix, tn93DistanceMatrix } from '@veg/hyphaeon-js';
import {
	libraryHonoursCrossProvider,
	libraryHonoursProvider,
	loadTn93Wasm,
	resetTn93Wasm,
	tn93CrossWasmOptions,
	tn93Provider,
	tn93WasmOptions,
	TN93_ARGV
} from '../src/tn93-wasm.js';

const HERE = resolve(fileURLToPath(import.meta.url), '..');
const ENGINE = process.env.HYPHAEON_ENGINE_DIR ?? resolve(HERE, '..', '..', '..', 'HyphAeon');
const EXAMPLES = join(ENGINE, 'examples');
const ready = existsSync(join(EXAMPLES, 'bat_oas1.fasta'));
if (!ready) console.warn(`\n[tn93-wasm] examples not found at ${EXAMPLES}; identity cases skipped.\n`);

/** The bundled FASTA examples, smallest first. RHO is NEXUS and has no place here. */
const EXAMPLE_FILES = ['bat_oas1.fasta', 'Smc6.fasta', 'camelid.fasta', 'HIV1_RT.fasta'];

function readFasta(file) {
	const names = [];
	const sequences = {};
	let current = null;
	for (const line of readFileSync(join(EXAMPLES, file), 'utf8').split('\n')) {
		if (line.startsWith('>')) {
			current = line.slice(1).trim();
			names.push(current);
			sequences[current] = '';
		} else if (current && line.trim()) {
			sequences[current] += line.trim();
		}
	}
	return { names, sequences };
}

afterEach(() => {
	resetTn93Wasm();
});

describe('the vendored tn93 build', () => {
	it('verifies its bytes against MANIFEST.json and refuses a mismatch without memoising it', async () => {
		const vendor = resolve(HERE, '..', 'vendor', 'tn93');
		const manifest = JSON.parse(readFileSync(join(vendor, 'MANIFEST.json'), 'utf8'));
		expect(manifest.version).toMatch(/^v\d+\.\d+\.\d+$/);
		expect(manifest.files['tn93.wasm'].sha256).toMatch(/^[0-9a-f]{64}$/);

		// A directory holding the real glue and a manifest that names the wrong hash.
		const bad = join(HERE, 'fixtures-tn93-bad');
		const fs = await import('node:fs/promises');
		await fs.mkdir(bad, { recursive: true });
		await fs.copyFile(join(vendor, 'tn93.cjs'), join(bad, 'tn93.cjs'));
		await fs.copyFile(join(vendor, 'tn93.wasm'), join(bad, 'tn93.wasm'));
		const wrong = { ...manifest, files: { ...manifest.files, 'tn93.wasm': { ...manifest.files['tn93.wasm'], sha256: 'f'.repeat(64) } } };
		await fs.writeFile(join(bad, 'MANIFEST.json'), JSON.stringify(wrong));
		try {
			// THE REFUSAL CARRIES WHAT A PERSON CAN ACT ON. There is no fallback any more, so this is
			// the end of every tree-free analysis on this installation: the message has to say which
			// build, which file and what the sha256 check found, and `code` has to be stable enough to
			// classify on without matching prose.
			const err = await loadTn93Wasm({ vendorDir: bad }).then(
				() => null,
				(e) => e
			);
			expect(err).toBeTruthy();
			expect(err.code).toBe('TN93_ENGINE_UNAVAILABLE');
			expect(err.stage).toBe('integrity');
			expect(err.expectedSha256).toBe('f'.repeat(64));
			expect(err.actualSha256).toBe(manifest.files['tn93.wasm'].sha256);
			expect(err.release).toContain(manifest.version);
			expect(err.files.join(' ')).toContain('tn93.wasm');
			expect(err.hint).toMatch(/[Rr]e-vendor/);
			expect(err.message).toMatch(/does not match the sha256/);
			expect(err.toDetail()).toMatchObject({ code: 'TN93_ENGINE_UNAVAILABLE', stage: 'integrity' });
			// Not memoised: the second call must fail the same way rather than return a bad module.
			await expect(loadTn93Wasm({ vendorDir: bad })).rejects.toThrow(/does not match the sha256/);
		} finally {
			await fs.rm(bad, { recursive: true, force: true });
		}
	});

	it('checks that the linked library honours the provider hook, rather than assuming it', () => {
		// A library without the hook ignores it silently and the run would report an engine it did
		// not use; tn93WasmOptions refuses in that case rather than mislabelling the provenance.
		expect(libraryHonoursProvider()).toBe(true);
	});

	it("runs the reference's own argv", () => {
		expect(TN93_ARGV).toEqual(['-t', '1.0', '-l', '1', '-q']);
	});

	it('checks the RECTANGULAR hook separately, because it is a separate call site', () => {
		// `tn93CrossDistanceMatrix` is what the dating pillar's divergences go through, and a library
		// tag could carry one hook without the other. The probe also pins the ARGUMENT ORDER, so a
		// library that ever called this hook the square way fails here rather than mis-indexing a
		// real matrix.
		expect(libraryHonoursCrossProvider()).toBe(true);
	});
});

describe.skipIf(!ready)('the two argv paths give the same distances', () => {
	// THE REPLACEMENT FOR THE PORT COMPARISON, and the one comparison still available: the engine
	// is asked the same question twice, by its two different command lines, and the answers must
	// line up. The square matrix is one FASTA and `tn93 -t 1.0 -l 1 -q -o out.csv in.fa`; the
	// rectangular one is two FASTAs and the same command plus `-s landmarks.fa`, reading n*m entries
	// at [i*m + j] instead of n*n at [i*n + j]. A provider that mis-indexes either — the failure this
	// whole module is built to prevent, because it returns a real matrix read the wrong way and
	// raises nothing — cannot satisfy both on a 476-taxon alignment.
	//
	// It does NOT check TN93 arithmetic. Nothing in this repository does any more; see the header.
	let square;
	let cross;
	beforeAll(async () => {
		square = await tn93WasmOptions();
		cross = await tn93CrossWasmOptions();
	}, 120000);

	for (const file of EXAMPLE_FILES) {
		it(`${file}: every landmark column equals the square matrix's own entry`, () => {
			const { names, sequences } = readFasta(file);
			// Three landmarks rather than one, so the [i*m + j] indexing is exercised in both axes.
			const landmarks = [names[0], names[Math.floor(names.length / 2)], names[names.length - 1]];
			const rows = names.filter((n) => !landmarks.includes(n));
			const sq = tn93DistanceMatrix(sequences, names, square);
			const cr = tn93CrossDistanceMatrix(sequences, rows, landmarks, cross);
			const n = names.length;
			const m = landmarks.length;
			const index = new Map(names.map((t, i) => [t, i]));
			let differing = 0;
			let worst = 0;
			for (let i = 0; i < rows.length; i++) {
				for (let j = 0; j < m; j++) {
					const want = sq[index.get(rows[i]) * n + index.get(landmarks[j])];
					const got = cr[i * m + j];
					if (got !== want) {
						differing++;
						worst = Math.max(worst, Math.abs(got - want));
					}
				}
			}
			expect({ file, differing, worst }).toEqual({ file, differing: 0, worst: 0 });
			// And the square matrix really is square: a zeroed diagonal and symmetry, not a row of
			// something else repeated. (dataset.py:816's `np.fill_diagonal(dist_mat, 0.0)`.)
			for (let i = 0; i < n; i++) expect(sq[i * n + i]).toBe(0);
			for (let i = 0; i < Math.min(n, 24); i++) {
				for (let j = 0; j < Math.min(n, 24); j++) expect(sq[i * n + j]).toBe(sq[j * n + i]);
			}
		}, 240000);
	}

	it('counts the pairs the tool declined to write rather than assuming there were none', () => {
		const { names, sequences } = readFasta(EXAMPLE_FILES[0]);
		const before = cross.tn93Stats.pairs;
		tn93CrossDistanceMatrix(sequences, names.slice(1), [names[0]], cross);
		expect(cross.tn93Stats.pairs).toBe(before + names.length - 1);
		expect(cross.tn93Stats.omitted).toBe(0);
	}, 120000);
});

describe("the library computes no distance of its own", () => {
	it('refuses a matrix with no engine rather than falling back to anything', () => {
		// The property that turns a forgotten `tn93Options` into a loud failure instead of a second
		// implementation quietly answering. It is UNCONDITIONAL in the library — a one-taxon matrix
		// refuses exactly as a thousand-taxon one does — because a rule that let small inputs through
		// would be the size-based engine selector this project rejected.
		const sequences = { a: 'ACGTACGTACGT', b: 'ACGTACGTATGT' };
		for (const taxa of [['a'], ['a', 'b']]) {
			const err = (() => {
				try {
					tn93DistanceMatrix(sequences, taxa);
					return null;
				} catch (e) {
					return e;
				}
			})();
			expect(err, `taxa=${taxa.length}`).toBeTruthy();
			expect(err.code).toBe('TN93_ENGINE_REQUIRED');
			expect(err.option).toBe('pairwiseDistances');
		}
		expect(() => tn93CrossDistanceMatrix(sequences, ['a'], ['b'])).toThrow(/TN93 engine/);
	});
});

describe.skipIf(!ready)("the library's wrapping is still the library's", () => {
	it('a MEASURED zero survives, the diagonal is zero, and the matrix is symmetric', async () => {
		// `a` and `b` differ only outside any position TN93 can score (trailing gaps), so the tool
		// reports 0 for a pair whose raw strings are not equal. dataset.py's matrix now starts at the
		// -1.0 "not written" sentinel rather than at 0.0, so a measured zero is distinguishable from a
		// missing entry and SURVIVES: the old 1e-4 floor (TN93_MIN_POSITIVE_DISTANCE) is unreachable,
		// which is the upstream repair the library's header records. What is checked here is that the
		// rounding, the sentinel and the imputation still happen in the LIBRARY, around whatever the
		// engine returns.
		const sequences = { a: 'ACGTACGTAC---', b: 'ACGTACGTAC--A', c: 'ACGTACGTTTGGA' };
		const names = ['a', 'b', 'c'];
		const m = tn93DistanceMatrix(sequences, names, await tn93WasmOptions());
		expect(m[0]).toBe(0); // the diagonal is a measurement of nothing, and is zero
		expect(m[4]).toBe(0);
		expect(m[8]).toBe(0);
		expect(m[1]).toBe(0); // a-b: distinct, measured 0, kept as the measurement it is
		expect(m[3]).toBe(m[1]); // and mirrored
		expect(m[2]).toBeGreaterThan(0); // a-c really differ
		expect(m[6]).toBe(m[2]);
		// float32, because the reference's matrix is float32 and the MDS squares it in float32.
		expect(m).toBeInstanceOf(Float32Array);
	}, 120000);
});

describe.skipIf(!ready)('input the compiled tool would refuse', () => {
	// Each of these is checked against the SAME alignment with the rewrite done BY HAND, so what is
	// proved is that `toolFasta`'s rewrite does not move a number — not that some other engine agrees
	// with this one about what the number is.
	it('a stop-codon asterisk is rewritten to an unknown, and that rewrite changes no distance', async () => {
		// examples/korber_env_gp160.fasta carries four '*' in one of its 143 sequences. The tool drops
		// characters outside its alphabet and then refuses the run because the surviving lengths
		// differ; this module rewrites them to '?', the slot the library already maps them to. Before
		// that rewrite this was a bare "tn93 exited 1" in the browser, on a real alignment.
		const wasm = await tn93WasmOptions();
		const names = ['a', 'b', 'c'];
		const starred = { a: 'ACGTACGTACGT', b: 'ACG*ACGTACGT', c: 'ACGTACGTATGT' };
		const byHand = { a: 'ACGTACGTACGT', b: 'ACG?ACGTACGT', c: 'ACGTACGTATGT' };
		expect(Array.from(tn93DistanceMatrix(starred, names, wasm))).toEqual(Array.from(tn93DistanceMatrix(byHand, names, wasm)));
	}, 120000);

	it('a ragged alignment is padded with gaps, and that padding changes no distance', async () => {
		// dataset.py pads shorter sequences with gaps on this path and says so. A gap carries
		// resolution weight 0 in the tool's `-a resolve` mode, so padding adds nothing to the counts —
		// which is exactly what this asserts, against the same input padded by hand.
		const wasm = await tn93WasmOptions();
		const names = ['a', 'b', 'c'];
		const ragged = { a: 'ACGTACGTACGT', b: 'ACGTACGTAC', c: 'ACGTACGTATGT' };
		const padded = { a: 'ACGTACGTACGT', b: 'ACGTACGTAC--', c: 'ACGTACGTATGT' };
		expect(Array.from(tn93DistanceMatrix(ragged, names, wasm))).toEqual(Array.from(tn93DistanceMatrix(padded, names, wasm)));
	}, 120000);
});

describe.skipIf(!ready)('saturation', () => {
	it('refuses rather than scoring an omitted pair', async () => {
		// Four sequences with no shared history: every pair reaches the tool's 1.0 threshold, so it
		// writes nothing. dataset.py would leave those entries at 0.0 and then impute them, which puts
		// the most distant pair in the alignment into the MDS as the closest — silently. The provider
		// raises instead, with the `tn93:` prefix `prepareRun` matches to produce TN93_UNCOMPUTABLE.
		// The same four sequences pipeline.test.js uses for this: ATG / TTT / GGG / CCC repeated.
		const codons = ['ATG', 'TTT', 'GGG', 'CCC'];
		const sequences = Object.fromEntries(['a', 'b', 'c', 'd'].map((n, i) => [n, codons[i].repeat(7)]));
		const names = ['a', 'b', 'c', 'd'];
		const module = await loadTn93Wasm();
		const provider = tn93Provider(module);
		expect(() => provider(names.map((n) => sequences[n]), names)).toThrow(/^tn93:/);
		// And through the library, which is the path a run actually takes.
		const wasm = await tn93WasmOptions();
		expect(() => tn93DistanceMatrix(sequences, names, wasm)).toThrow(/^tn93:/);
	}, 120000);
});
