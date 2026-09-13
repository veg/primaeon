/**
 * dating-model.test.js — the model-based half of the dating pillar, end to end, through the real
 * dating graph under onnxruntime-node.
 *
 * WHY THIS FILE EXISTS, SEPARATELY FROM dating-port.test.js. That file's whole point is that the
 * pillar it tests loads NO model: it asserts the import boundary under `src/dating/` and would have
 * to be weakened to reach a session. This one is the other side — it loads `general_taxa.onnx`,
 * runs every codon of an alignment through it, and follows the two matrices that come back all the
 * way to a date. Splitting them keeps the mechanical proof intact and makes a failure legible: if
 * `dating-port.test.js` is green and this is red, the model-free chain is fine and the fault is in
 * the graph, the kernel or one of the two new fits.
 *
 * FOUR LAYERS, EACH FAILING FOR A DIFFERENT REASON:
 *
 *   1. THE MANIFEST AND THE SESSION. `taxa_onnx_sha256` is optional and its absence must mean "not
 *      built" rather than "load something else"; the handle must refuse the BACKBONE, which has the
 *      four inputs this graph has and none of its outputs.
 *   2. THE PASS, against `fixtures/dating/model_outputs.json` — `splits.py`'s own extractor on the
 *      same tensors. This is where a wrong slice, a missed layer or a transposed block shows up, and
 *      it is checked at two different batch sizes, because the batch-invariance of the accumulation
 *      is the property `runtime/` depends on and nothing else tests.
 *   3. THE WHOLE RECORD, against `fixtures/dating/run_mrca_dating_model.json` — `hyphaeon dating
 *      --method all` itself, in BOTH distance modes, every field including the 142-row per-taxon
 *      table. The tn93 case is the diagnostic one: its divergences are the ones the model-free chain
 *      already reproduces bit for bit, so a failure there is necessarily in the kernel, the REML or
 *      the GLS fit. In latent the divergences are themselves a model output and a failure could be
 *      anywhere.
 *   4. THE SEAMS. Distance-mode resolution, the refusals, the record's shape and the vocabulary a
 *      page reads.
 *
 * ============================ TOLERANCES, ALL MEASURED AT THIS COMMIT ============================
 *
 *   - THE GRAPH: 1e-6 RELATIVE, not absolute. The error is float32 reassociation — the graph sums
 *     a whole call's sites at once where `splits.py` sums in chunks of 32 — so it scales with the
 *     largest entry, which scales as 1/N. MEASURED here: cross-taxa attention 1.22e-8 absolute,
 *     6.7e-7 relative; embeddings 2.9e-7 absolute, 1.3e-7 relative; and the two batch sizes land
 *     within 4e-9 of each other.
 *   - RATES AND CORRELATIONS (`mu`, `d0`, the standard errors, `r2`, `sigma2`, `rmse`, `fieller_g`,
 *     `alpha`, `temporal_r`): 1e-5 RELATIVE. MEASURED worst 2.4e-6, on `sigma2` under tn93.
 *   - DATES: YEARS, absolute, because a tolerance on a date is a duration. 1e-3 under tn93
 *     (MEASURED 8.1e-7 on the PGLS fit) and 5e-3 under latent (MEASURED 4.1e-4). The gap is not
 *     slack: t_MRCA is `t_ref − d0/mu` and the lever arm `d0/mu` is 150 years on one fit and 358 on
 *     the other, whose Fieller g of 1.72 says its own slope is not significantly positive.
 *   - THE LATENT SPLINE: 1 YEAR on `t_mrca`, 1e-3 relative on its betas. It is `−beta_0/beta_1` on
 *     an uncentred calendar axis (DATING Q5) with `beta_1 = 9.09e-6`, a lever arm of about 2·10³
 *     years per unit relative error in the slope; MEASURED, beta_1 lands at 1.1e-4 relative and the
 *     date at 0.38 years. Pinning λ* to the reference's own value barely moves it (0.43 → 0.38
 *     years), so the residual is the kernel's float32 floor and not the optimiser. The tn93 spline,
 *     whose slope is a hundred times larger, is held at 1e-3 years and lands at 1.5e-4.
 *   - `predicted_date` / `temporal_residual`: `max(2e-4, 1e-6·|value|)` years. They arrive on the
 *     FLOAT32 grid — ulp 1.22e-4 at year 2000 — and they are extrapolations, so their error scales
 *     with distance from `t_ref`. MEASURED: every row inside 2e-4 except the 17.6 %-coverage
 *     holdout, predicted at 3084 and therefore 1093 years outside the fitted range, at 1.14e-3.
 *   - STRINGS, INTEGERS, BOOLEANS, TAXON NAMES AND THE ANCHOR ORDER: EXACT. `selected_clock` in
 *     particular is a sentence assembled from thresholded comparisons; if it drifts, a threshold
 *     flipped, and that is a failure however small the number behind it moved.
 *
 * ============================ THE TWO FINDINGS THIS SUITE PINS ============================
 *
 * THE ASTERISK IS A MODEL INPUT. `dataset.py:747` rewrites `*` to `-` in the FASTA it hands the
 * `tn93` binary and the pure-Python branch does not; korber is a LANL MASE alignment with 2,389 of
 * them, and the TN93 matrix is the model's `dist_matrix`. MEASURED: without the rewrite the
 * site-averaged attention is off by 1.703e-3 — 9.3 % of its largest entry — and the embeddings by
 * 4.067e-2. `the asterisk convention is part of the forward pass` below is that measurement.
 *
 * `--distance-mode auto` IS A DECISION ABOUT THE WHOLE RECORD (DATING Q11). With no tree and a model
 * available it resolves to `latent`, and the latent root's distances are then fed to every
 * estimator, the ordinary one included: on korber `ols.t_mrca` moves from 1893.91 to 1926.81 and
 * `ols.mu` from 1.169e-3 to 5.551e-4, on the same sequences and the same dates.
 *
 * Skipped, loudly, when ../HyphAeon's models or dating fixtures are not beside this repository.
 */
