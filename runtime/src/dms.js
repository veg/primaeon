/**
 * dms.js — the digital deep mutational scan (`hyphaeon dms`) over a loaded session, run
 * progressively, cancellably, and only when the work fits.
 *
 * WHY THIS FILE EXISTS. `run_digital_dms_analysis` (hyphaeon/epistasis.py:724-768 at
 * veg/HyphAeon phase-2a) is three runtime steps (device, load, model) and then two library
 * calls; `@veg/hyphaeon-js` ports the second half as `runInsilicoSelectionDms` /
 * `digitalDmsRecord` (PHASE2A.md). What is left is exactly what the library refuses to own —
 * the session, the clock, the cancel and the cost — and what PLAN.md §4.0 row 7 asks of the
 * report: "19·L forward passes: the expensive one, so it runs last, in the background, filling
 * the heatmap progressively, cancellable, capped by work; above the cap the report says so and
 * offers the server".
 *
 * THE THREE APP-SIDE BEHAVIOURS, and why none of them changes a number:
 *
 *   1. PROGRESSIVE. The reference sweeps every site and prints a bar. Here the site list is cut
 *      into slabs of `floor(batchSize / 19)` sites — the library's own chunk size, so a slab is
 *      one forward pass — and `runInsilicoSelectionDms` is called once per slab, with
 *      `onProgress` receiving the plasticity records accumulated so far after each. Every record
 *      is computed from its own site's 19 mutant LRTs and that site's baseline (epistasis.py:549-577),
 *      so slabbing changes call shapes and nothing else: dms.test.js asserts that a slabbed run
 *      and a single-call run are BIT-EQUAL under a deterministic predict, and agree within the
 *      graph class (measured ~1e-6) through ORT, whose float noise depends on batch composition.
 *   2. THE BASELINE IS COMPUTED ONCE. `runInsilicoSelectionDms` scores a baseline over EVERY
 *      site (epistasis.py:490-500, not just the swept ones and not just the variable ones), so a
 *      naive slab loop would re-score L sites per slab. The predict callback is wrapped in a
 *      memo keyed by site index that answers the baseline phase from the first pass and lets the
 *      mutant phase through untouched. The graph is a pure function of its inputs and the
 *      baseline tokens for a site are the same rows every time, so the memo returns exactly what
 *      a second call would have returned; the library still applies its own clamp and float32
 *      store to what it receives.
 *   3. CAPPED BY WORK. PLAN.md §3.5's browser/server caps put `L × N_used²` ≤ 2.5 × 10⁹ on a
 *      single scoring pass; a DMS is 19 of those per site plus the baseline, so the budget here
 *      is `19 · L · N_used²` (`dmsWork`) against `options.dms.workBudget`, default 2.5 × 10⁹
 *      (`DMS_WORK_BUDGET_DEFAULT`). Over the budget NOTHING is run and the result says
 *      `{skipped: true, reason, work, budget}` — the report renders that as "too large for this
 *      browser; run it on the server", which is a product decision and is documented as one.
 *      Nothing about the arithmetic changes below the cap.
 *
 * CANCELLING KEEPS WHAT WAS COMPUTED. `signal` is checked before every graph call; when it
 * fires, the records completed so far are returned with `cancelled: true` rather than thrown
 * away, because the report's other sections are already on screen and a half-filled heatmap is
 * worth more than an error (analyze.js gives DMS its own child AbortController so cancelling it
 * cancels nothing else).
 *
 * THE RECORD IS THE REFERENCE'S. `focal_taxon` is the caller's string, not the taxon actually
 * swept, and `total_mutations` is 19 × L whatever subset ran — both `run_digital_dms_analysis`'s
 * behaviour, replicated by `digitalDmsRecord` and left alone here (PHASE2A.md, "Python quirks").
 * The resolved taxon is reported beside it as `focal_index` / `focal_name`, the two fields
 * fixtures/dms/run_insilico_selection_dms.json records, so a UI can name what it actually swept.
 */

import { runInsilicoSelectionDms, digitalDmsRecord, resolveFocalTaxon, dmsTargetSites, DMS_MUTANTS_PER_SITE } from '@veg/hyphaeon-js';

import { predictFromSession, resolveBatchSize, throwIfAborted, yieldToLoop } from './predict.js';
import { report } from './pipeline.js';

/** PLAN.md §3.5: work `L × N_used²` ≤ 2.5 × 10⁹ per pass; a DMS is 19 passes per site. */
export const DMS_WORK_BUDGET_DEFAULT = 2.5e9;

/** The work a full sweep of `L` sites over `N` taxa costs, in the units the cap is written in. */
export function dmsWork(L, N) {
	return DMS_MUTANTS_PER_SITE * L * N * N;
}

