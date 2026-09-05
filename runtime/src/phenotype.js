/**
 * phenotype.js — directional phenotype-genotype association (PhyloWAS, `hyphaeon phenotype`) over
 * a forward pass someone else already ran.
 *
 * WHY THIS FILE EXISTS. `run_phenotype_association` (hyphaeon/phenotype.py:347-646) is one model
 * plus a long stretch of arithmetic: a trait vector, the transformer attribution matrix, a
 * per-site correlation with its t-test, ACAT against the site LRT, BH, the extreme-value gene
 * statistic, the PARS bracket, trait co-selection and trait sectors, and — only when there is a
 * real tree — a Brownian-motion permulation null. `@veg/hyphaeon-js` ports all of it as pure
 * functions (`phenotype.js`, `permulations.js`, `../HyphAeon/PHASE3A.md`), and this module is the
 * runtime's glue, written to the same shape as `epistasis.js`: it feeds the library the graph's
 * outputs, applies `cmd_phenotype`'s defaults rather than the function's where they differ,
 * reports progress, and returns the CLI's result dictionary key for key with the app's own block
 * appended.
 *
 * It replaces the Python bridge. Until Phase 3 this was the ONE pillar the app could not run —
 * `mcp/src/bridge.js` shelled out to `hyphaeon phenotype` and `sections.phenotype` was null on
 * every surface (PHASE2.md gap 1). Nothing here starts a process.
 *
 * ONE FORWARD PASS, SHARED WITH EPISTASIS (PLAN.md §4.0). `mean_root_attns` [L, N] and the site
 * LRTs [L] are what `compute_transformer_attributions` needs, and the report's `meme` pass
 * already holds both. `runPhenotype` takes that pass exactly as `runEpistasis` does — through
 * `attributionsFromPass`, so the two pillars compute the SAME attribution matrix by calling the
 * same function, which is also what the reference does (`phenotype.py:44` imports
 * `compute_transformer_attributions` from `epistasis.py`). Given a session and no pass, it runs
 * the reference's own all-sites loop instead; see epistasis.js's header for why the two agree.
 *
 * PERMULATIONS NEED A REAL TREE, AND SAY SO WHEN THERE IS NONE. `phenotype.py:426` runs the
 * Brownian null only `if permulations > 0 and tree_obj is not None`, and `cmd_phenotype` sets
 * `tree_obj = None` whenever `--use-tn93` / `--no-tree` is in force (cli.py:621, phenotype.py:383).
 * PLAN.md D22 made that the app's DEFAULT rather than a flag: a run with no tree, or with a tree
 * that has no usable branch lengths, uses TN93 distances and therefore has no tree to draw a
 * covariance from. The display-only NJ tree (nj.js) is NOT substituted — a Brownian null over a
 * topology inferred from the same distances the association is computed on would be a null that
 * shares the alternative's error, which is worse than no null at all. So `permulations` are
 * skipped with `{requested, ran: 0, reason, detail}` and every `p_assoc` stays the parametric
 * t-test p, exactly as `--n-permutations 0` gives in the reference.
 *
 * TWO OPTIONS, ONE LETTER APART, AND THEY ARE NOT THE SAME THING (the reference's naming, kept):
 *   `permulations`   Brownian-motion phylogenetic permuLations of the TRAIT (`--permulations`,
 *                    default 0). Needs a tree. Produces `p_assoc_perm` and `gene_p_value_perm`.
 *   `nPermutations`  random K-site subset Monte Carlo permuTations for TRAIT SECTOR significance
 *                    (`--n-permutations`, default 10,000). Needs no tree. Produces sector
 *                    `p_perm` and the null moments. `permutations` is accepted as an alias, as in
 *                    epistasis.js, because that is what the report calls it.
 *
 * WHAT IS THE REFERENCE'S AND WHAT IS THE APP'S. Every key of the returned record up to
 * `sites` is `phenotype.py:624-646`'s, in its order, from the library's arithmetic; the parity
 * classes are PARITY.md's (site statistics at the graph class through the model, the p/score
 * tracks at 1e-9 given identical inputs, sector membership exact, `p_perm` statistical). The
 * `trait`, `permulations`, `sector_permutations`, `attention_source`, `options` and `elapsed_sec`
 * blocks are the app's, appended after them, and `report.js` drops them from the file a user
 * downloads.
 *
 * SURROGATE. The LRTs are predictions of what MEME would report and the attention is a model
 * internal; this is not a fitted phylogenetic regression. The report's provenance says so
 * (analyze.js) through `PHENOTYPE_SURROGATE_FOR`.
 */

