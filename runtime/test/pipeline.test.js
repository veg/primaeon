/**
 * pipeline.test.js — runMeme end to end.
 *
 * Two halves. The first drives the orchestration with a FAKE session so the phase order, the
 * batching, the accumulation of the optional heads, the gates and the provenance block can be
 * asserted exactly and quickly. The second loads the REAL viral graph through session-node.js
 * and scores examples/bat_oas1 (18 taxa x 351 codons) from the engine repository, which is the
 * Phase 0 exit criterion in miniature: the app repository, through the library from the methods
 * repository, over onnxruntime-node.
 *
 * WHICH GRAPH. `../HyphAeon/models/viral.onnx` with the hash from `../HyphAeon/models/manifest.json`
 * when the export has landed; otherwise DM3's pinned artifact
 * (static/models/axomeme/axomeme_v1_viral_finetuned.onnx, sha256 de765904…ccda3), which is
 * byte-identical to HuggingFace's model.viral.onnx and therefore the same graph. The suite skips
 * the real half, loudly, if neither is on this machine.
 *
 * The comparison against the Python reference's examples/bat_oas1_results.csv is PRINTED, not
 * asserted: the library's tokenizer and serine rule are recorded divergences from dataset.py
 * (see the library's headers), and the fixture harness — not this test — decides them.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { runMeme, PHASES, NO_TREE_MESSAGE, NO_BRANCH_LENGTHS_MESSAGE, MIN_SPECIES, SCHEMA_VERSION } from '../src/pipeline.js';
import { loadSession, resetSession } from '../src/session-node.js';
import { loadManifest, pickVariant } from '../src/manifest.js';
import { NEUTRAL_CALL } from '../src/postprocess.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SIBLINGS = join(HERE, '..', '..', '..');
const ENGINE = join(SIBLINGS, 'HyphAeon');
const DM3_MODEL = join(SIBLINGS, 'datamonkey3', 'static', 'models', 'axomeme', 'axomeme_v1_viral_finetuned.onnx');
const DM3_MODEL_SHA256 = 'de765904107ba436c6ad6abbecb8af54962abd8444e1b5044947bb945d8ccda3';

// -------------------------------------------------------------------------------------------
// A fake session: lrt = global site index + 0.5, attention = site * N + species.
// -------------------------------------------------------------------------------------------

function fakeSession(outputNames = ['lrt', 'mean_root_attns']) {
	let nextSite = 0;
	const runs = [];
	const ort = {
		Tensor: class {
			constructor(type, data, dims) {
				this.type = type;
				this.data = data;
				this.dims = dims;
			}
		}
	};
	const session = {
		inputNames: ['msa_codons', 'msa_aas', 'dist_matrix', 'mds_coords'],
		outputNames,
		run: async (feeds) => {
			const b = feeds.msa_codons.dims[0];
			const n = feeds.msa_codons.dims[1];
			runs.push(b);
			const lrt = new Float32Array(b);
			const attn = new Float32Array(b * n);
			for (let k = 0; k < b; k++) {
				lrt[k] = nextSite + k + 0.5;
				for (let j = 0; j < n; j++) attn[k * n + j] = (nextSite + k) * n + j;
			}
			nextSite += b;
			const out = { lrt: { data: lrt } };
			if (outputNames.includes('mean_root_attns')) out.mean_root_attns = { data: attn };
			return out;
		}
	};
	return { handle: { session, ort, sha256: 'cd'.repeat(32), verified: true, outputNames }, runs };
}

// Four taxa, six variable codons and one invariable codon (site 7, all ATG).
const CODONS = { a: 'ATG', b: 'TTT', c: 'GGG', d: 'CCC' };
const ALIGNMENT =
	Object.entries(CODONS)
		.map(([name, codon]) => `>${name}\n${codon.repeat(6)}ATG`)
		.join('\n') + '\n';
const TREE = '((a:0.1,b:0.2):0.05,(c:0.3,d:0.4):0.05);';

describe('runMeme over a fake session', () => {
	it('runs the phases in order, batches, zeroes the invariable site, and accumulates attention', async () => {
		const { handle, runs } = fakeSession();
		const events = [];
		const result = await runMeme({
			alignmentText: ALIGNMENT,
			treeText: TREE,
			// 4 taxa -> 64 bytes per site of dist_matrix; a 128-byte budget forces batches of 2.
			options: { batchBudgetBytes: 128 },
			session: handle,
			surface: 'node-server',
			progress: (phase, done, total, message) => events.push({ phase, done, total, message })
		});

		// Phase order, and each phase finishes.
		const phases = [...new Set(events.map((e) => e.phase))];
		expect(phases).toEqual([...PHASES]);
		const infer = events.filter((e) => e.phase === 'infer');
		expect(infer[0]).toMatchObject({ done: 0, total: 7 });
		expect(infer.at(-1)).toMatchObject({ done: 7, total: 7 });
		expect(runs).toEqual([2, 2, 2, 1]);

		expect(result.schema_version).toBe(SCHEMA_VERSION);
		expect(result.method).toBe('meme');
		expect(result.is_surrogate).toBe(true);
		expect(result.surrogate_for).toBe('MEME');
		expect(result.sites).toHaveLength(7);
		for (let i = 0; i < 6; i++) {
			expect(result.sites[i].site).toBe(i + 1);
			expect(result.sites[i].isVariable).toBe(true);
			expect(result.sites[i].lrt).toBeCloseTo(i + 0.5, 6);
			expect(result.sites[i].refCodon).toBe('ATG');
			expect(result.sites[i].refAa).toBe('M');
		}
		// The invariable site is zeroed AFTER the graph scored it (the fake said 6.5).
		expect(result.sites[6].isVariable).toBe(false);
		expect(result.sites[6].lrt).toBe(0);
		expect(result.sites[6].call).toBe(NEUTRAL_CALL);

		// Attention arrives per batch and is stitched into [L, N] in site order.
		expect(result.attention.dims).toEqual([7, 4]);
		expect(Array.from(result.attention.data.subarray(0, 8))).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
		expect(result.attention.data[6 * 4 + 3]).toBe(27);
		expect(result.root_repr).toBeUndefined();

		expect(result.summary).toMatchObject({
			totalSites: 7,
			variableSites: 6,
			speciesUsed: 4,
			speciesInAlignment: 4,
			referenceSequence: 'a',
			callMode: 'percentile',
			matchedFromTree: true,
			clampedDistances: 0
		});
		expect(result.provenance).toMatchObject({
			schema_version: 1,
			surface: 'node-server',
			artifact_sha256: 'cd'.repeat(32),
			artifact_verified: true,
			is_surrogate: true,
			surrogate_for: 'MEME',
			seed: null,
			options: { batchBudgetBytes: 128 }
		});
		expect(result.provenance.elapsed_sec).toBeGreaterThanOrEqual(0);
		expect(result.provenance.preprocessing).toMatchObject({
			taxa_in_alignment: 4,
			taxa_used: 4,
			dropped_taxa: [],
			pd_subsampled: false,
			reference_sequence: 'a',
			tree_source: 'user',
			unknown_codon_fraction: 0,
			in_frame_stops: 0,
			codons_trimmed: 0
		});
		expect(result.provenance.warnings).toEqual([]);
	});

	it('omits the attention head when the graph does not return it', async () => {
		const { handle } = fakeSession(['lrt']);
		const result = await runMeme({ alignmentText: ALIGNMENT, treeText: TREE, session: handle });
		expect(result.attention).toBeUndefined();
		expect(result.sites).toHaveLength(7);
	});

	it('refuses to run without a tree, without branch lengths, or with too few taxa', async () => {
		const { handle } = fakeSession();
		await expect(runMeme({ alignmentText: ALIGNMENT, treeText: '', session: handle })).rejects.toThrow(NO_TREE_MESSAGE);
		await expect(runMeme({ alignmentText: ALIGNMENT, treeText: '((a,b),(c,d));', session: handle })).rejects.toThrow(NO_BRANCH_LENGTHS_MESSAGE);
		await expect(runMeme({ alignmentText: '>a\nATGATG\n>b\nATGTTT\n', treeText: '(a:0.1,b:0.1);', session: handle })).rejects.toThrow(new RegExp(`at least ${MIN_SPECIES}`));
		await expect(runMeme({ alignmentText: ALIGNMENT, treeText: TREE, session: handle, options: { callMode: 'z-score' } })).rejects.toThrow(/Unknown callMode/);
		await expect(runMeme({ alignmentText: ALIGNMENT, treeText: TREE, session: handle, surface: 'cloud' })).rejects.toThrow(/unknown surface/);
		await expect(runMeme({ alignmentText: ALIGNMENT, treeText: TREE })).rejects.toThrow(/loadSession/);
	});

	it('honours an abort signal between phases', async () => {
		const { handle } = fakeSession();
		const controller = new AbortController();
		controller.abort();
		const err = await runMeme({ alignmentText: ALIGNMENT, treeText: TREE, session: handle, signal: controller.signal }).catch((e) => e);
		expect(err.name).toBe('AbortError');
	});

	it('warns about taxa the tree does not carry rather than dropping them silently', async () => {
		const { handle } = fakeSession();
		const result = await runMeme({
			alignmentText: ALIGNMENT + '>e\n' + 'AAA'.repeat(7) + '\n',
			treeText: TREE,
			session: handle
		});
		expect(result.summary.speciesUsed).toBe(4);
		expect(result.provenance.preprocessing.dropped_taxa).toEqual(['e']);
		const w = result.provenance.warnings.find((x) => x.code === 'TAXA_NOT_IN_TREE');
		expect(w).toBeDefined();
		expect(w.severity).toBe('warn');
		expect(w.taxa).toEqual(['e']);
	});

	it('records negative and clamped distances with their magnitude', async () => {
		const { handle } = fakeSession();
		const result = await runMeme({
			alignmentText: ALIGNMENT,
			treeText: '((a:0.1,b:-0.5):0.05,(c:0.3,d:0.4):0.05);',
			session: handle
		});
		const codes = result.provenance.warnings.map((w) => w.code);
		expect(codes).toContain('TREE_NEGATIVE_LENGTHS');
		expect(codes).toContain('DISTANCES_CLAMPED');
		expect(result.summary.clampedDistances).toBeGreaterThan(0);
		expect(result.summary.mostNegativeDistance).toBeLessThan(0);
	});
});

// -------------------------------------------------------------------------------------------
// The real graph, under onnxruntime-node, on the engine repository's bat_oas1 example.
// -------------------------------------------------------------------------------------------

async function resolveModel() {
	const enginePath = join(ENGINE, 'models', 'viral.onnx');
	const manifestPath = join(ENGINE, 'models', 'manifest.json');
	if (existsSync(enginePath)) {
		if (existsSync(manifestPath)) {
			const manifest = await loadManifest(manifestPath);
			const variant = pickVariant(manifest, 'viral');
			return { modelPath: enginePath, expectedSha256: variant.onnxSha256, source: 'engine models/viral.onnx + manifest', modelVersion: manifest.model_version };
		}
		// The graph landed before its manifest: hash it here so the session still verifies SOMETHING,
		// and say so, because this is not the arrangement the plan describes.
		const sha = createHash('sha256').update(readFileSync(enginePath)).digest('hex');
		return { modelPath: enginePath, expectedSha256: sha, source: 'engine models/viral.onnx (NO manifest — self-hashed)', modelVersion: null };
	}
	if (existsSync(DM3_MODEL)) {
		return { modelPath: DM3_MODEL, expectedSha256: DM3_MODEL_SHA256, source: 'DM3 pinned artifact', modelVersion: 'v1' };
	}
	return null;
}

const model = await resolveModel();
const alignmentPath = join(ENGINE, 'examples', 'bat_oas1.fasta');
const treePath = join(ENGINE, 'examples', 'bat_oas1.nwk');
const haveExample = existsSync(alignmentPath) && existsSync(treePath);
if (!model || !haveExample) {
	console.warn(
		`\n[pipeline] REAL-GRAPH RUN SKIPPED — needs a viral graph (${join(ENGINE, 'models', 'viral.onnx')} ` +
			`or ${DM3_MODEL}) and ${alignmentPath}. Nothing about the pipeline was checked against the real model.\n`
	);
} else {
	console.log(`[pipeline] real-graph run against ${model.source}`);
}

describe.skipIf(!model || !haveExample)('runMeme over the viral graph on bat_oas1', () => {
	it('scores 351 sites for 18 taxa with a finite LRT at every variable site', async () => {
		resetSession();
		const handle = await loadSession({ modelPath: model.modelPath, expectedSha256: model.expectedSha256 });
		expect(handle.verified).toBe(true);
		expect(handle.sha256).toBe(model.expectedSha256);

		const alignmentText = readFileSync(alignmentPath, 'utf8');
		const treeText = readFileSync(treePath, 'utf8');
		const phases = [];
		const result = await runMeme({
			alignmentText,
			treeText,
			session: handle,
			surface: 'node-server',
			progress: (phase) => phases.push(phase),
			provenance: { model_variant: 'viral', model_version: model.modelVersion, reference_version: '1.0.0' }
		});

		expect(result.sites).toHaveLength(351);
		expect(result.summary.totalSites).toBe(351);
		expect(result.summary.speciesUsed).toBe(18);
		expect(result.summary.speciesInAlignment).toBe(18);
		expect(result.summary.matchedFromTree).toBe(true);
		expect([...new Set(phases)]).toEqual([...PHASES]);

		const variable = result.sites.filter((s) => s.isVariable);
		const invariable = result.sites.filter((s) => !s.isVariable);
		expect(variable.length).toBeGreaterThan(100);
		expect(invariable.length).toBeGreaterThan(0);
		for (const s of variable) {
			expect(Number.isFinite(s.lrt)).toBe(true);
			expect(s.lrt).toBeGreaterThanOrEqual(0);
			expect(Number.isFinite(s.zScore)).toBe(true);
			expect(s.percentile).toBeGreaterThan(0);
		}
		for (const s of invariable) {
			expect(s.lrt).toBe(0);
			expect(s.call).toBe(NEUTRAL_CALL);
		}
		// Not all zero: the graph produced numbers.
		expect(Math.max(...variable.map((s) => s.lrt))).toBeGreaterThan(0);
		// The default mode calls the top of the range.
		expect(result.summary.calledSites).toBeGreaterThan(0);

		expect(result.provenance).toMatchObject({
			surface: 'node-server',
			model_variant: 'viral',
			artifact_sha256: model.expectedSha256,
			artifact_verified: true,
			is_surrogate: true
		});
		expect(result.provenance.preprocessing.taxa_used).toBe(18);
		expect(result.provenance.preprocessing.dropped_taxa).toEqual([]);

		// The optional heads: present iff the graph declares them.
		if (handle.outputNames.includes('mean_root_attns')) {
			expect(result.attention.dims).toEqual([351, 18]);
		} else {
			expect(result.attention).toBeUndefined();
		}

		// Reference comparison, printed for the fixture harness to act on (see the header).
		const csvPath = join(ENGINE, 'examples', 'bat_oas1_results.csv');
		if (existsSync(csvPath)) {
			const rows = readFileSync(csvPath, 'utf8').trim().split(/\r?\n/).slice(1).map((l) => l.split(','));
			const py = rows.map((r) => ({ site: Number(r[0]), lrt: Number(r[1]), invariable: r[4] === 'True' }));
			if (py.length === 351) {
				let maxAbs = 0;
				let invariableAgree = 0;
				for (let i = 0; i < 351; i++) {
					maxAbs = Math.max(maxAbs, Math.abs(py[i].lrt - result.sites[i].lrt));
					if (py[i].invariable === !result.sites[i].isVariable) invariableAgree++;
				}
				// Average ranks for ties: every invariable site is tied at 0 on both sides.
				const rank = (xs) => {
					const order = xs.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
					const r = new Array(xs.length);
					for (let i = 0; i < order.length; ) {
						let j = i;
						while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
						const avg = (i + j) / 2;
						for (let k = i; k <= j; k++) r[order[k][1]] = avg;
						i = j + 1;
					}
					return r;
				};
				const a = rank(py.map((p) => p.lrt));
				const b = rank(result.sites.map((s) => s.lrt));
				const n = a.length;
				const mean = (xs) => xs.reduce((p, q) => p + q, 0) / xs.length;
				const ma = mean(a);
				const mb = mean(b);
				let num = 0;
				let da = 0;
				let db = 0;
				for (let i = 0; i < n; i++) {
					num += (a[i] - ma) * (b[i] - mb);
					da += (a[i] - ma) ** 2;
					db += (b[i] - mb) ** 2;
				}
				const rho = num / Math.sqrt(da * db);
				console.log(
					`[pipeline] bat_oas1 vs examples/bat_oas1_results.csv: max |dLRT| = ${maxAbs.toFixed(4)}, ` +
						`Spearman rho = ${rho.toFixed(3)}, invariable flags agree on ${invariableAgree}/351 sites`
				);
			}
		}
	});
});
