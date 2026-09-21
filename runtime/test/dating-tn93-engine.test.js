/**
 * dating-tn93-engine.test.js — the dating pillar's distances come from veg/tn93's own compiled
 * code, and the record says so only when they did.
 *
 * WHY THIS FILE EXISTS. The bug it pins survived every existing suite. `runtime/src/tn93-wasm.js`
 * put the compiled engine behind the library's `pairwiseDistances` hook and `pipeline.js` used it,
 * but `runDating` never passed one: `computeTreeFreeDivergences` fell to the library's JavaScript
 * port on every surface, silently, while `ProvenancePanel.svelte` stood ready to report the
 * compiled engine. Nothing failed, because a missing hook is not an error — it is a slower run with
 * the same numbers, which is exactly the shape of defect a test has to be written on purpose to
 * catch. So the tests here do not check that an option was PASSED; they check that the hook was
 * CALLED, on the real chain, with a counting wrapper the library cannot ignore. The project's own
 * note names the failure mode: a library without the hook "would ignore the option and the run
 * would claim an engine it did not use".
 *
 * WHAT THE PORT'S DELETION TOOK WITH IT (2026-09-13). Half of this file used to be "compiled
 * against the port, identical": every root case on two real alignments, and a whole dating record
 * compared field by field. @veg/hyphaeon-js no longer contains a TN93 implementation — one engine,
 * veg/tn93, rather than two kept in step by hand — so that comparison has no second side and is
 * gone. What replaces it is an INVARIANCE check over this repository's own dispatch layer, which is
 * the part that has actually broken twice: the same run is made with the DUAL-shape provider and
 * with the narrow single-shape one, and the two records must be identical field for field. That
 * catches a mis-indexed matrix (the failure mode that returns real numbers read the wrong way and
 * raises nothing) without claiming to check TN93 arithmetic, which nothing here does any more. The
 * arithmetic is covered by the parity job and by the measurements recorded in
 * runtime/vendor/tn93/MANIFEST.json and in tn93-wasm.js's header.
 *
 * WHAT IS CHECKED:
 *   1. The hook is reached. `runDating` with the resolved options calls the provider and the record
 *      says `wasm`; with NONE the run now REFUSES (`Tn93EngineRequiredError` out of the library)
 *      instead of quietly computing the same numbers in JavaScript, which is the whole point of the
 *      deletion and is asserted here in place of the old "records `js`".
 *   2. The numbers do not move across this module's own plumbing. All four of
 *      `computeTreeFreeDivergences`'s root cases, on two real alignments, dual provider against
 *      narrow provider: every divergence identical, and a WHOLE dating record compared field by
 *      field. Case 3 is run BOTH ways — its rectangular branch and its square one (dating.js:1087
 *      and :1107), the second selected by a cohort of twelve, because the fixture this file shipped
 *      with dated taxa so that the earliest cohort was always eight or five and the square branch —
 *      the one that crashed — was never entered at all.
 *   3. The two call shapes cannot be confused, and a THIRD shape is refused rather than guessed at.
 *      The library calls the square hook with three arguments and the rectangular one with five; a
 *      square provider answering a cross call would return row 0 of the wrong matrix with no error
 *      at all. The library's own source is read here too, so a tag that adds a call site or changes
 *      a shape fails in this file rather than downstream of a wrongly-indexed matrix.
 *   4. `runDatingModelPass` reaches the hook too. Its square TN93 matrix is a MODEL INPUT
 *      (datingNeural.js note 4), and it had the same gap.
 *   5. The record names the engine that RAN. The label travels stamped on the options object, so an
 *      unstamped provider is `custom` however the caller labels it — the honesty line round one got
 *      wrong by inferring `wasm` from the presence of a function.
 *   6. `diagnose()` — the load every upload pays for, in four standalone callers — gets the engine
 *      as well, through `diagnoseUpload`, and the diagnosis it produces is unchanged.
 *   7. The engine is NOT chosen by the size of the job, at any size, and no selector can come back:
 *      the measured crossover is a cost, not a switch, and `'js'` is refused rather than routed.
 *
 * The alignments come from the engine checkout (HYPHAEON_ENGINE_DIR, default ../../HyphAeon), so
 * the suite skips rather than fails where that checkout is absent.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { computeTreeFreeDivergences, diagnose, parseAlignmentSequences } from '@veg/hyphaeon-js';

import { starsToGaps, verifyCodingAlignment } from '../src/dating/alignment.js';
import { runDating } from '../src/dating/run.js';
import { runDatingModelPass } from '../src/datingNeural.js';
import { ingestDates, taxaForDates } from '../src/dates/index.js';
import { diagnoseUpload } from '../src/pipeline.js';
import {
	TN93_ENGINE_KEY,
	loadTn93Wasm,
	resolveTn93Options,
	tn93CrossProvider,
	tn93CrossWasmOptions,
	tn93EngineOf,
	tn93WasmOptions
} from '../src/tn93-wasm.js';

const HERE = resolve(fileURLToPath(import.meta.url), '..');
const ENGINE = process.env.HYPHAEON_ENGINE_DIR ?? resolve(HERE, '..', '..', '..', 'HyphAeon');
const EXAMPLES = join(ENGINE, 'examples');
const KORBER = join(EXAMPLES, 'korber_env_gp160.fasta');
const H5N1 = join(EXAMPLES, 'H5N1_HA_geo.fasta');
const ready = existsSync(KORBER) && existsSync(H5N1);
if (!ready) console.warn(`\n[dating-tn93-engine] examples not found at ${EXAMPLES}; cases skipped.\n`);

/** The sequences this pillar measures distances on: verified, trimmed, `*` read as a gap. */
function pillarSequences(path) {
	const text = readFileSync(path, 'utf8');
	const verified = verifyCodingAlignment(parseAlignmentSequences(text), { allowStopCodons: true, autoTrimTrailing: true });
	return starsToGaps(verified.sequences).sequences;
}

