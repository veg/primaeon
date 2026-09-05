/**
 * analyze.js — one upload runs everything, in one pass over one loaded alignment, and the report
 * fills in as each section finishes.
 *
 * WHY THIS FILE EXISTS. PLAN.md §4.0 (D21) is a product decision with a runtime consequence:
 * "the only thing the interface asks for is a dataset", so nothing may be a pre-run option and
 * every pillar has to run, in a fixed order, sharing whatever the previous one already paid for.
 * `runEverything` is that orchestration — the single entry point the browser worker, the MCP's
 * `hyphaeon_analyze` and the job server all call, so the three surfaces cannot drift in what
 * "running HyphAeon on this file" means.
 *
 * THE ORDER, AND WHAT EACH STEP REUSES (PLAN.md §4.0's table, left to right):
 *
 *   1. diagnostics   `prepareRun` (parse -> tree -> matching -> duplicates -> PD cap -> MDS ->
 *                    tokens) ONCE, plus the library's `diagnose()`. Everything below reads the
 *                    LoadedAlignment it produced; nothing loads the alignment a second time.
 *   2. sites         `runMeme` over that preparation, requesting `lrt` AND the two optional
 *                    heads: `mean_root_attns` (epistasis) and `root_repr` (busted). One graph
 *                    pass over the variable sites is the whole cost of steps 2-4.
 *   3. gene          the busted head on the `root_repr` the meme pass already returned, plus the
 *                    library's statistics on its LRTs — cmd_busted's own two halves
 *                    (cli.py:424-505) without re-scoring a site. "Free from (2) plus one head
 *                    pass", as the plan says.
 *   4. epistasis     `runEpistasis` on the same pass's attention (see epistasis.js on why the
 *                    variable-sites pass and the reference's all-sites pass give the same edges
 *                    and sectors).
 *   5. attribution   `attributeSelection` on the CALLED sites only — the report's call mode
 *                    (default: percentile, Top 5% of variable sites), not the CLI's LRT >= 3.84
 *                    gate, because the report has already ranked the sites and attribution is
 *                    expensive per site. `options.attributionMinLrt` restores the CLI's gate.
 *   6. filter        cmd_meme's `--filter` variant, reported as "N suspicious patches" BESIDE
 *                    the primary sites. The reference REPLACES the LRTs with the cleaned ones
 *                    (cli.py:214-218); the report keeps both — `sections.sites` stays the
 *                    unmasked run and `sections.filter.cleaned` carries the masked view — because
 *                    a masked/unmasked toggle is the product (PLAN.md §4.0 row 6) and because a
 *                    silent replacement would make the two views impossible to compare.
 *   7. dms           last, progressive, cancellable through its OWN child AbortController, and
 *                    capped by work (dms.js). Cancelling it cancels nothing else.
 *   8. phenotype     null. It needs a trait, so it cannot run unasked; the report renders the
 *                    offer (PLAN.md §4.0 row 8, Phase 3).
 *
 * NOTHING BUT A REFUSAL STOPS THE REPORT. Steps 1 and 2 are the report (a run with no sites is
 * not a report), so they propagate. Every later section is wrapped: a failure is attached to
 * that section as `{error, failed: true}` and the rest continues, because a report on screen
 * with five sections and one apology beats an error page. A cancel (`signal`) is different — it
 * propagates from every phase except DMS, whose cancel is scoped to itself.
 *
 * PROGRESS AND STREAMING. `progress(phase, done, total, message)` uses the phases of the
 * contract in order; `onSection(name, payload, {final})` fires once per finished section and
 * repeatedly for DMS with `{final: false}`, so the heatmap fills in. Both are advisory: a sink
 * that throws (a closed SSE stream, a dead worker port) never takes the run down.
 *
 * SURROGATE, ONE RECORD. The provenance block is PLAN.md §3.5's, with the surface, the seed and
 * every option as submitted, and it says once for the whole report what each pillar is a
 * surrogate for.
 */

