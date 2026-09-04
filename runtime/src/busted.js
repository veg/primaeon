/**
 * busted.js — the alignment-wide omnibus (`hyphaeon busted`) over a backbone session and,
 * when one is given, the busted head session.
 *
 * WHY THIS FILE EXISTS. `cmd_busted` (hyphaeon/cli.py:329-568 at veg/HyphAeon phase-1a) is
 * three things stacked: the per-site LRTs and the pooled `root_repr` from the backbone
 * (cli.py:424-447), the neural `BustedMultiTaskHead` on the whole alignment (cli.py:457-464),
 * and the statistical bridge — Self–Liang p, ACAT over the variable sites, Simes over all
 * sites, the omnibus LRT (cli.py:469-505). The library's `runBusted` (js/src/omnibus.js) holds
 * the loop and the statistics as pure functions over two async callbacks; this module supplies
 * the callbacks from onnxruntime sessions (`predictSites` → the backbone with `lrt` +
 * `root_repr` requested; `predictHead` → `busted_head.onnx` with the all-false mask, feeds.js)
 * and wraps the record in the app's result shape with PLAN.md §3.5 provenance. The front half
 * (parse, load, branch-length hook) is `prepareRun` from pipeline.js, shared with `runMeme`.
 *
 * THE NEURAL FIELDS ARE NOT REPRODUCIBLE UPSTREAM, and the result says so. `model.safetensors`
 * lacks 11 `BustedMultiTaskHead` parameters and `cmd_busted` loads them unseeded (fixtures
 * `known_quirks`, PHASE0.md gap 10, PHASE1A.md item 4): every Python run draws a different
 * `selection_probability`, `predicted_gene_lrt`, `synonymous_rate_variation`, `omega_3`,
 * `proportion_*` and, through `pred_prob_pos > 0.50`, a different verdict. `busted_head.onnx` is
 * ONE seeded draw of that head (export.py `BUSTED_HEAD_INIT_SEED = 0`), so this surface is
 * deterministic where the reference is not, and the two agree on the neural fields only by
 * accident. `provenance.neural_head` records the head's hash, the export seed the manifest
 * carries (when it does), and `deterministic_upstream: false`; the e2e fixtures null these
 * fields and so does the parity comparison's expectation for them. The statistical fields
 * (`p_value_acat`, `p_value_simes`, `omnibus_lrt`, `total_selection_energy`, `sig_sites_*`) are
 * exact functions of the site LRTs and ARE compared.
 *
 * TAXON CAP. `busted --max-species` defaults to 512 (cli.py:1108), not None as meme's does, so
 * `options.maxSpecies` defaults to MAX_SPECIES_CAP here; the app's 256 default for meme is a
 * different policy (PLAN.md §3.3 `default_taxon_cap`) and a caller who wants it passes it.
 */

import { runBusted as libraryRunBusted, pvalsFromLrtSelfLiang, MAX_SPECIES_CAP } from '@veg/hyphaeon-js';

import { runSites, runBustedHead } from './feeds.js';
import {
	SCHEMA_VERSION,
	SURFACES,
	prepareRun,
	report,
	diagnoseWarnings,
	provenanceBlock
} from './pipeline.js';
import { resolveBatchSize, throwIfAborted } from './predict.js';

function now() {
	return typeof performance !== 'undefined' && typeof performance.now === 'function'
		? performance.now()
		: Date.now();
}

/**
 * Run the BUSTED surrogate on one alignment.
 *
 * @param {object} args
 * @param {string} args.alignmentText
 * @param {string|null} [args.treeText] null/empty to use a tree embedded in the alignment
 * @param {object} [args.options] as runMeme's, plus:
 * @param {number|null} [args.options.maxSpecies] default 512 (cli.py:1108); `Infinity` = no cap
 * @param {string} [args.options.gene] the record's `gene`; default the alignment name's stem
 * @param {boolean} [args.options.neuralHead] run the head (default: when `head` is given)
 * @param {{session: any, ort: any}} args.session the backbone handle
 * @param {{session: any, ort: any}|null} [args.head] the busted_head handle (loadBustedHead /
 *   createSession().loadHead()); null → statistics only, neural fields null as the fixtures hold them
 * @param {Function} [args.progress]
 * @param {string} [args.surface]
 * @param {AbortSignal} [args.signal]
 * @param {object} [args.provenance]
 * @returns {Promise<object>} { schema_version, method: 'busted', is_surrogate, surrogate_for,
 *   record (cli.py:486-505 key for key), sites, statistics, root_repr?, summary, provenance }
 */