function datesFor(path) {
	const text = readFileSync(path, 'utf8');
	return ingestDates({ taxa: taxaForDates(text), source: null });
}

/** `pairwiseDistances`, wrapped so a test can prove the library reached it. */
function counting(options) {
	const seen = { calls: 0, pairs: 0 };
	const inner = options.pairwiseDistances;
	return {
		seen,
		options: {
			...options,
			pairwiseDistances: (...args) => {
				seen.calls += 1;
				const out = inner(...args);
				seen.pairs += out.length;
				return out;
			}
		}
	};
}

/** Every leaf that differs between two plain structures, as [path, a, b]. */
function deepDiff(a, b, path = '', out = []) {
	if (a === b) return out;
	if (typeof a === 'number' && typeof b === 'number') {
		if (!(Number.isNaN(a) && Number.isNaN(b)) && a !== b) out.push([path, a, b]);
		return out;
	}
	if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
		out.push([path, a, b]);
		return out;
	}
	for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) deepDiff(a[k], b[k], path ? `${path}.${k}` : k, out);
	return out;
}

/** What a run is allowed to differ in: the clock, and the engine label itself. */
const EXPECTED_TO_DIFFER = /elapsed_seconds|elapsedSeconds|tn93_engine|tn93_pairs_omitted/;