import {
	attributeSelection,
	attributionsOneIndexed,
	runAlignmentFilter,
	memeSiteRecords,
	memeSitePq,
	bustedRecord,
	BUSTED_EMBED_DIM
} from '@veg/hyphaeon-js';

import {
	prepareRun,
	diagnoseWarnings,
	provenanceBlock,
	report as reportProgress,
	runMeme,
	clampMaxSpecies,
	ATTRIBUTION_MIN_LRT_DEFAULT,
	FILTER_P_THRESH_DEFAULT,
	CALL_MODES
} from './pipeline.js';
import { runBustedHead } from './feeds.js';
import { predictFromSession, resolveBatchSize, throwIfAborted } from './predict.js';
import { CALL_DEFAULTS } from './callModes.js';
import { runEpistasis, BROWSER_PERMUTATIONS_DEFAULT } from './epistasis.js';
import { runDms, DMS_WORK_BUDGET_DEFAULT } from './dms.js';
import { createReport, setSection, addTiming, REPORT_PHASES, SECTION_ORDER } from './report.js';

/** What each section of the report is a surrogate for (PLAN.md §2, hard truth 1). */
export const SURROGATE_FOR = Object.freeze({
	sites: 'MEME',
	gene: 'BUSTED',
	epistasis: 'co-evolution / sector analysis (ESSM)',
	attribution: 'MEME branch attribution',
	filter: 'alignment-artifact screen',
	dms: 'deep mutational scanning (ESSM)'
});

/** The report's own defaults. Every one of them is changeable behind "Re-run with…", not before. */
export const REPORT_DEFAULTS = Object.freeze({
	callMode: CALL_DEFAULTS.mode, // percentile: Top 5% / Top 2% of variable sites
	maxSpecies: 256, // the manifest's default_taxon_cap
	seed: 42,
	permutations: BROWSER_PERMUTATIONS_DEFAULT,
	dms: Object.freeze({ enabled: true, workBudget: DMS_WORK_BUDGET_DEFAULT })
});

const now = () =>
	typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();

/** Fire `onSection` without letting a failed sink lose finished work. */
function emit(onSection, name, payload, final) {
	if (typeof onSection !== 'function') return;
	try {
		onSection(name, payload, { final });
	} catch {
		// Advisory, like progress.
	}
}

/** True when `err` is this run's cancellation rather than a real failure. */
function isAbort(err, signal) {
	return err?.name === 'AbortError' || Boolean(signal?.aborted);
}

/** A failed optional section: what went wrong, in the section's own slot. */
function sectionError(err) {
	return { failed: true, error: String(err?.message ?? err), stack: err?.stack ?? null };
}

/**
 * The sites the report calls: `call !== 'Neutral'` under the run's call mode (postprocess.js /
 * callModes.js). Returned 0-indexed, ascending — `attributeSelection`'s `focalSites`.
 *
 * @param {Array<{site: number, call: string, isVariable?: boolean}>} sites
 * @returns {number[]}
 */
export function calledSiteIndices(sites) {
	const out = [];
	for (const s of sites) if (s.call && s.call !== 'Neutral') out.push(s.site - 1);
	return out;
}

/**
 * The gene section from the pass `runMeme` already ran: cmd_busted's statistics on its LRTs and,
 * when a head session is given, `busted_head.onnx` on the `root_repr` it already returned
 * (cli.py:434-464 — `hidden_all` is zero at invariable sites, which is what the meme pass's
 * scatter produces). No site is scored twice.
 *
 * @param {object} args
 * @param {object} args.loaded
 * @param {{lrt: Float32Array, root_repr: {data: Float32Array, dims: number[]}|null}} args.inference
 * @param {{session: any, ort: any, sha256?: string|null, exportSeed?: number|null}|null} [args.head]
 * @param {{gene?: string|null, alignment?: string|null}} [args.options]
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<{record: object, statistics: object, head: object|null, neural_head: object}>}
 */
