/**
 * analyze.test.js — one upload, one report: the order the sections arrive in, the numbers they
 * carry, and what happens when the expensive one is cancelled or refused.
 *
 * WHY THIS FILE EXISTS. `runEverything` is the contract every surface codes against (PLAN.md
 * §4.0 / the orchestrator contract), so what has to be pinned is not one number but a shape:
 * sections in the plan's order, `sites` and `gene` equal to what `hyphaeon meme` / `hyphaeon
 * busted` write for the same inputs (fixtures/e2e), epistasis equal to `hyphaeon epistasis`'s
 * (that comparison lives in epistasis.test.js, on the same code path), attribution on the sites
 * the report CALLED, the filter reported beside the primary sites rather than replacing them,
 * and a DMS that can be cancelled or skipped without costing the rest of the report.
 *
 * The runs here use `maxSpecies: Infinity` — the CLI's default (cli.py:1025) — so the fixtures
 * apply; the report's own default is 256 (the manifest's `default_taxon_cap`), which is a
 * product decision and not what the reference does.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createSession } from '../src/createSession.js';
import { runEverything, calledSiteIndices, REPORT_DEFAULTS } from '../src/analyze.js';
import { REPORT_SCHEMA_VERSION, SECTION_ORDER, toReportRecord, downloadsForReport } from '../src/report.js';
import { dmsWork } from '../src/dms.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE = join(HERE, '..', '..', '..', 'HyphAeon');
const MODELS = join(ENGINE, 'models');
const FIXTURES = join(ENGINE, 'fixtures');
const EXAMPLES = join(ENGINE, 'examples');
const LRT_REL_TOL = 1e-5;

const ready = existsSync(join(MODELS, 'general.onnx')) && existsSync(join(MODELS, 'busted_head.onnx')) && existsSync(join(FIXTURES, 'e2e', 'meme_bat_oas1.json'));
if (!ready) console.warn(`\n[analyze] SKIPPED — needs ${MODELS}/{general,busted_head}.onnx and ${FIXTURES}/e2e.\n`);

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

/** One bat_oas1 report, reused: the whole thing, with the DMS held to eight sites for the clock. */
let batReport = null;
const batOrder = [];
const batProgress = [];
async function batOas1Report() {
	if (batReport) return batReport;
	const s = await session();
	batReport = await runEverything({
		...example('bat_oas1'),
		inputs: { alignmentName: 'bat_oas1.fasta', treeName: 'bat_oas1.nwk', demo: 'bat_oas1' },
		options: {
			maxSpecies: Infinity,
			seed: 42,
			permutations: 200,
			dms: { enabled: true, siteSubset: [0, 1, 2, 3, 4, 5, 6, 7], batchSize: 38 }
		},
		session: s,
		surface: 'node-server',
		progress: (phase, done, total, message) => batProgress.push({ phase, done, total, message }),
		onSection: (name, payload, meta) => batOrder.push(meta.final ? name : `${name}~`)
	});
	return batReport;
}

describe('the report record, without a model', () => {
	it('names its sections and defaults where PLAN.md §4.0 does', () => {
		expect(SECTION_ORDER).toEqual(['sites', 'gene', 'epistasis', 'attribution', 'filter', 'dms', 'phenotype']);
		expect(REPORT_SCHEMA_VERSION).toBe(2);
		expect(REPORT_DEFAULTS.callMode).toBe('percentile');
		expect(REPORT_DEFAULTS.maxSpecies).toBe(256);
		expect(REPORT_DEFAULTS.seed).toBe(42);
		expect(REPORT_DEFAULTS.permutations).toBe(1000);
		expect(REPORT_DEFAULTS.dms.enabled).toBe(true);
	});

	it('calls the sites the call mode called, 0-indexed for attributeSelection', () => {
		const sites = [
			{ site: 1, call: 'Neutral' },
			{ site: 2, call: 'Top 2%' },
			{ site: 7, call: 'Top 5%' }
		];
		expect(calledSiteIndices(sites)).toEqual([1, 6]);
	});

	it('refuses an unknown call mode and a session that is not a session', async () => {
		await expect(runEverything({ alignmentText: '>a\nATG\n', session: { session: {}, ort: {} }, options: { callMode: 'q-value' } })).rejects.toThrow(/unknown callMode/);
		await expect(runEverything({ alignmentText: '>a\nATG\n', session: null })).rejects.toThrow(/createSession/);
	});
});

