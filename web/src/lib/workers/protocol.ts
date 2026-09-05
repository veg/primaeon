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
 * THE `section` MESSAGE (Phase 2). The analyze worker hosts the whole `runEverything`
 * orchestrator and the page renders each section as it finishes, so the envelope gains a third
 * event kind between `progress` and `result`: `section` carries one section's payload and whether
 * it is that section's final version (DMS posts many non-final ones as the heatmap fills). Like
 * `progress`, it is tied to a request id and dropped for an unknown id.
 *
 * THE PHENOTYPE REQUEST (Phase 3). The trait is the reader's, so the pillar cannot run with the
 * rest; it is a SECOND request kind on the analyze worker rather than a worker of its own, because
 * it needs the warm ORT session that worker already holds and it reads the same prepared tensors
 * (`kind` discriminates; see analyze.worker.ts).
 *
 * THE WORKERS AND WHY THEY ARE SEPARATE.
 *   prep    `diagnose()` and the prescreen on every input change (debounced). Cheap, frequent,
 *           must not wait behind a run: its own worker.
 *   analyze the whole `runEverything` (every pillar, PLAN.md §4.0) in ONE worker, Phase 2's
 *           successor to `infer`, plus the on-demand phenotype run; see analyze.worker.ts for why
 *           one worker and not one per phase. Phase 1's third worker fitted branch lengths in a
 *           vendored WebAssembly engine; D22 replaced it with the library's tree-free TN93 path,
 *           so there is no tree worker any more and no second WASM heap to keep apart from ORT's.
 *   infer   the whole `runMeme` — session load, prepare, inference, post-processing — in ONE
 *           worker, with the ORT session created there. This is the simpler of the two designs
 *           the plan allowed (per-phase workers behind an adapter, or one worker running the
 *           runtime's orchestration): an ORT session cannot cross `postMessage`, the prepared
 *           tensors (L·N tokens, N² distances) would have to be copied between phase workers,
 *           and the runtime's `runMeme` already yields between batches for progress and cancel.
 *           The main thread is free throughout; ORT spawns its own thread pool from the worker.
 */

import type {
	CallMode,
	DiagnosisSnapshot,
	MemeRecord,
	PhenotypeRunOptions,
	ReportOptions,
	ReportRecord,
	RunOptions,
	TraitSpec,
	TreeSource
} from '$lib/api';
import type { PhenotypeSection } from '$lib/report/types';
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

export interface SectionMessage {
	id: number;
	kind: 'section';
	name: string;
	payload: unknown;
	final: boolean;
}

export type ToWorker<T> = RequestMessage<T> | CancelMessage;
export type FromWorker<T> = ProgressMessage | SectionMessage | ResultMessage<T> | ErrorMessage;

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

// ---- inference worker -------------------------------------------------------------------------

export interface InferRequest {
	alignmentText: string;
	/** Newick WITH branch lengths, or '' for the tree-free TN93 path (D22). */
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

// ---- analyze worker (Phase 2: runEverything) -------------------------------------------------

export interface AnalyzeRequest {
	/** Discriminates this request from a phenotype one on the same worker; optional for brevity. */
	kind?: 'analyze';
	alignmentText: string;
	/**
	 * The tree AS SUPPLIED: a Newick with branch lengths, or '' for an embedded tree or for the
	 * tree-free TN93 path. Nothing is fitted on the way in any more (D22): the library decides,
	 * inside `loadAlignmentAndTree`, whether the tree is usable and otherwise takes TN93 distances,
	 * and reports which through `notices.treeFree`.
	 */
	treeText: string;
	treeSource: TreeSource;
	inputs: { alignmentName: string; treeName: string | null; demo?: string };
	options: ReportOptions;
	manifestUrl: string;
	modelsBase: string;
	ortBase: string;
	numThreads: number;
}

export interface AnalyzeResponse {
	/** The orchestrator's ReportRecord (contract: schema_version 2, kind 'report'); sections also arrived as `section` events. */
	record: Pick<ReportRecord, 'sections' | 'provenance' | 'timings'> & Record<string, unknown>;
	numThreads: number;
	crossOriginIsolated: boolean;
	firstLoad: boolean;
	/** What produced the record: the runtime's `runEverything`. ('bridge' named the interim runMeme+runBusted composition removed at Phase 2b integration.) */
	orchestrator: 'runtime';
}

// ---- phenotype request (Phase 3: the analyze worker's second kind) ----------------------------

/**
 * One `hyphaeon phenotype` run on a report that already exists. The alignment and tree are the
 * ones the report was run on, so the site indices of the result line up with the Sites section;
 * lib/report/phenotype.svelte.ts says where those texts come from for each report source.
 */
export interface PhenotypeRequest {
	kind: 'phenotype';
	alignmentText: string;
	/** The tree the report used, or '' when the report ran tree-free (permulations then cannot run). */
	treeText: string;
	treeSource: TreeSource;
	/** The trait, exactly as the reader described it (api.ts TraitSpec). */
	trait: TraitSpec;
	/** The report's options, so the same taxa are selected and the same graph is loaded. */
	options: ReportOptions;
	/** The pillar's own knobs (permulations B, seed, alpha, minimum taxa per site). */
	phenotypeOptions: PhenotypeRunOptions;
	/** Names for the record's `alignment` / `tree` fields, as the CLI writes them. */
	inputs?: { alignmentName: string | null; treeName: string | null };
	manifestUrl: string;
	modelsBase: string;
	ortBase: string;
	numThreads: number;
}

export interface PhenotypeResponse {
	/** `hyphaeon phenotype`'s document plus the runtime's app-side fields. */
	record: PhenotypeSection;
	numThreads: number;
	crossOriginIsolated: boolean;
	firstLoad: boolean;
	elapsedMs: number;
}

/** Everything the analyze worker accepts, and everything it answers. */
export type AnalyzeWorkerRequest = AnalyzeRequest | PhenotypeRequest;
export type AnalyzeWorkerResponse = AnalyzeResponse | PhenotypeResponse;

/** Narrow a request on the wire (the worker's only dispatch). */
export function isPhenotypeRequest(req: AnalyzeWorkerRequest): req is PhenotypeRequest {
	return (req as PhenotypeRequest).kind === 'phenotype';
}
