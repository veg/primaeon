/**
 * parity-fixtures.test.js — the Python CLI's own outputs, replayed through the runtime with the
 * real general graph under onnxruntime-node.
 *
 * WHY THIS FILE EXISTS. The library's fixture replays (js/test) prove each function on identical
 * inputs; this file proves the RUNTIME reproduces `hyphaeon meme` / `hyphaeon busted` end to
 * end on the bundled examples, at the classes PARITY.md gives: site order and `is_invariable`
 * exact; `hyphaeon_lrt` within 1e-5·max(1, |lrt|) (the graph class as measured in Phase 0: two
 * fp32 torch paths differ by 6.7e-6, so 1e-6 is unreachable); p and q equal after float32
 * rounding GIVEN the surface's own LRT (the reference casts both to float32, cli.py:99-100), and
 * within the propagated LRT tolerance against the file; busted's statistical fields exact /
 * L·1e-6 / 1e-6; attribution ΔLRTs at twice the graph class (a difference of two graph values,
 * scaled by the site LRT) with the driver ranking compared up to ties inside that tolerance.
 *
 * THE MDS SIGN RESIDUAL IS CLOSED (was PHASE1.md gap 1). dataset.py's `compute_mds_coordinates`
 * used to inherit LAPACK ssyevd's eigenvector signs, the library's tred2/tql2 did not reproduce
 * them, and the model is NOT sign-invariant (`mds_proj = nn.Linear(4, embed_dim)` on the raw
 * coordinates, model.py:262/334) — so bat_oas1's columns 1 and 2 came out flipped and every
 * variable site's LRT moved (median 7e-3 relative, max 8.4e-2). veg/HyphAeon phase-2a made the
 * sign a CONVENTION on both sides (`--mds-sign canonical`, the default; MDS_SIGN.md) and
 * regenerated the fixtures under it. This file now asserts the full class on bat_oas1 with NO
 * sign alignment, and keeps the alignment helper to assert that it has become a no-op — the
 * shape PHASE2A.md gap 8 asks for, so a regression in either implementation's convention fails
 * here rather than passing as "the known residual".
 *
 * All of it is skipped, loudly, when ../HyphAeon's models or fixtures are not beside this repo.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
	loadAlignmentAndTree,
	memeSitePq,
	pvalsFromLrtMeme,
	benjaminiHochberg,
	attributeSelection,
	runAlignmentFilter
} from '@veg/hyphaeon-js';

import { runMeme } from '../src/pipeline.js';
import { runBusted } from '../src/busted.js';
import { inferSites, predictFromSession } from '../src/predict.js';
import { createSession } from '../src/createSession.js';
import { memeJsonText, memeCsvText, bustedJsonText, memeDocument } from '../src/results.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE = join(HERE, '..', '..', '..', 'HyphAeon');
const MODELS = join(ENGINE, 'models');
const FIXTURES = join(ENGINE, 'fixtures');
const EXAMPLES = join(ENGINE, 'examples');

const LRT_REL_TOL = 1e-5;
/** delta_lrt = site_lrt - counterfactual_lrt: two graph-class values, so twice the class, scaled by the site LRT. */
const attrTol = (siteLrt) => 2 * LRT_REL_TOL * Math.max(1, Math.abs(siteLrt));

const ready =
	existsSync(join(MODELS, 'general.onnx')) &&
	existsSync(join(MODELS, 'busted_head.onnx')) &&
	existsSync(join(FIXTURES, 'e2e', 'meme_Smc6.json'));
if (!ready) console.warn(`\n[parity-fixtures] SKIPPED — needs ${MODELS}/{general,busted_head}.onnx and ${FIXTURES}/e2e.\n`);

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

/** Flip each MDS column of `loaded.z` to the sign the Python fixture recorded; returns the flipped columns. */
function alignMdsSigns(loaded, name) {
	const c = fixture('dataset/load_alignment_and_tree.json').find((x) => x.name.includes(name));
	const py = c.outputs.mds_coords.flat(Infinity);
	const flipped = [];
	for (let k = 0; k < 4; k++) {
		let dot = 0;
		for (let i = 0; i < loaded.N; i++) dot += py[i * 4 + k] * loaded.z[i * 4 + k];
		if (dot < 0) {
			for (let i = 0; i < loaded.N; i++) loaded.z[i * 4 + k] = -loaded.z[i * 4 + k];
			flipped.push(k);
		}
	}
	return flipped;
}