import {
	runPhenotypeAssociation,
	runTransformerAttributions,
	resolvePhenotypeVector,
	PRESETS,
	PHENOTYPE_THRESHOLDS
} from '@veg/hyphaeon-js';

import { attributionsFromPass, attentionPredictFromSession } from './epistasis.js';
import { report } from './pipeline.js';
import { resolveBatchSize, throwIfAborted, yieldToLoop } from './predict.js';

/** PLAN.md §2, hard truth 1: what this pillar is a surrogate for. */
export const PHENOTYPE_SURROGATE_FOR = 'phenotype-genotype association (PhyloWAS / RERconverge-style)';

/**
 * `cmd_phenotype` (cli.py:610-705, argparse) — the values the CLI passes, which are the ones a
 * user comparing with `hyphaeon phenotype` will have seen. `minTaxa` is the CLI's `--min-taxa`
 * (the function's `min_taxa_per_site`); `maxPermP` null keeps every trait sector with
 * C(S) >= 0.45 (`PHENOTYPE_THRESHOLDS.sectorMinCoherence`).
 */
export const PHENOTYPE_CLI_DEFAULTS = Object.freeze({
	permulations: 0,
	minTaxa: 4,
	alpha: 0.05,
	nPermutations: 10000,
	maxPermP: null,
	seed: 42,
	continuous: false
});

/** App-side: the browser's B for the trait-sector null, chosen for latency (as in epistasis.js). */
export const BROWSER_SECTOR_PERMUTATIONS_DEFAULT = 1000;

/** Why a run has no permulation p-values. Recorded, never inferred by the reader. */
export const PERMULATION_SKIP_REASONS = Object.freeze({
	notRequested: 'not-requested',
	treeFree: 'tree-free',
	noTree: 'no-tree',
	failed: 'failed'
});

/** The sentence a UI shows beside a phenotype result that has no permulation column. */
export const PERMULATION_TREE_FREE_NOTE =
	'Brownian-motion permulations need a phylogeny with branch lengths. This run had none, so it ' +
	'used TN93 distances (PLAN.md D22) and the association p-values are the parametric t-test ' +
	'ones — the same thing `hyphaeon phenotype --use-tn93` reports. The display tree is a ' +
	'neighbour-joining tree on those same distances and is deliberately NOT used as a null.';

/**
 * Resolve the pillar's options: the CLI's defaults under the caller's overrides.
 *
 * @param {object} [options]
 * @param {{browser?: boolean}} [ctx]
 */
export function resolvePhenotypeOptions(options = {}, { browser = false } = {}) {
	const d = PHENOTYPE_CLI_DEFAULTS;
	const permulations = Math.floor(options.permulations ?? d.permulations);
	if (!Number.isInteger(permulations) || permulations < 0) {
		throw new Error(`runPhenotype: permulations must be a non-negative integer, got ${String(options.permulations)}`);
	}
	const nPermutations = options.nPermutations ?? options.permutations ?? (browser ? BROWSER_SECTOR_PERMUTATIONS_DEFAULT : d.nPermutations);
	if (!Number.isInteger(nPermutations) || nPermutations < 0) {
		throw new Error(`runPhenotype: nPermutations must be a non-negative integer, got ${String(nPermutations)}`);
	}
	const seed = options.seed ?? d.seed;
	if (!Number.isSafeInteger(seed)) throw new Error(`runPhenotype: seed must be an integer, got ${String(seed)}`);
	const alpha = options.alpha ?? d.alpha;
	if (!(alpha > 0 && alpha <= 1)) throw new Error(`runPhenotype: alpha must be in (0, 1], got ${String(alpha)}`);
	const minTaxa = Math.floor(options.minTaxa ?? options.minTaxaPerSite ?? d.minTaxa);
	if (!Number.isInteger(minTaxa) || minTaxa < 1) {
		throw new Error(`runPhenotype: minTaxa must be a positive integer, got ${String(options.minTaxa)}`);
	}
	return {
		permulations,
		minTaxa,
		alpha,
		nPermutations,
		maxPermP: options.maxPermP ?? d.maxPermP,
		seed,
		continuous: options.continuous === true
	};
}

/**
 * The trait, described for a report: what the user asked for, how many taxa it matched, and by
 * which of `resolve_phenotype_vector`'s three sources (phenotype.py:141-272, tried in that
 * priority order — a metadata table wins over a preset, which wins over an inline list).
 *
 * @param {object} phenotype the caller's trait options
 * @param {object} meta the library's `phenotype_meta`
 */