describe.skipIf(!ready)('runEverything on bat_oas1 (session-node, general graph + busted head)', () => {
	it('streams the sections in PLAN.md §4.0\'s order, DMS progressively and last', async () => {
		await batOas1Report();
		expect(batOrder[0]).toBe('diagnostics');
		const finals = batOrder.filter((n) => !n.endsWith('~'));
		expect(finals).toEqual(['diagnostics', 'sites', 'gene', 'epistasis', 'attribution', 'filter', 'dms']);
		// The DMS publishes partials before its final, and nothing follows it.
		expect(batOrder.filter((n) => n === 'dms~').length).toBe(4);
		expect(batOrder.indexOf('dms~')).toBeGreaterThan(batOrder.indexOf('filter'));
		expect(batOrder[batOrder.length - 1]).toBe('dms');
		// Progress uses the contract's phase names, in order.
		const phases = [...new Set(batProgress.map((p) => p.phase))];
		expect(phases).toEqual(['parse', 'prepare', 'infer', 'stats', 'postprocess', 'gene', 'epistasis', 'attribute', 'filter', 'dms']);
	});

	it('sites reproduce `hyphaeon meme` on the same input at the graph class', async () => {
		const report = await batOas1Report();
		const ref = fixture('e2e/meme_bat_oas1.json')[0].outputs;
		const sites = report.sections.sites;
		expect(sites.taxa_count).toBe(ref.taxa_count);
		expect(sites.codon_count).toBe(ref.codon_count);
		expect(sites.sites.map((s) => s.is_invariable)).toEqual(ref.sites.map((s) => s.is_invariable));
		let worst = 0;
		for (let i = 0; i < ref.sites.length; i++) {
			const r = ref.sites[i].hyphaeon_lrt;
			const g = sites.sites[i].hyphaeon_lrt;
			const d = Math.abs(r - g) / Math.max(1, Math.abs(r));
			if (d > worst) worst = d;
		}
		console.log(`[analyze] bat_oas1 sites vs hyphaeon meme: max relative |ΔLRT| ${worst.toExponential(2)}`);
		expect(worst).toBeLessThanOrEqual(LRT_REL_TOL);
		// The primary view is the UNMASKED, UNATTRIBUTED run: the filter and the attribution are
		// their own sections and must not have rewritten it (cli.py:214-218 does; the report does not).
		expect(sites.filter_enabled).toBe(false);
		expect(sites.attribution_enabled).toBe(false);
		expect(sites.arrays.raw).toBe(null);
	});

	it('gene comes from the same forward pass: statistics over its LRTs plus one head call', async () => {
		const report = await batOas1Report();
		const gene = report.sections.gene;
		const sites = report.sections.sites;
		expect(gene.record.taxa).toBe(sites.taxa_count);
		expect(gene.record.sites).toBe(sites.codon_count);
		expect(gene.statistics.numVariable).toBe(sites.summary.variableSites);
		expect(gene.record.p_value_acat).toBeGreaterThan(0);
		expect(gene.record.p_value_acat).toBeLessThanOrEqual(1);
		expect(gene.record.omnibus_lrt).toBeGreaterThanOrEqual(0);
		// The head ran and is flagged as the non-reproducible half (PHASE1A gap 4).
		expect(gene.neural_head.enabled).toBe(true);
		expect(gene.neural_head.deterministic_upstream).toBe(false);
		expect(gene.record.selection_probability).not.toBe(null);
		// The gene phase costs a head call, not a rescore: it is the cheapest phase of the report.
		expect(report.timings.gene).toBeLessThan(report.timings.infer);
	});

	it('epistasis, attribution and filter all ran over the one loaded alignment', async () => {
		const report = await batOas1Report();
		const ep = report.sections.epistasis;
		expect(ep.taxa_count).toBe(report.sections.sites.taxa_count);
		expect(ep.attention_source).toBe('shared-pass');
		expect(ep.permutations.n).toBe(200);
		expect(ep.permutations.seed).toBe(42);
		expect(Array.isArray(ep.edges)).toBe(true);
		expect(ep.graph.nodes.length).toBe(ep.codon_count);
		// The report's own DMS section sweeps the alignment, so the per-sector sweep stays off.
		expect(ep.dms_enabled).toBe(false);

		const attr = report.sections.attribution;
		expect(attr.attribution_enabled).toBe(true);
		expect(attr.gate.kind).toBe('called');
		expect(attr.gate.call_mode).toBe('percentile');
		expect(attr.focal_sites).toEqual(calledSiteIndices(report.sections.sites.sites).map((s) => s + 1));
		expect(attr.attributed_sites).toBe(Object.keys(attr.attributions).length);
		expect(attr.focal_sites.length).toBeGreaterThan(0);

		const filter = report.sections.filter;
		expect(filter.filter_enabled).toBe(true);
		expect(filter.primary_view).toBe('unmasked');
		expect(Array.isArray(filter.artifacts_masked)).toBe(true);
		expect(filter.num_artifacts_masked).toBe(filter.artifacts_masked.length);
		// Nothing masked on bat_oas1, so there is no second view to keep.
		expect(filter.cleaned).toBe(filter.num_artifacts_masked > 0 ? filter.cleaned : null);
	});

	it('DMS is last, progressive and inside its budget; phenotype is offered, not run', async () => {
		const report = await batOas1Report();
		const dms = report.sections.dms;
		expect(dms.plasticity.length).toBe(8);
		expect(dms.progress).toEqual({ done: 8, total: 8 });
		expect(dms.skipped).toBeUndefined();
		expect(dms.cancelled).toBeUndefined();
		expect(dms.work).toBe(dmsWork(8, report.sections.sites.taxa_count));
		expect(dms.total_mutations).toBe(19 * report.sections.sites.codon_count);
		expect(report.sections.phenotype).toBe(null);
	});

	it('carries PLAN.md §3.5 provenance with the surface, the seed and every option as submitted', async () => {
		const report = await batOas1Report();
		expect(report.kind).toBe('report');
		expect(report.schema_version).toBe(REPORT_SCHEMA_VERSION);
		expect(report.provenance.surface).toBe('node-server');
		expect(report.provenance.seed).toBe(42);
		expect(report.provenance.is_surrogate).toBe(true);
		expect(report.provenance.surrogate_for).toContain('MEME');
		expect(report.provenance.model_variant).toBe('general');
		expect(report.provenance.artifact_sha256).toMatch(/^[0-9a-f]{64}$/);
		expect(report.provenance.options.callMode).toBe('percentile');
		expect(report.provenance.options.maxSpecies).toBe('none');
		expect(report.provenance.report.sections_run).toEqual(['sites', 'gene', 'epistasis', 'attribution', 'filter', 'dms']);
		expect(report.provenance.report.sections_failed).toEqual([]);
		expect(report.provenance.preprocessing.taxa_used).toBe(report.sections.sites.taxa_count);
		expect(report.diagnostics.warnings.every((w) => typeof w.code === 'string')).toBe(true);
		// Timings per phase, and they add up to less than the whole run.
		for (const phase of ['prepare', 'infer', 'gene', 'epistasis', 'attribute', 'filter', 'dms', 'total']) {
			expect(typeof report.timings[phase], phase).toBe('number');
		}
		const sum = ['prepare', 'infer', 'gene', 'epistasis', 'attribute', 'filter', 'dms'].reduce((a, k) => a + report.timings[k], 0);
		expect(sum).toBeLessThanOrEqual(report.timings.total + 1e-6);
	});

	it('serialises to JSON and offers one download per section that ran', async () => {
		const report = await batOas1Report();
		const record = toReportRecord(report, { includeArrays: false });
		const round = JSON.parse(JSON.stringify(record));
		expect(round.sections.sites.sites.length).toBe(report.sections.sites.sites.length);
		expect(round.sections.sites.arrays).toBeUndefined();
		expect(round.sections.sites.attention).toBeUndefined();
		expect(round.sections.dms.plasticity.length).toBe(8);
		const names = downloadsForReport(report).map((d) => d.name);
		expect(names).toEqual([
			'bat_oas1.meme.json',
			'bat_oas1.meme.csv',
			'bat_oas1.busted.json',
			'bat_oas1.busted.csv',
			'bat_oas1.epistasis.json',
			'bat_oas1.epistasis.csv',
			'bat_oas1.epistasis.graphml',
			'bat_oas1.dms.json',
			'bat_oas1.dms.csv',
			'bat_oas1.report.json'
		]);
	});
});

