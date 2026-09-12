/**
 * tree-free.test.js — PLAN.md D22 end to end: the runtime's tree-free path against the Python
 * CLI's own `--use-tn93` runs, through the real general graph under onnxruntime-node.
 *
 * WHY THIS FILE EXISTS. `../HyphAeon/PHASE3A.md` gap 2: "Real-model replays stay app-side … the
 * four `*_tn93.json` e2e fixtures are replayed only at the assembly level" — the library's own
 * `tn93.test.js` checks taxon counts, codon counts and the invariable mask, because it has no
 * ONNX graph. This file closes that: it runs the model on the same inputs and compares the
 * columns the model produces.
 *
 * WHAT D22 BUYS, AND WHY THESE FOUR CASES. Before Phase 3, camelid and HIV1_RT were the app's
 * only parity failures, and for one cause: their `.nwk` files carry a topology and no branch
 * lengths, so the app fitted lengths with HyPhy 2.5.98 compiled to WASM while the fixtures came
 * from native HyPhy 2.5.65 (PHASE1.md gap 3; camelid median relative |ΔLRT| 1.1e-5, HIV1_RT
 * 4.7e-4). D22 removed HyPhy: both now take the reference's own TN93 path, both sides compute
 * the same distance matrix — bit-identical, as PHASE3A.md measured — and the gap closes by
 * construction rather than by widening a tolerance. So these two are asserted at the STRICT
 * graph class, the same class bat_oas1 and Smc6 have always met:
 *
 *   camelid    fixtures/e2e/meme_camelid_tn93.json    212 taxa, 96 codons
 *   HIV1_RT    fixtures/e2e/meme_HIV1_RT_tn93.json    475 taxa, 335 codons
 *   Smc6       fixtures/e2e/busted_Smc6_tn93.json     the statistical half of cmd_busted
 *   Smc6       fixtures/e2e/epistasis_Smc6_tn93.json  edges and sectors, exact
 *
 * HOW EACH RUN REACHES THE TREE-FREE PATH IS PART OF WHAT IS TESTED. camelid and HIV1_RT are
 * given their real `.nwk` files: the runtime must notice the missing branch lengths and go
 * tree-free by itself (`tree_free.reason === 'no_branch_lengths'`), which is D22's product
 * behaviour and is what makes it match a `--use-tn93` fixture. Smc6's tree HAS branch lengths,
 * so its two runs pass `useTn93: true` explicitly — the reference's own flag, reason 'requested'.
 *
 * The Smc6 epistasis fixture is also the sharpest available check that the tree-free path is
 * really being taken end to end: the same alignment gives 5 edges and 2 sectors WITH its tree and
 * 6 edges and 3 sectors without it, so a run that quietly fell back to the tree could not pass.
 *
 * Skipped, loudly, when ../HyphAeon's models or fixtures are not beside this repository.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { benjaminiHochberg } from '@veg/hyphaeon-js';

import { runMeme, prepareRun } from '../src/pipeline.js';
import { runBusted } from '../src/busted.js';
import { runEpistasis } from '../src/epistasis.js';
import { inferSites } from '../src/predict.js';
import { createSession } from '../src/createSession.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE = join(HERE, '..', '..', '..', 'HyphAeon');
const MODELS = join(ENGINE, 'models');
const FIXTURES = join(ENGINE, 'fixtures');
const EXAMPLES = join(ENGINE, 'examples');

/** PLAN.md §5.4's measured class for anything that went through the graph. */
const LRT_REL_TOL = 1e-5;
const EIGEN_TOL = 1e-5;
/** PARITY.md's statistical bound for a Monte Carlo p, floored at 1/B. */
const statTol = (p, B) => 3 * Math.sqrt((Math.max(p, 1 / B) * (1 - Math.max(p, 1 / B))) / B);

const ready = existsSync(join(MODELS, 'general.onnx')) && existsSync(join(FIXTURES, 'e2e', 'meme_camelid_tn93.json'));
if (!ready) console.warn(`\n[tree-free] SKIPPED — needs ${MODELS}/general.onnx and ${FIXTURES}/e2e/*_tn93.json.\n`);

const fixture = (rel) => JSON.parse(readFileSync(join(FIXTURES, rel), 'utf8'));
const example = (name) => ({
	alignmentText: readFileSync(join(EXAMPLES, `${name}.fasta`), 'utf8'),
	treeText: existsSync(join(EXAMPLES, `${name}.nwk`)) ? readFileSync(join(EXAMPLES, `${name}.nwk`), 'utf8') : null
});

let sessions = null;
async function session() {
	if (!sessions) sessions = await createSession({ modelsBase: MODELS, variant: 'general', threads: 2, bustedHead: true });
	return sessions;
}

