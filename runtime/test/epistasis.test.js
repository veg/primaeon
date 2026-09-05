/**
 * epistasis.test.js — the co-selection network and the sectors, against `hyphaeon epistasis`'s
 * own output, through the real general graph.
 *
 * WHY THIS FILE EXISTS. PHASE2A.md gap 3: "Real-model replays stay app-side … The epistasis e2e
 * fixture wants the same treatment (`runTransformerAttributions` -> the ONNX `lrt` and
 * `mean_root_attns`)." The library's tests replay `fixtures/epistasis/*` with playback callbacks
 * reconstructed from recorded outputs; this file runs the model. It checks
 * fixtures/e2e/epistasis_Smc6_n_permutations_1000.json — the CLI at `--n-permutations 1000
 * --seed 42 --mds-sign canonical` — at PARITY.md's classes:
 *
 *   exact        edge set and (site_u, site_v) order, `ref_u/v`, `shared_taxa/branches`;
 *                sector ids, `sites`, `size`, `pars_signature`, `shared_taxa`
 *   graph 1e-5   `lrt_u/v`, `similarity`, `cesi`, sector `mean_lrt`, plasticity `baseline_lrt`
 *                (PLAN.md §5.4's measured class, not parity.py's 1e-6 — two fp32 paths differ by
 *                more than that, and Smc6's worst edge field here is 2.9e-6)
 *   eigen 1e-5   `spectral_coherence` (measured: 0.0)
 *   statistical  `p_perm` within 3*sqrt(p(1-p)/B) at B = 1,000 — the CLI's own B, where
 *                PHASE2A.md measures +/-0.03 of Monte Carlo error per side
 *
 * and it pins the claim epistasis.js's header makes about running on the meme pass's attention
 * instead of the reference's all-sites pass.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { loadAlignmentAndTree } from '@veg/hyphaeon-js';

import { createSession } from '../src/createSession.js';
import { inferSites } from '../src/predict.js';
import { runEpistasis, resolveEpistasisOptions, dmsSitesForSectors, EPISTASIS_CLI_DEFAULTS, BROWSER_PERMUTATIONS_DEFAULT } from '../src/epistasis.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE = join(HERE, '..', '..', '..', 'HyphAeon');
const MODELS = join(ENGINE, 'models');
const FIXTURES = join(ENGINE, 'fixtures');
const EXAMPLES = join(ENGINE, 'examples');

const LRT_REL_TOL = 1e-5;
const EIGEN_TOL = 1e-5;
/** PARITY.md's statistical bound, p floored at 1/B. */
const statTol = (p, B) => 3 * Math.sqrt((Math.max(p, 1 / B) * (1 - Math.max(p, 1 / B))) / B);

const ready = existsSync(join(MODELS, 'general.onnx')) && existsSync(join(FIXTURES, 'e2e', 'epistasis_Smc6_n_permutations_1000.json'));
if (!ready) console.warn(`\n[epistasis] SKIPPED — needs ${MODELS}/general.onnx and ${FIXTURES}/e2e.\n`);

const fixture = (rel) => JSON.parse(readFileSync(join(FIXTURES, rel), 'utf8'));
const example = (name) => ({
	alignmentText: readFileSync(join(EXAMPLES, `${name}.fasta`), 'utf8'),
	treeText: existsSync(join(EXAMPLES, `${name}.nwk`)) ? readFileSync(join(EXAMPLES, `${name}.nwk`), 'utf8') : null
});

let sessions = null;
async function session() {
	if (!sessions) sessions = await createSession({ modelsBase: MODELS, variant: 'general', threads: 2 });
	return sessions;
}

/** The library's loader with the CLI's options (no cap, duplicates pruned). */
function load(name) {
	const { alignmentText, treeText } = example(name);
	return loadAlignmentAndTree(alignmentText, treeText, { maxSpecies: null, pruneDuplicates: true });
}