export function describeTrait(phenotype = {}, meta = {}) {
	const source = phenotype.phenotypeCsv
		? 'table'
		: phenotype.preset
			? 'preset'
			: phenotype.foreground
				? 'foreground'
				: 'vector';
	return {
		source,
		preset: phenotype.preset ?? null,
		mode: meta.mode ?? null,
		foreground_count: meta.foreground_count ?? 0,
		background_count: meta.background_count ?? 0,
		description: meta.description ?? '',
		/** phenotype.py:125 declares `background` and never reads it; said out loud, not hidden. */
		background_ignored: Boolean(phenotype.background)
	};
}

/** The taxa a trait would mark as foreground, without running anything. For a UI's preview. */
export function previewTrait(taxa, phenotype = {}) {
	const resolved = resolvePhenotypeVector(taxa, phenotype);
	const foreground = [];
	for (let i = 0; i < taxa.length; i++) if (resolved.y[i] > 0) foreground.push(taxa[i]);
	return { ...describeTrait(phenotype, resolved.meta), foreground, y: resolved.y };
}

/**
 * `run_phenotype_association` (phenotype.py:347-646) steps 3-11 over a loaded alignment and
 * either a forward pass already run or a session to run one.
 *
 * @param {object} args
 * @param {object} [args.loaded] the library's LoadedAlignment (runMeme's `result.loaded`)
 * @param {object} [args.prepared] a `prepareRun()` result to take `loaded` (and the tree
 *   decision) from, instead of `loaded`
 * @param {Float32Array|{data: Float32Array, dims: number[]}} [args.attention] `mean_root_attns`
 *   [L, N] from the meme pass
 * @param {ArrayLike<number>} [args.lrt] that pass's clamped float32 site LRTs [L]
 * @param {object} [args.attributions] a `computeTransformerAttributions` record, if the caller
 *   already built one (the epistasis section's, for instance)
 * @param {{session: any, ort: any}} [args.session] the backbone handle; required when no pass is given
 * @param {{preset?: string, foreground?: string|string[], background?: string|string[],
 *   phenotypeCsv?: string, phenotypeFile?: string, traitCol?: string, speciesCol?: string,
 *   continuous?: boolean, y?: ArrayLike<number>}} [args.phenotype] the trait, as
 *   `resolvePhenotypeVector` takes it; `y` hands over a ready vector instead (which comes back
 *   with an EMPTY `phenotype_meta.description` — the library does not invent provenance for a
 *   raw vector, see ../HyphAeon/PHASE3A.md)
 * @param {object} [args.options] `permulations`, `nPermutations` (or `permutations`), `seed`,
 *   `alpha`, `minTaxa`, `maxPermP`, `continuous`, `batchSize`, `browser`
 * @param {object|null} [args.tree] the parsed tree for the permulations; defaults to the loaded
 *   run's own tree, and is ignored (with a reason) in tree-free mode
 * @param {{alignment?: string|null, tree?: string|null}} [args.inputs] labels for the document
 * @param {Function} [args.progress] `(phase, done, total, message)`; phase 'phenotype'
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<object>} phenotype.py:624-646's record plus `trait`, `permulations`,
 *   `sector_permutations`, `attention_source`, `options`, `elapsed_sec`
 */
