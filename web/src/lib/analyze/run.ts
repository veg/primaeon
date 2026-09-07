/**
 * run.ts — one browser run, start to stored record: tree estimation when needed, then the
 * inference worker, then IndexedDB.
 *
 * WHY THIS FILE EXISTS. The /analyze page needs a single `runAnalysis()` it can await, cancel,
 * and watch through a six-step checklist (PLAN.md §4.2: "a step checklist like axomeme3's, each
 * step marked with its measured time"). The steps are axomeme3's six (index.html:1146-1151 of
 * the checkout beside this repository), renamed for this pipeline:
 *
 *   parse           Decompressing and parsing the alignment
 *   tree            Parsing and matching the tree
 *   distances       The tree's patristic distances, or tree-free TN93 distances (D22)
 *   prepare         MDS embedding
 *   infer           Neural network inference (model download on the first run)
 *   postprocess     p-values, q-values, tier calls (and --filter / --attribute when asked)
 *
 * The runtime's `runMeme` reports phases `parse`, `prepare`, `infer`, `stats`, `filter`,
 * `attribute`, `postprocess` (runtime/src/pipeline.js PHASES) and the inference worker adds
 * `load` for the session; PHASE_STEP maps each onto a checklist step, so a runtime phase that
 * appears later (busted's `head`, say) lands on the last step instead of being lost.
 *
 * NO TREE IS ESTIMATED HERE ANY MORE (D22). Phase 1 fitted branch lengths, or built a tree, in a
 * second WebAssembly engine in its own worker before inference, and the third checklist step was
 * that wait. A tree with branch lengths is now used as given and anything else is handed over as
 * nothing at all, so the library takes pairwise TN93 distances into the MDS inside
 * `loadAlignmentAndTree` — the reference's own `--use-tn93` path — and reports which it did
 * through `notices.treeFree`. The `distances` step is what that wait became: it is marked done as
 * soon as the tree decision is made, and the work itself happens in the inference worker.
 *
 * THIS FILE IS PHASE 1's SINGLE-ANALYSIS PATH. The product runs everything through
 * lib/report/run.svelte.ts (`startReport`) and the analyze worker; `runAnalysis` remains as the
 * `runMeme`-only route and its stored v1 `ResultRecord`, which lib/storage/reports.ts still reads.
 *
 * THREADS. `navigator.hardwareConcurrency` is requested (PLAN.md D13); the runtime honours it
 * only under cross-origin isolation and reports what it used. The request is capped at
 * MAX_THREADS because ORT's WASM pool spawns one worker per thread and a 64-core machine gains
 * nothing past the memory bandwidth of a 7.8 MB graph.
 */

import type { DiagnosisSnapshot, ResultRecord, RunInputs, RunOptions, StepId, StepRecord, TreeSource } from '$lib/api';
import { digest } from './inputs';
import { inferClient } from '$lib/workers/clients';
import { newRunId, saveResult } from '$lib/storage/results';

export const MAX_THREADS = 16;

export const STEP_LABELS: Record<StepId, string> = {
	parse: 'Decompressing and parsing the alignment',
	tree: 'Parsing and matching the tree',
	distances: 'Tree distances, or tree-free TN93 distances',
	prepare: 'Patristic distances and MDS embedding',
	infer: 'Neural network inference',
	postprocess: 'p-values, q-values and tier calls'
};

export const STEP_ORDER: readonly StepId[] = ['parse', 'tree', 'distances', 'prepare', 'infer', 'postprocess'];

/** Runtime / worker phase -> checklist step. Unknown phases land on the last step. */
const PHASE_STEP: Record<string, StepId> = {
	parse: 'parse',
	prepare: 'prepare',
	load: 'infer',
	infer: 'infer',
	stats: 'postprocess',
	filter: 'postprocess',
	attribute: 'postprocess',
	postprocess: 'postprocess'
};

export function freshSteps(): StepRecord[] {
	return STEP_ORDER.map((id) => ({ id, label: STEP_LABELS[id], status: 'pending', message: null, elapsedMs: null }));
}

export interface RunRequest {
	alignmentText: string;
	alignmentName: string;
	treeText: string | null;
	treeName: string | null;
	/** From the diagnosis: the tree is embedded in the alignment (no upload needed). */
	embeddedTree: boolean;
	/** From the diagnosis (`TREE_FREE_TN93`): no tree, or no usable branch lengths (D22). */
	treeFree: boolean;
	options: RunOptions;
	diagnosis: DiagnosisSnapshot | null;
	demo?: string;
	/** `$app/paths` base, for the asset URLs. */
	base: string;
	signal?: AbortSignal;
	onSteps?: (steps: StepRecord[]) => void;
}

/** Absolute URL for a site path, so a worker (whose location is the bundle) resolves it right. */
function absolute(base: string, path: string): string {
	return new URL(`${base}${path}`, globalThis.location?.href ?? 'http://localhost/').href;
}

class Checklist {
	steps = freshSteps();
	private started = new Map<StepId, number>();
	constructor(private readonly emit?: (steps: StepRecord[]) => void) {}

	private find(id: StepId): StepRecord {
		return this.steps.find((s) => s.id === id)!;
	}

	private publish(): void {
		this.steps = this.steps.map((s) => ({ ...s }));
		this.emit?.(this.steps);
	}

	start(id: StepId, message: string | null = null): void {
		const s = this.find(id);
		if (s.status === 'done') return;
		if (s.status !== 'active') {
			s.status = 'active';
			this.started.set(id, performance.now());
		}
		if (message !== null) s.message = message;
		this.publish();
	}

