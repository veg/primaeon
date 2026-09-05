/**
 * epistasis.js — the co-selection network, the epistatic sectors and the sector-site DMS
 * (`hyphaeon epistasis`) over a forward pass someone else already ran.
 *
 * WHY THIS FILE EXISTS. `run_epistatic_analysis` (hyphaeon/epistasis.py:630-720 at veg/HyphAeon
 * phase-2a) is four library calls in a row — `compute_transformer_attributions`,
 * `compute_branch_coselection_network`, `extract_epistatic_sectors_tse`, and
 * `run_insilico_selection_dms` on the sector sites — around one model. `@veg/hyphaeon-js` ports
 * all four as pure functions (js/src/epistasis.js, sectors.js, dms.js, PHASE2A.md); this module
 * is the runtime's glue: it feeds them the graph's outputs, applies the CLI's defaults rather
 * than the functions' (they differ: `cmd_epistasis` passes `min_sim=0.30`, the function default
 * is 0.35 — fixtures/manifest.json `known_quirks`), reports progress, and returns the CLI's
 * result dictionary key for key (PLAN.md Appendix B).
 *
 * ONE FORWARD PASS FOR THE WHOLE REPORT (PLAN.md §4.0 row 4: "attention comes out of the same
 * forward pass; the rest is graph math"). `runMeme` with `options.attention` requests the
 * graph's second output, `mean_root_attns` [L, N], beside `lrt`, so the site-selection pass
 * already holds everything `compute_transformer_attributions` needs; `runEpistasis` takes that
 * pass (`attention`, `lrt`) and never re-runs the graph for it. The one difference from the
 * reference, and why it does not matter: `compute_transformer_attributions` scores EVERY site
 * (epistasis.py:85-103), while the meme pass scores the variable ones (inference.py:162-192) and
 * leaves zero rows elsewhere. At an invariable site every valid amino-acid token is the same
 * (dataset.py:718-723), so the non-consensus indicator `delta` (epistasis.py:76-83, the same
 * token rule) is zero across the row, and `leaf_attributions = attention * delta` is zero there
 * whatever the attention was. Such a site has norm 0, is not "active" in the network
 * (epistasis.py:145-150), is not in the permutation pool, cannot be an edge endpoint or a
 * sector member, and is not swept by the sector-site DMS. Two quantities do differ, neither of
 * them in the output: the graph's per-node `lrt` attribute at invariable sites (0 here, the
 * model's `y_soft` there — measured up to 4.8 on bat_oas1), which the CLI never writes, since
 * `edges[]`, `sectors[]` and `plasticity[]` carry only active sites and the GraphML registers
 * edge endpoints only (cli.py:821-833); and the graph's own batch-composition noise, because a
 * variable-sites batch and an all-sites batch are different ORT calls — measured on bat_oas1 as
 * max |Δ| 7.2e-7 over every edge field, with edge set and order, sector membership and
 * `spectral_coherence` IDENTICAL. test/epistasis.test.js pins both facts against the real
 * graph. When no pass is given and a session is, `runEpistasis` runs the reference's own loop
 * (`runTransformerAttributions`, all sites) — the path the MCP's `hyphaeon_epistasis` takes.
 *
 * WHAT IS THE REFERENCE'S AND WHAT IS THE APP'S:
 *   - Every key of the result (`edges`, `sectors`, `plasticity`, the counts and their aliases)
 *     is the library's arithmetic on the graph's tensors, at PARITY.md's classes: edge set and
 *     order exact, `similarity`/`cesi`/`lrt_*` at the graph class, sector membership exact,
 *     `spectral_coherence` at 1e-5, `p_perm` and the null moments statistical.
 *   - `p_perm` IS A MONTE CARLO ESTIMATE, and at the CLI's own B = 1,000 it carries roughly
 *     ±0.03 absolute (PHASE2A.md, "Epistasis end to end": measured 0.093 vs 0.080 on the same
 *     sector, both sides within their bound). The browser default is 1,000 for latency
 *     (`BROWSER_PERMUTATIONS_DEFAULT`); the parity class was written for B = 10,000
 *     (`EPISTASIS_CLI_DEFAULTS.nPermutations`, the CLI's default). The result records B, the
 *     seed and this caveat under `permutations` so a UI never prints `p_perm` to three decimals
 *     as if it were exact.
 *   - The per-sector DMS (`plasticity`) is part of `hyphaeon epistasis` (run unless `--no-dms`),
 *     but in the browser report it is OFF by default (`options.dms` false): the report runs the
 *     whole-alignment DMS last as its own section (dms.js), and the sector sites are in it. The
 *     parity runner turns it on to reproduce the CLI's file.
 *   - The graph JSON (`graph`) is the app's addition for the force network (PLAN.md §4.5), the
 *     `CoselectionGraph.toJson()` shape; omit it with `options.graph: false`.
 *
 * SURROGATE. The LRTs are predictions of what MEME would report and the attention is a model
 * internal; nothing here is a fitted co-evolution model. The record says so through the report's
 * provenance (analyze.js), not by softening the reference's field names.
 */

