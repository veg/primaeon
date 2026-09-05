/**
 * dms.test.js — the digital DMS through the real graph: the fixtures, the progressive updates,
 * the cancel and the work budget.
 *
 * WHY THIS FILE EXISTS. PHASE2A.md gap 3 again: `fixtures/dms/run_insilico_selection_dms.json`
 * is replayed in the library with a playback `predict` reconstructed from the recorded outputs;
 * the 1e-5-class replay through ONNX belongs here. Both fixture cases are run (the default focal
 * taxon and `--focal-taxon r_ferr`, which the reference resolves to index 3), and every recorded
 * number is compared: `wt_aa` exact, the four reductions and all 19 `mutant_deltas` per site at
 * the graph class for a DIFFERENCE of two graph values (2 * 1e-5 * max(1, |baseline_lrt|) —
 * measured worst 1.8e-5 against a scale of 5.5, i.e. 16% of the bound), `p_value` at the derived
 * class 1e-6.
 *
 * The other three tests are the app's own behaviour (dms.js's header): slabbing publishes
 * partial tables and changes no number, cancelling keeps what was computed, and a sweep above
 * the work budget is refused before any forward pass.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { loadAlignmentAndTree } from '@veg/hyphaeon-js';

import { createSession } from '../src/createSession.js';
import { runDms, dmsWork, dmsBudget, memoiseBaseline, DMS_WORK_BUDGET_DEFAULT } from '../src/dms.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE = join(HERE, '..', '..', '..', 'HyphAeon');
const MODELS = join(ENGINE, 'models');
const FIXTURES = join(ENGINE, 'fixtures');
const EXAMPLES = join(ENGINE, 'examples');

const ready = existsSync(join(MODELS, 'general.onnx')) && existsSync(join(FIXTURES, 'dms', 'run_insilico_selection_dms.json'));
if (!ready) console.warn(`\n[dms] SKIPPED — needs ${MODELS}/general.onnx and ${FIXTURES}/dms.\n`);

let sessions = null;
async function session() {
	if (!sessions) sessions = await createSession({ modelsBase: MODELS, variant: 'general', threads: 2 });
	return sessions;
}

let bat = null;
function batOas1() {
	if (!bat) {
		bat = loadAlignmentAndTree(
			readFileSync(join(EXAMPLES, 'bat_oas1.fasta'), 'utf8'),
			readFileSync(join(EXAMPLES, 'bat_oas1.nwk'), 'utf8'),
			{ maxSpecies: null, pruneDuplicates: true }
		);
	}
	return bat;
}

describe('the work budget (PLAN.md §3.5 caps, dms.js)', () => {
	it('counts 19 * sites * N^2 and refuses above the budget', () => {
		expect(dmsWork(100, 20)).toBe(19 * 100 * 400);
		const ok = dmsBudget({ L: 1097, N: 20 });
		expect(ok.within).toBe(true);
		expect(ok.budget).toBe(DMS_WORK_BUDGET_DEFAULT);
		expect(ok.reason).toBe(null);
		// RHO's shape: 349 codons over 655 taxa is 2.8e9, above the 2.5e9 cap.
		const tooBig = dmsBudget({ L: 349, N: 655 });
		expect(tooBig.within).toBe(false);
		expect(tooBig.work).toBeGreaterThan(DMS_WORK_BUDGET_DEFAULT);
		expect(tooBig.reason).toMatch(/above this surface's budget/);
		// A subset is judged on what it will actually sweep.
		expect(dmsBudget({ L: 349, N: 655, sites: 40 }).within).toBe(true);
	});

	it('memoiseBaseline answers the baseline phase once per site and passes the mutant phase through', async () => {
		const calls = [];
		const predict = async (c, a, meta) => {
			calls.push({ phase: meta.phase, sites: Array.from(meta.siteIndices) });
			return Float32Array.from(meta.siteIndices, (s) => s + 0.5);
		};
		const memo = memoiseBaseline(predict, { L: 4 });
		const N = 1;
		const tokens = (n) => new Int32Array(n * N);
		const first = await memo(tokens(3), tokens(3), { phase: 'dms-baseline', batch: 3, N, siteIndices: Int32Array.from([0, 1, 2]) });
		expect(Array.from(first)).toEqual([0.5, 1.5, 2.5]);
		const second = await memo(tokens(3), tokens(3), { phase: 'dms-baseline', batch: 3, N, siteIndices: Int32Array.from([1, 2, 3]) });
		expect(Array.from(second)).toEqual([1.5, 2.5, 3.5]);
		await memo(tokens(2), tokens(2), { phase: 'dms', batch: 2, N, siteIndices: Int32Array.from([0, 1]) });
		expect(calls.map((c) => `${c.phase}:${c.sites.join(',')}`)).toEqual(['dms-baseline:0,1,2', 'dms-baseline:3', 'dms:0,1']);
	});
});

describe.skipIf(!ready)('fixtures/dms/run_insilico_selection_dms.json through runDms (real graph)', () => {
	const cases = ready ? JSON.parse(readFileSync(join(FIXTURES, 'dms', 'run_insilico_selection_dms.json'), 'utf8')) : [];

	for (const c of cases) {
		it(`${c.name}: focal taxon, wild types and every delta at the graph class`, async () => {
			const { backbone } = await session();
			const loaded = batOas1();
			const got = await runDms({
				loaded,
				session: backbone,
				options: { siteSubset: c.inputs.target_sites, focalTaxon: c.inputs.focal_taxon, batchSize: c.inputs.batch_size },
				inputs: { alignment: c.inputs.alignment, tree: c.inputs.tree }
			});
			expect(got.focal_index).toBe(c.outputs.focal_index);
			expect(got.focal_name).toBe(c.outputs.focal_name);
			expect(got.plasticity.map((p) => p.site)).toEqual(c.outputs.plasticity.map((p) => p.site));
			// The Python quirks the library replicates and the record repeats.
			expect(got.total_mutations).toBe(19 * loaded.L);
			expect(got.focal_taxon).toBe(c.inputs.focal_taxon || loaded.taxa[0]);
			expect(got.selection_dms_plasticity).toBe(got.plasticity);

			let worst = 0;
			let at = null;
			for (let i = 0; i < c.outputs.plasticity.length; i++) {
				const r = c.outputs.plasticity[i];
				const g = got.plasticity[i];
				expect(g.wt_aa).toBe(r.wt_aa);
				// delta = mutant - baseline: two graph-class values, so twice the class, scaled by
				// the site's own LRT (the same rule parity-fixtures.test.js uses for attribution).
				const tol = 2 * 1e-5 * Math.max(1, Math.abs(r.baseline_lrt));
				for (const k of ['baseline_lrt', 'intrinsic_plasticity', 'mean_delta_lrt', 'max_delta_lrt', 'min_delta_lrt']) {
					const d = Math.abs(r[k] - g[k]);
					expect(d, `${k} at site ${r.site}`).toBeLessThanOrEqual(tol);
					if (d > worst) {
						worst = d;
						at = `${k}@${r.site}`;
					}
				}
				expect(Object.keys(g.mutant_deltas)).toEqual(Object.keys(r.mutant_deltas));
				for (const [aa, v] of Object.entries(r.mutant_deltas)) {
					const d = Math.abs(v - g.mutant_deltas[aa]);
					expect(d, `mutant ${aa} at site ${r.site}`).toBeLessThanOrEqual(tol);
					if (d > worst) {
						worst = d;
						at = `${aa}@${r.site}`;
					}
				}
				expect(Math.abs(r.p_value - g.p_value)).toBeLessThanOrEqual(1e-6);
			}
			console.log(`[dms] ${c.name}: ${got.plasticity.length} sites, worst |Δ| ${worst.toExponential(2)} (${at})`);
		});
	}

	it('slabbing is not semantics: through the real graph the two batch sizes agree at the graph class', async () => {
		const { backbone } = await session();
		const loaded = batOas1();
		const sites = [140, 272, 328];
		const small = await runDms({ loaded, session: backbone, options: { siteSubset: sites, batchSize: 19 } });
		const large = await runDms({ loaded, session: backbone, options: { siteSubset: sites, batchSize: 256 } });
		expect(small.plasticity.map((p) => [p.site, p.wt_aa])).toEqual(large.plasticity.map((p) => [p.site, p.wt_aa]));
		// Not bit-equal, and the reason is ORT rather than this code: a batch of 19 mutants and a
		// batch of 256 are different graph calls, so the float noise differs (measured ~1e-6 here,
		// the same effect epistasis.test.js measures between the two attention passes). The
		// batch-independence of the RECORD arithmetic is pinned exactly in the next test, with a
		// deterministic predict.
		let worst = 0;
		for (let i = 0; i < small.plasticity.length; i++) {
			for (const [aa, v] of Object.entries(small.plasticity[i].mutant_deltas)) {
				worst = Math.max(worst, Math.abs(v - large.plasticity[i].mutant_deltas[aa]));
			}
			worst = Math.max(worst, Math.abs(small.plasticity[i].baseline_lrt - large.plasticity[i].baseline_lrt));
		}
		console.log(`[dms] batch 19 vs 256 through ORT: worst |Δ delta_lrt| ${worst.toExponential(2)}`);
		expect(worst).toBeLessThanOrEqual(2 * 1e-5 * Math.max(1, ...small.plasticity.map((p) => Math.abs(p.baseline_lrt))));
	});

	it('slabbing changes call shapes only: with a deterministic predict every record is bit-equal', async () => {
		const loaded = batOas1();
		// A predict that depends on the site and the tokens, not on the batch: what the graph would
		// be if ORT summed in a fixed order.
		const predict = async (c, a, meta) => {
			const out = new Float32Array(meta.batch);
			for (let k = 0; k < meta.batch; k++) {
				let h = meta.siteIndices[k] * 2654435761;
				for (let i = 0; i < meta.N; i++) h = (h ^ (c[k * meta.N + i] * 40503 + a[k * meta.N + i] * 2246822519)) >>> 0;
				out[k] = Math.fround((h % 100000) / 20000);
			}
			return out;
		};
		const sites = [0, 1, 2, 3, 4, 5, 6];
		const small = await runDms({ loaded, predict, options: { siteSubset: sites, batchSize: 19 } });
		const large = await runDms({ loaded, predict, options: { siteSubset: sites, batchSize: 256 } });
		expect(small.plasticity).toEqual(large.plasticity);
		expect(small.plasticity.length).toBe(sites.length);
	});
});

describe.skipIf(!ready)('progressive, cancellable, capped', () => {
	it('publishes the partial table after every slab and finishes with the whole one', async () => {
		const { backbone } = await session();
		const loaded = batOas1();
		/** @type {number[]} */
		const updates = [];
		let lastPartial = null;
		const res = await runDms({
			loaded,
			session: backbone,
			options: { siteSubset: [0, 1, 2, 3, 4, 5, 6, 7], batchSize: 38 },
			onProgress: (p) => {
				updates.push(p.plasticity.length);
				lastPartial = p;
			}
		});
		// batchSize 38 = two sites per forward pass, so four updates for eight sites.
		expect(updates).toEqual([2, 4, 6, 8]);
		expect(res.plasticity.length).toBe(8);
		expect(res.progress).toEqual({ done: 8, total: 8 });
		expect(lastPartial.progress).toEqual({ done: 8, total: 8 });
		expect(lastPartial.partial).toBe(false);
		expect(res.cancelled).toBeUndefined();
	});

	it('a cancel keeps the records already computed and says so', async () => {
		const { backbone } = await session();
		const loaded = batOas1();
		const controller = new AbortController();
		let seen = 0;
		const res = await runDms({
			loaded,
			session: backbone,
			options: { siteSubset: Array.from({ length: 60 }, (_, i) => i), batchSize: 38 },
			signal: controller.signal,
			onProgress: () => {
				seen++;
				if (seen === 2) controller.abort();
			}
		});
		expect(res.cancelled).toBe(true);
		expect(res.plasticity.length).toBe(4);
		expect(res.progress).toEqual({ done: 4, total: 60 });
		expect(res.plasticity.every((p) => Number.isFinite(p.intrinsic_plasticity))).toBe(true);
	});

	it('above the budget nothing is scored and the result says what it would have cost', async () => {
		const { backbone } = await session();
		const loaded = batOas1();
		let called = 0;
		const res = await runDms({
			loaded,
			session: backbone,
			predict: async () => {
				called++;
				throw new Error('the budget check should have refused before any forward pass');
			},
			options: { workBudget: 1000 }
		});
		expect(called).toBe(0);
		expect(res.skipped).toBe(true);
		expect(res.plasticity).toEqual([]);
		expect(res.work).toBe(dmsWork(loaded.L, loaded.N));
		expect(res.budget).toBe(1000);
		expect(res.reason).toMatch(/Run it on the server/);
		expect(res.progress).toEqual({ done: 0, total: loaded.L });
	});

	it('a site cap sweeps the first N and reports the rest as not swept', async () => {
		const { backbone } = await session();
		const loaded = batOas1();
		const res = await runDms({ loaded, session: backbone, options: { maxSites: 3, batchSize: 256 } });
		expect(res.plasticity.length).toBe(3);
		expect(res.capped).toBe(true);
		expect(res.progress).toEqual({ done: 3, total: loaded.L });
		expect(res.sites_requested).toBe(loaded.L);
	});
});