describe('option resolution (cli.py cmd_epistasis, not the library defaults)', () => {
	it('takes the CLI\'s min_sim 0.30, min_shared 2, max_fdr 0.05, min_lrt 1.0 and the function\'s min_cesi 2.0', () => {
		const o = resolveEpistasisOptions({});
		expect(o.minSim).toBe(0.3);
		expect(o.minShared).toBe(2);
		expect(o.maxFdr).toBe(0.05);
		expect(o.minLrt).toBe(1.0);
		expect(o.minCesi).toBe(2.0);
		expect(o.minCliqueSize).toBe(3);
		expect(o.minCoherence).toBe(0.5);
		expect(o.maxPermP).toBe(null);
		expect(o.nPermutations).toBe(EPISTASIS_CLI_DEFAULTS.nPermutations);
		expect(o.seed).toBe(42);
	});

	it('drops B to the browser default only when the caller says browser, and refuses a bad B or seed', () => {
		expect(resolveEpistasisOptions({}, { browser: true }).nPermutations).toBe(BROWSER_PERMUTATIONS_DEFAULT);
		expect(resolveEpistasisOptions({ permutations: 250 }, { browser: true }).nPermutations).toBe(250);
		expect(resolveEpistasisOptions({ nPermutations: 5000 }).nPermutations).toBe(5000);
		expect(() => resolveEpistasisOptions({ permutations: -1 })).toThrow(/non-negative integer/);
		expect(() => resolveEpistasisOptions({ seed: 1.5 })).toThrow(/seed must be an integer/);
	});

	it('picks the DMS sites the way epistasis.py:702-712 does: sector members, else CESI >= 3 edge endpoints', () => {
		const sectors = [{ sites: [10, 4] }, { sites: [4, 77] }];
		expect(dmsSitesForSectors(sectors, [])).toEqual([3, 9, 76]);
		const edges = [
			{ site_u: 5, site_v: 9, cesi: 3.5 },
			{ site_u: 2, site_v: 3, cesi: 2.9 }
		];
		expect(dmsSitesForSectors([], edges)).toEqual([4, 8]);
		expect(dmsSitesForSectors([], [])).toEqual([]);
	});
});