function maxRelLrtDiff(refSites, lrts) {
	let max = 0;
	let at = null;
	for (let i = 0; i < refSites.length; i++) {
		const r = refSites[i].hyphaeon_lrt;
		const d = Math.abs(r - lrts[i]) / Math.max(1, Math.abs(r));
		if (d > max) {
			max = d;
			at = refSites[i].site;
		}
	}
	return { max, at };
}

/** The PARITY.md p/q check: p = float32(pvals_from_lrt_meme(surface lrt)), q = float32(BH(float32 p)). */
function assertPqGivenLrt(sites) {
	const lrts = Float64Array.from(sites, (s) => s.hyphaeon_lrt);
	const p = Float32Array.from(pvalsFromLrtMeme(lrts));
	const q = Float32Array.from(benjaminiHochberg(Float32Array.from(sites, (s) => Math.fround(s.p_value))));
	for (let i = 0; i < sites.length; i++) {
		expect(Math.fround(sites[i].p_value)).toBe(p[i]);
		expect(Math.fround(sites[i].q_value)).toBe(q[i]);
	}
}

function assertMemeClass(ref, result, { label }) {
	expect(result.taxa_count).toBe(ref.taxa_count);
	expect(result.codon_count).toBe(ref.codon_count);
	expect(result.sites.map((s) => s.site)).toEqual(ref.sites.map((s) => s.site));
	expect(result.sites.map((s) => s.is_invariable)).toEqual(ref.sites.map((s) => s.is_invariable));
	const { max, at } = maxRelLrtDiff(ref.sites, result.sites.map((s) => s.hyphaeon_lrt));
	console.log(`[parity-fixtures] ${label}: max relative |dLRT| ${max.toExponential(2)} at site ${at}`);
	expect(max, `${label} hyphaeon_lrt at site ${at}`).toBeLessThanOrEqual(LRT_REL_TOL);
	assertPqGivenLrt(result.sites);
	// Against the file itself, p and q move with the LRT: chi2 tails have slope < 1 near these
	// values, so the propagated bound is the LRT class times the largest LRT.
	const maxLrt = Math.max(...ref.sites.map((s) => Math.abs(s.hyphaeon_lrt)));
	const pTol = LRT_REL_TOL * Math.max(1, maxLrt) + 1e-7;
	for (let i = 0; i < ref.sites.length; i++) {
		expect(Math.abs(result.sites[i].p_value - ref.sites[i].p_value)).toBeLessThanOrEqual(pTol);
		expect(Math.abs(result.sites[i].q_value - ref.sites[i].q_value)).toBeLessThanOrEqual(pTol);
	}
}

describe.skipIf(!ready)('fixtures/e2e/meme_Smc6.json through runMeme (session-node, general graph)', () => {
	it('reproduces the CLI: site order, is_invariable exact; LRT at 1e-5; p/q float32-equal given LRT', async () => {
		const ref = fixture('e2e/meme_Smc6.json')[0].outputs;
		const { backbone } = await session();
		const result = await runMeme({
			...example('Smc6'),
			options: { maxSpecies: Infinity, alignmentName: 'Smc6.fasta', treeName: 'Smc6.nwk' },
			session: backbone,
			surface: 'node-server'
		});
		assertMemeClass(ref, result, { label: 'Smc6' });
		expect(result.filter_enabled).toBe(ref.filter_enabled);
		expect(result.artifacts_masked).toEqual(ref.artifacts_masked);
		expect(result.attribution_enabled).toBe(ref.attribution_enabled);
		expect(result.attributions).toEqual(ref.attributions);

		// The writers give the CLI's document: same keys in the same order, same first record.
		const doc = memeDocument(result, { provenance: false });
		expect(Object.keys(doc)).toEqual(Object.keys(ref));
		expect(doc.sites[0]).toEqual(ref.sites[0]);
		const text = memeJsonText(result, { provenance: false });
		expect(JSON.parse(text).sites[0]).toEqual(ref.sites[0]);
		expect(text.startsWith('{\n  "alignment": "Smc6.fasta",\n  "tree": "Smc6.nwk",')).toBe(true);
		const csv = memeCsvText(result).split('\n');
		expect(csv[0]).toBe('site,hyphaeon_lrt,p_value,q_value,is_invariable');
		expect(csv[1]).toBe('1,0.0,0.6666666865348816,0.6666666865348816,True');
	});
});