/**
 * Whether a sweep fits the budget, and the numbers to say so with.
 *
 * @param {{L: number, N: number, sites?: number, workBudget?: number}} args `sites` is how many
 *   sites will actually be swept (default L); the budget is judged on the SWEPT sites, since a
 *   subset is what a caller asking for one pays for
 * @returns {{work: number, budget: number, within: boolean, reason: string|null}}
 */
export function dmsBudget({ L, N, sites = L, workBudget = DMS_WORK_BUDGET_DEFAULT }) {
	const budget = Number.isFinite(workBudget) && workBudget > 0 ? workBudget : DMS_WORK_BUDGET_DEFAULT;
	const work = dmsWork(sites, N);
	const within = work <= budget;
	return {
		work,
		budget,
		within,
		reason: within
			? null
			: `A digital DMS of ${sites} site(s) over ${N} taxa is 19 x ${sites} x ${N}^2 = ${work.toExponential(2)} units of work, ` +
				`above this surface's budget of ${budget.toExponential(2)} (PLAN.md 3.5). Run it on the server, or sweep fewer sites.`
	};
}

/**
 * Wrap a predict callback so the baseline phase is scored once per site for the whole run.
 * The mutant phase passes straight through. See behaviour 2 in the header.
 *
 * @param {(c: Int32Array, a: Int32Array, meta: object) => Promise<ArrayLike<number>>} predict
 * @param {{L: number, signal?: AbortSignal}} args
 */
export function memoiseBaseline(predict, { L, signal }) {
	const cache = new Float32Array(L);
	const known = new Uint8Array(L);
	const wrapped = async (c, a, meta) => {
		throwIfAborted(signal);
		if (meta.phase !== 'dms-baseline') return predict(c, a, meta);
		const idx = meta.siteIndices;
		const batch = meta.batch;
		const N = meta.N;
		/** @type {number[]} */
		const missing = [];
		for (let k = 0; k < batch; k++) if (!known[idx[k]]) missing.push(k);
		if (missing.length === batch) {
			const y = await predict(c, a, meta);
			const out = new Float32Array(batch);
			for (let k = 0; k < batch; k++) {
				out[k] = y[k];
				cache[idx[k]] = y[k];
				known[idx[k]] = 1;
			}
			return out;
		}
		if (missing.length > 0) {
			const cb = new Int32Array(missing.length * N);
			const ab = new Int32Array(missing.length * N);
			const sub = new Int32Array(missing.length);
			for (let j = 0; j < missing.length; j++) {
				const k = missing[j];
				cb.set(c.subarray(k * N, (k + 1) * N), j * N);
				ab.set(a.subarray(k * N, (k + 1) * N), j * N);
				sub[j] = idx[k];
			}
			const y = await predict(cb, ab, { ...meta, batch: missing.length, siteIndices: sub });
			for (let j = 0; j < missing.length; j++) {
				cache[idx[missing[j]]] = y[j];
				known[idx[missing[j]]] = 1;
			}
		}
		const out = new Float32Array(batch);
		for (let k = 0; k < batch; k++) out[k] = cache[idx[k]];
		return out;
	};
	wrapped.baseline = cache;
	wrapped.known = known;
	return wrapped;
}

/** The payload shape the orchestrator contract gives the report's `dms` section. */
function dmsPayload({ loaded, plasticity, focal, options, inputs, done, total, extra = {} }) {
	const record = digitalDmsRecord(loaded, plasticity, {
		alignment: inputs.alignment ?? null,
		tree: inputs.tree ?? null,
		focalTaxon: options.focalTaxon ?? null,
		taxa: loaded.taxa
	});
	return {
		...record,
		focal_index: focal.index,
		focal_name: focal.name,
		sites_swept: plasticity.length,
		sites_requested: total,
		progress: { done, total },
		...extra
	};
}

/**
 * `run_digital_dms_analysis`'s steps 4-5 over a loaded session: the 19-substitution sweep, in
 * slabs, with the partial table published after every slab.
 *
 * @param {object} args
 * @param {object} args.loaded the library's LoadedAlignment (shared with the rest of the report)
 * @param {{session: any, ort: any}} [args.session] the backbone handle; required unless `predict`
 * @param {Function} [args.predict] a `predict(c, a, meta)` callback (default: from `session`)
 * @param {object} [args.options]
 * @param {ArrayLike<number>|null} [args.options.siteSubset] 0-indexed sites to sweep (the
 *   reference's `target_sites`); default every site
 * @param {string|null} [args.options.focalTaxon] `--focal-taxon`
 * @param {number} [args.options.batchSize] mutants per forward pass; default the adaptive size
 * @param {number} [args.options.workBudget] default DMS_WORK_BUDGET_DEFAULT; `Infinity` = no cap
 * @param {number} [args.options.maxSites] sweep at most this many of the requested sites (the
 *   report's progressive cap); the rest are reported as not swept, never as zero
 * @param {{alignment?: string|null, tree?: string|null}} [args.inputs]
 * @param {(payload: object) => void} [args.onProgress] called with the partial payload per slab
 * @param {Function} [args.progress] `(phase, done, total, message)`
 * @param {AbortSignal} [args.signal] cancelling keeps the records already computed
 * @returns {Promise<object>} the `digitalDmsRecord` fields (`alignment`, `tree`, `taxa_count`,
 *   `codon_count`, `focal_taxon`, `total_mutations`, `plasticity`, `selection_dms_plasticity`)
 *   plus `focal_index`, `focal_name`, `sites_swept`, `sites_requested`, `progress: {done, total}`,
 *   `work`, `budget`, and `cancelled` / `skipped` + `reason` when either happened
 */