import {
	computeTransformerAttributions,
	runTransformerAttributions,
	computeBranchCoselectionNetwork,
	extractEpistaticSectorsTse,
	runInsilicoSelectionDms
} from '@veg/hyphaeon-js';

import { runSites } from './feeds.js';
import { bundleFromTokens, predictFromSession, resolveBatchSize, throwIfAborted, yieldToLoop } from './predict.js';
import { report } from './pipeline.js';

/**
 * `cmd_epistasis` (cli.py:740-758, argparse 1098-1110): the values the CLI passes, which are
 * NOT all the functions' defaults. `minSim` 0.30 (function: 0.35); `minCesi` is never passed by
 * the CLI, so the function's 2.0 applies; `maxOverlap` is accepted and unused upstream;
 * `nPermutations` 10,000; `seed` 42 (`SEED_DEFAULT`). `maxPermP` null keeps every sector with
 * C(S) >= minCoherence.
 */
export const EPISTASIS_CLI_DEFAULTS = Object.freeze({
	minSim: 0.3,
	minShared: 2,
	maxFdr: 0.05,
	minLrt: 1.0,
	minCesi: 2.0,
	minCliqueSize: 3,
	maxOverlap: 0.5,
	minCoherence: 0.5,
	nPermutations: 10000,
	maxPermP: null,
	seed: 42,
	/** epistasis.py:705 — sector-less alignments fall back to edges with CESI >= 3.0 for the DMS. */
	dmsFallbackMinCesi: 3.0
});

/** App-side: the browser's B, chosen for latency (PLAN.md §4.0 row 4, PHASE2A.md). */
export const BROWSER_PERMUTATIONS_DEFAULT = 1000;

/** PHASE2A.md's consequence for consumers, recorded with every result. */
export const P_PERM_MONTE_CARLO_NOTE =
	'p_perm and the null moments are Monte Carlo estimates from B random K-site subsets; at B = 1,000 ' +
	'each side carries about +/-0.03 absolute (and about +/-5% on the null std), so two runs agree only ' +
	'within 3*sqrt(p(1-p)/B). Re-run with 10,000 permutations for the precision the parity class assumes.';

/**
 * The attention predict callback the library's `runTransformerAttributions` wants
 * (`{lrt, attention}` per batch) over a loaded session: `lrt` and `mean_root_attns` requested,
 * nothing else computed.
 *
 * @param {{session: any, ort: any, outputNames?: string[]}} handle from loadSession()
 * @param {{signal?: AbortSignal}} [options]
 */
export function attentionPredictFromSession(handle, options = {}) {
	if (!handle || !handle.session || !handle.ort) {
		throw new Error('attentionPredictFromSession: pass the handle returned by loadSession() as `session`');
	}
	if (Array.isArray(handle.outputNames) && !handle.outputNames.includes('mean_root_attns')) {
		throw new Error('attentionPredictFromSession: the loaded graph declares no `mean_root_attns` output');
	}
	return async (c, a, meta) => {
		throwIfAborted(options.signal);
		const out = await runSites(handle.session, bundleFromTokens(c, a, meta), handle.ort, ['lrt', 'mean_root_attns']);
		if (!out.mean_root_attns) throw new Error('graph run returned no `mean_root_attns` output');
		return { lrt: out.lrt, attention: out.mean_root_attns };
	};
}

/** Accept `{data, dims}` (inferSites) or a flat Float32Array for the attention matrix. */
function attentionData(attention, L, N) {
	const data = attention && typeof attention === 'object' && 'data' in attention ? attention.data : attention;
	if (!data || data.length !== L * N) {
		throw new Error(`runEpistasis: attention has ${data ? data.length : 0} values, expected L*N = ${L}*${N}`);
	}
	return data instanceof Float32Array ? data : Float32Array.from(data);
}

/**
 * `compute_transformer_attributions` from a pass already run: the model's `mean_root_attns`
 * [L, N] and its (clamped) site LRTs [L], with the loaded alignment's amino-acid tokens.
 *
 * @param {{loaded: object, attention: Float32Array|{data: Float32Array, dims: number[]}, lrt: ArrayLike<number>}} args
 */
export function attributionsFromPass({ loaded, attention, lrt }) {
	const { L, N } = loaded;
	if (lrt.length !== L) throw new Error(`runEpistasis: lrt has ${lrt.length} values, expected L = ${L}`);
	return computeTransformerAttributions({
		attention: attentionData(attention, L, N),
		lrts: lrt,
		aaTokens: loaded.a,
		L,
		N
	});
}