import { afterAll, describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseAlignmentSequences, parseHeaderTimestamp } from '@veg/hyphaeon-js';

import { createSession } from '../src/createSession.js';
import { runDatingModelPass } from '../src/datingNeural.js';
import { loadTaxaGraph, releaseSessions, runTaxaSites } from '../src/session-node.js';
import { parseManifest, pickVariant, taxaGraphArch, taxaOutputNames, TAXA_OUTPUT_NAMES } from '../src/manifest.js';
import {
	DATING_NEURAL_MAX_TAXA,
	NOT_BUILT,
	NOT_BUILT_WITHOUT_MODEL,
	datingCsvText,
	datingJsonText,
	effectiveRidge,
	resolveDistanceMode,
	runDating
} from '../src/dating/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE = process.env.HYPHAEON_ENGINE_DIR ?? join(HERE, '..', '..', '..', 'HyphAeon');
const MODELS = process.env.HYPHAEON_MODELS_DIR ?? join(ENGINE, 'models');
const FIXTURES = join(ENGINE, 'fixtures', 'dating');
const EXAMPLES = join(ENGINE, 'examples');

const HAS_GRAPH = existsSync(join(MODELS, 'general_taxa.onnx')) && existsSync(join(MODELS, 'manifest.json'));
const HAS_FIXTURES = existsSync(join(FIXTURES, 'model_outputs.json')) && existsSync(join(FIXTURES, 'run_mrca_dating_model.json'));
const HAS_EXAMPLE = existsSync(join(EXAMPLES, 'korber_env_gp160.fasta'));
if (!HAS_GRAPH) console.warn(`\n[dating-model] SKIPPED — needs ${MODELS}/general_taxa.onnx (run \`hyphaeon export-onnx\`).\n`);
if (HAS_GRAPH && !HAS_FIXTURES) console.warn(`\n[dating-model] SKIPPED — needs ${FIXTURES}/{model_outputs,run_mrca_dating_model}.json.\n`);

const ready = HAS_GRAPH && HAS_FIXTURES && HAS_EXAMPLE;
const suite = describe.skipIf(!ready);

const fixture = (name) => JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'));
const caseOf = (name, which) => fixture(name).find((c) => c.name === which);

/**
 * `fixtures/README.md`'s convention: a non-finite float travels as a string, because JSON has no
 * literal for one. `-Infinity` in `pgls.ci_fieller[0]` is not a large number, it is the UNBOUNDED
 * branch — the reference reporting that the rate is not distinguishable from zero at 95 % — so it
 * is compared by identity and never by tolerance.
 */
function decode(v) {
	if (v === 'NaN') return NaN;
	if (v === 'Infinity') return Infinity;
	if (v === '-Infinity') return -Infinity;
	return v;
}

/**
 * Python's `json.dump` writes `Infinity` / `-Infinity` / `NaN` as bare tokens (`allow_nan=True` is
 * its default), which the library's `pyJsonDumps` mirrors byte for byte and which `JSON.parse`
 * rejects. Reading our own download therefore needs the same substitution a reader of the CLI's
 * file needs, which is itself worth asserting.
 */