export async function runBusted({
	alignmentText,
	treeText = null,
	options = {},
	session,
	head = null,
	progress,
	surface = 'browser',
	signal,
	provenance: provenanceOverrides = {}
} = {}) {
	const t0 = now();
	if (!session || !session.session || !session.ort) {
		throw new Error('runBusted: pass the backbone handle returned by loadSession() as `session`');
	}
	if (head && (!head.session || !head.ort)) {
		throw new Error('runBusted: `head` must be the handle returned by loadBustedHead()');
	}
	if (!SURFACES.includes(surface)) {
		throw new Error(`runBusted: unknown surface "${surface}" (one of ${SURFACES.join(', ')})`);
	}

	const prep = await prepareRun({
		alignmentText,
		treeText,
		options,
		progress,
		signal,
		defaultMaxSpecies: MAX_SPECIES_CAP
	});
	const { loaded, names, treeArg, speciesCap, preprocessing } = prep;
	const { L, N } = loaded;

	const useHead = options.neuralHead ?? head != null;
	const backboneHasRepr = !Array.isArray(session.outputNames) || session.outputNames.includes('root_repr');
	const runtimeWarnings = [...prep.warnings];
	if (useHead && !head) {
		throw new Error('runBusted: options.neuralHead is true but no `head` session was given');
	}
	if (useHead && !backboneHasRepr) {
		runtimeWarnings.push({
			code: 'BUSTED_HEAD_SKIPPED',
			severity: 'warn',
			message: 'The backbone graph declares no `root_repr` output; the neural BUSTED head was not run.',
			data: {}
		});
	}
	const headEnabled = useHead && backboneHasRepr;

	const batchSize = resolveBatchSize(N, options);
	const outputs = headEnabled ? ['lrt', 'root_repr'] : ['lrt'];
	const predictSites = async (bundle) => {
		throwIfAborted(signal);
		const out = await runSites(session.session, bundle, session.ort, outputs);
		return { lrt: out.lrt, root_repr: out.root_repr };
	};
	const predictHead = headEnabled
		? async (input) => {
				throwIfAborted(signal);
				report(progress, 'infer', L, L, 'Running the neural BUSTED head...');
				return runBustedHead(head.session, input, head.ort);
			}
		: null;

	report(progress, 'infer', 0, L, `Scoring variable sites (${L} codons)...`);
	const alignmentName = options.alignmentName ?? null;
	const gene = options.gene ?? (alignmentName ? alignmentName.replace(/^.*[\\/]/, '').replace(/\.[^.]*$/, '') : null);
	const lib = await libraryRunBusted(
		loaded,
		{ predictSites, predictHead },
		{
			batchSize,
			gene,
			alignment: alignmentName,
			progress: (done, total) =>
				report(progress, 'infer', done, total, `Scoring variable site ${done} of ${total}...`)
		}
	);
	// cli.py:466 — `elapsed` covers load through the head.
	const elapsedSeconds = (now() - t0) / 1000;
	throwIfAborted(signal);

	report(progress, 'postprocess', 0, 1, 'Building the gene record...');
	const { statistics, lrts, root_repr: rootRepr, head: headOutputs, ...record } = lib;
	record.elapsed_seconds = elapsedSeconds;
	const pvals = pvalsFromLrtSelfLiang(lrts);
	const sites = Array.from({ length: L }, (_, i) => ({
		site: i + 1,
		hyphaeon_lrt: Number(lrts[i]),
		p_value: pvals[i],
		is_invariable: loaded.invariable[i] === 1
	}));

	const warnings = diagnoseWarnings({
		alignmentText,
		treeArg,
		loaded,
		speciesCap,
		runtimeWarnings,
		enabled: options.diagnose
	});
	report(progress, 'postprocess', 1, 1, 'Done');

	const provenance = provenanceBlock({
		surface,
		session,
		head: headEnabled ? head : null,
		surrogateFor: 'BUSTED',
		seed: options.seed ?? session.defaultSeed ?? null,
		elapsedSec: (now() - t0) / 1000,
		options,
		preprocessing,
		warnings,
		inputs: {
			alignment: alignmentName,
			tree: options.treeName ?? (treeArg === null ? 'embedded_in_alignment' : null)
		},
		overrides: provenanceOverrides
	});
	provenance.neural_head = {
		enabled: headEnabled,
		artifact_sha256: headEnabled ? (head.sha256 ?? null) : null,
		export_seed: headEnabled ? (head.exportSeed ?? null) : null,
		deterministic_upstream: false,
		note:
			'cmd_busted loads BustedMultiTaskHead unseeded with 11 parameters missing from model.safetensors; ' +
			'busted_head.onnx is one seeded draw of that head, so selection_probability, predicted_gene_lrt, ' +
			'synonymous_rate_variation, omega_3, proportion_* and a head-driven verdict are not reproducible ' +
			'against the Python reference. The statistical fields are.'
	};

	const result = {
		schema_version: SCHEMA_VERSION,
		method: 'busted',
		is_surrogate: true,
		surrogate_for: 'BUSTED',
		record,
		sites,
		statistics: {
			numVariable: statistics.numVariable,
			pAcat: statistics.pAcat,
			pSimes: statistics.pSimes,
			omnibusLrt: statistics.omnibusLrt,
			totalSelectionEnergy: statistics.totalSelectionEnergy,
			sigSitesP05: statistics.sigSitesP05,
			sigSitesP10: statistics.sigSitesP10
		},
		arrays: { lrt: lrts, p_value: pvals, invariable: loaded.invariable },
		head: headOutputs,
		summary: {
			totalSites: L,
			variableSites: statistics.numVariable,
			speciesUsed: N,
			speciesInAlignment: names.length,
			batchSize,
			neuralHead: headEnabled,
			positiveSelectionDetected: record.positive_selection_detected
		},
		provenance
	};
	if (rootRepr) result.root_repr = { data: rootRepr, dims: [L, rootRepr.length / L] };
	Object.defineProperty(result, 'loaded', { value: loaded, enumerable: false, writable: false });
	return result;
}