/** max |Δ| relative to max(1, |ref|) over two site columns, with the worst site named. */
function worstRelative(ref, got, key) {
	let worst = 0;
	let at = -1;
	for (let i = 0; i < ref.length; i++) {
		const d = Math.abs(ref[i][key] - got[i][key]) / Math.max(1, Math.abs(ref[i][key]));
		if (d > worst) {
			worst = d;
			at = ref[i].site;
		}
	}
	return { worst, at };
}

/**
 * THE SLOW BLOCK BELOW IS A PARITY CHECK, AND IT CAN BE SKIPPED ON A PULL REQUEST.
 *
 * It scores a whole real alignment through the graph and compares the result with the reference
 * CLI's own output. That is worth doing, and it is also the single longest thing in this suite,
 * which made it the long pole of continuous integration's fast path. `HYPHAEON_SKIP_SLOW_TESTS=1`
 * skips it; the workflow sets that on pull requests only, so it still runs on main, on the nightly
 * schedule and for every developer who just types `npm test`. Nothing is lost quietly: the numbers
 * this block checks are covered more thoroughly by the parity gate, which runs on exactly the pull
 * requests that can move them, and the surface wiring is covered by the faster blocks beside it.
 */
const SKIP_SLOW = process.env.HYPHAEON_SKIP_SLOW_TESTS === '1';
if (SKIP_SLOW) console.warn('[slow tests skipped] HYPHAEON_SKIP_SLOW_TESTS=1 — the full-alignment fixture comparisons in this file did not run.');

describe.skipIf(!ready || SKIP_SLOW)('meme, tree-free, against the CLI\'s own --use-tn93 files', () => {
	for (const [name, file, expectedReason] of [
		['camelid', 'e2e/meme_camelid_tn93.json', 'no_branch_lengths'],
		['HIV1_RT', 'e2e/meme_HIV1_RT_tn93.json', 'no_branch_lengths']
	]) {
		it(`${name}: the topology-only tree is ignored and the TN93 run matches the reference at the graph class`, async () => {
			const { backbone } = await session();
			const ref = fixture(file)[0];
			expect(ref.inputs.argv).toContain('--use-tn93');
			const { alignmentText, treeText } = example(name);
			expect(treeText, `${name}.nwk should exist and carry no branch lengths`).toBeTruthy();

			const result = await runMeme({
				alignmentText,
				// The user's own topology-only tree, exactly as an upload would carry it.
				treeText,
				options: { maxSpecies: Infinity, alignmentName: `${name}.fasta`, treeName: `${name}.nwk` },
				session: backbone,
				surface: 'node-server'
			});

			// 1. The run took the tree-free path, and said why.
			const pp = result.provenance.preprocessing;
			expect(pp.tree_source).toBe('tn93');
			expect(pp.tree_provided).toBe('user');
			expect(pp.tree_free.reason).toBe(expectedReason);
			expect(pp.branch_lengths_missing).toBe(true);
			expect(pp.match_tier).toBe(null); // the tree-free path does no taxon matching
			// 2. The assembly agrees with the reference's.
			expect(result.taxa_count).toBe(ref.outputs.taxa_count);
			expect(result.codon_count).toBe(ref.outputs.codon_count);
			expect(result.sites.map((s) => s.is_invariable)).toEqual(ref.outputs.sites.map((s) => s.is_invariable));
			expect(result.sites.map((s) => s.site)).toEqual(ref.outputs.sites.map((s) => s.site));
			// 3. The model's own column, at the strict graph class — the parity gap D22 closed.
			const { worst, at } = worstRelative(ref.outputs.sites, result.sites, 'hyphaeon_lrt');
			const beyond = ref.outputs.sites.filter(
				(s, i) => Math.abs(s.hyphaeon_lrt - result.sites[i].hyphaeon_lrt) > LRT_REL_TOL * Math.max(1, Math.abs(s.hyphaeon_lrt))
			).length;
			console.log(
				`[tree-free] ${name} meme vs hyphaeon meme --use-tn93: max relative |ΔLRT| ${worst.toExponential(2)} at site ${at}; ` +
					`${beyond}/${ref.outputs.sites.length} sites beyond the class`
			);
			expect(beyond).toBe(0);
			expect(worst).toBeLessThanOrEqual(LRT_REL_TOL);
			// 4. p and q are what cmd_meme writes for THIS surface's LRT: float32 values
			//    (cli.py:99-100 casts both), agreeing with the reference file to within what a
			//    graph-class LRT difference propagates. PARITY.md's special class evaluates the
			//    reference function on the surface's own input for exactly this reason — comparing
			//    p at 1e-9 against a file whose LRT differs would fail for a reason already
			//    reported under `hyphaeon_lrt`.
			let worstP = 0;
			let worstQ = 0;
			for (let i = 0; i < result.sites.length; i++) {
				const site = result.sites[i];
				expect(site.p_value).toBe(Math.fround(site.p_value));
				expect(site.q_value).toBe(Math.fround(site.q_value));
				worstP = Math.max(worstP, Math.abs(site.p_value - ref.outputs.sites[i].p_value));
				worstQ = Math.max(worstQ, Math.abs(site.q_value - ref.outputs.sites[i].q_value));
			}
			console.log(`[tree-free] ${name} p/q vs the reference file: max |Δp| ${worstP.toExponential(2)}, max |Δq| ${worstQ.toExponential(2)}`);
			expect(worstP).toBeLessThanOrEqual(1e-5);
			expect(worstQ).toBeLessThanOrEqual(1e-5);
			// And the pair is internally consistent: q is BH over p, recomputed here from the
			// surface's own p column with the library's own function.
			const q = benjaminiHochberg(Float64Array.from(result.sites, (x) => x.p_value));
			for (let i = 0; i < result.sites.length; i++) {
				expect(Math.abs(result.sites[i].q_value - q[i])).toBeLessThanOrEqual(1e-7);
			}
		}, 300_000);
	}
});