describe('the two call shapes are not interchangeable', () => {
	let square;
	let cross;
	beforeAll(async () => {
		square = await tn93WasmOptions();
		cross = await tn93CrossWasmOptions();
	}, 120000);

	it('the square provider refuses a rectangular call rather than answering it wrongly', () => {
		// tn93CrossDistanceMatrix calls (allSeqs, lmSeqs, taxaAll, taxaLandmarks, threshold) and reads
		// [i*m + j]. With one landmark that is out[i] — row 0 of the square matrix — so an unguarded
		// square provider returns every taxon's distance to whichever sequence came first, as its
		// distance to the root, with no error anywhere.
		expect(() => square.pairwiseDistances(['ACG', 'ACT'], ['AGG'], ['a', 'b'], ['r'], 100)).toThrow(/RECTANGULAR hook signature/);
	});

	it('the rectangular provider refuses a square call', async () => {
		// The SINGLE-SHAPE provider still refuses, so wiring it in directly stays an error rather
		// than a silent wrong answer. What `tn93CrossWasmOptions` returns is the DUAL provider below.
		const bare = tn93CrossProvider(await loadTn93Wasm());
		expect(() => bare(['ACG', 'ACT'], ['a', 'b'], 100)).toThrow(/SQUARE hook signature/);
	});

	it('the object handed to computeTreeFreeDivergences answers BOTH shapes, each with its own matrix', () => {
		// THE BUG THIS PINS. `computeTreeFreeDivergences` hands ONE options object to whichever
		// library function its root case picks, and case 3 picks between them at runtime on the size
		// of the earliest cohort: rectangular at dating.js:1087, SQUARE at dating.js:1107 when the
		// cohort is larger than ten. A cross-only provider threw the arity guard out of `runDating`
		// on that branch — uncaught, because `isTn93Refusal` matches the prefix `tn93:` and the
		// guard's message does not.
		// Real-ish sequences: three bases apart is saturated at the tool's 1.0 threshold, and a
		// declined pair is a refusal on the square shape by design (see tn93-wasm.js's header).
		const A = 'ACGTACGTACGTACGTACGTACGTACGTACGT';
		const B = 'ACGTACGTACGTACGTACGTACGTACGTACGA';
		const C = 'ACGTACGTACGTACGTACGTACGTACGTACTA';
		const sq = cross.pairwiseDistances([A, B, C], ['a', 'b', 'c'], 100);
		expect(sq.length).toBe(9);
		// A real square matrix: symmetric, zero diagonal — not row 0 of something else.
		for (let i = 0; i < 3; i++) {
			expect(sq[i * 3 + i]).toBe(0);
			for (let j = 0; j < 3; j++) expect(sq[i * 3 + j]).toBe(sq[j * 3 + i]);
		}
		const cr = cross.pairwiseDistances([A, B, C], [C], ['a', 'b', 'c'], ['r'], 100);
		expect(cr.length).toBe(3);
		// The two shapes agree where they measure the same pair: column 0 of the cross is the
		// distance to 'AGG', which is row 2 of the square.
		expect(cr[0]).toBe(sq[0 * 3 + 2]);
		expect(cr[1]).toBe(sq[1 * 3 + 2]);
	});

	it('every hook call the library can make is one of the two shapes, and both are answered', async () => {
		// The enumeration this file rests on, checked against the linked library rather than trusted:
		// `pairwiseDistances` is called from exactly two places in preprocess/tn93.js — the square
		// matrix and the cross matrix — and those two functions are called from six places, five of
		// them in computeTreeFreeDivergences (dating.js:1049, :1066, :1087, :1107, :1136) and one in
		// assemble.js. If a tag ever adds a third call site or changes a shape, this fails here
		// instead of somewhere downstream of a wrongly-indexed matrix.
		// The LINKED library, resolved rather than guessed at, so this reads the tag the runtime runs.
		const libSrc = resolve(createRequire(import.meta.url).resolve('@veg/hyphaeon-js'), '..');
		const tn93Src = readFileSync(join(libSrc, 'preprocess', 'tn93.js'), 'utf8');
		const calls = [...tn93Src.matchAll(/options\.pairwiseDistances\(([^)]*)\)/g)].map((m) => m[1].split(',').length);
		expect(calls, 'the library calls the hook in exactly the two shapes this module answers').toEqual([3, 5]);
		const datingSrc = readFileSync(join(libSrc, 'dating.js'), 'utf8');
		expect([...datingSrc.matchAll(/\btn93CrossDistanceMatrix\(/g)]).toHaveLength(4);
		expect([...datingSrc.matchAll(/\btn93DistanceMatrix\(/g)]).toHaveLength(1);
	});

	it('a shape that is NEITHER is refused by every provider, never answered', async () => {
		// The silent-wrong-answer class in general, not just the two known confusions. An argument
		// count the library does not use, or five arguments whose lists do not line up, is a shape
		// this module does not understand — and answering it would return a matrix indexed the wrong
		// way with no error at all, which is the one failure this file exists to make impossible.
		const dual = cross.pairwiseDistances;
		const bad = [
			[['ACG', 'ACT'], ['a', 'b'], 100, 'extra'], // four arguments: no such call site
			[['ACG', 'ACT'], ['AGG'], ['a', 'b'], ['r', 'r2'], 100], // five, but taxaLandmarks is longer than lmSeqs
			[['ACG', 'ACT'], ['a', 'b', 'c'], 100], // three, but the taxa list does not match the sequences
			[['ACG', 'ACT'], 'a,b', 100] // three, but the taxa are not a list at all
		];
		for (const args of bad) {
			expect(() => dual(...args), `dual provider on ${args.length} argument(s)`).toThrow(/unrecognised pairwiseDistances signature/);
			expect(() => square.pairwiseDistances(...args)).toThrow(/unrecognised pairwiseDistances signature/);
		}
		// The ONE omission that is allowed, and only on the square shape: the threshold is the last
		// argument and cannot change how the result is read, and this repository's own suites call a
		// provider that way (tn93-wasm.test.js's saturation case).
		expect(() => dual(['ACGTT', 'ACGTA'], ['a', 'b'])).not.toThrow();
	});

	it('the library honours both hooks, and is asked rather than assumed', async () => {
		// A library tag without the hook ignores the option in silence, so the loader probes it and
		// refuses instead of reporting an engine that did not run.
		const { libraryHonoursCrossProvider, libraryHonoursProvider } = await import('../src/tn93-wasm.js');
		expect(libraryHonoursProvider()).toBe(true);
		expect(libraryHonoursCrossProvider()).toBe(true);
	});
});

describe.skipIf(!ready)('runDating reaches the compiled engine', () => {
	it('calls the hook it was handed, and records `wasm` only then', async () => {
		const resolved = await resolveTn93Options({ shape: 'cross' });
		expect(resolved.tn93Engine).toBe('wasm');
		const probe = counting(resolved.tn93Options);

		const alignmentText = readFileSync(H5N1, 'utf8');
		const dates = datesFor(H5N1);
		const base = { alignmentText, alignmentName: 'H5N1_HA_geo.fasta', dates, timeUnits: dates.time_units };

		const compiled = runDating({ ...base, tn93Options: probe.options, tn93Engine: 'wasm' });
		expect(compiled.ok).toBe(true);
		// THE ASSERTION THE BUG WOULD HAVE FAILED: the library actually called the provider. Checking
		// the recorded label alone would have passed against a run that ignored the option.
		expect(probe.seen.calls).toBeGreaterThan(0);
		expect(probe.seen.pairs).toBeGreaterThan(0);
		expect(compiled.record.primaeon.tn93_engine).toBe('wasm');
		expect(compiled.tn93Engine).toBe('wasm');

		// AND THE OTHER DIRECTION, WHICH IS THE ONE THE DELETION CHANGED. With nothing handed in the
		// run used to complete on the library's JavaScript port and record `js`. There is no port, so
		// it now refuses — loudly, out of the library, naming the option that is missing — rather than
		// producing a date from an engine nobody chose.
		let err = null;
		try {
			runDating(base);
		} catch (e) {
			err = e;
		}
		expect(err, 'a tn93-mode run with no engine must refuse, not compute').toBeTruthy();
		expect(err.code).toBe('TN93_ENGINE_REQUIRED');
		expect(err.option).toBe('pairwiseDistances');
	}, 120000);

	it("rejects tn93Engine: 'js' instead of quietly meaning something else by it", async () => {
		// The option named the library's port. Routing it to "use my own provider" would answer a
		// request for particular ARITHMETIC with a slot to plug something into; refusing finds the
		// callers instead. The escape hatch is separate and already exists: hand in
		// `options.pairwiseDistances` and the result is stamped `custom`.
		const err = await resolveTn93Options({ engine: 'js' }).then(
			() => null,
			(e) => e
		);
		expect(err).toBeTruthy();
		expect(err.code).toBe('TN93_ENGINE_UNAVAILABLE');
		expect(err.stage).toBe('js_requested');
		expect(err.message).toMatch(/deleted/);
		expect(err.message).toMatch(/custom/);
	}, 120000);

	it('refuses a compiled build whose bytes do not verify, with a hint a person can act on', async () => {
		// The case that used to be a NOTE and a slower run. It is the end of every tree-free analysis
		// on that installation now, so the refusal has to say which build, which file and what the
		// sha256 check found — checked here on the path a dating surface actually resolves through.
		const err = await resolveTn93Options({ shape: 'cross', wasm: { vendorDir: join(HERE, 'no-such-tn93-vendor-dir') } }).then(
			() => null,
			(e) => e
		);
		expect(err).toBeTruthy();
		expect(err.code).toBe('TN93_ENGINE_UNAVAILABLE');
		expect(err.stage).toBe('manifest');
		expect(err.files.join(' ')).toMatch(/no-such-tn93-vendor-dir/);
		expect(err.hint).toBeTruthy();
	}, 120000);
});

describe.skipIf(!ready)('the numbers do not move across this module\'s own plumbing', () => {
	// WHAT THIS COMPARES, NOW THAT THERE IS NO PORT. `cross` is the DUAL-shape provider — one object
	// that answers both of the library's hooks, which is what `computeTreeFreeDivergences` needs
	// because case 3 picks its shape at runtime from the data. `narrow` is the single-shape provider
	// for whichever hook the case reaches. Both run veg/tn93's compiled code; what differs is this
	// repository's dispatch in between, and that dispatch is what has broken twice (a square provider
	// answering a cross call with row 0 of the wrong matrix, and a cross-only provider throwing on
	// case 3's square branch). Identical records mean the dual provider routed every call to the same
	// matrix the narrow one computes directly. It is not a check of TN93 arithmetic; see the header.
	let cross;
	let narrowCross;
	let narrowSquare;
	beforeAll(async () => {
		cross = await tn93CrossWasmOptions();
		const module = await loadTn93Wasm();
		narrowCross = { [TN93_ENGINE_KEY]: 'wasm', pairwiseDistances: tn93CrossProvider(module) };
		narrowSquare = await tn93WasmOptions();
	}, 120000);

	// The four cases of computeTreeFreeDivergences (dating.py:624-698) — and case 3 TWICE, because
	// it is two different library functions.
	//
	// THE FIXTURE THIS REPLACES COULD NOT SEE THE BUG. It dated taxon i to `2000 + (i % 20)`, which
	// makes the earliest cohort 8 taxa on korber and 5 on H5N1 — both at or under the `> 10` that
	// dating.js:1086 tests, so every `earliest` case went down the RECTANGULAR branch at :1087 and
	// the square one at :1107 was never called at all. `2000 + floor(i / 12)` gives twelve taxa the
	// earliest date instead, which is the branch that crashed. `squareCalls` is asserted rather than
	// assumed: `earliest_cohort_n12` is the description BOTH branches write, so the only honest proof
	// of which one ran is the hook the library actually reached.
	const COHORTS = [
		{ name: 'small cohort (rectangular, dating.js:1087)', dates: (/** @type {string[]} */ t) => new Map(t.map((x, i) => [x, 2000 + (i % 20)])), square: false },
		{ name: 'large cohort (SQUARE, dating.js:1107)', dates: (/** @type {string[]} */ t) => new Map(t.map((x, i) => [x, 2000 + Math.floor(i / 12)])), square: true }
	];
	for (const file of ['korber_env_gp160.fasta', 'H5N1_HA_geo.fasta']) {
		for (const cohort of COHORTS) {
			it(`${file}, ${cohort.name}: every root case, compiled against the port, identical`, () => {
				const seqs = pillarSequences(join(EXAMPLES, file));
				const taxa = [...seqs.keys()];
				const dates = cohort.dates(taxa);
				for (const rootTaxon of [null, 'earliest', 'unweighted_consensus', taxa[0]]) {
					const dated = taxa.filter((t) => t !== rootTaxon);
					const before = cross.tn93Stats.squareCalls;
					const dual = computeTreeFreeDivergences(seqs, dated, dates, { ...cross, rootTaxon });
					// Case 3 and a cohort over ten is the square hook, and nothing else here is.
					const wantSquare = cohort.square && rootTaxon === 'earliest';
					expect({ root: rootTaxon, square: cross.tn93Stats.squareCalls > before }).toEqual({ root: rootTaxon, square: wantSquare });
					if (wantSquare) expect(dual.root_description).toMatch(/^earliest_cohort_n(1[1-9]|[2-9]\d)/);
					// The SAME case through the narrow provider for the shape it actually reaches. A
					// dual provider that routed a call to the wrong matrix would differ here.
					const narrow = computeTreeFreeDivergences(seqs, dated, dates, {
						...(wantSquare ? narrowSquare : narrowCross),
						rootTaxon
					});
					expect(dual.case, `root case for ${rootTaxon}`).toBe(narrow.case);
					expect(dual.taxa).toEqual(narrow.taxa);
					expect(dual.root_description).toBe(narrow.root_description);
					let worst = 0;
					for (let i = 0; i < narrow.divergences.length; i++) {
						worst = Math.max(worst, Math.abs(narrow.divergences[i] - dual.divergences[i]));
					}
					expect({ root: rootTaxon, worst }).toEqual({ root: rootTaxon, worst: 0 });
					// And the divergences really were measured rather than left at a default: a root
					// case that returned zeros everywhere would satisfy every equality above.
					expect(dual.divergences.some((d) => d > 0)).toBe(true);
				}
				// No pair was left unwritten at the tool's 1.0 threshold on either alignment, which is the
				// one condition under which the two engines are allowed to disagree (tn93-wasm.js header).
				expect(cross.tn93Stats.omitted).toBe(0);
			}, 180000);
		}
	}

	it("case 3's SQUARE sub-branch: a large earliest cohort still runs, and matches the port", () => {
		// `--root-taxon earliest` takes dating.js:1107's square branch when the earliest cohort holds
		// MORE THAN TEN sequences and the alignment is under 2500 — ordinary with year-granularity
		// dates. H5N1_HA_geo has one 1996 sequence and twenty from 1997, so excluding the 1996 one
		// makes the cohort 20 and selects that branch. This is the case the fix's first shape guard
		// crashed: `runDating` threw the arity error, uncaught, where the port fitted a clock.
		const alignmentText = readFileSync(join(EXAMPLES, 'H5N1_HA_geo.fasta'), 'utf8');
		const dates = ingestDates({
			taxa: taxaForDates(alignmentText),
			source: readFileSync(join(EXAMPLES, 'H5N1_HA_metadata.csv'), 'utf8'),
			sourceName: 'H5N1_HA_metadata.csv'
		});
		const earliest = dates.rows.filter((r) => r.value === 1996).map((r) => r.taxon);
		expect(earliest).toHaveLength(1);
		const base = { alignmentText, dates, rootTaxon: 'earliest', excludedTaxa: earliest, timeUnits: dates.time_units };

		// Narrow SQUARE provider against the dual one: this branch calls tn93DistanceMatrix, so the
		// narrow square provider answers it directly and the dual one has to route it there.
		const narrow = runDating({ ...base, tn93Options: narrowSquare, tn93Engine: 'wasm' });
		const compiled = runDating({ ...base, tn93Options: cross, tn93Engine: 'wasm' });
		expect(narrow.ok).toBe(true);
		expect(compiled.ok).toBe(true);
		// The cohort really is the square branch's: more than ten, fewer than 2500 dated taxa.
		expect(compiled.record.primaeon.root_taxa.length).toBeGreaterThan(10);
		expect(compiled.record.root_description).toMatch(/^earliest_cohort_n\d+$/);
		expect(deepDiff(narrow.record, compiled.record).filter(([p]) => !EXPECTED_TO_DIFFER.test(p))).toEqual([]);
		expect(deepDiff(narrow.rows, compiled.rows).filter(([p]) => !EXPECTED_TO_DIFFER.test(p))).toEqual([]);
	}, 180000);

	it('a whole dating record is the same record through either provider', () => {
		const alignmentText = readFileSync(KORBER, 'utf8');
		const dates = datesFor(KORBER);
		const base = { alignmentText, alignmentName: 'korber_env_gp160.fasta', dates, timeUnits: dates.time_units };
		const compiled = runDating({ ...base, tn93Options: cross, tn93Engine: 'wasm' });
		const narrow = runDating({ ...base, tn93Options: narrowCross, tn93Engine: 'wasm' });
		expect(compiled.ok && narrow.ok).toBe(true);
		expect(narrow.rows.length).toBeGreaterThan(100);
		// A real fit, not two matching nulls: the estimate exists and the divergences are not zero.
		expect(Number.isFinite(compiled.record.ols.t_mrca)).toBe(true);
		expect(compiled.divergences.some((d) => d > 0)).toBe(true);

		const recordDiff = deepDiff(narrow.record, compiled.record).filter(([p]) => !EXPECTED_TO_DIFFER.test(p));
		expect(recordDiff).toEqual([]);
		const rowDiff = deepDiff(narrow.rows, compiled.rows).filter(([p]) => !EXPECTED_TO_DIFFER.test(p));
		expect(rowDiff).toEqual([]);
		expect(compiled.warnings.map((w) => w.code)).toEqual(narrow.warnings.map((w) => w.code));
	}, 180000);
});

describe.skipIf(!ready)('the dating model pass reaches the hook as well', () => {
	it('hands its square TN93 matrix to the engine before it ever calls the graph', async () => {
		// The pass builds `loadAlignmentAndTree(..., {useTn93: true})` — a square N*N matrix that goes
		// into the MDS the graph reads, so it is a model INPUT and not a diagnostic. It had the same
		// gap as runDating. The graph itself is not needed to prove the distance step: the session
		// stub below fails at the first batch, by which time the matrix is long since built.
		const square = await tn93WasmOptions();
		const probe = counting(square);
		const alignmentText = readFileSync(H5N1, 'utf8');
		await expect(
			runDatingModelPass({
				alignmentText,
				session: { session: {}, ort: {} },
				tn93Options: probe.options
			})
		).rejects.toBeTruthy();
		expect(probe.seen.calls, 'the pass computed its distances without the engine').toBeGreaterThan(0);
	}, 180000);

	it('goes through the loader rather than round the side of it', async () => {
		// Proof that the pass's own default path IS the loader, without needing a graph: point it at a
		// vendor directory that does not exist and demand the compiled engine. A pass that computed
		// its distances in JavaScript would sail past this and fail at the stub session instead.
		const alignmentText = readFileSync(H5N1, 'utf8');
		await expect(
			runDatingModelPass({
				alignmentText,
				session: { session: {}, ort: {} },
				tn93Engine: 'wasm',
				tn93Wasm: { vendorDir: join(HERE, 'no-such-tn93-vendor-dir') }
			})
		).rejects.toThrow(/no-such-tn93-vendor-dir|ENOENT/);
	}, 180000);
});

describe.skipIf(!ready)('the record names the engine that ran, and cannot be told otherwise', () => {
	// R3. Round one derived the label as `tn93Engine ?? (tn93Options?.pairwiseDistances ? 'wasm' :
	// 'js')`, so ANY provider was reported as veg/tn93's compiled code — a caller's own, a test
	// double, or this module's own object after a future fallback to the port. A label like that is
	// worse than no label: the provenance panel prints it and a reader cannot tell it apart from one
	// that was earned. The label now travels ON the options object, stamped by the resolution that
	// actually happened (`TN93_ENGINE_KEY`), and is read, never inferred.
	let crossOptions;
	beforeAll(async () => {
		crossOptions = (await resolveTn93Options({ shape: 'cross' })).tn93Options;
	}, 120000);

	const baseRun = () => {
		const alignmentText = readFileSync(H5N1, 'utf8');
		const dates = datesFor(H5N1);
		return { alignmentText, dates, timeUnits: dates.time_units };
	};

	it('an UNSTAMPED provider is `custom`, however loudly the caller claims `wasm`', () => {
		// The exact shape of the old bug: someone else's engine behind the hook, announced as ours.
		const borrowed = { pairwiseDistances: (...args) => crossOptions.pairwiseDistances(...args) };
		const run = runDating({ ...baseRun(), tn93Options: borrowed, tn93Engine: 'wasm' });
		expect(run.ok).toBe(true);
		expect(run.record.primaeon.tn93_engine).toBe('custom');
		expect(run.tn93Engine).toBe('custom');
	}, 120000);

	it('the stamp decides, and the key it is written under is the one tn93-wasm.js writes', () => {
		// `src/dating/` may not import `../tn93-wasm.js` (dating-port.test.js's import-graph rule), so
		// run.js spells the key as a literal. This is the test that keeps the two spellings equal: the
		// object below is stamped only through the exported constant.
		expect(TN93_ENGINE_KEY).toBe('tn93Engine');
		const stampedCustom = { [TN93_ENGINE_KEY]: 'custom', pairwiseDistances: (...args) => crossOptions.pairwiseDistances(...args) };
		expect(runDating({ ...baseRun(), tn93Options: stampedCustom }).record.primaeon.tn93_engine).toBe('custom');
		const stampedWasm = { ...crossOptions };
		expect(runDating({ ...baseRun(), tn93Options: stampedWasm }).record.primaeon.tn93_engine).toBe('wasm');
		// A STAMP NO LONGER MAKES AN ENGINE EXIST. 'js' named the library's port, which is deleted; a
		// record carrying it would be a claim about code this build does not contain, so it is not a
		// value this run can be told to write. The object still has a provider, so the run completes
		// and the honest label for a provider nothing here vouches for is `custom`.
		const stampedJs = { [TN93_ENGINE_KEY]: 'js', pairwiseDistances: (...args) => crossOptions.pairwiseDistances(...args) };
		expect(runDating({ ...baseRun(), tn93Options: stampedJs }).record.primaeon.tn93_engine).toBe('custom');
		// And with no options at all there is no engine, so the run refuses rather than recording one.
		expect(() => runDating(baseRun())).toThrow(/no compiled TN93 engine/);
	}, 120000);

	it('the omitted-pair count is this run\'s, not the counter\'s running total', () => {
		// `tn93Stats` lives on the options object, and a surface resolves that ONCE and reuses it for
		// every job it serves (the server's worker pool, an MCP session, a re-run in the browser's
		// dating worker). Read after the call rather than as a delta, the second run reports every
		// pair the first one omitted as well — a number in the record and in a `warn` that was never
		// measured on the alignment it is attached to. The stub below omits two pairs per call, so
		// two runs of the same options object must each report two.
		const stats = { pairs: 0, omitted: 0, calls: 0, squareCalls: 0 };
		const stub = {
			[TN93_ENGINE_KEY]: 'wasm',
			tn93Stats: stats,
			pairwiseDistances: (...args) => {
				const out = crossOptions.pairwiseDistances(...args);
				stats.calls += 1;
				stats.pairs += out.length;
				stats.omitted += 2;
				return out;
			}
		};
		const first = runDating({ ...baseRun(), tn93Options: stub });
		const second = runDating({ ...baseRun(), tn93Options: stub });
		expect(first.record.primaeon.tn93_pairs_omitted).toBe(2);
		expect(second.record.primaeon.tn93_pairs_omitted).toBe(2);
		expect(stats.omitted, 'the counter itself keeps accumulating; the record does not').toBe(4);
		const note = second.warnings.find((w) => w.code === 'DATING_TN93_PAIRS_OMITTED');
		expect(note.data).toMatchObject({ omitted: 2, engine: 'wasm' });
		expect(note.data.pairs).toBeGreaterThan(0);
		expect(note.data.pairs).toBeLessThanOrEqual(stats.pairs / 2);
	}, 120000);

	it('every object this module hands out carries its own engine, and `custom` is what unstamped means', async () => {
		expect(tn93EngineOf(crossOptions)).toBe('wasm');
		expect(tn93EngineOf(await tn93WasmOptions())).toBe('wasm');
		expect(tn93EngineOf({ pairwiseDistances: () => [] })).toBe('custom');
		// NO ENGINE IS `null`, NOT `'js'`. An options object with no provider is not a run computing
		// its distances in JavaScript; it is a run that cannot start (the library throws at the first
		// matrix). Reporting it as an engine name would put a claim in the record for a run that
		// produced no distance at all.
		expect(tn93EngineOf(null)).toBe(null);
		expect(tn93EngineOf({ matchMode: 'resolve' })).toBe(null);
		// And a stale `'js'` stamp is not honoured into existence either.
		expect(tn93EngineOf({ [TN93_ENGINE_KEY]: 'js', pairwiseDistances: () => [] })).toBe('custom');
	}, 120000);
});

describe('the compiled engine is the engine, at every size, with nothing behind it', () => {
	// The measurements say the compiled build cannot pay back its ~90 ms of load below a few
	// thousand pairs, and an earlier draft of this work turned that into a switch: small jobs went
	// to the port. That was wrong, and this block is what stops it coming back.
	//
	// veg/tn93 is a repository this project's authors maintain, and the vendored build is how its
	// updates arrive here. A JavaScript port is a second implementation of the same arithmetic, kept
	// in step by hand — so a path still able to run it is a path where the two can silently diverge
	// the day upstream changes. The compiled target was asked for on that ground, and it overrides
	// the timing. The port has now been DELETED rather than demoted to a fallback, so there is no
	// longer anything for a size rule, a shape rule or a surface to select.
	it('resolves `auto` to the compiled engine no matter how small the job is', async () => {
		for (const pairs of [1, 10, 153, 3499, 10 ** 9]) {
			const out = await resolveTn93Options({ shape: 'cross', pairs });
			expect(out.tn93Engine, `pairs=${pairs}`).toBe('wasm');
			expect(typeof out.tn93Options.pairwiseDistances).toBe('function');
		}
	}, 120000);

	it('has no size-based selector and no fallback path left to reintroduce a second engine', async () => {
		const src = readFileSync(new URL('../src/tn93-wasm.js', import.meta.url), 'utf8');
		// The prose explains why the crossover is NOT a switch; no live code may branch on it.
		expect(src).not.toMatch(/export const TN93_WASM_BREAK_EVEN_PAIRS/);
		expect(src).not.toMatch(/export function tn93EngineForPairs/);
		expect(src).not.toMatch(/return ported\(/);
		// And nothing may hand back an options object claiming the deleted port.
		expect(src).not.toMatch(/TN93_ENGINE_KEY\]: 'js'/);
	});

	it('an explicit `wasm` is honoured, and `js` is refused rather than routed', async () => {
		expect((await resolveTn93Options({ engine: 'wasm', pairs: 1 })).tn93Engine).toBe('wasm');
		expect((await resolveTn93Options({ shape: 'cross' })).tn93Engine).toBe('wasm');
		await expect(resolveTn93Options({ engine: 'js', pairs: 10 ** 9 })).rejects.toThrow(/TN93 engine/);
		// An engine name that never existed is refused the same way, rather than falling through to
		// the compiled build and quietly succeeding.
		await expect(resolveTn93Options({ engine: 'native' })).rejects.toThrow(/not an engine this product has/);
	}, 120000);

	it("a caller's own provider is still accepted, and is labelled `custom` rather than ours", async () => {
		// The escape hatch `'js'` must not be re-pointed at. It is separate, explicit, and honest
		// about whose numbers these are.
		const mine = { pairwiseDistances: () => new Float64Array(4) };
		const out = await resolveTn93Options({ options: mine });
		expect(out.tn93Engine).toBe('custom');
		expect(out.tn93Options).toBe(mine);
	}, 120000);
});

describe.skipIf(!ready)('diagnose() gets the engine too, on the path every upload takes', () => {
	// R2. `diagnose()` does a model-level load of its own (diagnostics.js:654) and the library's
	// signature has no `tn93Options`, so a tree-free diagnose computed its whole N*N matrix with the
	// port — on every upload, in four standalone callers (web prep.worker, mcp tools, mcp validate,
	// server validate), before anything else ran. `diagnoseUpload` closes it through `diagnose`'s own
	// `parsed` argument, with NO library change.
	it('reaches the hook, and reports the engine that computed the matrix', async () => {
		const alignmentText = readFileSync(KORBER, 'utf8');
		const resolved = await resolveTn93Options();
		const probe = counting(resolved.tn93Options);
		const out = await diagnoseUpload({ alignmentText, tn93Options: probe.options });
		// THE ASSERTION THE BUG WOULD HAVE FAILED: the library called the provider during diagnose.
		expect(probe.seen.calls).toBeGreaterThan(0);
		expect(out.tn93_engine).toBe('wasm'); // the probe is a wrapper around a STAMPED object
		expect(out.summary.taxaUsed).toBe(143);
	}, 180000);

	it('changes nothing about the diagnosis itself', async () => {
		// The engine is a question of who multiplies; the report a reader sees must be the same one.
		// `parsed` and `tn93Options` are the only mechanisms used, so this is the test that they were
		// used faithfully — `diagnose` given the same engine directly must produce the same document.
		const alignmentText = readFileSync(KORBER, 'utf8');
		const { tn93Options } = await resolveTn93Options();
		const plain = diagnose({ alignmentText, tn93Options });
		const withEngine = await diagnoseUpload({ alignmentText });
		expect(withEngine.ok).toBe(plain.ok);
		expect(withEngine.summary).toEqual(plain.summary);
		expect(withEngine.warnings).toEqual(plain.warnings);
		expect(withEngine.tn93_engine).toBe('wasm');
	}, 180000);

	it('reports a missing engine as a refusal rather than throwing out of a diagnosis', async () => {
		// `diagnose()` is what a surface runs to find out what is wrong with an upload, so it must not
		// be the thing that explodes. With the port deleted a tree-free diagnosis cannot be produced
		// at all without an engine — bare `diagnose` throws — and `diagnoseUpload` turns that into a
		// `refuse` row a panel can render, carrying the stage, the release, the files and the hint.
		const alignmentText = readFileSync(KORBER, 'utf8');
		const out = await diagnoseUpload({ alignmentText, tn93Wasm: { vendorDir: join(HERE, 'no-such-tn93-vendor-dir') } });
		expect(out.ok).toBe(false);
		expect(out.tn93_engine).toBe(null);
		const row = out.warnings.find((w) => w.code === 'TN93_ENGINE_UNAVAILABLE');
		expect(row, 'the refusal must be a diagnostic, not an exception').toBeTruthy();
		expect(row.severity).toBe('refuse');
		expect(row.data.stage).toBe('manifest');
		expect(row.data.hint).toBeTruthy();
		expect(out.tn93_engine_error.code).toBe('TN93_ENGINE_UNAVAILABLE');
		// AND IT IS NOT THE SATURATION REFUSAL. Reporting a missing engine as TN93_SATURATED_PAIRS
		// would tell a reader their alignment is too divergent to measure when nothing measured it.
		expect(out.warnings.some((w) => w.code === 'TN93_SATURATED_PAIRS')).toBe(false);
	}, 180000);

	it('does not load an engine for a run that will not compute a TN93 matrix', async () => {
		// A tree with usable branch lengths is the tree path (D22): no distances to compute, so
		// nothing to load, and the label says so rather than naming an engine that never ran.
		const alignmentText = readFileSync(join(EXAMPLES, 'bat_oas1.fasta'), 'utf8');
		const treeText = readFileSync(join(EXAMPLES, 'bat_oas1.nwk'), 'utf8');
		const out = await diagnoseUpload({ alignmentText, treeText });
		expect(out.tn93_engine).toBe(null);
		expect(out.warnings).toEqual(diagnose({ alignmentText, treeText }).warnings);
		// And it really did not load one: a vendor directory that does not exist changes nothing here.
		const noEngine = await diagnoseUpload({ alignmentText, treeText, tn93Wasm: { vendorDir: join(HERE, 'no-such-tn93-vendor-dir') } });
		expect(noEngine.ok).toBe(out.ok);
		expect(noEngine.warnings).toEqual(out.warnings);
	}, 180000);

	it('takes the compiled engine even on a small upload, and matches `diagnose` exactly', async () => {
		// 18 taxa is 153 pairs: about 3 ms ported against ~90 ms of load, so this is the case where the
		// timings most want the port — and it still takes the compiled build, because one engine that
		// tracks veg/tn93 is worth more than 90 ms on an upload check. The diagnosis is identical.
		const alignmentText = readFileSync(join(EXAMPLES, 'bat_oas1.fasta'), 'utf8');
		const out = await diagnoseUpload({ alignmentText });
		expect(out.tn93_engine).toBe('wasm');
		expect(out.tn93_engine_error).toBeNull();
		expect(out.warnings).toEqual(diagnose({ alignmentText, tn93Options: (await resolveTn93Options()).tn93Options }).warnings);
	}, 180000);
});