export async function geneFromPass({ loaded, inference, head = null, options = {}, signal }) {
	const { L, N } = loaded;
	let headOutputs = null;
	if (head && inference.root_repr) {
		throwIfAborted(signal);
		const embedDim = inference.root_repr.dims[1] ?? BUSTED_EMBED_DIM;
		headOutputs = await runBustedHead(
			head.session,
			{ root_repr: inference.root_repr.data, mask: new Uint8Array(L), dims: [1, L, embedDim] },
			head.ort
		);
	}
	const record = bustedRecord({
		lrts: inference.lrt,
		invariable: loaded.invariable,
		numTaxa: N,
		head: headOutputs,
		gene: options.gene ?? null,
		alignment: options.alignment ?? null
	});
	const { statistics, ...plain } = record;
	return {
		record: plain,
		statistics: {
			numVariable: statistics.numVariable,
			pAcat: statistics.pAcat,
			pSimes: statistics.pSimes,
			omnibusLrt: statistics.omnibusLrt,
			totalSelectionEnergy: statistics.totalSelectionEnergy,
			sigSitesP05: statistics.sigSitesP05,
			sigSitesP10: statistics.sigSitesP10
		},
		head: headOutputs,
		neural_head: {
			enabled: Boolean(headOutputs),
			artifact_sha256: headOutputs ? (head.sha256 ?? null) : null,
			export_seed: headOutputs ? (head.exportSeed ?? null) : null,
			deterministic_upstream: false,
			note:
				'cmd_busted loads BustedMultiTaskHead unseeded with 11 parameters missing from model.safetensors; ' +
				'busted_head.onnx is one seeded draw of that head, so selection_probability, predicted_gene_lrt, ' +
				'synonymous_rate_variation, omega_3, proportion_* and a head-driven verdict are not reproducible ' +
				'against the Python reference. The statistical fields are.'
		}
	};
}

/**
 * Run every analysis one upload can produce, in PLAN.md §4.0's order, and return the ReportRecord.
 *
 * @param {object} args
 * @param {string} args.alignmentText FASTA / NEXUS / PHYLIP; may carry an embedded tree
 * @param {string|null} [args.treeText] Newick; null/empty to use an embedded tree
 * @param {{alignmentName?: string, treeName?: string, demo?: string}} [args.inputs] what was uploaded
 * @param {object} [args.options]
 * @param {string} [args.options.variant] recorded; the session already chose it
 * @param {number} [args.options.maxSpecies] taxon cap, default 256 (`Infinity` = none)
 * @param {string} [args.options.referenceSequence] coordinates / `refCodon` source
 * @param {string} [args.options.callMode] 'percentile' (default) | 'zscore' | 'pvalue'
 * @param {number} [args.options.seed] default 42; the sector permutation null's seed
 * @param {{enabled?: boolean, workBudget?: number, maxSites?: number, focalTaxon?: string,
 *   siteSubset?: ArrayLike<number>, batchSize?: number}} [args.options.dms] the DMS section's own
 *   options (`batchSize` is mutants per forward pass, and so also the progressive update size)
 * @param {number} [args.options.permutations] B for the sector null; default 1,000 in the browser
 * @param {boolean} [args.options.epistasis] run the epistasis section (default true)
 * @param {boolean} [args.options.attribute] run the attribution section (default true)
 * @param {boolean} [args.options.filter] run the artifact filter section (default true)
 * @param {Function} [args.options.estimateTree] the HyPhy / NJ hook (dataset.py:601-611)
 * @param {{backbone?: object, head?: object, session?: any, ort?: any}} args.session the handle
 *   `createSession()` returned (or a bare backbone handle)
 * @param {object} [args.head] the busted-head handle, when the session object does not carry one
 * @param {string} [args.surface] PLAN.md §3.5 surface; default 'browser'
 * @param {AbortSignal} [args.signal] cancels the whole run (DMS has its own child controller)
 * @param {(phase: string, done: number, total: number, message: string) => void} [args.progress]
 * @param {(name: string, payload: object, meta: {final: boolean}) => void} [args.onSection]
 * @param {object} [args.provenance] overrides for the provenance block (model_version, model_variant,
 *   artifact_sha256, reference_version, hyphaeon_js_version), as `runMeme` takes them: a browser
 *   session handle (session-web.js) carries only the URL and the sha256, so the analyze worker
 *   supplies the manifest's names; a Node `createSession` handle is stamped and needs none.
 * @returns {Promise<object>} the ReportRecord (report.js)
 */