describe.skipIf(!ready)('fixtures/e2e/meme_bat_oas1.json through runMeme, and the MDS sign residual', () => {
	const ref = ready ? fixture('e2e/meme_bat_oas1.json')[0].outputs : null;

	it('reproduces the CLI with NO sign alignment: the canonical convention closed the gap', async () => {
		const { backbone } = await session();
		const result = await runMeme({ ...example('bat_oas1'), options: { maxSpecies: Infinity }, session: backbone });
		expect(result.sites.map((s) => s.is_invariable)).toEqual(ref.sites.map((s) => s.is_invariable));
		const { max, at } = maxRelLrtDiff(ref.sites, result.sites.map((s) => s.hyphaeon_lrt));
		const off = ref.sites.filter((s, i) => !s.is_invariable && Math.abs(s.hyphaeon_lrt - result.sites[i].hyphaeon_lrt) / Math.max(1, s.hyphaeon_lrt) > LRT_REL_TOL).length;
		console.log(`[parity-fixtures] bat_oas1 (canonical MDS signs, no alignment): max relative |dLRT| ${max.toExponential(2)} at site ${at}, ${off}/182 variable sites beyond 1e-5`);
		expect(max).toBeLessThanOrEqual(LRT_REL_TOL);
		expect(off).toBe(0);
		// And the sign-alignment helper is now a no-op: no column of the library's z disagrees with
		// the Python's (veg/HyphAeon phase-2a MDS_SIGN.md, both sides `canonical`).
		const loaded = loadAlignmentAndTree(example('bat_oas1').alignmentText, example('bat_oas1').treeText, { maxSpecies: null });
		expect(alignMdsSigns(loaded, 'bat_oas1')).toEqual([]);
	});

	it('aligning the columns to the Python signs therefore changes nothing, and still reproduces the CLI', async () => {
		const { backbone } = await session();
		const { alignmentText, treeText } = example('bat_oas1');
		const loaded = loadAlignmentAndTree(alignmentText, treeText, { maxSpecies: null, pruneDuplicates: true });
		alignMdsSigns(loaded, 'bat_oas1');
		const { lrt } = await inferSites(loaded, backbone, { outputs: ['lrt'] });
		const { pvals, qvals } = memeSitePq(lrt);
		const sites = Array.from(lrt, (v, i) => ({
			site: i + 1,
			hyphaeon_lrt: Number(v),
			p_value: Number(pvals[i]),
			q_value: Number(qvals[i]),
			is_invariable: loaded.invariable[i] === 1
		}));
		assertMemeClass(ref, { taxa_count: loaded.N, codon_count: loaded.L, sites }, { label: 'bat_oas1 (MDS signs aligned)' });
	});
});