export async function runPhenotype({
	loaded = null,
	prepared = null,
	attention = null,
	lrt = null,
	attributions = null,
	session = null,
	predict = null,
	phenotype = {},
	options = {},
	tree,
	inputs = {},
	progress,
	signal
} = {}) {
	const t0 = Date.now();
	const load = loaded ?? prepared?.loaded ?? null;
	if (!load || !load.a || !Number.isInteger(load.L)) {
		throw new Error('runPhenotype: pass the library LoadedAlignment as `loaded` (or a prepareRun result as `prepared`)');
	}
	if (!phenotype || (!phenotype.preset && !phenotype.foreground && !phenotype.phenotypeCsv && !phenotype.y)) {
		// The wording is deliberate: `mcp/src/engine.js` classifies an input error by matching
		// "no trait" / "Provide one of", the same way it matches the library's own refusals.
		throw new Error(
			'runPhenotype: no trait was given, and this pillar cannot run without one. Provide one of ' +
				'`phenotype.preset`, `phenotype.foreground`, `phenotype.phenotypeCsv` or a ready ' +
				`\`phenotype.y\` (presets: ${Object.keys(PRESETS).join(', ')}).`
		);
	}
	const opts = resolvePhenotypeOptions(options, { browser: Boolean(options.browser) });
	const { L, N } = load;
	const total = 3;

	// --- the attribution matrix, from the shared pass or the reference's own loop --------------
	let attr = attributions;
	let attentionSource = 'given';
	if (!attr) {
		if (attention && lrt) {
			report(progress, 'phenotype', 0, total, 'Attributing attention to non-consensus taxa...');
			attr = attributionsFromPass({ loaded: load, attention, lrt });
			attentionSource = 'shared-pass';
		} else {
			if (!session) throw new Error('runPhenotype: pass the meme pass (`attention` + `lrt`) or a `session` to run one');
			report(progress, 'phenotype', 0, total, `Computing transformer attributions across ${L} codons...`);
			const batchSize = resolveBatchSize(N, options);
			attr = await runTransformerAttributions(load, predict ?? attentionPredictFromSession(session, { signal }), {
				batchSize,
				onProgress: (p) => report(progress, 'phenotype', 0, total, `Attributions: site ${p.done} of ${p.total}...`)
			});
			attentionSource = 'all-sites';
		}
	}
	throwIfAborted(signal);
	await yieldToLoop();

	// --- the permulation gate (phenotype.py:426; PLAN.md D22) -----------------------------------
	const treeFree = load.notices?.treeFree ?? prepared?.treeFree ?? null;
	const runTree = treeFree ? null : (tree !== undefined ? tree : (prepared?.tree ?? load.tree ?? null));
	/** @type {{requested: number, ran: number, reason: string|null, detail: string|null, seed: number}} */
	const permulations = {
		requested: opts.permulations,
		ran: 0,
		reason: null,
		detail: null,
		seed: opts.seed
	};
	if (opts.permulations === 0) {
		permulations.reason = PERMULATION_SKIP_REASONS.notRequested;
		permulations.detail = 'permulations = 0: the association p-values are the parametric t-test ones (the CLI default).';
	} else if (runTree === null) {
		permulations.reason = treeFree ? PERMULATION_SKIP_REASONS.treeFree : PERMULATION_SKIP_REASONS.noTree;
		permulations.detail = treeFree
			? `${PERMULATION_TREE_FREE_NOTE} (tree-free reason: ${treeFree.reason})`
			: 'No parsed tree was available for the Brownian covariance.';
	}

	report(
		progress,
		'phenotype',
		1,
		total,
		`Associating ${L} codons with the trait${permulations.reason === null ? ` (${opts.permulations} permulations)` : ''}...`
	);
	const record = await runPhenotypeAssociation(
		{
			loaded: load,
			taxa: load.taxa,
			attributions: attr,
			phenotype: phenotype.y ? undefined : phenotype,
			y: phenotype.y,
			tree: permulations.reason === null ? runTree : null,
			alignment: inputs.alignment ?? null,
			treePath: inputs.tree ?? null
		},
		null,
		{
			permulations: opts.permulations,
			minTaxaPerSite: opts.minTaxa,
			alpha: opts.alpha,
			nPermutations: opts.nPermutations,
			maxPermP: opts.maxPermP,
			seed: opts.seed,
			continuous: opts.continuous || phenotype.continuous === true
		}
	);
	throwIfAborted(signal);

	// phenotype.py:638 — `permulations_count` is the REQUESTED count when the draws succeeded and
	// 0 when they did not, so it doubles as "did they run".
	permulations.ran = record.permulations_count;
	if (permulations.reason === null && permulations.ran === 0) {
		permulations.reason = PERMULATION_SKIP_REASONS.failed;
		permulations.detail =
			'The permulation block raised and phenotype.py:441-443 swallows it (a covariance that is ' +
			'not positive definite is the usual cause); the parametric p-values were kept.';
	}
	report(
		progress,
		'phenotype',
		total,
		total,
		`${record.significant_sites_count} site(s) at FDR q <= ${opts.alpha}; ${record.trait_sectors_count} trait sector(s)`
	);

	return {
		...record,
		// --- the app's own block, after the reference's keys ------------------------------------
		trait: describeTrait(phenotype, record.phenotype_meta),
		permulations,
		sector_permutations: {
			n: opts.nPermutations,
			seed: opts.seed,
			rng: 'xoshiro256**',
			note:
				'Trait-sector p_perm and the null moments are Monte Carlo estimates from B random ' +
				'K-site subsets; two runs agree only within 3*sqrt(p(1-p)/B).'
		},
		attention_source: attentionSource,
		thresholds: { ...PHENOTYPE_THRESHOLDS },
		options: { ...opts },
		elapsed_sec: (Date.now() - t0) / 1000
	};
}