/**
 * epistasis.py:702-712 — the sites the sector-site DMS sweeps (0-indexed, ascending): every
 * sector member; when there are no sectors, both endpoints of every edge with CESI >= 3.0.
 *
 * @param {Array<{sites: number[]}>} sectors
 * @param {Array<{site_u: number, site_v: number, cesi?: number}>} edges
 * @param {number} [fallbackMinCesi]
 * @returns {number[]}
 */
export function dmsSitesForSectors(sectors, edges, fallbackMinCesi = EPISTASIS_CLI_DEFAULTS.dmsFallbackMinCesi) {
	const set = new Set();
	for (const sec of sectors) for (const s of sec.sites) set.add(s - 1);
	if (set.size === 0 && edges.length > 0) {
		for (const e of edges) {
			if ((e.cesi ?? 0) >= fallbackMinCesi) {
				set.add(e.site_u - 1);
				set.add(e.site_v - 1);
			}
		}
	}
	return [...set].sort((x, y) => x - y);
}

/**
 * Resolve the network / sector options: the CLI's defaults under the caller's overrides.
 * `permutations` is the app's name for `nPermutations` (analyze.js options), either wins.
 */
export function resolveEpistasisOptions(options = {}, { browser = false } = {}) {
	const d = EPISTASIS_CLI_DEFAULTS;
	const nPermutations = options.nPermutations ?? options.permutations ?? (browser ? BROWSER_PERMUTATIONS_DEFAULT : d.nPermutations);
	if (!Number.isInteger(nPermutations) || nPermutations < 0) {
		throw new Error(`runEpistasis: nPermutations must be a non-negative integer, got ${String(nPermutations)}`);
	}
	const seed = options.seed ?? d.seed;
	if (!Number.isSafeInteger(seed)) throw new Error(`runEpistasis: seed must be an integer, got ${String(seed)}`);
	return {
		minSim: options.minSim ?? d.minSim,
		minShared: options.minShared ?? d.minShared,
		maxFdr: options.maxFdr ?? d.maxFdr,
		minLrt: options.minLrt ?? d.minLrt,
		minCesi: options.minCesi ?? d.minCesi,
		minCliqueSize: options.minCliqueSize ?? d.minCliqueSize,
		maxOverlap: options.maxOverlap ?? d.maxOverlap,
		minCoherence: options.minCoherence ?? d.minCoherence,
		nPermutations,
		maxPermP: options.maxPermP ?? d.maxPermP,
		seed,
		focalTaxon: options.focalTaxon ?? null,
		dms: Boolean(options.dms),
		graph: options.graph !== false
	};
}

/**
 * `run_epistatic_analysis` (epistasis.py:630-720) steps 4-5 over a loaded alignment and either a
 * forward pass already run or a session to run one.
 *
 * @param {object} args
 * @param {object} args.loaded the library's LoadedAlignment (runMeme's `result.loaded`)
 * @param {Float32Array|{data: Float32Array, dims: number[]}} [args.attention] `mean_root_attns`
 *   [L, N] from the meme pass (runMeme `options.attention`, `result.inference.mean_root_attns`)
 * @param {ArrayLike<number>} [args.lrt] the pass's clamped float32 site LRTs [L] (`result.inference.lrt`)
 * @param {{session: any, ort: any}} [args.session] the backbone handle; required when no pass is
 *   given (then the reference's all-sites loop runs) or when `options.dms` is on
 * @param {Function} [args.predict] a `predict(c, a, meta)` callback for the sector-site DMS;
 *   default `predictFromSession(session)`
 * @param {object} [args.options] `minSim`, `minShared`, `maxFdr`, `minLrt`, `minCesi`,
 *   `minCliqueSize`, `maxOverlap`, `minCoherence`, `nPermutations` (or `permutations`), `maxPermP`,
 *   `seed`, `focalTaxon`, `dms` (sector-site DMS, default false), `graph` (default true),
 *   `batchSize`, `browser` (B defaults to 1,000 instead of 10,000)
 * @param {{alignment?: string|null, tree?: string|null}} [args.inputs] labels for the document
 * @param {Function} [args.progress] `(phase, done, total, message)`; phase 'epistasis'
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<object>} the CLI's result dictionary (`alignment`, `tree`, `taxa_count`,
 *   `codon_count`, `evaluated_taxa`, `coselection_edges_count`, `discovered_sectors_count`,
 *   `edges`, `sectors`, `plasticity`, `coselection_edges`, `epistatic_sectors`,
 *   `selection_dms_plasticity`) plus the app's `graph`, `permutations`, `dms_sites`,
 *   `attention_source`, `options`, `elapsed_sec`
 */