describe.skipIf(!ready)('fixtures/attribution/attribute_selection.json and e2e/meme_bat_oas1_attribute_filter.json with the real predict', () => {
	it('attribute_selection: same focal sites, consensus, ΔLRT at 1e-5, ranking up to ties, epoch and mode', async () => {
		const fx = fixture('attribution/attribute_selection.json')[0];
		const { backbone } = await session();
		const { alignmentText, treeText } = example('bat_oas1');
		const loaded = loadAlignmentAndTree(alignmentText, treeText, { maxSpecies: null, pruneDuplicates: true });
		alignMdsSigns(loaded, 'bat_oas1');
		const attr = await attributeSelection(loaded, predictFromSession(backbone), {
			minLrt: fx.inputs.min_lrt,
			baseLrts: Float32Array.from(fx.outputs.base_lrts),
			taxa: loaded.taxa,
			batchSize: fx.inputs.batch_size
		});
		expect([...attr.keys()].map(String)).toEqual(Object.keys(fx.outputs.attributions));
		expect(attr.size).toBe(fx.outputs.n_sites_attributed);
		let maxDelta = 0;
		for (const [k, ref] of Object.entries(fx.outputs.attributions)) {
			const got = attr.get(Number(k));
			expect(got.consensus_codon).toBe(ref.consensus_codon);
			expect(got.consensus_aa).toBe(ref.consensus_aa);
			expect(got.num_mutated_taxa).toBe(ref.num_mutated_taxa);
			expect(got.predicted_lrt).toBeCloseTo(ref.predicted_lrt, 5);
			// Drivers keyed by taxon: every ΔLRT within the class.
			const ATTR_TOL = attrTol(ref.predicted_lrt);
			const byTaxon = new Map(got.driving_species.map((d) => [d.taxon, d]));
			for (const d of ref.driving_species) {
				const g = byTaxon.get(d.taxon);
				expect(g, `${k}/${d.taxon}`).toBeDefined();
				maxDelta = Math.max(maxDelta, Math.abs(g.delta_lrt - d.delta_lrt));
				expect(Math.abs(g.delta_lrt - d.delta_lrt)).toBeLessThanOrEqual(ATTR_TOL);
				expect(g.observed_codon).toBe(d.observed_codon);
				expect(g.observed_aa).toBe(d.observed_aa);
				expect(g.mean_patristic_depth).toBeCloseTo(d.mean_patristic_depth, 6);
			}
			// Ranking: identical wherever consecutive ΔLRTs are separated by more than the class.
			for (let j = 0; j + 1 < ref.driving_species.length; j++) {
				const gap = ref.driving_species[j].delta_lrt - ref.driving_species[j + 1].delta_lrt;
				if (gap > 2 * ATTR_TOL) {
					expect(got.driving_species.slice(0, j + 1).map((d) => d.taxon).sort()).toEqual(ref.driving_species.slice(0, j + 1).map((d) => d.taxon).sort());
				}
			}
			expect(got.when_selection_occurred.evolutionary_epoch).toBe(ref.when_selection_occurred.evolutionary_epoch);
			expect(got.when_selection_occurred.mode_of_adaptation).toBe(ref.when_selection_occurred.mode_of_adaptation);
			expect(got.when_selection_occurred.weighted_patristic_depth).toBeCloseTo(ref.when_selection_occurred.weighted_patristic_depth, 4);
			expect(got.when_selection_occurred.tree_depth_ratio).toBeCloseTo(ref.when_selection_occurred.tree_depth_ratio, 4);
		}
		console.log(`[parity-fixtures] attribute_selection: max |d delta_lrt| ${maxDelta.toExponential(2)} over ${attr.size} sites`);
	});

	it('meme --attribute --filter: the cmd_meme filter variant finds the same patches and artifacts, and the sites match', async () => {
		const fx = fixture('e2e/meme_bat_oas1_attribute_filter.json')[0].outputs;
		const { backbone } = await session();
		const { alignmentText, treeText } = example('bat_oas1');
		const loaded = loadAlignmentAndTree(alignmentText, treeText, { maxSpecies: null, pruneDuplicates: true });
		alignMdsSigns(loaded, 'bat_oas1');
		const predict = predictFromSession(backbone);
		const { lrt } = await inferSites(loaded, backbone, { outputs: ['lrt'] });
		const filter = await runAlignmentFilter({ alignmentText, treeText, loaded, baseLrts: lrt }, predict, { cliVariant: true, maxSpecies: null });
		expect(filter.artifacts_masked).toEqual(fx.artifacts_masked);
		expect(filter.num_artifacts_masked).toBe(fx.artifacts_masked.length);
		const finalLrt = filter.num_artifacts_masked > 0 ? filter.cleaned.lrts : lrt;
		const { pvals, qvals } = memeSitePq(finalLrt);
		const sites = Array.from(finalLrt, (v, i) => ({
			site: i + 1,
			hyphaeon_lrt: Number(v),
			p_value: Number(pvals[i]),
			q_value: Number(qvals[i]),
			is_invariable: loaded.invariable[i] === 1
		}));
		assertMemeClass(fx, { taxa_count: loaded.N, codon_count: loaded.L, sites }, { label: 'bat_oas1 --attribute --filter (MDS signs aligned)' });
		const attr = await attributeSelection(loaded, predict, { minLrt: 3.84, baseLrts: finalLrt, taxa: loaded.taxa });
		expect([...attr.keys()].map((k) => String(k + 1))).toEqual(Object.keys(fx.attributions));
	});

	it('runMeme wires --attribute and --filter the way cmd_meme does (same focal sites on the unaligned run)', async () => {
		const fx = fixture('e2e/meme_bat_oas1_attribute_filter.json')[0].outputs;
		const { backbone } = await session();
		const result = await runMeme({
			...example('bat_oas1'),
			options: { maxSpecies: Infinity, filter: true, attribute: true },
			session: backbone
		});
		expect(result.filter_enabled).toBe(true);
		expect(result.attribution_enabled).toBe(true);
		expect(result.artifacts_masked).toEqual(fx.artifacts_masked);
		// The focal set is LRT >= 3.84; the sign residual moves LRTs by < 0.1, and the six
		// attributed sites clear the threshold by more than that on both sides.
		expect(Object.keys(result.attributions)).toEqual(Object.keys(fx.attributions));
		for (const k of Object.keys(fx.attributions)) {
			const site = result.sites[Number(k) - 1];
			expect(site.attribution_details.site_1indexed).toBe(Number(k));
			expect(typeof site.top_driver).toBe('string');
		}
	});
});