	progress(id: StepId, message: string, done?: number, total?: number): void {
		const s = this.find(id);
		if (s.status !== 'active') this.start(id);
		s.message = message;
		if (done !== undefined && total !== undefined && total > 0) {
			s.done = done;
			s.total = total;
		}
		this.publish();
	}

	finish(id: StepId, message: string | null = null): void {
		const s = this.find(id);
		if (s.status === 'done') return;
		const t = this.started.get(id);
		s.status = 'done';
		s.elapsedMs = t !== undefined ? Math.round(performance.now() - t) : 0;
		if (message !== null) s.message = message;
		this.publish();
	}

	skip(id: StepId, message: string): void {
		const s = this.find(id);
		s.status = 'skipped';
		s.message = message;
		s.elapsedMs = 0;
		this.publish();
	}

	fail(message: string): void {
		const active = this.steps.find((s) => s.status === 'active');
		if (active) {
			const t = this.started.get(active.id);
			active.status = 'failed';
			active.message = message;
			active.elapsedMs = t !== undefined ? Math.round(performance.now() - t) : null;
		}
		this.publish();
	}

	/** Finish every step before `id` that is still open: the runtime moved past them. */
	closeBefore(id: StepId): void {
		const idx = STEP_ORDER.indexOf(id);
		for (const s of this.steps.slice(0, idx)) if (s.status === 'active') this.finish(s.id);
	}
}

/** Run everything and store the record. Rejects with an `AbortError` on cancel. */
export async function runAnalysis(req: RunRequest): Promise<ResultRecord> {
	const t0 = performance.now();
	const list = new Checklist(req.onSteps);
	const throwIfAborted = () => {
		if (req.signal?.aborted) {
			const err = new Error('Cancelled');
			err.name = 'AbortError';
			throw err;
		}
	};

	try {
		// --- parse: hash the inputs (the library parses again inside the worker) --------------
		list.start('parse', 'Hashing inputs...');
		const userTree = req.treeText && req.treeText.trim() ? req.treeText : null;
		const [alignmentDigest, treeDigest] = await Promise.all([
			digest(req.alignmentName, req.alignmentText),
			userTree ? digest(req.treeName ?? 'tree.nwk', userTree) : Promise.resolve(null)
		]);
		list.finish('parse', `${(alignmentDigest.size / 1024).toFixed(0)} KB, sha256 ${alignmentDigest.sha256?.slice(0, 12) ?? 'n/a'}…`);
		throwIfAborted();

		// --- tree: decide the source (D22: used as given, or tree-free) ----------------------------
		list.start('tree');
		let treeSource: TreeSource;
		let treeForRun: string | null;
		if (req.treeFree) {
			treeSource = 'tn93';
			treeForRun = null;
			list.finish('tree', userTree || req.embeddedTree ? 'The tree has no usable branch lengths: running tree-free' : 'No tree supplied: running tree-free');
		} else if (userTree) {
			treeSource = 'user';
			treeForRun = userTree;
			list.finish('tree', 'Using the uploaded tree');
		} else {
			treeSource = 'embedded';
			treeForRun = null;
			list.finish('tree', 'Using the tree embedded in the alignment');
		}
		throwIfAborted();

		list.start('distances');
		list.finish(
			'distances',
			treeSource === 'tn93'
				? 'Pairwise TN93 distances feed the MDS (the reference\u2019s --use-tn93 path)'
				: 'Patristic distances from the tree\u2019s branch lengths'
		);
		throwIfAborted();

		// --- prepare + infer + postprocess: the inference worker ---------------------------------
		const hardwareConcurrency = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency ?? null : null;
		const requestedThreads = Math.max(1, Math.min(MAX_THREADS, hardwareConcurrency ?? 1));
		list.start('prepare', 'Starting the inference worker...');
		const response = await inferClient().call(
			{
				alignmentText: req.alignmentText,
				treeText: treeForRun ?? '',
				treeSource,
				options: req.options,
				manifestUrl: absolute(req.base, '/models/manifest.json'),
				modelsBase: absolute(req.base, '/models/'),
				ortBase: absolute(req.base, '/ort/'),
				tn93Base: absolute(req.base, '/tn93/'),
				numThreads: requestedThreads,
				name: req.demo ?? req.alignmentName
			},
			{
				signal: req.signal,
				onProgress: (phase, done, total, message) => {
					// A step stays open until the runtime reports the NEXT step's phase, so its elapsed
					// time covers the whole phase including its closing report.
					const step = PHASE_STEP[phase] ?? 'postprocess';
					list.closeBefore(step);
					list.progress(step, message, done, total);
				}
			}
		);
		list.closeBefore('postprocess');
		list.finish('postprocess', 'Done');

		// --- persist -------------------------------------------------------------------------------
		const id = newRunId();
		const createdAt = Date.now();
		const inputs: RunInputs = {
			alignment: alignmentDigest,
			tree: treeDigest,
			treeSource,
			...(req.demo ? { demo: req.demo } : {})
		};
		const record: ResultRecord = {
			id,
			createdAt,
			createdAtIso: new Date(createdAt).toISOString(),
			created_at: new Date(createdAt).toISOString(),
			name: req.demo ?? req.alignmentName,
			method: 'meme',
			inputs,
			options: req.options,
			steps: list.steps.map((s) => ({ ...s })),
			diagnostics: req.diagnosis,
			runtime: {
				numThreads: response.numThreads,
				crossOriginIsolated: response.crossOriginIsolated,
				hardwareConcurrency,
				wallMs: Math.round(performance.now() - t0)
			},
			result: { ...response.result, id }
		};
		await saveResult(record);
		return record;
	} catch (err) {
		list.fail(err instanceof Error ? err.message : String(err));
		throw err;
	}
}