export async function runDms({ loaded, session = null, predict = null, options = {}, inputs = {}, onProgress, progress, signal } = {}) {
	if (!loaded || !loaded.c || !Number.isInteger(loaded.L)) {
		throw new Error('runDms: pass the library LoadedAlignment as `loaded`');
	}
	const { L, N } = loaded;
	const focal = resolveFocalTaxon(loaded.taxa ?? [], options.focalTaxon ?? null);
	let sites = dmsTargetSites(options.siteSubset ?? null, L);
	const requested = sites.length;
	let capped = false;
	if (Number.isFinite(options.maxSites) && options.maxSites >= 0 && sites.length > options.maxSites) {
		sites = sites.slice(0, Math.floor(options.maxSites));
		capped = true;
	}

	// --- the cap, before anything is run -------------------------------------------------------
	const budget = dmsBudget({ L, N, sites: sites.length, workBudget: options.workBudget });
	if (!budget.within) {
		report(progress, 'dms', 0, sites.length, 'Digital DMS skipped: above the work budget');
		return dmsPayload({
			loaded,
			plasticity: [],
			focal,
			options,
			inputs,
			done: 0,
			total: requested,
			extra: { skipped: true, reason: budget.reason, work: budget.work, budget: budget.budget }
		});
	}
	if (sites.length === 0) {
		return dmsPayload({ loaded, plasticity: [], focal, options, inputs, done: 0, total: requested, extra: { work: budget.work, budget: budget.budget } });
	}

	const base = predict ?? (session ? predictFromSession(session, { signal }) : null);
	if (!base) throw new Error('runDms: pass a `session` or a `predict` callback');
	const batchSize = options.batchSize ?? Math.max(DMS_MUTANTS_PER_SITE, resolveBatchSize(N, options));
	const perSlab = Math.max(1, Math.floor(batchSize / DMS_MUTANTS_PER_SITE));
	const memoPredict = memoiseBaseline(base, { L, signal });

	/** @type {object[]} */
	const plasticity = [];
	let cancelled = false;
	report(progress, 'dms', 0, sites.length, `Digital DMS: ${DMS_MUTANTS_PER_SITE} substitutions at ${sites.length} site(s)...`);
	try {
		for (let start = 0; start < sites.length; start += perSlab) {
			throwIfAborted(signal);
			const slab = sites.slice(start, Math.min(start + perSlab, sites.length));
			const records = await runInsilicoSelectionDms(loaded, memoPredict, {
				focalTaxon: options.focalTaxon ?? null,
				batchSize,
				siteSubset: slab,
				taxa: loaded.taxa,
				progress: (p) =>
					report(
						progress,
						'dms',
						plasticity.length,
						sites.length,
						p.phase === 'dms-baseline'
							? `Baseline LRTs: site ${p.done} of ${p.total}...`
							: `Digital DMS: ${plasticity.length + p.done} of ${sites.length} sites...`
					)
			});
			for (const r of records) plasticity.push(r);
			report(progress, 'dms', plasticity.length, sites.length, `Digital DMS: ${plasticity.length} of ${sites.length} sites`);
			if (onProgress) {
				onProgress(
					dmsPayload({
						loaded,
						plasticity: plasticity.slice(),
						focal,
						options,
						inputs,
						done: plasticity.length,
						total: requested,
						extra: { work: budget.work, budget: budget.budget, partial: plasticity.length < sites.length, ...(capped ? { capped: true } : {}) }
					})
				);
			}
			// One turn of the loop per slab: where a worker posts progress and a cancel lands.
			await yieldToLoop();
		}
	} catch (err) {
		// A cancel keeps what was computed; anything else is a real failure and propagates.
		if (err?.name !== 'AbortError' && !signal?.aborted) throw err;
		cancelled = true;
	}

	return dmsPayload({
		loaded,
		plasticity,
		focal,
		options,
		inputs,
		done: plasticity.length,
		total: requested,
		extra: {
			work: budget.work,
			budget: budget.budget,
			...(cancelled ? { cancelled: true, reason: 'cancelled by the caller' } : {}),
			...(capped ? { capped: true, reason: `capped at ${sites.length} of ${requested} site(s)` } : {})
		}
	});
}
