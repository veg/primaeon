/**
 * phenotype.test.js — the PhyloWAS pillar (`hyphaeon phenotype`) through the real general graph,
 * against the CLI's own file.
 *
 * WHY THIS FILE EXISTS. Phenotype was the ONE pillar the app could not run: `sections.phenotype`
 * was null on every surface and `hyphaeon_phenotype` shelled out to the Python CLI
 * (PHASE2.md gap 1). Phase 3a ported it to `@veg/hyphaeon-js` and this phase wired it up, so the
 * bridge is gone. `../HyphAeon/PHASE3A.md` gap 2 says what is left for the app to prove:
 *
 *   "the phenotype e2e fixture records no model outputs, so `association_rho`,
 *    `attribution_norm`, the two attention means, the two frequency columns, `spectral_energy`,
 *    `similarity`, `shared_branches` and `spectral_coherence` are pinned by no JSON replay …
 *    the standing check needs the ONNX graph and belongs next to the existing runtime replays."
 *
 * This is that standing check. `fixtures/e2e/phenotype_RHO_marine_n_permutations_0.json` is
 * `hyphaeon phenotype -a RHO.fasta -fg <the README Example 3 marine foreground> --n-permutations 0
 * --cpu --seed 42 --mds-sign canonical`, and the run below reproduces its argv through
 * `prepareRun` + one attention pass + `runPhenotype`.
 *
 * WHAT CLASS EACH COLUMN IS IN. Everything here is downstream of the graph — the site LRTs and
 * the attention matrix — so the model-bearing columns are at PLAN.md §5.4's graph class
 * (1e-5 · max(1, |ref|)), which is also what the fixture's own `tolerance` field says. Three
 * things are exact and are asserted as such, because nothing in the model touches them: the trait
 * resolution (`phenotype_meta`, a pure function of the taxon names and the `-fg` string), the
 * per-site identity columns (`site`, `ref_aa`, `derived_aa`) and every count and signature
 * string. `p_assoc_perm` is null on both sides at `--permulations 0`, which is the CLI's default
 * and the case the fixture pins.
 *
 * THE SECOND HALF of the file is the D22 permulation gate on a small alignment: with a real tree
 * the Brownian null runs, and tree-free it is skipped WITH A REASON rather than silently
 * substituting the display NJ tree. That is the app's own rule (phenotype.js), not the
 * reference's, and it is the one behaviour of this pillar no fixture can pin.
 *
 * Skipped, loudly, when ../HyphAeon's models or fixtures are not beside this repository.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { runPhenotype, resolvePhenotypeOptions, describeTrait, previewTrait, PHENOTYPE_CLI_DEFAULTS, PERMULATION_SKIP_REASONS } from '../src/phenotype.js';
import { prepareRun } from '../src/pipeline.js';
import { inferSites } from '../src/predict.js';
import { createSession } from '../src/createSession.js';
import { phenotypeDocument } from '../src/report.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE = join(HERE, '..', '..', '..', 'HyphAeon');
const MODELS = join(ENGINE, 'models');
const FIXTURES = join(ENGINE, 'fixtures');
const EXAMPLES = join(ENGINE, 'examples');

const LRT_REL_TOL = 1e-5;

const ready =
	existsSync(join(MODELS, 'general.onnx')) && existsSync(join(FIXTURES, 'e2e', 'phenotype_RHO_marine_n_permutations_0.json'));
if (!ready) console.warn(`\n[phenotype] SKIPPED — needs ${MODELS}/general.onnx and ${FIXTURES}/e2e/phenotype_RHO_*.json.\n`);

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

/** prepareRun + one attention pass: what the report already holds when the user answers the offer. */
async function pass(name, options = {}) {
	const { backbone } = await session();
	const { alignmentText, treeText } = example(name);
	const prepared = await prepareRun({
		alignmentText,
		treeText: options.treeText === undefined ? treeText : options.treeText,
		options: { maxSpecies: Infinity, diagnose: false, ...options.prepare },
		defaultMaxSpecies: null
	});
	const inference = await inferSites(prepared.loaded, backbone, { outputs: ['lrt', 'mean_root_attns'] });
	return { prepared, inference, attention: inference.mean_root_attns, lrt: inference.lrt };
}