export async function runEpistasis({ loaded, attention = null, lrt = null, session = null, predict = null, options = {}, inputs = {}, progress, signal } = {}) {
	const t0 = Date.now();
	if (!loaded || !loaded.a || !Number.isInteger(loaded.L)) {
		throw new Error('runEpistasis: pass the library LoadedAlignment as `loaded`');
	}
	const opts = resolveEpistasisOptions(options, { browser: Boolean(options.browser) });
	const { L, N } = loaded;
	const total = 4 + (opts.dms ? 1 : 0);

	// 4a. compute_transformer_attributions
	let attr;
	let attentionSource;
	if (attention && lrt) {
		report(progress, 'epistasis', 0, total, 'Attributing attention to non-consensus taxa...');
		attr = attributionsFromPass({ loaded, attention, lrt });
		attentionSource = 'shared-pass';
	} else {
		if (!session) throw new Error('runEpistasis: pass the meme pass (`attention` + `lrt`) or a `session` to run one');
		report(progress, 'epistasis', 0, total, `Computing transformer attributions across ${L} codons...`);
		const batchSize = resolveBatchSize(N, options);
		attr = await runTransformerAttributions(loaded, attentionPredictFromSession(session, { signal }), {
			batchSize,
			onProgress: (p) => report(progress, 'epistasis', 0, total, `Attributions: site ${p.done} of ${p.total}...`)
		});
		attentionSource = 'all-sites';
	}
	throwIfAborted(signal);
	report(progress, 'epistasis', 1, total, 'Co-selection network...');
	await yieldToLoop();

	// 4b. compute_branch_coselection_network with the CLI's thresholds
	const { sigPairs: edges, graph } = computeBranchCoselectionNetwork(attr.leafAttributions, attr.lrts, loaded.taxa, attr.consensusAas, {
		minSim: opts.minSim,
		minShared: opts.minShared,
		maxFdr: opts.maxFdr,
		minLrt: opts.minLrt,
		minCesi: opts.minCesi,
		N
	});
	throwIfAborted(signal);
	report(progress, 'epistasis', 2, total, `${edges.length} co-selection edge(s); mining sectors (B = ${opts.nPermutations})...`);
	await yieldToLoop();

	// 4c. extract_epistatic_sectors_tse
	const sectors = extractEpistaticSectorsTse(graph, attr.leafAttributions, attr.lrts, attr.consensusAas, {
		minCliqueSize: opts.minCliqueSize,
		maxOverlap: opts.maxOverlap,
		minCoherence: opts.minCoherence,
		focalTaxon: opts.focalTaxon,
		aNp: loaded.a,
		taxa: loaded.taxa,
		nPermutations: opts.nPermutations,
		maxPermP: opts.maxPermP,
		seed: opts.seed,
		N
	});
	throwIfAborted(signal);
	report(progress, 'epistasis', 3, total, `${sectors.length} sector(s)`);

	// 5. the sector-site DMS (epistasis.py:702-716), on request
	const dmsSites = dmsSitesForSectors(sectors, edges);
	let plasticity = [];
	if (opts.dms && dmsSites.length > 0) {
		const predictFn = predict ?? (session ? predictFromSession(session, { signal }) : null);
		if (!predictFn) throw new Error('runEpistasis: options.dms needs a `predict` callback or a `session`');
		report(progress, 'epistasis', 3, total, `Selection DMS on ${dmsSites.length} sector site(s)...`);
		plasticity = await runInsilicoSelectionDms(loaded, predictFn, {
			focalTaxon: opts.focalTaxon,
			batchSize: options.dmsBatchSize ?? 64,
			siteSubset: dmsSites,
			taxa: loaded.taxa,
			progress: (p) =>
				report(progress, 'epistasis', 3, total, p.phase === 'dms-baseline' ? `DMS baseline: site ${p.done} of ${p.total}...` : `DMS: ${p.mutantsDone} of ${p.totalMutants} mutants...`)
		});
		throwIfAborted(signal);
	}
	report(progress, 'epistasis', total, total, 'Epistasis ready');

	// epistasis.py:717-731, key for key; then the app's additions.
	return {
		alignment: inputs.alignment ?? null,
		tree: inputs.tree ?? null,
		taxa_count: N,
		codon_count: L,
		evaluated_taxa: N,
		coselection_edges_count: edges.length,
		discovered_sectors_count: sectors.length,
		edges,
		sectors,
		plasticity,
		coselection_edges: edges,
		epistatic_sectors: sectors,
		selection_dms_plasticity: plasticity,
		graph: opts.graph ? graph.toJson() : undefined,
		permutations: { n: opts.nPermutations, seed: opts.seed, rng: 'xoshiro256**', note: P_PERM_MONTE_CARLO_NOTE },
		dms_sites: dmsSites.map((s) => s + 1),
		dms_enabled: Boolean(opts.dms),
		attention_source: attentionSource,
		options: { ...opts },
		elapsed_sec: (Date.now() - t0) / 1000
	};
}