describe.skipIf(!ready)('fixtures/e2e/epistasis_Smc6_n_permutations_1000.json through runEpistasis (real graph)', () => {
	const ref = ready ? fixture('e2e/epistasis_Smc6_n_permutations_1000.json')[0].outputs : null;
	const B = 1000;

	/** One run reused by every assertion below: the meme pass's attention, the CLI's options. */
	let got = null;
	async function run() {
		if (got) return got;
		const { backbone } = await session();
		const loaded = load('Smc6');
		const inference = await inferSites(loaded, backbone, { outputs: ['lrt', 'mean_root_attns'] });
		got = await runEpistasis({
			loaded,
			attention: inference.mean_root_attns,
			lrt: inference.lrt,
			session: backbone,
			options: { nPermutations: B, seed: 42, dms: true },
			inputs: { alignment: 'Smc6.fasta', tree: 'Smc6.nwk' }
		});
		return got;
	}

	it('reproduces the counts and the edge table: set and order exact, floats at the graph class', async () => {
		const res = await run();
		expect(res.taxa_count).toBe(ref.taxa_count);
		expect(res.codon_count).toBe(ref.codon_count);
		expect(res.coselection_edges_count).toBe(ref.coselection_edges_count);
		expect(res.discovered_sectors_count).toBe(ref.discovered_sectors_count);
		expect(res.edges.map((e) => [e.site_u, e.site_v])).toEqual(ref.edges.map((e) => [e.site_u, e.site_v]));

		let worst = 0;
		let at = null;
		for (let i = 0; i < ref.edges.length; i++) {
			const r = ref.edges[i];
			const g = res.edges[i];
			expect([g.ref_u, g.ref_v, g.shared_taxa, g.shared_branches]).toEqual([r.ref_u, r.ref_v, r.shared_taxa, r.shared_branches]);
			for (const k of ['lrt_u', 'lrt_v', 'similarity', 'cesi', 'p_val', 'hyper_p', 'fdr_q']) {
				const d = Math.abs(r[k] - g[k]);
				const tol = LRT_REL_TOL * Math.max(1, Math.abs(r[k]));
				expect(d, `${k} at ${r.site_u}-${r.site_v}`).toBeLessThanOrEqual(tol);
				if (d > worst) {
					worst = d;
					at = `${k}@${r.site_u}-${r.site_v}`;
				}
			}
		}
		console.log(`[epistasis] Smc6 edges: ${res.edges.length} identical pairs, worst float |Δ| ${worst.toExponential(2)} (${at})`);
	});

	it('reproduces the sectors: membership and signatures exact, coherence at 1e-5, p_perm in the statistical class', async () => {
		const res = await run();
		expect(res.sectors.map((s) => s.sector_id)).toEqual(ref.sectors.map((s) => s.sector_id));
		for (let i = 0; i < ref.sectors.length; i++) {
			const r = ref.sectors[i];
			const g = res.sectors[i];
			expect(g.sites).toEqual(r.sites);
			expect(g.size).toBe(r.size);
			expect(g.shared_taxa).toBe(r.shared_taxa);
			expect(g.shared_branches).toBe(r.shared_branches);
			expect(g.pars_signature).toBe(r.pars_signature);
			expect(g.consensus_signature).toBe(r.consensus_signature);
			expect(g.isotropic_baseline).toBeCloseTo(r.isotropic_baseline, 12);
			expect(Math.abs(g.spectral_coherence - r.spectral_coherence)).toBeLessThanOrEqual(EIGEN_TOL);
			expect(Math.abs(g.mean_lrt - r.mean_lrt)).toBeLessThanOrEqual(LRT_REL_TOL * Math.max(1, Math.abs(r.mean_lrt)));
			const tol = statTol(r.p_perm, B);
			console.log(
				`[epistasis] sector ${r.sector_id} sites ${JSON.stringify(r.sites)}: C ${g.spectral_coherence} vs ${r.spectral_coherence}; ` +
					`p_perm ${g.p_perm} vs ${r.p_perm} (|Δ| ${Math.abs(g.p_perm - r.p_perm).toFixed(4)} <= ${tol.toFixed(4)}); ` +
					`null mean ${g.null_coherence_mean.toFixed(4)} vs ${r.null_coherence_mean.toFixed(4)}`
			);
			expect(Math.abs(g.p_perm - r.p_perm)).toBeLessThanOrEqual(tol);
			// The null moments at B = 1,000 are noisy on both sides (PHASE2A.md: ~5% on the std),
			// so they are checked at the loose bound that measurement justifies, not at 2%.
			expect(Math.abs(g.null_coherence_mean - r.null_coherence_mean)).toBeLessThanOrEqual(0.05 * r.null_coherence_mean);
			expect(Math.abs(g.null_coherence_std - r.null_coherence_std)).toBeLessThanOrEqual(0.15 * r.null_coherence_std);
		}
	});

	it('reproduces the sector-site DMS the CLI runs (epistasis.py:702-716): same sites, deltas at the graph class', async () => {
		const res = await run();
		expect(res.dms_enabled).toBe(true);
		expect(res.plasticity.map((p) => p.site)).toEqual(ref.plasticity.map((p) => p.site));
		expect(res.dms_sites).toEqual(ref.plasticity.map((p) => p.site));
		let worst = 0;
		for (let i = 0; i < ref.plasticity.length; i++) {
			const r = ref.plasticity[i];
			const g = res.plasticity[i];
			expect(g.wt_aa).toBe(r.wt_aa);
			const scale = 2 * LRT_REL_TOL * Math.max(1, Math.abs(r.baseline_lrt));
			for (const k of ['baseline_lrt', 'intrinsic_plasticity', 'mean_delta_lrt', 'max_delta_lrt', 'min_delta_lrt']) {
				expect(Math.abs(r[k] - g[k]), `${k} at site ${r.site}`).toBeLessThanOrEqual(scale);
			}
			for (const [aa, v] of Object.entries(r.mutant_deltas)) {
				const d = Math.abs(v - g.mutant_deltas[aa]);
				expect(d, `mutant ${aa} at site ${r.site}`).toBeLessThanOrEqual(scale);
				if (d > worst) worst = d;
			}
			// p_value is a special function of a graph-class input: the derived class, 1e-6.
			expect(Math.abs(r.p_value - g.p_value)).toBeLessThanOrEqual(1e-6);
		}
		console.log(`[epistasis] Smc6 sector DMS: ${res.plasticity.length} sites, worst |Δ delta_lrt| ${worst.toExponential(2)}`);
	});

	it('writes the CLI\'s key set, records B, the seed and the Monte Carlo caveat, and carries the graph', async () => {
		const res = await run();
		for (const k of [
			'alignment',
			'tree',
			'taxa_count',
			'codon_count',
			'evaluated_taxa',
			'coselection_edges_count',
			'discovered_sectors_count',
			'edges',
			'sectors',
			'plasticity',
			'coselection_edges',
			'epistatic_sectors',
			'selection_dms_plasticity'
		]) {
			expect(Object.keys(res)).toContain(k);
		}
		expect(res.coselection_edges).toBe(res.edges);
		expect(res.epistatic_sectors).toBe(res.sectors);
		expect(res.selection_dms_plasticity).toBe(res.plasticity);
		expect(res.permutations).toMatchObject({ n: B, seed: 42, rng: 'xoshiro256**' });
		expect(res.permutations.note).toMatch(/\+\/-0\.03|Monte Carlo/);
		expect(res.graph.nodes.length).toBe(res.codon_count);
		expect(res.graph.edges.length).toBe(res.edges.length);
		expect(res.attention_source).toBe('shared-pass');
	});
});