describe('options, without a model', () => {
	it('takes cmd_phenotype\'s defaults and refuses nonsense', () => {
		const o = resolvePhenotypeOptions({});
		expect(o).toEqual({ ...PHENOTYPE_CLI_DEFAULTS, minTaxa: 4, nPermutations: 10000, permulations: 0 });
		expect(resolvePhenotypeOptions({}, { browser: true }).nPermutations).toBe(1000);
		expect(resolvePhenotypeOptions({ permutations: 250 }, { browser: true }).nPermutations).toBe(250);
		expect(() => resolvePhenotypeOptions({ permulations: -1 })).toThrow(/non-negative/);
		expect(() => resolvePhenotypeOptions({ seed: 1.5 })).toThrow(/seed must be an integer/);
		expect(() => resolvePhenotypeOptions({ alpha: 0 })).toThrow(/alpha/);
		expect(() => resolvePhenotypeOptions({ minTaxa: 0 })).toThrow(/minTaxa/);
	});

	it('names the trait\'s source and says out loud that `background` is ignored', () => {
		const d = describeTrait({ foreground: 'a,b', background: 'c' }, { mode: 'discrete', foreground_count: 2, background_count: 1, description: 'x' });
		expect(d.source).toBe('foreground');
		expect(d.background_ignored).toBe(true); // phenotype.py:125 declares it and never reads it
		expect(describeTrait({ preset: 'marine' }, {}).source).toBe('preset');
		expect(describeTrait({ phenotypeCsv: 'a,b\n' }, {}).source).toBe('table');
		expect(describeTrait({}, {}).source).toBe('vector');
	});

	it('previews which taxa a trait marks, without running anything', () => {
		const taxa = ['turTru', 'papAnu', 'hg38'];
		const p = previewTrait(taxa, { foreground: 'turTru' });
		expect(p.foreground).toEqual(['turTru']);
		expect(p.mode).toBe('discrete');
		// The reference's own quirk: an inline pattern is a REGEX before it is a glob, so `pan*`
		// is `pa` + zero-or-more `n` and matches papAnu (phenotype.py:249-256).
		expect(previewTrait(taxa, { foreground: 'pan*' }).foreground).toEqual(['papAnu']);
	});

	it('refuses to run without a trait at all', async () => {
		await expect(runPhenotype({ loaded: { a: new Int32Array(1), L: 1, N: 1, taxa: ['a'] }, phenotype: {} })).rejects.toThrow(/no trait was given/);
	});
});

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