describe.skipIf(!ready)('busted --use-tn93 on Smc6: the statistical half', () => {
	it('reproduces cmd_busted\'s counts and sums on the TN93 assembly', async () => {
		const s = await session();
		const ref = fixture('e2e/busted_Smc6_tn93.json')[0].outputs;
		const { alignmentText, treeText } = example('Smc6');
		const result = await runBusted({
			alignmentText,
			// Smc6's tree HAS branch lengths, so tree-free has to be asked for, as the CLI asks.
			treeText,
			options: { useTn93: true, maxSpecies: 512, gene: 'Smc6', alignmentName: 'Smc6.fasta' },
			session: s.backbone,
			head: s.head,
			surface: 'node-server'
		});
		const pp = result.provenance.preprocessing;
		expect(pp.tree_source).toBe('tn93');
		expect(pp.tree_free.reason).toBe('requested');
		expect(pp.tree_provided).toBe(null); // a requested TN93 run does not consult the tree at all

		const rec = result.record;
		const L = ref.sites;
		expect(rec.taxa).toBe(ref.taxa);
		expect(rec.sites).toBe(L);
		// Exact: the significance counts (float32 comparisons on the surface's own p).
		expect(rec.sig_sites_p05).toBe(ref.sig_sites_p05);
		expect(rec.sig_sites_p10).toBe(ref.sig_sites_p10);
		// Derived class 1e-6 for the two combined p-values; L * 1e-6 for the two sums.
		console.log(
			`[tree-free] Smc6 busted --use-tn93: p_acat ${rec.p_value_acat} (ref ${ref.p_value_acat}); ` +
				`omnibus ${rec.omnibus_lrt} (ref ${ref.omnibus_lrt}); energy ${rec.total_selection_energy} (ref ${ref.total_selection_energy})`
		);
		expect(Math.abs(rec.p_value_acat - ref.p_value_acat)).toBeLessThanOrEqual(1e-6);
		expect(Math.abs(rec.p_value_simes - ref.p_value_simes)).toBeLessThanOrEqual(1e-6);
		expect(Math.abs(rec.omnibus_lrt - ref.omnibus_lrt)).toBeLessThanOrEqual(L * 1e-6);
		expect(Math.abs(rec.total_selection_energy - ref.total_selection_energy)).toBeLessThanOrEqual(L * 1e-6);
		// The neural head fields are null in the fixture (model.safetensors lacks 11 head
		// parameters, so the reference draws them unseeded) and must not be compared.
		for (const key of ['predicted_gene_lrt', 'selection_probability', 'synonymous_rate_variation', 'positive_selection_detected']) {
			expect(ref[key], key).toBe(null);
		}
		expect(rec.rate_distributions.omega_1).toBe(ref.rate_distributions.omega_1);
		expect(rec.rate_distributions.omega_2).toBe(ref.rate_distributions.omega_2);
	}, 300_000);
});