export async function runEverything({
	alignmentText,
	treeText = null,
	inputs = {},
	options = {},
	session,
	head = null,
	surface = 'browser',
	signal,
	progress,
	onSection,
	provenance: provenanceOverrides = {}
} = {}) {
	const t0 = now();
	const backbone = session?.backbone ?? session;
	const headHandle = head ?? session?.head ?? null;
	if (!backbone || !backbone.session || !backbone.ort) {
		throw new Error('runEverything: pass createSession()\'s handle (or a backbone handle) as `session`');
	}
	const callMode = options.callMode ?? REPORT_DEFAULTS.callMode;
	if (!CALL_MODES.includes(callMode)) {
		throw new Error(`runEverything: unknown callMode "${callMode}" (one of ${CALL_MODES.join(', ')})`);
	}
	const seed = options.seed ?? REPORT_DEFAULTS.seed;
	const dmsOptions = { ...REPORT_DEFAULTS.dms, ...(options.dms ?? {}) };
	const runEpistasisSection = options.epistasis !== false;
	const runAttribution = options.attribute !== false;
	const runFilter = options.filter !== false;

	const record = createReport({
		inputs: {
			alignmentName: inputs.alignmentName ?? null,
			treeName: inputs.treeName ?? null,
			demo: inputs.demo ?? null,
			alignmentBytes: alignmentText ? alignmentText.length : 0,
			hasTree: Boolean(treeText && treeText.trim())
		},
		options: {
			variant: options.variant ?? backbone.variant ?? null,
			maxSpecies: options.maxSpecies ?? REPORT_DEFAULTS.maxSpecies,
			referenceSequence: options.referenceSequence ?? null,
			callMode,
			seed,
			permutations: options.permutations ?? REPORT_DEFAULTS.permutations,
			dms: { enabled: Boolean(dmsOptions.enabled), workBudget: dmsOptions.workBudget },
			epistasis: runEpistasisSection,
			attribute: runAttribution,
			filter: runFilter
		}
	});

	const phase = (name, done, total, message) => reportProgress(progress, name, done, total, message);
	const timed = async (name, fn) => {
		const start = now();
		try {
			return await fn();
		} finally {
			addTiming(record, name, (now() - start) / 1000);
		}
	};

	// --- 1. diagnostics -------------------------------------------------------------------------
	const memeOptions = {
		maxSpecies: options.maxSpecies ?? REPORT_DEFAULTS.maxSpecies,
		pruneDuplicates: options.pruneDuplicates,
		referenceSequence: options.referenceSequence,
		estimateTree: options.estimateTree,
		requireBranchLengths: options.requireBranchLengths,
		treeSource: options.treeSource,
		alignmentName: inputs.alignmentName,
		treeName: inputs.treeName,
		batchSize: options.batchSize,
		batchBudgetBytes: options.batchBudgetBytes,
		callMode,
		seed,
		diagnose: options.diagnose
	};
	const prep = await timed('prepare', () =>
		prepareRun({
			alignmentText,
			treeText,
			options: memeOptions,
			progress,
			signal,
			defaultMaxSpecies: clampMaxSpecies(options.maxSpecies ?? REPORT_DEFAULTS.maxSpecies)
		})
	);
	const { loaded, treeArg, speciesCap, preprocessing } = prep;
	const { L, N } = loaded;
	const warnings = diagnoseWarnings({
		alignmentText,
		treeArg,
		loaded,
		speciesCap,
		runtimeWarnings: prep.warnings,
		enabled: options.diagnose
	});
	record.diagnostics = {
		taxa_in_alignment: preprocessing.taxa_in_alignment,
		taxa_used: N,
		codon_count: L,
		preprocessing,
		warnings,
		refused: false
	};
	emit(onSection, 'diagnostics', record.diagnostics, true);

	const batchSize = resolveBatchSize(N, options);
	const predict = predictFromSession(backbone, { signal });

	// --- 2. sites (meme) ------------------------------------------------------------------------
	const wantAttention = runEpistasisSection && (!Array.isArray(backbone.outputNames) || backbone.outputNames.includes('mean_root_attns'));
	const wantRepr = Boolean(headHandle) && (!Array.isArray(backbone.outputNames) || backbone.outputNames.includes('root_repr'));
	const sites = await timed('infer', () =>
		runMeme({
			alignmentText,
			treeText,
			options: {
				...memeOptions,
				prepared: prep,
				attention: wantAttention,
				rootRepr: wantRepr,
				// The report runs the filter and the attribution as their own sections, so runMeme
				// runs neither: its `sites` stay the unmasked, unattributed primary view.
				filter: false,
				attribute: false
			},
			session: backbone,
			progress,
			surface,
			signal
		})
	);
	setSection(record, 'sites', sites);
	emit(onSection, 'sites', sites, true);
	const inference = sites.inference;

	// --- 3. gene (busted) -----------------------------------------------------------------------
	try {
		const gene = await timed('gene', async () => {
			phase('gene', 0, 1, 'Gene-level omnibus...');
			const g = await geneFromPass({
				loaded,
				inference,
				head: headHandle,
				options: {
					gene: options.gene ?? (inputs.alignmentName ? String(inputs.alignmentName).replace(/^.*[\\/]/, '').replace(/\.[^.]*$/, '') : null),
					alignment: inputs.alignmentName ?? null
				},
				signal
			});
			g.record.elapsed_seconds = null; // cli.py writes null here; the report's timings hold the clock
			phase('gene', 1, 1, `Gene verdict: ${g.record.positive_selection_detected ? 'selection detected' : 'no selection detected'}`);
			return g;
		});
		setSection(record, 'gene', gene);
		emit(onSection, 'gene', gene, true);
	} catch (err) {
		if (isAbort(err, signal)) throw err;
		setSection(record, 'gene', sectionError(err));
		emit(onSection, 'gene', record.sections.gene, true);
	}
	throwIfAborted(signal);

	// --- 4. epistasis + sectors -----------------------------------------------------------------
	if (runEpistasisSection) {
		try {
			const epistasis = await timed('epistasis', () =>
				runEpistasis({
					loaded,
					attention: wantAttention ? inference.mean_root_attns : null,
					lrt: wantAttention ? inference.lrt : null,
					session: backbone,
					predict,
					options: {
						seed,
						permutations: options.permutations,
						browser: true,
						focalTaxon: options.focalTaxon ?? null,
						// The report's own DMS section sweeps the whole alignment, so the per-sector
						// sweep of `hyphaeon epistasis` is off here (it would score the sector sites
						// twice); the parity runner and the MCP turn it on to reproduce the CLI.
						dms: Boolean(options.epistasisDms),
						batchSize: options.batchSize
					},
					inputs: { alignment: inputs.alignmentName ?? null, tree: inputs.treeName ?? null },
					progress,
					signal
				})
			);
			setSection(record, 'epistasis', epistasis);
			emit(onSection, 'epistasis', epistasis, true);
		} catch (err) {
			if (isAbort(err, signal)) throw err;
			setSection(record, 'epistasis', sectionError(err));
			emit(onSection, 'epistasis', record.sections.epistasis, true);
		}
		throwIfAborted(signal);
	}

	// --- 5. attribution on the called sites -----------------------------------------------------
	if (runAttribution) {
		try {
			const attribution = await timed('attribute', async () => {
				const focalSites = options.attributionMinLrt == null ? calledSiteIndices(sites.sites) : null;
				phase('attribute', 0, 1, `Attributing selection at ${focalSites ? focalSites.length : 'gated'} site(s)...`);
				const map = await attributeSelection(loaded, predict, {
					minLrt: options.attributionMinLrt ?? ATTRIBUTION_MIN_LRT_DEFAULT,
					baseLrts: sites.arrays.lrt,
					focalSites: focalSites ?? undefined,
					taxa: loaded.taxa,
					batchSize,
					onProgress: (p) => phase('attribute', p.done, p.total, `Attributing site ${p.done} of ${p.total}...`)
				});
				phase('attribute', 1, 1, `${map.size} site(s) attributed`);
				return {
					attributions: attributionsOneIndexed(map),
					attribution_enabled: true,
					attributed_sites: map.size,
					call_mode: callMode,
					// Which sites were chosen and why — the report's gate, not cli.py's.
					focal_sites: (focalSites ?? []).map((s) => s + 1),
					gate:
						focalSites === null
							? { kind: 'min_lrt', min_lrt: options.attributionMinLrt }
							: { kind: 'called', call_mode: callMode, note: 'the report attributes the sites it called, not cli.py\'s LRT >= 3.84 gate' }
				};
			});
			setSection(record, 'attribution', attribution);
			emit(onSection, 'attribution', attribution, true);
		} catch (err) {
			if (isAbort(err, signal)) throw err;
			setSection(record, 'attribution', sectionError(err));
			emit(onSection, 'attribution', record.sections.attribution, true);
		}
		throwIfAborted(signal);
	}

	// --- 6. alignment-artifact filter -----------------------------------------------------------
	if (runFilter) {
		try {
			const filter = await timed('filter', async () => {
				phase('filter', 0, 1, 'Screening for alignment artifacts...');
				const res = await runAlignmentFilter(
					{ alignmentText, treeText: treeArg, loaded, baseLrts: sites.arrays.lrt },
					predict,
					{
						cliVariant: true,
						pLocalThresh: options.filterPThresh ?? FILTER_P_THRESH_DEFAULT,
						maxSpecies: speciesCap,
						pruneDuplicates: options.pruneDuplicates !== false,
						batchSize,
						onProgress: (p) => phase('filter', p.done, p.total, `Re-scoring cleaned alignment: site ${p.done} of ${p.total}...`)
					}
				);
				phase('filter', 1, 1, `${res.num_artifacts_masked} artifact patch(es) masked`);
				// Both views, deliberately: the primary sites above are the UNMASKED run, and the
				// cleaned table is offered beside them rather than replacing them (see the header).
				let cleaned = null;
				if (res.num_artifacts_masked > 0 && res.cleaned) {
					const { pvals, qvals } = memeSitePq(res.cleaned.lrts);
					cleaned = {
						sites: memeSiteRecords(res.cleaned.lrts, pvals, qvals, res.cleaned.loaded.invariable, null),
						taxa_count: res.cleaned.loaded.N,
						codon_count: res.cleaned.loaded.L,
						metrics: res.cleaned_metrics,
						fasta: res.cleaned.fastaText
					};
				}
				return {
					filter_enabled: true,
					artifacts_masked: res.artifacts_masked,
					num_patches_detected: res.num_patches_detected,
					num_artifacts_masked: res.num_artifacts_masked,
					masked_codons_count: res.masked_codons_count,
					patches: res.patches,
					artifacts: res.artifacts,
					masked_codon_ranges_1idx_by_taxon: res.masked_codon_ranges_1idx_by_taxon,
					raw_metrics: res.raw_metrics,
					cleaned_metrics: res.cleaned_metrics,
					suppressed_spurious_sites: res.suppressed_spurious_sites,
					cleaned,
					cleaned_fasta: res.cleaned ? res.cleaned.fastaText : null,
					primary_view: 'unmasked'
				};
			});
			setSection(record, 'filter', filter);
			emit(onSection, 'filter', filter, true);
		} catch (err) {
			if (isAbort(err, signal)) throw err;
			// cli.py:192's "No tree specified" on an embedded tree with a masked artifact lands here.
			setSection(record, 'filter', sectionError(err));
			emit(onSection, 'filter', record.sections.filter, true);
		}
		throwIfAborted(signal);
	}

	// --- 7. digital DMS, last, progressive, separately cancellable -------------------------------
	if (dmsOptions.enabled !== false) {
		const dmsController = new AbortController();
		const onParentAbort = () => dmsController.abort(signal?.reason);
		if (signal) {
			if (signal.aborted) dmsController.abort(signal.reason);
			else signal.addEventListener('abort', onParentAbort, { once: true });
		}
		try {
			const dms = await timed('dms', () =>
				runDms({
					loaded,
					session: backbone,
					predict: predictFromSession(backbone, { signal: dmsController.signal }),
					options: {
						siteSubset: dmsOptions.siteSubset ?? null,
						focalTaxon: dmsOptions.focalTaxon ?? options.focalTaxon ?? null,
						workBudget: dmsOptions.workBudget,
						maxSites: dmsOptions.maxSites,
						// The DMS section may size its own forward pass (mutants per call, which is
						// also the slab size and therefore how often the heatmap updates); it falls
						// back to the run's batch size, and then to the adaptive one.
						batchSize: dmsOptions.batchSize ?? options.batchSize,
						batchBudgetBytes: options.batchBudgetBytes
					},
					inputs: { alignment: inputs.alignmentName ?? null, tree: inputs.treeName ?? null },
					onProgress: (partial) => emit(onSection, 'dms', partial, false),
					progress,
					signal: dmsController.signal
				})
			);
			setSection(record, 'dms', dms);
			emit(onSection, 'dms', dms, true);
		} catch (err) {
			// runDms itself swallows its own cancel and returns what it has; anything reaching here
			// is a real failure (or the parent's cancel, which still must not lose the report).
			setSection(record, 'dms', sectionError(err));
			emit(onSection, 'dms', record.sections.dms, true);
		} finally {
			if (signal) signal.removeEventListener('abort', onParentAbort);
		}
	}

	// --- 8. phenotype: the offer, not the analysis ----------------------------------------------
	setSection(record, 'phenotype', null);

	// --- provenance -------------------------------------------------------------------------------
	phase('postprocess', 0, 1, 'Assembling the report...');
	const elapsed = (now() - t0) / 1000;
	record.provenance = provenanceBlock({
		surface,
		session: backbone,
		head: headHandle && record.sections.gene?.neural_head?.enabled ? headHandle : null,
		surrogateFor: Object.values(SURROGATE_FOR),
		seed,
		elapsedSec: elapsed,
		options: record.options,
		preprocessing,
		warnings,
		inputs: {
			alignment: inputs.alignmentName ?? null,
			tree: inputs.treeName ?? (treeArg === null ? 'embedded_in_alignment' : null),
			demo: inputs.demo ?? null
		},
		overrides: provenanceOverrides
	});
	record.provenance.report = {
		schema_version: record.schema_version,
		sections_run: SECTION_ORDER.filter((name) => record.sections[name] != null),
		sections_failed: SECTION_ORDER.filter((name) => record.sections[name]?.failed),
		phases: REPORT_PHASES,
		surrogate_for: SURROGATE_FOR
	};
	record.timings.total = elapsed;
	phase('postprocess', 1, 1, 'Report ready');
	return record;
}