describe.skipIf(!ready || SKIP_SLOW)('RHO against `hyphaeon phenotype` (fixtures/e2e/phenotype_RHO_marine_n_permutations_0.json)', () => {
	let got = null;
	const ref = ready ? fixture('e2e/phenotype_RHO_marine_n_permutations_0.json')[0] : null;

	async function run() {
		if (got) return got;
		const argv = ref.inputs.argv;
		/** The value of a flag in the fixture's own argv, or the CLI's default when it is absent. */
		const flag = (name, dflt) => (argv.includes(name) ? Number(argv[argv.indexOf(name) + 1]) : dflt);
		const foreground = argv[argv.indexOf('-fg') + 1];
		// RHO carries its tree embedded (NEXUS) and the CLI was given no -t, so `tree` is null in
		// the written document even though the run had a tree.
		const { prepared, attention, lrt } = await pass('RHO', { treeText: null });
		got = await runPhenotype({
			prepared,
			attention,
			lrt,
			phenotype: { foreground },
			options: {
				// `--permulations` is absent from the fixture's argv: the CLI's default is 0, which
				// is exactly the case it pins (parametric association p, no Brownian null).
				permulations: flag('--permulations', PHENOTYPE_CLI_DEFAULTS.permulations),
				nPermutations: flag('--n-permutations', PHENOTYPE_CLI_DEFAULTS.nPermutations),
				seed: flag('--seed', PHENOTYPE_CLI_DEFAULTS.seed)
			},
			inputs: { alignment: 'RHO.fasta', tree: null }
		});
		return got;
	}

	it('produces the reference\'s record, key for key and in its order', async () => {
		const res = await run();
		expect(Object.keys(phenotypeDocument(res))).toEqual(Object.keys(ref.outputs));
		expect(res.alignment).toBe('RHO.fasta');
		expect(res.tree).toBe(null);
		expect(res.taxa_count).toBe(ref.outputs.taxa_count); // 655 unique haplotypes of 710 records
		expect(res.codon_count).toBe(ref.outputs.codon_count);
		// The trait is a pure function of the taxon names and the -fg string: exact.
		expect(res.phenotype_meta).toEqual(ref.outputs.phenotype_meta);
		expect(res.trait.source).toBe('foreground');
		expect(res.attention_source).toBe('shared-pass');
	}, 300_000);

	it('reproduces the gene-level statistics at the graph class, and the PARS signature exactly', async () => {
		const res = await run();
		const o = ref.outputs;
		const close = (key, tol = LRT_REL_TOL * Math.max(1, Math.abs(o[key]))) => {
			const d = Math.abs(res[key] - o[key]);
			console.log(`[phenotype] ${key.padEnd(23)} ${res[key]} vs ${o[key]}  |Δ| ${d.toExponential(2)}`);
			expect(d, key).toBeLessThanOrEqual(tol);
		};
		for (const key of ['spectral_energy', 'norm_spectral_ratio', 'max_assoc', 'p_evd_length_adjusted', 'score_track_a', 'score_track_b', 'dual_track_composite']) {
			close(key);
		}
		expect(res.compact_pars_signature).toBe(o.compact_pars_signature);
		expect(res.significant_sites_count).toBe(o.significant_sites_count);
		expect(res.coselection_pairs_count).toBe(o.coselection_pairs_count);
		expect(res.trait_sectors_count).toBe(o.trait_sectors_count);
		// --permulations 0: no Brownian null was asked for, so the association p is parametric.
		expect(res.permulations_count).toBe(0);
		expect(res.gene_p_value_perm).toBe(null);
		expect(res.permulations.reason).toBe(PERMULATION_SKIP_REASONS.notRequested);
	}, 300_000);

	it('reproduces the site table: the same sites in the same order, every column at the graph class', async () => {
		const res = await run();
		const o = ref.outputs;
		expect(res.sites.length).toBe(o.sites.length);
		// The table is sorted by score descending; the same sites in the same order.
		expect(res.sites.map((s) => s.site)).toEqual(o.sites.map((s) => s.site));
		expect(res.sites.map((s) => s.ref_aa)).toEqual(o.sites.map((s) => s.ref_aa));
		expect(res.sites.map((s) => s.derived_aa)).toEqual(o.sites.map((s) => s.derived_aa));
		const worst = {};
		for (let i = 0; i < o.sites.length; i++) {
			const r = o.sites[i];
			const g = res.sites[i];
			expect(g.p_assoc_perm, `site ${r.site}`).toBe(null);
			expect(g.p_assoc).toBe(g.p_assoc_parametric);
			for (const key of [
				'hyphaeon_lrt',
				'p_lrt',
				'attribution_norm',
				'fg_mean_attn',
				'bg_mean_attn',
				'association_rho',
				'p_value',
				'p_assoc',
				'p_assoc_parametric',
				'score',
				'foreground_freq_pct',
				'background_freq_pct',
				'q_value'
			]) {
				const d = Math.abs(r[key] - g[key]);
				expect(d, `${key} at site ${r.site}`).toBeLessThanOrEqual(LRT_REL_TOL * Math.max(1, Math.abs(r[key])));
				if (!worst[key] || d > worst[key].d) worst[key] = { d, site: r.site };
			}
		}
		console.log(
			`[phenotype] RHO sites (${o.sites.length}): ` +
				Object.entries(worst)
					.map(([k, v]) => `${k} ${v.d.toExponential(2)}@${v.site}`)
					.join(', ')
		);
	}, 300_000);

	it('reproduces the trait co-selection pairs and the trait sector', async () => {
		const res = await run();
		const o = ref.outputs;
		expect(res.coselection_pairs.map((p) => [p.site_u, p.site_v])).toEqual(o.coselection_pairs.map((p) => [p.site_u, p.site_v]));
		let worstPair = 0;
		let worstAt = '';
		for (let i = 0; i < o.coselection_pairs.length; i++) {
			const r = o.coselection_pairs[i];
			const g = res.coselection_pairs[i];
			expect([g.ref_u, g.ref_v, g.shared_branches]).toEqual([r.ref_u, r.ref_v, r.shared_branches]);
			for (const key of ['lrt_u', 'lrt_v', 'similarity', 'cesi', 'p_value', 'q_value']) {
				const d = Math.abs(r[key] - g[key]);
				expect(d, `${key} at (${r.site_u}, ${r.site_v})`).toBeLessThanOrEqual(LRT_REL_TOL * Math.max(1, Math.abs(r[key])));
				if (d > worstPair) {
					worstPair = d;
					worstAt = `${key}@(${r.site_u},${r.site_v})`;
				}
			}
		}
		console.log(`[phenotype] RHO pairs (${o.coselection_pairs.length}): worst float |Δ| ${worstPair.toExponential(2)} (${worstAt})`);

		expect(res.trait_sectors.length).toBe(o.trait_sectors.length);
		for (let i = 0; i < o.trait_sectors.length; i++) {
			const r = o.trait_sectors[i];
			const g = res.trait_sectors[i];
			expect(g.sites).toEqual(r.sites);
			expect(g.size).toBe(r.size);
			expect(g.pars_signature).toBe(r.pars_signature);
			expect(g.shared_taxa).toBe(r.shared_taxa);
			expect(Math.abs(g.spectral_coherence - r.spectral_coherence)).toBeLessThanOrEqual(1e-5);
			expect(Math.abs(g.mean_lrt - r.mean_lrt) / Math.max(1, Math.abs(r.mean_lrt))).toBeLessThanOrEqual(LRT_REL_TOL);
			// --n-permutations 0 makes the sector permutation block degenerate: one "null" draw,
			// which is the sector itself, so p_perm is 1.0 and the null spread is 0 on both sides.
			expect(g.p_perm).toBe(r.p_perm);
			expect(g.null_coherence_std).toBe(r.null_coherence_std);
			console.log(`[phenotype] RHO sector ${r.sector_id} ${r.pars_signature}: C ${g.spectral_coherence} vs ${r.spectral_coherence}`);
		}
	}, 300_000);
});