describe.skipIf(!ready)('runEverything on Smc6 against the CLI\'s own meme and busted files', () => {
	it('reproduces hyphaeon meme and the statistical half of hyphaeon busted', async () => {
		const s = await session();
		const report = await runEverything({
			...example('Smc6'),
			inputs: { alignmentName: 'Smc6.fasta', treeName: 'Smc6.nwk' },
			options: {
				maxSpecies: Infinity,
				seed: 42,
				epistasis: false,
				attribute: false,
				filter: false,
				dms: { enabled: false }
			},
			session: s,
			surface: 'node-server'
		});
		const memeRef = fixture('e2e/meme_Smc6.json')[0].outputs;
		let worst = 0;
		for (let i = 0; i < memeRef.sites.length; i++) {
			const r = memeRef.sites[i].hyphaeon_lrt;
			const d = Math.abs(r - report.sections.sites.sites[i].hyphaeon_lrt) / Math.max(1, Math.abs(r));
			if (d > worst) worst = d;
		}
		expect(worst).toBeLessThanOrEqual(LRT_REL_TOL);

		const bustedRef = fixture('e2e/busted_Smc6.json')[0].outputs;
		const rec = report.sections.gene.record;
		const L = memeRef.codon_count;
		console.log(
			`[analyze] Smc6: max relative |ΔLRT| ${worst.toExponential(2)}; ` +
				`p_acat ${rec.p_value_acat} (ref ${bustedRef.p_value_acat}); omnibus ${rec.omnibus_lrt} (ref ${bustedRef.omnibus_lrt})`
		);
		expect(rec.taxa).toBe(bustedRef.taxa);
		expect(rec.sites).toBe(bustedRef.sites);
		expect(rec.sig_sites_p05).toBe(bustedRef.sig_sites_p05);
		expect(rec.sig_sites_p10).toBe(bustedRef.sig_sites_p10);
		// derived class for ACAT / Simes; L * 1e-6 for the two sums (PARITY.md).
		expect(Math.abs(rec.p_value_acat - bustedRef.p_value_acat)).toBeLessThanOrEqual(1e-6);
		expect(Math.abs(rec.p_value_simes - bustedRef.p_value_simes)).toBeLessThanOrEqual(1e-6);
		expect(Math.abs(rec.omnibus_lrt - bustedRef.omnibus_lrt)).toBeLessThanOrEqual(L * 1e-6);
		expect(Math.abs(rec.total_selection_energy - bustedRef.total_selection_energy)).toBeLessThanOrEqual(L * 1e-6);
		// The sections that were switched off are absent, not empty.
		expect(report.sections.epistasis).toBe(null);
		expect(report.sections.attribution).toBe(null);
		expect(report.sections.filter).toBe(null);
		expect(report.sections.dms).toBe(null);
	});
});