function parsePythonJson(text) {
	return JSON.parse(
		text.replace(/-Infinity/g, '"-Inf"').replace(/(?<![\w"])Infinity/g, '"+Inf"').replace(/\bNaN\b/g, '"NaN"'),
		(k, v) => (v === '-Inf' ? -Infinity : v === '+Inf' ? Infinity : v === 'NaN' ? NaN : v)
	);
}

// =================================================================================================
// Tolerance classes — see the header for where each number comes from
// =================================================================================================

const GRAPH_REL = 1e-6;
const RATE_REL = 1e-5;
const YEARS = { tn93: 1e-3, latent: 5e-3 };
const SPLINE = {
	tn93: { years: 1e-3, rel: 1e-4 },
	latent: { years: 1.0, rel: 1e-3 }
};
/** A date on the float32 grid, extrapolated: one ulp at year 2000 plus the rate's own error. */
const dateTolerance = (v) => Math.max(2e-4, 1e-6 * Math.abs(v));

/** Which fields are dates (years), which are small absolutes, and which are relative. */
const YEAR_FIELD = /t_mrca|ci_mrca|ci_fieller|ci_delta|timespan|knots|t_ref|\.date$/;
const ABS_FIELD = /divergence_residual|root_divergence|fitted_divergence|\bd0$|se_d0|sigma2|rmse/;

// =================================================================================================
// Shared: one session, one pass, two runs
// =================================================================================================

const manifestText = HAS_GRAPH ? readFileSync(join(MODELS, 'manifest.json'), 'utf8') : '{}';
const alignmentText = HAS_EXAMPLE ? readFileSync(join(EXAMPLES, 'korber_env_gp160.fasta'), 'utf8') : '';

let shared = null;
async function chain() {
	if (shared) return shared;
	const session = await createSession({ modelsBase: MODELS, variant: 'general', threads: 2 });
	const taxa = await session.loadTaxaGraph();
	const pass = await runDatingModelPass({ alignmentText, session: taxa, manifest: session.manifest });
	const seqs = parseAlignmentSequences(alignmentText);
	// The date layer's own default for this example, as dating-port.test.js uses (dating.py:330-332).
	const dates = new Map([...seqs.keys()].map((t) => [t, parseHeaderTimestamp(t, { archival1959: true })]));
	const runs = {};
	for (const mode of ['tn93', 'latent']) {
		runs[mode] = runDating({
			alignmentText,
			alignmentName: 'examples/korber_env_gp160.fasta',
			dates,
			rootTaxon: 'CONSENSUS',
			distanceMode: mode,
			neural: pass
		});
	}
	shared = { session, taxa, pass, seqs, dates, runs };
	return shared;
}

// =================================================================================================
// 1. The manifest and the session
// =================================================================================================

suite('the manifest declares a third artifact, optionally', () => {
	const manifest = parseManifest(manifestText);

	it('names the dating graph, its hash and its two outputs', () => {
		const v = pickVariant(manifest, 'general');
		expect(v.taxaOnnxFile).toBe('general_taxa.onnx');
		expect(v.taxaOnnxSha256).toMatch(/^[0-9a-f]{64}$/);
		expect(taxaOutputNames(manifest)).toEqual([...TAXA_OUTPUT_NAMES]);
	});

	it('carries the divisors rather than leaving the runtime to guess a depth', () => {
		// cross_attn_sum is accumulated over the graph's ROW LAYERS as well as over the call's sites
		// (splits.py:152), so the divisor is a property of the checkpoint and not of this code.
		const arch = taxaGraphArch(manifest);
		expect(arch.stated).toBe(true);
		expect(arch.rowLayers).toBe(6);
		expect(arch.embedDim).toBe(384);
	});

	it('reports null — not a guess — when a manifest declares no dating graph', () => {
		const older = parseManifest({
			model_version: 'v1',
			variants: { general: { onnx_sha256: 'a'.repeat(64) } }
		});
		const v = pickVariant(older, 'general');
		expect(v.taxaOnnxSha256).toBeNull();
		expect(v.taxaOnnxFile).toBeNull();
		// and the arch falls back to the exported checkpoint's own numbers, saying it was not stated
		expect(taxaGraphArch(older)).toEqual({ rowLayers: 6, embedDim: 384, stated: false });
	});

	it('refuses a malformed taxa hash instead of treating it as absent', () => {
		expect(() =>
			parseManifest({ model_version: 'v1', variants: { general: { onnx_sha256: 'a'.repeat(64), taxa_onnx_sha256: 'nope' } } })
		).toThrow(/malformed taxa_onnx_sha256/);
	});

	it('the outputs are NOT in the default fetch list, which is what keeps meme runs free of them', async () => {
		// The moment these join DEFAULT_OUTPUT_NAMES every `runSites` caller that omits `outputs`
		// starts asking a graph that does not have them. Measured elsewhere: onnxruntime does not
		// prune to the fetch list, so the separation is the artifact, not the list — but the list is
		// what stops the runtime asking the wrong graph for the wrong thing.
		const { DEFAULT_OUTPUT_NAMES } = await import('../src/manifest.js');
		for (const name of TAXA_OUTPUT_NAMES) expect(DEFAULT_OUTPUT_NAMES).not.toContain(name);
	});
});

suite('the session layer loads and verifies the dating graph', () => {
	it('loads it, verifies its sha256 and declares both outputs', async () => {
		const { taxa } = await chain();
		expect(taxa.kind).toBe('taxa');
		expect(taxa.verified).toBe(true);
		expect(taxa.sha256).toBe(pickVariant(parseManifest(manifestText), 'general').taxaOnnxSha256);
		expect(taxa.outputNames).toEqual([...TAXA_OUTPUT_NAMES]);
	});

	it('refuses the BACKBONE, which has the same four inputs and none of these outputs', async () => {
		const v = pickVariant(parseManifest(manifestText), 'general');
		await expect(
			loadTaxaGraph({ modelPath: join(MODELS, v.onnxFile), expectedSha256: v.onnxSha256, threads: 1 })
		).rejects.toThrow(/missing expected outputs: cross_attn_sum, taxa_repr_sum/);
	});

	it('refuses a hash mismatch rather than scoring with it', async () => {
		const v = pickVariant(parseManifest(manifestText), 'general');
		await expect(
			loadTaxaGraph({ modelPath: join(MODELS, v.taxaOnnxFile), expectedSha256: 'b'.repeat(64), threads: 1 })
		).rejects.toThrow(/hash mismatch/);
	});

	it('runTaxaSites REFUSES a partial answer where runSites omits a missing head', async () => {
		// A covariance kernel built from a missing matrix is the plausible wrong number this pillar
		// exists to avoid, so the omit policy that is right for an optional head is wrong here.
		const fake = { run: async () => ({ cross_attn_sum: { data: new Float32Array(4) } }) };
		const ort = { Tensor: class { constructor(t, d, dims) { this.type = t; this.data = d; this.dims = dims; } } };
		const bundle = {
			msa_codons: { data: new BigInt64Array(2), dims: [1, 2, 1] },
			msa_aas: { data: new BigInt64Array(2), dims: [1, 2, 1] },
			dist_matrix: { data: new Float32Array(4), dims: [1, 2, 2] },
			mds_coords: { data: new Float32Array(8), dims: [1, 2, 4] }
		};
		await expect(runTaxaSites(fake, bundle, ort)).rejects.toThrow(/no `taxa_repr_sum` output/);
	});
});

// =================================================================================================
// 2. The pass, against splits.py's own extractor
// =================================================================================================

suite('the forward pass reproduces splits.py on the same tensors', () => {
	const ref = HAS_FIXTURES ? caseOf('model_outputs', '000_korber_env_gp160_cpu') : null;

	it('reads every codon and every taxon: no cap, no duplicate pruning, no variable-site filter', async () => {
		const { pass } = await chain();
		// dating.py:2553-2561. 981 codons, not the variable subset the report's pass scores; 143
		// taxa in the alignment's own order, CONSENSUS included.
		expect(pass.L).toBe(ref.inputs.n_codons);
		expect(pass.N).toBe(ref.inputs.taxa.length);
		expect(pass.taxa).toEqual(ref.inputs.taxa);
		expect(pass.embedDim).toBe(ref.inputs.embed_dim);
		expect(pass.rowLayers).toBe(6);
		expect(pass.starsRewritten).toBe(2389);
	});

	it('lands on mean_cross_attn and mean_taxa_repr within 1e-6 relative', async () => {
		const { pass } = await chain();
		const attn = worstAgainst(pass.crossAttn, ref.outputs.mean_cross_attn, pass.N);
		const repr = worstAgainst(pass.taxaRepr, ref.outputs.mean_taxa_repr, pass.embedDim);
		console.log(
			`[dating-model] cross_attn |Δ| ${attn.abs.toExponential(3)} (rel ${attn.rel.toExponential(3)}); ` +
				`taxa_repr |Δ| ${repr.abs.toExponential(3)} (rel ${repr.rel.toExponential(3)})`
		);
		expect(attn.rel).toBeLessThan(GRAPH_REL);
		expect(repr.rel).toBeLessThan(GRAPH_REL);
		// Non-vacuity: the bound is 1.5x what is actually observed, not a decade of headroom.
		expect(attn.rel).toBeGreaterThan(0);
	});

	it('rows do not sum to 1, because the root is dropped from BOTH axes', async () => {
		const { pass } = await chain();
		// splits.py:131 takes attn[1:, 1:] of a softmax that ran over all num_species + 1 nodes. A
		// port that renormalised would look tidier and would not be this matrix.
		for (let i = 0; i < pass.N; i++) {
			let s = 0;
			for (let j = 0; j < pass.N; j++) s += pass.crossAttn[i * pass.N + j];
			expect(s).toBeGreaterThan(0.98);
			expect(s).toBeLessThan(0.9843);
		}
	});

	it('is batch-invariant: the accumulation is what makes the sums usable at all', async () => {
		// The property runtime/ depends on and nothing else tests. The graph emits sums over the
		// sites in ONE call; if the reduction had baked in a batch size, a single re-run at the same
		// size would still pass.
		const { taxa, session } = await chain();
		const small = await runDatingModelPass({ alignmentText, session: taxa, manifest: session.manifest, batchSize: 31 });
		const { pass } = await chain();
		let worst = 0;
		for (let i = 0; i < pass.crossAttn.length; i++) worst = Math.max(worst, Math.abs(pass.crossAttn[i] - small.crossAttn[i]));
		console.log(`[dating-model] batch ${pass.batchSize} vs 31: max |Δ| ${worst.toExponential(3)}`);
		expect(small.batchSize).toBe(31);
		expect(small.calls).toBeGreaterThan(pass.calls);
		expect(worst).toBeLessThan(1e-8);
	});

	it('the asterisk convention is part of the forward pass, not a clean-up', async () => {
		// dataset.py:747 rewrites '*' to '-' before the tn93 binary sees the alignment; the
		// pure-Python branch does not. The TN93 matrix is the model's own dist_matrix input, so the
		// two are different forward passes. This asserts the SIZE of that difference, because a port
		// that dropped the rewrite would still return a plausible matrix.
		const { taxa, session, seqs } = await chain();
		const unmodified = new Map([...seqs.entries()]);
		const raw = await runDatingModelPass({ sequences: unmodified, session: taxa, manifest: session.manifest });
		const off = worstAgainst(raw.crossAttn, ref.outputs.mean_cross_attn, raw.N);
		console.log(`[dating-model] without '*' -> '-': cross_attn |Δ| ${off.abs.toExponential(3)} (rel ${off.rel.toExponential(3)})`);
		expect(off.abs).toBeGreaterThan(1e-3);
		expect(off.rel).toBeGreaterThan(0.09);
	});
});

// =================================================================================================
// 3. The whole record, against `hyphaeon dating --method all`
// =================================================================================================

for (const mode of ['tn93', 'latent']) {
	suite(`the record against \`hyphaeon dating --method all --distance-mode ${mode}\``, () => {
		const ref = HAS_FIXTURES ? caseOf('run_mrca_dating_model', mode === 'tn93' ? '000_korber_tn93' : '001_korber_latent').outputs.result : null;

		it('reproduces every field of the reference record', async () => {
			const { runs } = await chain();
			const run = runs[mode];
			expect(run.ok).toBe(true);
			const failures = [];
			for (const key of [
				'root_description',
				'distance_mode',
				'taxa_count',
				'timespan',
				'active_model',
				't_mrca',
				'ci_mrca',
				'mu',
				'clock_model',
				'ci_method',
				'selected_clock',
				'power',
				'loocv',
				'ols',
				'pgls',
				'spline',
				'latent_root',
				'ensemble'
			]) {
				compare(failures, key, run.record[key], ref[key], mode);
			}
			expect(failures, failures.slice(0, 8).join('\n')).toEqual([]);
		});

		it('reproduces the per-taxon table row for row, in the reference\'s order', async () => {
			const { runs } = await chain();
			const rows = runs[mode].record.taxa_summary;
			expect(rows.length).toBe(ref.taxa_summary.length);
			const failures = [];
			ref.taxa_summary.forEach((want, i) => {
				const got = rows[i];
				if (got.taxon !== want.taxon) failures.push(`taxa[${i}]: ${got.taxon} vs ${want.taxon}`);
				for (const k of ['sampling_date', 'root_divergence', 'fitted_divergence', 'divergence_residual']) {
					near(failures, `taxa[${i}].${k}`, got[k], want[k], 1e-6);
				}
				// `temporal_residual` is `predicted_date - sampling_date`, so its error is the DATE's and
				// the bound is taken from the date, not from the difference.
				for (const k of ['predicted_date', 'temporal_residual']) {
					near(failures, `taxa[${i}].${k}`, got[k], want[k], dateTolerance(want.predicted_date));
				}
				near(failures, `taxa[${i}].z_score`, got.z_score, want.z_score, Math.max(1e-6, 1e-4 * Math.abs(want.z_score)));
				if (got.is_outlier !== want.is_outlier) failures.push(`taxa[${i}].is_outlier`);
				if (got.is_holdout !== want.is_holdout) failures.push(`taxa[${i}].is_holdout`);
			});
			expect(failures, failures.slice(0, 8).join('\n')).toEqual([]);
		});

		it('writes the reference\'s own JSON and CSV shape', async () => {
			const { runs } = await chain();
			const json = parsePythonJson(datingJsonText(runs[mode].record, { includeProvenance: false }));
			expect(Object.keys(json)).toEqual(Object.keys(ref));
			// `latent_root` is a FOUR-key subset, not the estimator's whole record: dating.py:3155-3161
			// drops z_root, weights, dists, dists_latent, mu_ols and t_mrca_ols, and t_mrca_ols in
			// particular is a diagnostic that would sit beside the real OLS fit looking like a second
			// opinion.
			if (mode === 'latent') {
				expect(Object.keys(json.latent_root)).toEqual(['alpha', 'temporal_r', 'temporal_r2', 'anchor_taxa']);
			} else {
				expect(json.latent_root).toBeNull();
			}
			expect(Object.keys(json.pgls)).toEqual(Object.keys(ref.pgls));
			const csv = datingCsvText(runs[mode].rows).trim().split('\n');
			expect(csv.length).toBe(ref.taxa_summary.length + 1);
		});
	});
}

suite('the two distance modes are two different response vectors (DATING Q11)', () => {
	it('turning the model on moves the ORDINARY fit as well, and by a lot', async () => {
		const { runs } = await chain();
		// Same sequences, same dates, same estimator. What changed is what it was fitted against.
		expect(runs.tn93.record.ols.t_mrca).toBeCloseTo(1893.91095511759, 2);
		expect(runs.latent.record.ols.t_mrca).toBeCloseTo(1926.8110853177513, 2);
		expect(runs.tn93.record.ols.mu / runs.latent.record.ols.mu).toBeGreaterThan(2);
		// and the headline answer comes from a different estimator in each
		expect(runs.tn93.record.active_model).toBe('pgls');
		expect(runs.latent.record.active_model).toBe('ols');
	});

	it('`auto` resolves to latent only when the model ran, and says so', () => {
		expect(resolveDistanceMode('auto', true).mode).toBe('latent');
		expect(resolveDistanceMode('auto', false).mode).toBe('tn93');
		expect(resolveDistanceMode('auto', true).reason).toMatch(/dating graph is available/);
		expect(resolveDistanceMode('tn93', true)).toEqual({ mode: 'tn93', reason: 'requested: --distance-mode tn93' });
		// The reference silently picks one for an unrecognised string (dating.py:2531-2532).
		expect(() => resolveDistanceMode('patristic', true)).toThrow(/not one of auto, tn93, latent/);
	});

	it('names the latent divergences in the reader\'s own vocabulary', async () => {
		const { runs } = await chain();
		const w = runs.latent.warnings.find((x) => x.code === 'DATING_LATENT_DIVERGENCES');
		expect(w).toBeTruthy();
		expect(w.message).toMatch(/NOT a sequence distance/);
		expect(w.data.alpha).toBeCloseTo(0.05406843894704035, 6);
		expect(runs.tn93.warnings.find((x) => x.code === 'DATING_LATENT_DIVERGENCES')).toBeUndefined();
	});
});

// =================================================================================================
// 4. The seams
// =================================================================================================

suite('what the record says about the run', () => {
	it('carries the model pass and the THREE numbers called ridge (DATING Q8)', async () => {
		const { runs } = await chain();
		const p = runs.tn93.record.primaeon;
		expect(p.schema_version).toBe(2);
		expect(p.model_pass.taxa).toBe(143);
		expect(p.model_pass.row_layers).toBe(6);
		expect(p.model_pass.embed_dim).toBe(384);
		// λ* built the covariance; `printed_ridge` is the clip the CLI prints and the SPLINE adds to
		// every eigenvalue; `pgls.ridge` is `1 − λ*` unclipped, recomputed at dating.py:1466. On this
		// example they are 0.6984, 0.2000 and 0.3016 — three numbers, one word.
		expect(p.pagel_lambda).toBeCloseTo(0.6984254721729402, 4);
		expect(p.printed_ridge).toBeCloseTo(0.2, 6);
		expect(runs.tn93.record.pgls.ridge).toBeCloseTo(0.30157452782705985, 4);
		expect(p.printed_ridge).toBe(effectiveRidge(p.pagel_lambda));
		expect(p.printed_ridge).not.toBeCloseTo(runs.tn93.record.pgls.ridge, 4);
	});

	it('says the spline was reweighted by the model (DATING Q10)', async () => {
		const { runs } = await chain();
		const w = runs.tn93.warnings.find((x) => x.code === 'DATING_MODEL_SPLINE_REWEIGHTED');
		expect(w).toBeTruthy();
		expect(w.data.ridge).toBeCloseTo(0.2, 6);
		// The model-free spline on the SAME divergences is a different answer, and phase 3's record
		// is the one that carried it: t_mrca 1938.77, beta_0 -4.3868, and the curvature test PREFERRED
		// it. With the model it is 1864.55, -1.7112, and rejected.
		expect(runs.tn93.record.spline.t_mrca).toBeCloseTo(1864.54779490812, 2);
		expect(runs.tn93.record.spline.is_nonlinear_preferred).toBe(false);
	});

	it('drops the two "not built" entries once they are built, and keeps the rest', async () => {
		const { runs } = await chain();
		const names = runs.tn93.record.primaeon.estimators_not_built.map((e) => e.name);
		expect(names).not.toContain('Attention PGLS');
		expect(names).not.toContain('Latent root search');
		expect(names).toEqual(NOT_BUILT.map((e) => e.name));
	});

	it('flags the clade attenuation that keeps PGLS out of both the headline and the average', async () => {
		const { runs } = await chain();
		// Under latent the GLS rate is deflated 5.5-fold with a worse generalised R², which is
		// dating.py:2884-2891's signature of a sample whose structure and whose dates are confounded.
		const w = runs.latent.warnings.find((x) => x.code === 'DATING_CLADE_ATTENUATED');
		expect(w).toBeTruthy();
		expect(w.data.attenuation).toBeLessThan(0.5);
		expect(runs.latent.record.ensemble.weights).toEqual({ ols: 1.0 });
		expect(runs.tn93.record.ensemble.weights.pgls).toBeGreaterThan(0);
	});
});

suite('a run without the dating graph is phase 3, exactly', () => {
	it('carries null estimators, says why, and lists them as not built', async () => {
		const { seqs, dates } = await chain();
		const run = runDating({
			alignmentText,
			dates,
			rootTaxon: 'CONSENSUS',
			modelUnavailableReason: 'this build declares no dating graph'
		});
		expect(run.ok).toBe(true);
		expect(run.record.distance_mode).toBe('tn93');
		expect(run.record.pgls).toBeNull();
		expect(run.record.latent_root).toBeNull();
		expect(run.record.primaeon.model_pass).toBeNull();
		expect(run.record.primaeon.pagel_lambda).toBeNull();
		const names = run.record.primaeon.estimators_not_built.map((e) => e.name);
		expect(names.slice(0, 2)).toEqual(NOT_BUILT_WITHOUT_MODEL.map((e) => e.name));
		const w = run.warnings.find((x) => x.code === 'DATING_MODEL_GRAPH_ABSENT');
		expect(w.message).toMatch(/no dating graph/);
		expect(seqs.size).toBe(143);
	});

	it('reproduces phase 3\'s own numbers, which the model must not have moved', async () => {
		const { dates } = await chain();
		const run = runDating({ alignmentText, dates, rootTaxon: 'CONSENSUS' });
		// `hyphaeon dating --method ols`, the model-free acceptance run: unchanged by phase 4.
		expect(run.record.ols.t_mrca).toBeCloseTo(1893.91095511759, 6);
		expect(run.record.spline.t_mrca).toBeCloseTo(1938.7746674292187, 4);
		expect(run.record.spline.is_nonlinear_preferred).toBe(true);
		expect(run.record.active_model).toBe('spline');
	});

	it('refuses `latent` without a model rather than approximating a root in its space', async () => {
		const { dates } = await chain();
		expect(() => runDating({ alignmentText, dates, rootTaxon: 'CONSENSUS', distanceMode: 'latent' })).toThrow(
			/latent' needs the dating graph/
		);
	});

	it('drops the model-based half rather than shifting every holdout by one', async () => {
		// tn93 mode, and one dated sequence the model never read. The reference builds `sub_taxa` and
		// then indexes `is_train` by position in it (dating.py:2776-2781) — the taxa-order index — so a
		// dropped name silently moves every holdout one row along and the covariance is fitted against
		// the wrong training set. Replicating that would be a date that is wrong and says nothing.
		const { pass, dates } = await chain();
		const short = { ...pass, taxa: pass.taxa.slice(0, -1), N: pass.N };
		const run = runDating({ alignmentText, dates, rootTaxon: 'CONSENSUS', distanceMode: 'tn93', neural: short });
		expect(run.ok).toBe(true);
		expect(run.record.pgls).toBeNull();
		expect(run.warnings.find((w) => w.code === 'DATING_MODEL_TAXA_MISSING')).toBeTruthy();
		// and the half that never touched the covariance is untouched
		expect(run.record.ols.t_mrca).toBeCloseTo(1893.91095511759, 6);
		expect(run.record.spline).not.toBeNull();
	});

	it('refuses the model-based estimators above the reference\'s own cohort limit', async () => {
		const { pass } = await chain();
		const many = new Map();
		for (let i = 0; i < DATING_NEURAL_MAX_TAXA + 2; i++) many.set(`t${i}`, 'ACGACGACGACG');
		const run = runDating({
			sequences: many,
			dates: new Map([...many.keys()].map((t, i) => [t, 2000 + i * 0.01])),
			neural: { ...pass, taxa: [...many.keys()], N: many.size }
		});
		expect(run.ok).toBe(false);
		expect(run.refusal).toBe('DATING_MODEL_TOO_MANY_TAXA');
		// The reference falls back to OLS and the spline at the same number (dating.py:2745) without
		// saying that the covariance it would have built is the whole difference.
		expect(run.warnings.at(-1).message).toMatch(/falls back to the ordinary fit/);
	});
});

// =================================================================================================
// Helpers
// =================================================================================================

/** Largest absolute and relative difference against a fixture's nested rows. */
function worstAgainst(flatArray, rows, stride) {
	let abs = 0;
	let max = 0;
	for (let i = 0; i < rows.length; i++) {
		for (let j = 0; j < rows[i].length; j++) {
			const want = rows[i][j];
			abs = Math.max(abs, Math.abs(flatArray[i * stride + j] - want));
			max = Math.max(max, Math.abs(want));
		}
	}
	return { abs, rel: max > 0 ? abs / max : abs };
}

function near(failures, label, got, want, tolRaw) {
	want = decode(want);
	const tol = tolRaw;
	if (!Number.isFinite(want)) {
		if (!Object.is(got, want)) failures.push(`${label}: got ${got}, want ${want}`);
		return;
	}
	const d = Math.abs(got - want);
	if (!(d <= tol)) failures.push(`${label}: |Δ| ${d.toExponential(3)} > ${tol.toExponential(3)} (got ${got}, want ${want})`);
}

/** Walk a record block, choosing the class from the field's name and the distance mode. */
function compare(failures, path, got, want, mode) {
	if (want === null || want === undefined) {
		if (got !== null && got !== undefined) failures.push(`${path}: got ${JSON.stringify(got)}, want null`);
		return;
	}
	want = decode(want);
	if (typeof want === 'number' && !Number.isFinite(want)) {
		if (!Object.is(got, want)) failures.push(`${path}: got ${got}, want ${want}`);
		return;
	}
	if (typeof want === 'string' || typeof want === 'boolean') {
		if (got !== want) failures.push(`${path}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
		return;
	}
	if (Array.isArray(want)) {
		want.forEach((v, i) => compare(failures, `${path}[${i}]`, got?.[i], v, mode));
		return;
	}
	if (typeof want === 'object') {
		for (const k of Object.keys(want)) compare(failures, `${path}.${k}`, got?.[k], want[k], mode);
		return;
	}
	if (typeof want !== 'number') return;
	const spline = path.startsWith('spline');
	const tol = !Number.isFinite(want)
		? 0
		: YEAR_FIELD.test(path)
			? spline
				? SPLINE[mode].years
				: YEARS[mode]
			: ABS_FIELD.test(path)
				? 1e-6
				: Math.max((spline ? SPLINE[mode].rel : RATE_REL) * Math.abs(want), 1e-12);
	near(failures, path, got, want, tol);
}

/** onnxruntime-node 1.23.2 SIGABRTs at exit with a session still alive on its thread pool. */
if (ready) {

	afterAll(async () => {
		await releaseSessions();
	});
}