describe.skipIf(!ready)('the permulation gate (PLAN.md D22, app-side)', () => {
	// Six of Smc6's twenty primates as an arbitrary "foreground": the trait is not a hypothesis
	// here, it is a vector, and what is under test is which null the pillar is allowed to draw.
	const FOREGROUND = 'hg18,homSap_293T,panTro4,panPan,ponAbe2,nomLeu3';

	it('draws the Brownian null when the run had a real tree', async () => {
		const { prepared, attention, lrt } = await pass('Smc6');
		expect(prepared.treeFree).toBe(null);
		const res = await runPhenotype({
			prepared,
			attention,
			lrt,
			phenotype: { foreground: FOREGROUND },
			options: { permulations: 100, nPermutations: 200, seed: 42 },
			inputs: { alignment: 'Smc6.fasta', tree: 'Smc6.nwk' }
		});
		expect(res.permulations).toMatchObject({ requested: 100, ran: 100, reason: null, seed: 42 });
		expect(res.permulations_count).toBe(100);
		expect(res.gene_p_value_perm).toBeGreaterThan(0);
		expect(res.gene_p_value_perm).toBeLessThanOrEqual(1);
		// Every site's association p is now the empirical one, on the (1 + k) / (1 + P) grid.
		for (const s of res.sites) {
			expect(s.p_assoc_perm).not.toBe(null);
			expect(s.p_assoc).toBe(s.p_assoc_perm);
			expect(Math.round(s.p_assoc_perm * 101)).toBeCloseTo(s.p_assoc_perm * 101, 6);
		}
		console.log(`[phenotype] Smc6 with its tree: ${res.permulations_count} permulations, gene p = ${res.gene_p_value_perm}`);
	}, 300_000);

	it('skips it in tree-free mode, says why, and does NOT substitute the display NJ tree', async () => {
		const { prepared, attention, lrt } = await pass('Smc6', { prepare: { useTn93: true } });
		expect(prepared.treeFree.reason).toBe('requested');
		expect(prepared.displayTree.source).toBe('nj'); // there IS a tree to hand; it is not used
		const res = await runPhenotype({
			prepared,
			attention,
			lrt,
			phenotype: { foreground: FOREGROUND },
			options: { permulations: 100, nPermutations: 200, seed: 42 },
			inputs: { alignment: 'Smc6.fasta', tree: null }
		});
		expect(res.permulations.requested).toBe(100);
		expect(res.permulations.ran).toBe(0);
		expect(res.permulations.reason).toBe(PERMULATION_SKIP_REASONS.treeFree);
		expect(res.permulations.detail).toMatch(/neighbour-joining tree on those same distances and is deliberately NOT used/);
		expect(res.permulations_count).toBe(0);
		expect(res.gene_p_value_perm).toBe(null);
		for (const s of res.sites) {
			expect(s.p_assoc_perm).toBe(null);
			expect(s.p_assoc).toBe(s.p_assoc_parametric);
		}
		console.log(`[phenotype] Smc6 tree-free: permulations skipped (${res.permulations.reason}); ${res.sites.length} sites on the parametric p`);
	}, 300_000);
});
