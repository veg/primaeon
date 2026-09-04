/**
 * pipeline.test.js — runMeme end to end.
 *
 * Two halves. The first drives the orchestration with a FAKE session so the phase order, the
 * variable-site-only inference, the batching, the optional heads, the gates, the filter /
 * attribute wiring and the provenance block can be asserted exactly and quickly. The second
 * loads the REAL general graph through session-node.js and scores examples/bat_oas1 (18 taxa x
 * 351 codons) from the engine repository: shape, finiteness, agreement of the invariable mask,
 * and that the Python columns and the app columns coexist on every site. The numeric parity
 * against the Python CLI's fixtures is test/parity-fixtures.test.js.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
	runMeme,
	PHASES,
	NO_TREE_MESSAGE,
	NO_BRANCH_LENGTHS_MESSAGE,
	MIN_SPECIES,
	SCHEMA_VERSION,
	clampMaxSpecies,
	MAX_SPECIES_CAP
} from '../src/pipeline.js';
import { loadSession, resetSession } from '../src/session-node.js';
import { loadManifest, pickVariant } from '../src/manifest.js';
import { NEUTRAL_CALL } from '../src/postprocess.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE = join(HERE, '..', '..', '..', 'HyphAeon');

// -------------------------------------------------------------------------------------------
// A fake session: lrt = (first codon token of the site's first taxon) / 10 + batch-local index
// noise, so the value depends on the tokens the graph was fed; attention = site-major counter.
// The fake records which sites (by batch size) it saw and which outputs were fetched.
// -------------------------------------------------------------------------------------------

function fakeSession(outputNames = ['lrt', 'mean_root_attns', 'root_repr'], lrtFor = null) {
	const runs = [];
	const fetched = [];
	const ort = {
		Tensor: class {
			constructor(type, data, dims) {
				this.type = type;
				this.data = data;
				this.dims = dims;
			}
		}
	};
	let counter = 0;
	const session = {
		inputNames: ['msa_codons', 'msa_aas', 'dist_matrix', 'mds_coords'],
		outputNames,
		run: async (feeds, fetches) => {
			const b = feeds.msa_codons.dims[0];
			const n = feeds.msa_codons.dims[1];
			runs.push(b);
			fetched.push(fetches ?? null);
			const lrt = new Float32Array(b);
			const attn = new Float32Array(b * n);
			const repr = new Float32Array(b * 384);
			for (let k = 0; k < b; k++) {
				const codons = Array.from(feeds.msa_codons.data.subarray(k * n, (k + 1) * n), Number);
				lrt[k] = lrtFor ? lrtFor(codons) : codons.reduce((s, t) => s + t, 0) / 100;
				for (let j = 0; j < n; j++) attn[k * n + j] = counter * n + j;
				repr[k * 384] = counter + 1;
				counter++;
			}
			const out = { lrt: { data: lrt } };
			if (outputNames.includes('mean_root_attns') && (!fetches || fetches.includes('mean_root_attns'))) {
				out.mean_root_attns = { data: attn };
			}
			if (outputNames.includes('root_repr') && (!fetches || fetches.includes('root_repr'))) {
				out.root_repr = { data: repr };
			}
			return out;
		}
	};
	return {
		handle: { session, ort, sha256: 'cd'.repeat(32), verified: true, outputNames, variant: 'fake', modelVersion: 'v0' },
		runs,
		fetched
	};
}

// Four taxa, six variable codons and one invariable codon (site 7, all ATG).
const CODONS = { a: 'ATG', b: 'TTT', c: 'GGG', d: 'CCC' };
const ALIGNMENT =
	Object.entries(CODONS)
		.map(([name, codon]) => `>${name}\n${codon.repeat(6)}ATG`)
		.join('\n') + '\n';
const TREE = '((a:0.1,b:0.2):0.05,(c:0.3,d:0.4):0.05);';

describe('clampMaxSpecies', () => {
	it('defaults, clamps, and treats Infinity as no cap (the CLI default)', () => {
		expect(clampMaxSpecies(undefined)).toBe(256);
		expect(clampMaxSpecies(null)).toBe(256);
		expect(clampMaxSpecies(Infinity)).toBeNull();
		expect(clampMaxSpecies('none')).toBeNull();
		expect(clampMaxSpecies(1)).toBe(MIN_SPECIES);
		expect(clampMaxSpecies(10000)).toBe(MAX_SPECIES_CAP);
		expect(clampMaxSpecies('abc')).toBe(256);
		expect(clampMaxSpecies(40.7)).toBe(40);
	});
});

describe('runMeme over a fake session', () => {
	it('runs the phases in order, scores VARIABLE sites only, batches, and fetches lrt alone', async () => {
		const { handle, runs, fetched } = fakeSession();
		const events = [];
		const result = await runMeme({
			alignmentText: ALIGNMENT,
			treeText: TREE,
			options: { batchSize: 4 },
			session: handle,
			surface: 'node-server',
			progress: (phase, done, total, message) => events.push({ phase, done, total, message })
		});

		// Phase order: every phase reported is in PHASES order; filter/attribute absent.
		const phases = [...new Set(events.map((e) => e.phase))];
		expect(phases).toEqual(['parse', 'prepare', 'infer', 'stats', 'postprocess']);
		expect(phases.map((p) => PHASES.indexOf(p))).toEqual([...phases.map((p) => PHASES.indexOf(p))].sort((a, b) => a - b));
		const infer = events.filter((e) => e.phase === 'infer');
		expect(infer.at(-1)).toMatchObject({ done: 6, total: 6 });

		// inference.py:170-186: six variable sites, batches of 4 -> [4, 2]; site 7 never sent.
		expect(runs).toEqual([4, 2]);
		// Only `lrt` is fetched when nothing else was asked for.
		for (const f of fetched) expect(f).toEqual(['lrt']);

		expect(result.schema_version).toBe(SCHEMA_VERSION);
		expect(result.method).toBe('meme');
		expect(result.is_surrogate).toBe(true);
		expect(result.surrogate_for).toBe('MEME');
		expect(result.taxa_count).toBe(4);
		expect(result.codon_count).toBe(7);
		expect(result.sites).toHaveLength(7);
		for (let i = 0; i < 6; i++) {
			const s = result.sites[i];
			expect(s.site).toBe(i + 1);
			// The Python columns...
			expect(s.is_invariable).toBe(false);
			expect(s.hyphaeon_lrt).toBeGreaterThan(0);
			expect(s.p_value).toBeLessThan(2 / 3);
			expect(s.q_value).toBeGreaterThanOrEqual(s.p_value);
			// ...and the app's, never replacing them.
			expect(s.isVariable).toBe(true);
			expect(s.lrt).toBe(s.hyphaeon_lrt);
			expect(s.refCodon).toBe('ATG');
			expect(s.refAa).toBe('M');
			expect(Number.isFinite(s.zScore)).toBe(true);
		}
		// The invariable site was never scored: zero, p = 2/3 (float32), q = float32 too.
		const inv = result.sites[6];
		expect(inv.is_invariable).toBe(true);
		expect(inv.isVariable).toBe(false);
		expect(inv.hyphaeon_lrt).toBe(0);
		expect(inv.lrt).toBe(0);
		expect(inv.p_value).toBe(Math.fround(2 / 3));
		expect(inv.call).toBe(NEUTRAL_CALL);
		// p and q are the float32 casts cmd_meme writes.
		for (const s of result.sites) {
			expect(s.p_value).toBe(Math.fround(s.p_value));
			expect(s.q_value).toBe(Math.fround(s.q_value));
		}
		expect(result.arrays.lrt).toBeInstanceOf(Float32Array);
		expect(result.arrays.p_value).toBeInstanceOf(Float32Array);
		expect(result.attention).toBeUndefined();
		expect(result.root_repr).toBeUndefined();
		expect(result.attributions).toEqual({});
		expect(result.filter_enabled).toBe(false);
		expect(result.attribution_enabled).toBe(false);
		expect(result.loaded).toBeDefined();
		expect(Object.keys(result)).not.toContain('loaded');

		expect(result.summary).toMatchObject({
			totalSites: 7,
			variableSites: 6,
			invariableSites: 1,
			speciesUsed: 4,
			speciesInAlignment: 4,
			referenceSequence: 'a',
			callMode: 'percentile',
			matchTier: 'exact',
			batchSize: 4
		});
		expect(result.provenance).toMatchObject({
			schema_version: 1,
			surface: 'node-server',
			model_variant: 'fake',
			model_version: 'v0',
			artifact_sha256: 'cd'.repeat(32),
			artifact_verified: true,
			is_surrogate: true,
			surrogate_for: 'MEME',
			options: { batchSize: 4 },
			inputs: { alignment: null, tree: null }
		});
		expect(result.provenance.elapsed_sec).toBeGreaterThanOrEqual(0);
		expect(result.runtime_sec).toBeLessThanOrEqual(result.provenance.elapsed_sec);
		expect(result.provenance.preprocessing).toMatchObject({
			taxa_in_alignment: 4,
			taxa_used: 4,
			dropped_taxa: [],
			duplicates_collapsed: 0,
			pd_subsampled: false,
			reference_sequence: 'a',
			tree_source: 'user',
			branch_lengths_missing: false,
			branch_lengths_estimated: false,
			distance_rescaled: false,
			codons_trimmed: 0,
			unknown_codon_fraction: 0,
			in_frame_stops: 0,
			taxon_cap: 256
		});
		expect(Array.isArray(result.provenance.warnings)).toBe(true);
		for (const w of result.provenance.warnings) {
			expect(w).toHaveProperty('code');
			expect(['info', 'warn', 'refuse']).toContain(w.severity);
		}
	});

	it('returns the attention and root_repr heads only when asked, zero at invariable sites', async () => {
		const { handle, fetched } = fakeSession();
		const result = await runMeme({
			alignmentText: ALIGNMENT,
			treeText: TREE,
			options: { attention: true, rootRepr: true, batchSize: 3 },
			session: handle
		});
		expect(fetched[0]).toEqual(['lrt', 'mean_root_attns', 'root_repr']);
		expect(result.attention.dims).toEqual([7, 4]);
		expect(result.root_repr.dims).toEqual([7, 384]);
		// Site 7 (invariable) was never scored: its rows stay zero.
		expect(Array.from(result.attention.data.subarray(6 * 4, 7 * 4))).toEqual([0, 0, 0, 0]);
		expect(result.root_repr.data[6 * 384]).toBe(0);
		// Scored sites carry the fake's counters in site order.
		expect(Array.from(result.attention.data.subarray(0, 4))).toEqual([0, 1, 2, 3]);
		expect(result.root_repr.data[5 * 384]).toBe(6);
	});

	it('omits the heads when the graph does not declare them', async () => {
		const { handle } = fakeSession(['lrt']);
		const result = await runMeme({ alignmentText: ALIGNMENT, treeText: TREE, options: { attention: true }, session: handle });
		expect(result.attention).toBeUndefined();
		expect(result.sites).toHaveLength(7);
	});

	it('refuses to run without a tree, with too few taxa, or with unknown modes / surfaces', async () => {
		const { handle } = fakeSession();
		await expect(runMeme({ alignmentText: ALIGNMENT, treeText: '', session: handle })).rejects.toThrow(NO_TREE_MESSAGE);
		await expect(runMeme({ alignmentText: '>a\nATGATG\n>b\nATGTTT\n', treeText: '(a:0.1,b:0.1);', session: handle })).rejects.toThrow(new RegExp(`at least ${MIN_SPECIES}`));
		await expect(runMeme({ alignmentText: ALIGNMENT, treeText: TREE, session: handle, options: { callMode: 'z-score' } })).rejects.toThrow(/Unknown callMode/);
		await expect(runMeme({ alignmentText: ALIGNMENT, treeText: TREE, session: handle, surface: 'cloud' })).rejects.toThrow(/unknown surface/);
		await expect(runMeme({ alignmentText: ALIGNMENT, treeText: TREE })).rejects.toThrow(/loadSession/);
	});

	it('takes the reference\'s "HyPhy not found" branch for a tree without branch lengths, and records it', async () => {
		const { handle } = fakeSession();
		const result = await runMeme({ alignmentText: ALIGNMENT, treeText: '((a,b),(c,d));', session: handle });
		expect(result.provenance.preprocessing.branch_lengths_missing).toBe(true);
		expect(result.provenance.preprocessing.branch_lengths_estimated).toBe(false);
		expect(result.provenance.warnings.map((w) => w.code)).toContain('BRANCH_LENGTHS_MISSING');
		// A caller may insist instead.
		await expect(
			runMeme({ alignmentText: ALIGNMENT, treeText: '((a,b),(c,d));', session: handle, options: { requireBranchLengths: true } })
		).rejects.toThrow(NO_BRANCH_LENGTHS_MESSAGE);
	});

	it('calls the estimateTree hook for a tree without branch lengths and reloads with its answer', async () => {
		const { handle } = fakeSession();
		const calls = [];
		const result = await runMeme({
			alignmentText: ALIGNMENT,
			treeText: '((a,b),(c,d));',
			session: handle,
			options: {
				estimateTree: async (alignmentText, treeText) => {
					calls.push({ alignmentText, treeText });
					return { treeText: TREE, source: 'nj' };
				}
			}
		});
		expect(calls).toHaveLength(1);
		expect(calls[0].treeText).toBe('((a,b),(c,d));');
		expect(result.provenance.preprocessing.branch_lengths_estimated).toBe(true);
		expect(result.provenance.preprocessing.tree_source).toBe('nj');
		expect(result.provenance.preprocessing.branch_lengths_missing).toBe(false);
	});

	it('finds a tree embedded in the alignment when none is given', async () => {
		const { handle } = fakeSession();
		const result = await runMeme({ alignmentText: ALIGNMENT + TREE + '\n', treeText: null, session: handle });
		expect(result.taxa_count).toBe(4);
		expect(result.provenance.preprocessing.tree_source).toBe('embedded');
		expect(result.provenance.inputs.tree).toBe('embedded_in_alignment');
	});

	it('honours an abort signal', async () => {
		const { handle } = fakeSession();
		const controller = new AbortController();
		controller.abort();
		const err = await runMeme({ alignmentText: ALIGNMENT, treeText: TREE, session: handle, signal: controller.signal }).catch((e) => e);
		expect(err.name).toBe('AbortError');
	});

	it('drops taxa the tree does not carry and records them', async () => {
		const { handle } = fakeSession();
		const result = await runMeme({
			alignmentText: ALIGNMENT + '>e\n' + 'AAA'.repeat(7) + '\n',
			treeText: TREE,
			session: handle
		});
		expect(result.summary.speciesUsed).toBe(4);
		expect(result.provenance.preprocessing.dropped_taxa).toEqual(['e']);
		expect(result.provenance.preprocessing.taxa_not_in_tree).toBe(1);
		const w = result.provenance.warnings.find((x) => x.code === 'TAXA_NOT_IN_TREE');
		expect(w).toBeDefined();
	});

	it('runs the filter and attribution phases when asked and wires their outputs', async () => {
		// A fake whose LRT depends only on the tokens fed, so counterfactual re-scores differ.
		const { handle, runs } = fakeSession(['lrt'], (codons) => codons.reduce((s, t) => s + t, 0) / 10);
		const events = [];
		const result = await runMeme({
			alignmentText: ALIGNMENT,
			treeText: TREE,
			options: { filter: true, attribute: true, attributionMinLrt: 0.5, batchSize: 8 },
			session: handle,
			progress: (phase, done, total) => events.push({ phase, done, total })
		});
		const phases = [...new Set(events.map((e) => e.phase))];
		expect(phases).toEqual(['parse', 'prepare', 'infer', 'stats', 'filter', 'attribute', 'postprocess']);
		expect(result.filter_enabled).toBe(true);
		expect(result.filter).toBeDefined();
		expect(Array.isArray(result.artifacts_masked)).toBe(true);
		expect(result.attribution_enabled).toBe(true);
		// Every variable site clears 0.5 with these tokens, so all six are attributed.
		expect(Object.keys(result.attributions)).toEqual(['1', '2', '3', '4', '5', '6']);
		expect(result.attributionRecords.size).toBe(6);
		const s1 = result.sites[0];
		expect(s1.attribution_details.site_1indexed).toBe(1);
		expect(typeof s1.evolutionary_epoch).toBe('string');
		expect(typeof s1.adaptation_mode).toBe('string');
		expect(s1.top_driver).not.toBeNull();
		expect(s1.top_mutation).toMatch(/^[A-Z*-]->[A-Z*-]$/);
		// The invariable site is not attributed and carries no attribution fields.
		expect(result.sites[6].evolutionary_epoch).toBeUndefined();
		// One baseline run, then counterfactuals: three non-consensus taxa per site in one batch each.
		expect(runs[0]).toBe(6);
		expect(runs.slice(1).every((b) => b <= 8)).toBe(true);
	});
});

// -------------------------------------------------------------------------------------------
// The real graph, under onnxruntime-node, on the engine repository's bat_oas1 example.
// -------------------------------------------------------------------------------------------

async function resolveModel() {
	const enginePath = join(ENGINE, 'models', 'general.onnx');
	const manifestPath = join(ENGINE, 'models', 'manifest.json');
	if (!existsSync(enginePath) || !existsSync(manifestPath)) return null;
	const manifest = await loadManifest(manifestPath);
	const variant = pickVariant(manifest, 'general');
	return { modelPath: enginePath, expectedSha256: variant.onnxSha256, modelVersion: manifest.model_version };
}

const model = await resolveModel();
const alignmentPath = join(ENGINE, 'examples', 'bat_oas1.fasta');
const treePath = join(ENGINE, 'examples', 'bat_oas1.nwk');
const haveExample = existsSync(alignmentPath) && existsSync(treePath);
if (!model || !haveExample) {
	console.warn(`\n[pipeline] REAL-GRAPH RUN SKIPPED — needs ${join(ENGINE, 'models', 'general.onnx')} + manifest and ${alignmentPath}.\n`);
}

describe.skipIf(!model || !haveExample)('runMeme over the general graph on bat_oas1', () => {
	it('scores 351 sites for 18 taxa with a finite LRT at every variable site', async () => {
		resetSession();
		const handle = await loadSession({ modelPath: model.modelPath, expectedSha256: model.expectedSha256 });
		expect(handle.verified).toBe(true);
		expect(handle.outputNames).toEqual(['lrt', 'mean_root_attns', 'root_repr']);

		const alignmentText = readFileSync(alignmentPath, 'utf8');
		const treeText = readFileSync(treePath, 'utf8');
		const phases = [];
		const result = await runMeme({
			alignmentText,
			treeText,
			options: { attention: true, alignmentName: 'bat_oas1.fasta', treeName: 'bat_oas1.nwk' },
			session: handle,
			surface: 'node-server',
			progress: (phase) => phases.push(phase),
			provenance: { model_variant: 'general', model_version: model.modelVersion, reference_version: '1.0.0' }
		});

		expect(result.sites).toHaveLength(351);
		expect(result.taxa_count).toBe(18);
		expect(result.codon_count).toBe(351);
		expect(result.summary.speciesUsed).toBe(18);
		expect([...new Set(phases)]).toEqual(['parse', 'prepare', 'infer', 'stats', 'postprocess']);

		const variable = result.sites.filter((s) => !s.is_invariable);
		const invariable = result.sites.filter((s) => s.is_invariable);
		expect(variable.length).toBe(182);
		expect(invariable.length).toBe(169);
		for (const s of variable) {
			expect(Number.isFinite(s.hyphaeon_lrt)).toBe(true);
			expect(s.hyphaeon_lrt).toBeGreaterThanOrEqual(0);
			expect(s.lrt).toBe(s.hyphaeon_lrt);
			expect(s.isVariable).toBe(true);
			expect(s.percentile).toBeGreaterThan(0);
		}
		for (const s of invariable) {
			expect(s.hyphaeon_lrt).toBe(0);
			expect(s.p_value).toBe(Math.fround(2 / 3));
			expect(s.call).toBe(NEUTRAL_CALL);
		}
		expect(Math.max(...variable.map((s) => s.hyphaeon_lrt))).toBeGreaterThan(1);
		expect(result.summary.calledSites).toBeGreaterThan(0);
		expect(result.attention.dims).toEqual([351, 18]);

		expect(result.provenance).toMatchObject({
			surface: 'node-server',
			model_variant: 'general',
			artifact_sha256: model.expectedSha256,
			artifact_verified: true,
			is_surrogate: true,
			inputs: { alignment: 'bat_oas1.fasta', tree: 'bat_oas1.nwk' }
		});
		// bat_oas1's tree is in Mya: the > 10 rescale fires (dataset.py:678-681) and is recorded.
		expect(result.provenance.preprocessing.distance_rescaled).toBe(true);
		expect(result.provenance.preprocessing.raw_dist_max).toBeGreaterThan(10);
		expect(result.provenance.warnings.map((w) => w.code)).toContain('DISTANCE_RESCALED');
	});
});