describe.skipIf(!ready)('epistasis --use-tn93 on Smc6: edges and sectors exact', () => {
	it('finds the reference\'s 6 edges and 3 sectors — not the 5 and 2 the tree gives', async () => {
		const { backbone } = await session();
		const ref = fixture('e2e/epistasis_Smc6_tn93.json')[0].outputs;
		const B = 1000;
		const { alignmentText, treeText } = example('Smc6');
		const prep = await prepareRun({
			alignmentText,
			treeText,
			options: { useTn93: true, maxSpecies: Infinity, diagnose: false },
			defaultMaxSpecies: null
		});
		expect(prep.preprocessing.tree_free.reason).toBe('requested');
		expect(prep.loaded.N).toBe(ref.taxa_count);
		expect(prep.loaded.L).toBe(ref.codon_count);
		// The display tree is NJ on these distances, and is not what anything below reads.
		expect(prep.displayTree.source).toBe('nj');

		const inference = await inferSites(prep.loaded, backbone, { outputs: ['lrt', 'mean_root_attns'] });
		const got = await runEpistasis({
			loaded: prep.loaded,
			attention: inference.mean_root_attns,
			lrt: inference.lrt,
			session: backbone,
			options: { nPermutations: B, seed: 42, dms: true },
			inputs: { alignment: 'Smc6.fasta', tree: null }
		});

		// This is the discriminator: the tree run gives 5 edges / 2 sectors on the same alignment.
		expect(got.coselection_edges_count).toBe(ref.coselection_edges_count);
		expect(got.discovered_sectors_count).toBe(ref.discovered_sectors_count);
		expect(got.edges.map((e) => [e.site_u, e.site_v])).toEqual(ref.edges.map((e) => [e.site_u, e.site_v]));
		expect(got.edges.map((e) => [e.ref_u, e.ref_v])).toEqual(ref.edges.map((e) => [e.ref_u, e.ref_v]));
		expect(got.edges.map((e) => [e.shared_taxa, e.shared_branches])).toEqual(ref.edges.map((e) => [e.shared_taxa, e.shared_branches]));

		// Every float field of an edge at the graph class, the same rule the tree-based
		// epistasis.test.js applies to the same fields: 1e-5 * max(1, |ref|). `p_val` / `hyper_p`
		// are a hypergeometric survival function of identical integer counts and land far below it;
		// `fdr_q` is BH over that column, so it carries m/k times whatever `p_val` carried.
		let worstEdge = 0;
		let worstField = '';
		for (let i = 0; i < ref.edges.length; i++) {
			for (const key of ['lrt_u', 'lrt_v', 'similarity', 'cesi', 'p_val', 'hyper_p', 'fdr_q']) {
				const d = Math.abs(ref.edges[i][key] - got.edges[i][key]);
				const tol = LRT_REL_TOL * Math.max(1, Math.abs(ref.edges[i][key]));
				expect(d, `${key} at ${ref.edges[i].site_u}-${ref.edges[i].site_v}`).toBeLessThanOrEqual(tol);
				if (d > worstEdge) {
					worstEdge = d;
					worstField = `${key}@${ref.edges[i].site_u}-${ref.edges[i].site_v}`;
				}
			}
		}
		console.log(`[tree-free] Smc6 epistasis --use-tn93: ${ref.edges.length} identical edges, worst float |Δ| ${worstEdge.toExponential(2)} (${worstField})`);

		for (let i = 0; i < ref.sectors.length; i++) {
			const a = ref.sectors[i];
			const b = got.sectors[i];
			expect(b.sector_id).toBe(a.sector_id);
			expect(b.sites).toEqual(a.sites);
			expect(b.size).toBe(a.size);
			expect(b.pars_signature).toBe(a.pars_signature);
			expect(b.shared_taxa).toBe(a.shared_taxa);
			expect(Math.abs(b.spectral_coherence - a.spectral_coherence)).toBeLessThanOrEqual(EIGEN_TOL);
			expect(Math.abs(b.mean_lrt - a.mean_lrt) / Math.max(1, Math.abs(a.mean_lrt))).toBeLessThanOrEqual(LRT_REL_TOL);
			// p_perm is a Monte Carlo estimate on both sides, at the fixture's own B = 1,000.
			const tol = statTol(a.p_perm, B);
			console.log(`[tree-free] sector ${a.sector_id} sites [${a.sites}]: C ${b.spectral_coherence} vs ${a.spectral_coherence}; p_perm ${b.p_perm} vs ${a.p_perm} (tol ${tol.toFixed(4)})`);
			expect(Math.abs(b.p_perm - a.p_perm)).toBeLessThanOrEqual(tol);
		}

		// The per-sector DMS the CLI runs unless --no-dms.
		expect(got.plasticity.map((p) => p.site)).toEqual(ref.plasticity.map((p) => p.site));
		expect(got.plasticity.map((p) => p.wt_aa)).toEqual(ref.plasticity.map((p) => p.wt_aa));
	}, 300_000);
});
