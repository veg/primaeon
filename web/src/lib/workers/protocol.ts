/**
 * protocol.ts — the messages the three analysis workers speak, and the request/response shapes
 * of each.
 *
 * WHY THIS FILE EXISTS. PLAN.md §4.2 puts preprocessing, tree estimation and inference in Web
 * Workers so the page never blocks (DM3's AxomemeAnalysisRunner ran the ~0.6–2 s MDS on the main
 * thread and its header names a worker as "the first thing to do if this feels slow"). Workers
 * talk in `postMessage`, which is untyped; this file is the type on both ends. One envelope for
 * every worker: a request carries an `id`; the worker answers with any number of `progress`
 * events and exactly one `result` or `error` for that id; a `cancel` names the id to abort.
 *
 * Errors cross the boundary as `{name, message, stack}` because a thrown Error does not survive
 * structured cloning with its prototype; `WorkerClient` rebuilds an Error with the same name so
 * `AbortError` stays distinguishable from a failure.
 *
 * THE THREE WORKERS AND WHY THEY ARE THREE.
 *   prep    `diagnose()` and the prescreen on every input change (debounced). Cheap, frequent,
 *           must not wait behind a run: its own worker.
 *   tree    HyPhy WASM (HKY85 branch lengths, NJ). A 6.4 MB Emscripten module with its own heap
 *           and file system; lazy, and kept out of the inference worker so ORT's memory and
 *           HyPhy's never share one WASM heap.
 *   infer   the whole `runMeme` — session load, prepare, inference, post-processing — in ONE
 *           worker, with the ORT session created there. This is the simpler of the two designs
 *           the plan allowed (per-phase workers behind an adapter, or one worker running the
 *           runtime's orchestration): an ORT session cannot cross `postMessage`, the prepared
 *           tensors (L·N tokens, N² distances) would have to be copied between phase workers,
 *           and the runtime's `runMeme` already yields between batches for progress and cancel.
 *           The main thread is free throughout; ORT spawns its own thread pool from the worker.
 */

import type { CallMode, DiagnosisSnapshot, MemeRecord, RunOptions, TreeSource } from '$lib/api';
import type { PrescreenResult } from '$lib/diagnostics/panel';

// ---- envelope ---------------------------------------------------------------------------------

export interface RequestMessage<T> {
	id: number;
	kind: 'request';
	payload: T;
}

export interface CancelMessage {
	id: number;
	kind: 'cancel';
}

export interface ProgressMessage {
	id: number;
	kind: 'progress';
	phase: string;
	done: number;
	total: number;
	message: string;
}

export interface ResultMessage<T> {
	id: number;
	kind: 'result';
	payload: T;
}

export interface ErrorMessage {
	id: number;
	kind: 'error';
	name: string;
	message: string;
	stack?: string;
}

export type ToWorker<T> = RequestMessage<T> | CancelMessage;
export type FromWorker<T> = ProgressMessage | ResultMessage<T> | ErrorMessage;

// ---- prep worker ------------------------------------------------------------------------------

export interface PrepRequest {
	alignmentText: string;
	/** Null when no tree was supplied (the worker then looks for an embedded one). */
	treeText: string | null;
	/** The taxon cap the run will use, so the diagnosis matches what the model is given. */
	maxSpecies: number;
	/** For the prescreen's optimism caveat: 'user' | 'nj' | 'unknown'. */
	treeSource: string;
	/** Whether to run the XGBoost prescreen (skipped while the tree is being estimated). */
	prescreen: boolean;
}

export interface PrepResponse {
	diagnosis: DiagnosisSnapshot;
	/** Sequence names in file order, from the library's parser (the reference dropdown). */
	names: string[];
	prescreen: PrescreenResult | null;
	/** Milliseconds the diagnosis took in the worker. */
	elapsedMs: number;
}

// ---- tree worker ------------------------------------------------------------------------------

export interface TreeRequest {
	alignmentText: string;
	/** A topology-only tree to fit branch lengths on, or null to infer an NJ tree. */
	treeText: string | null;
	/** Absolute URL prefix where hyphy.js / hyphy.wasm / hyphy.data are served. */
	hyphyBase: string;
}

export interface TreeResponse {
	treeText: string;
	treeSource: Extract<TreeSource, 'hyphy-hky85' | 'nj'>;
	elapsedMs: number;
	/** Free-form notes from the tool (log-likelihood, taxa renamed, ...). */
	notes: string[];
}

// ---- inference worker -------------------------------------------------------------------------

export interface InferRequest {
	alignmentText: string;
	/** Newick WITH branch lengths; the runtime refuses anything else. */
	treeText: string;
	treeSource: TreeSource;
	options: RunOptions;
	/** Absolute URL of `models/manifest.json` and the directory the graphs are served from. */
	manifestUrl: string;
	modelsBase: string;
	/** Absolute URL prefix of the vendored ORT WASM (`.../ort/`). */
	ortBase: string;
	/** Threads to ask ORT for; honoured only when the worker is cross-origin isolated. */
	numThreads: number;
	/** Display name for the record (file name or demo id). */
	name: string;
}

export interface InferResponse {
	result: MemeRecord;
	numThreads: number;
	crossOriginIsolated: boolean;
	/** Phase timings the worker measured, keyed by the runtime's phase names. */
	phaseMs: Record<string, number>;
	firstLoad: boolean;
}

/** Call modes the runtime accepts, re-stated here so the worker validates before the runtime throws. */
export const CALL_MODES: readonly CallMode[] = ['percentile', 'zscore', 'pvalue'];