describe.skipIf(!ready)('cancelling and capping the expensive section', () => {
	it('cancelling mid-DMS keeps every other section and the partial heatmap', async () => {
		const s = await session();
		const controller = new AbortController();
		let partials = 0;
		const report = await runEverything({
			...example('bat_oas1'),
			inputs: { alignmentName: 'bat_oas1.fasta', treeName: 'bat_oas1.nwk' },
			options: {
				maxSpecies: Infinity,
				permutations: 100,
				epistasis: true,
				dms: { enabled: true, siteSubset: Array.from({ length: 60 }, (_, i) => i), batchSize: 38 }
			},
			session: s,
			surface: 'node-server',
			signal: controller.signal,
			onSection: (name, payload, meta) => {
				if (name === 'dms' && !meta.final) {
					partials++;
					if (partials === 2) controller.abort();
				}
			}
		});
		expect(report.sections.sites.sites.length).toBe(351);
		expect(report.sections.gene.record.p_value_acat).toBeGreaterThan(0);
		expect(report.sections.epistasis.edges).toBeDefined();
		expect(report.sections.attribution.attribution_enabled).toBe(true);
		expect(report.sections.dms.cancelled).toBe(true);
		expect(report.sections.dms.plasticity.length).toBe(4);
		expect(report.sections.dms.progress).toEqual({ done: 4, total: 60 });
		expect(report.provenance.report.sections_failed).toEqual([]);
	});

	it('a DMS above the work budget is reported as skipped, with the rest of the report intact', async () => {
		const s = await session();
		const report = await runEverything({
			...example('bat_oas1'),
			inputs: { alignmentName: 'bat_oas1.fasta' },
			options: {
				maxSpecies: Infinity,
				epistasis: false,
				attribute: false,
				filter: false,
				dms: { enabled: true, workBudget: 1000 }
			},
			session: s,
			surface: 'node-server'
		});
		expect(report.sections.dms.skipped).toBe(true);
		expect(report.sections.dms.plasticity).toEqual([]);
		expect(report.sections.dms.budget).toBe(1000);
		expect(report.sections.dms.reason).toMatch(/server/);
		expect(report.sections.sites.sites.length).toBe(351);
		expect(report.sections.gene.record.sites).toBe(351);
		// A skipped DMS still contributes no download.
		expect(downloadsForReport(report).map((d) => d.name)).not.toContain('bat_oas1.dms.csv');
	});
});