describe.skipIf(!ready)('the shared meme pass against the reference\'s all-sites pass', () => {
	it('gives the same edges and sectors, differing only by the graph\'s batch-composition noise', async () => {
		const { backbone } = await session();
		const loaded = load('bat_oas1');
		const inference = await inferSites(loaded, backbone, { outputs: ['lrt', 'mean_root_attns'] });
		const shared = await runEpistasis({ loaded, attention: inference.mean_root_attns, lrt: inference.lrt, options: { nPermutations: 100, seed: 42 } });
		const allSites = await runEpistasis({ loaded, session: backbone, options: { nPermutations: 100, seed: 42 } });
		expect(shared.attention_source).toBe('shared-pass');
		expect(allSites.attention_source).toBe('all-sites');
		expect(shared.edges.map((e) => [e.site_u, e.site_v])).toEqual(allSites.edges.map((e) => [e.site_u, e.site_v]));
		expect(shared.sectors.map((s) => s.sites)).toEqual(allSites.sectors.map((s) => s.sites));
		let worst = 0;
		for (let i = 0; i < shared.edges.length; i++) {
			for (const k of ['lrt_u', 'lrt_v', 'similarity', 'cesi', 'p_val', 'fdr_q']) {
				worst = Math.max(worst, Math.abs(shared.edges[i][k] - allSites.edges[i][k]));
			}
		}
		for (let i = 0; i < shared.sectors.length; i++) {
			expect(shared.sectors[i].spectral_coherence).toBe(allSites.sectors[i].spectral_coherence);
			expect(shared.sectors[i].p_perm).toBe(allSites.sectors[i].p_perm);
		}
		console.log(`[epistasis] bat_oas1 shared pass vs all-sites pass: ${shared.edges.length} identical edges, worst float |Δ| ${worst.toExponential(2)}`);
		expect(worst).toBeLessThanOrEqual(LRT_REL_TOL);
	});

	it('refuses to invent a pass: no attention and no session is an error', async () => {
		const loaded = load('bat_oas1');
		await expect(runEpistasis({ loaded })).rejects.toThrow(/pass the meme pass/);
		await expect(runEpistasis({})).rejects.toThrow(/LoadedAlignment/);
	});
});