describe.skipIf(!ready)('fixtures/e2e/busted_Smc6.json through runBusted (session-node, general graph + busted head)', () => {
	it('statistical fields at the PARITY.md classes; neural fields present, flagged nondeterministic', async () => {
		const ref = fixture('e2e/busted_Smc6.json')[0].outputs;
		const { backbone, head } = await session();
		expect(head).not.toBeNull();
		const result = await runBusted({
			...example('Smc6'),
			options: { alignmentName: 'Smc6.fasta', gene: 'Smc6' },
			session: backbone,
			head,
			surface: 'node-server'
		});
		const r = result.record;
		const L = ref.sites;
		expect(r.taxa).toBe(ref.taxa);
		expect(r.sites).toBe(ref.sites);
		expect(r.sig_sites_p05).toBe(ref.sig_sites_p05);
		expect(r.sig_sites_p10).toBe(ref.sig_sites_p10);
		expect(Math.abs(r.omnibus_lrt - ref.omnibus_lrt)).toBeLessThanOrEqual(L * 1e-6);
		expect(Math.abs(r.total_selection_energy - ref.total_selection_energy)).toBeLessThanOrEqual(L * 1e-6);
		expect(Math.abs(r.p_value_acat - ref.p_value_acat)).toBeLessThanOrEqual(1e-6);
		expect(Math.abs(r.p_value_simes - ref.p_value_simes)).toBeLessThanOrEqual(1e-6);
		expect(r.rate_distributions.omega_1).toBe(0.1);
		expect(r.rate_distributions.omega_2).toBe(1.0);
		// The head ran: numbers, not nulls — and the provenance says they are not comparable.
		expect(typeof r.selection_probability).toBe('number');
		expect(r.selection_probability).toBeGreaterThanOrEqual(0);
		expect(r.selection_probability).toBeLessThanOrEqual(1);
		expect(typeof r.predicted_gene_lrt).toBe('number');
		expect(typeof r.synonymous_rate_variation).toBe('number');
		const props = [r.rate_distributions.proportion_1, r.rate_distributions.proportion_2, r.rate_distributions.proportion_3];
		expect(props.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 4);
		expect(typeof r.positive_selection_detected).toBe('boolean');
		expect(r.elapsed_seconds).toBeGreaterThan(0);
		expect(result.provenance.neural_head).toMatchObject({ enabled: true, deterministic_upstream: false, artifact_sha256: head.sha256 });
		expect(result.provenance.busted_head_sha256).toBe(head.sha256);
		expect(result.provenance.surrogate_for).toBe('BUSTED');
		// Record keys in the CLI's order. The fixture carries two arrays the CLI does NOT write
		// (`site_lrts`, `is_invariable`: gen_fixtures.py busted_site_lrts, a `hyphaeon meme` run on
		// the same inputs whose float32 sums reproduce omnibus_lrt and total_selection_energy), so
		// they are dropped from the key comparison and checked against the per-site results instead.
		const FIXTURE_ONLY = ['site_lrts', 'is_invariable'];
		const cliKeys = Object.keys(ref).filter((k) => !FIXTURE_ONLY.includes(k));
		expect(Object.keys(r)).toEqual(cliKeys);
		const text = bustedJsonText(result, { provenance: false });
		expect(Object.keys(JSON.parse(text))).toEqual(cliKeys);
		if (Array.isArray(ref.site_lrts)) {
			expect(result.sites).toHaveLength(ref.site_lrts.length);
			expect(result.sites.map((s) => s.is_invariable)).toEqual(ref.is_invariable);
			const { max, at } = maxRelLrtDiff(ref.site_lrts.map((lrt, i) => ({ site: i + 1, hyphaeon_lrt: lrt })), result.sites.map((s) => s.hyphaeon_lrt));
			console.log(`[parity-fixtures] busted Smc6 site_lrts: max relative |dLRT| ${max.toExponential(2)} at site ${at}`);
			expect(max, `busted site_lrts at site ${at}`).toBeLessThanOrEqual(LRT_REL_TOL);
		}
		console.log(`[parity-fixtures] busted Smc6: p_acat ${r.p_value_acat} (ref ${ref.p_value_acat}), omnibus ${r.omnibus_lrt} (ref ${ref.omnibus_lrt}), head prob ${r.selection_probability}`);
	});

	it('without a head, the neural fields are null and the verdict follows ACAT alone, as the fixtures hold them', async () => {
		const ref = fixture('e2e/busted_Smc6.json')[0].outputs;
		const { backbone } = await session();
		const result = await runBusted({ ...example('Smc6'), session: backbone, head: null });
		const r = result.record;
		expect(r.selection_probability).toBeNull();
		expect(r.predicted_gene_lrt).toBeNull();
		expect(r.rate_distributions.proportion_3).toBeNull();
		expect(r.positive_selection_detected).toBe(ref.positive_selection_detected);
		expect(result.provenance.neural_head.enabled).toBe(false);
		expect(result.sites).toHaveLength(ref.sites);
	});
});
