/**
 * run.svelte.ts — the live report job: start `runEverything` in the analyze worker, keep the
 * ReportRecord in reactive state as progress and sections arrive, write it to IndexedDB on the
 * way, and let the report page (which the user is looking at while it runs) subscribe by id.
 *
 * WHY THIS FILE EXISTS. PLAN.md §4.0: one action, one report, sections streaming in. The analyze
 * route starts the run and navigates to `/report/local/?id=<id>` at once; the report route then
 * needs the SAME in-flight state — not a copy — to render the skeletons filling in, cancel the
 * run, or cancel just the DMS. Both routes are in one document (client-side navigation), so a
 * module-level registry of jobs keyed by id, holding Svelte 5 `$state` records, is the simplest
 * thing that works: the analyze page calls `startReport()`, the report page calls `liveJob(id)`,
 * and whoever mounts sees the same record object change.
 *
 * PERSISTENCE CADENCE. The record is saved when created (status `running`, empty sections), on
 * every final section, on the terminal status, and — for the progressive DMS payloads, which can
 * arrive several times a second — at most once every SAVE_INTERVAL_MS, with a last save on the
 * final one. A reload mid-run therefore reopens the report with every finished section and the
 * DMS heatmap as far as its last save, and a `running` status the loader turns into
 * `interrupted` because no live job exists for it any more.
 *
 * CANCEL, TWO WAYS. `cancel()` aborts the whole request (the worker's AbortController trips at the
 * next batch boundary; everything already posted stays). `cancelDms()` is the same abort issued
 * only while the orchestrator is in the `dms` phase: DMS runs last by design (PLAN.md §4.0 row 7),
 * so aborting then loses nothing else, and the section is marked `cancelled` with the sites that
 * finished — the contract offers one AbortSignal, and this is how the report's "Cancel" on the DMS
 * bar maps onto it.
 *
 * THE TREE IS NOT PREPARED ANY MORE (D22). Phase 1 and 2 fitted branch lengths, or built a tree,
 * in a vendored WebAssembly engine before the worker was asked to run. `planTree()` is what is
 * left of that step: a pure decision about which text to hand over and what to call the source —
 * a tree WITH branch lengths is used as given, and anything else (no tree, or a tree without
 * usable lengths) is handed over as nothing at all, so the library takes pairwise TN93 distances
 * into the MDS inside `loadAlignmentAndTree` and reports it through `notices.treeFree`. The record
 * keeps the tree text it handed over, which for a tree-free run is null.
 */

import type {
	DiagnosisSnapshot,
	InputDigest,
	ReportInputs,
	ReportOptions,
	ReportPhase,
	ReportRecord,
	SectionName,
	TreeSource
} from '$lib/api';
import { REPORT_PHASES } from '$lib/api';
import { digest } from '$lib/analyze/inputs';
import { emptySections, type DmsSection, type ReportSections } from '$lib/report/types';
import { newReportId, saveReport } from '$lib/storage/reports';
import { analyzeClient } from '$lib/workers/clients';
import type { AnalyzeResponse } from '$lib/workers/protocol';

export const MAX_THREADS = 16;
export const SAVE_INTERVAL_MS = 2000;
/** How long a cancelled analyze call may take to return its record before the worker is killed. */
export const CANCEL_GRACE_MS = 120_000;

export interface LiveJob {
	id: string;
	/** Reactive: the record as it stands right now. */
	readonly record: ReportRecord;
	/** Which orchestrator the worker reported, once known. */
	orchestrator: AnalyzeResponse['orchestrator'] | null;
	/** Abort everything still running. */
	cancel(): void;
	/** Abort only if the run is in its DMS phase (a no-op otherwise). */
	cancelDms(): void;
	/** Resolves when the run has ended, however it ended. */
	readonly finished: Promise<void>;
}

const jobs = new Map<string, LiveJob>();

/** The in-flight (or just-finished, still in this document) job for a report id. */
export function liveJob(id: string): LiveJob | null {
	return jobs.get(id) ?? null;
}

/** Absolute URL for a site path, so a worker (whose location is the bundle) resolves it right. */
function absolute(base: string, path: string): string {
	return new URL(`${base}${path}`, globalThis.location?.href ?? 'http://localhost/').href;
}

export interface TreePlanRequest {
	/** The tree text the reader supplied, or null. */
	treeText: string | null;
	/** From the diagnosis: the tree is embedded in the alignment. */
	embeddedTree: boolean;
	/** From the diagnosis (`TREE_FREE_TN93`): no tree, or no usable branch lengths. */
	treeFree: boolean;
	/** The library's reason, when it gave one; kept for the status line and the strip. */
	treeFreeReason?: string | null;
}

export interface PreparedTree {
	/** The tree handed to the runtime; '' for an embedded tree AND for a tree-free run. */
	treeText: string;
	treeSource: TreeSource;
	/** Set when the run will be tree-free, for the status line. */
	treeFreeReason?: string | null;
}

/**
 * Which tree the run gets, and what to call the source. Pure and synchronous: under D22 there is
 * nothing to fit and nothing to build, so the only decision left is what to CALL the source. The
 * decision itself belongs to the library, which takes TN93 distances inside `loadAlignmentAndTree`
 * whenever the tree it is handed has no usable branch lengths.
 *
 * THE TEXT IS ALWAYS PASSED THROUGH, even when the diagnosis already says the run will be
 * tree-free. Withholding it would make the library report `no_tree` for a reader who supplied one,
 * which is a different sentence on the report's strip and a wrong one; the library keeps such a
 * tree for display and says `no_branch_lengths` instead. It never reaches the model either way:
 * in tree-free mode the distances come from the alignment and every sequence is kept, in alignment
 * order, with no matching against the tree's tips.
 */
export function planTree(req: TreePlanRequest): PreparedTree {
	const userTree = req.treeText && req.treeText.trim() ? req.treeText.trim() : null;
	if (req.treeFree) {
		return {
			treeText: userTree ?? '',
			treeSource: 'tn93',
			treeFreeReason: req.treeFreeReason ?? (userTree || req.embeddedTree ? 'no_branch_lengths' : 'no_tree')
		};
	}
	if (userTree) return { treeText: userTree, treeSource: 'user' };
	return { treeText: '', treeSource: 'embedded' };
}

export interface StartRequest {
	alignmentText: string;
	alignmentName: string;
	/** The ORIGINAL tree text as uploaded (for the digest), or null. */
	uploadedTreeText: string | null;
	treeName: string | null;
	/** From planTree(): the tree the model is given, and what to call the source. */
	tree: PreparedTree;
	options: ReportOptions;
	diagnosis: DiagnosisSnapshot | null;
	demo?: string;
	base: string;
}

/**
 * Create the record, save it, start the worker, register the job, and return its id. The caller
 * navigates to `reportPath(id)`; the job keeps running across that navigation.
 */
export async function startReport(req: StartRequest): Promise<string> {
	const id = newReportId();
	const createdAt = Date.now();
	const [alignmentDigest, treeDigest] = await Promise.all([
		digest(req.alignmentName, req.alignmentText),
		req.uploadedTreeText ? digest(req.treeName ?? 'tree.nwk', req.uploadedTreeText) : Promise.resolve<InputDigest | null>(null)
	]);
	const inputs: ReportInputs = {
		alignment: alignmentDigest,
		tree: treeDigest,
		treeSource: req.tree.treeSource,
		alignmentName: req.alignmentName,
		treeName: req.treeName,
		...(req.demo ? { demo: req.demo } : {}),
		alignmentText: req.alignmentText,
		treeText: req.tree.treeText || null
	};
	const record = $state<ReportRecord>({
		schema_version: 2,
		kind: 'report',
		id,
		createdAt,
		createdAtIso: new Date(createdAt).toISOString(),
		name: req.demo ?? req.alignmentName,
		inputs,
		options: req.options,
		diagnostics: req.diagnosis,
		sections: emptySections(),
		provenance: null,
		timings: {},
		status: { state: 'running', phase: 'parse', done: 0, total: 1, message: 'Starting...', completed: [] }
	});
	await persist(record);

	const controller = new AbortController();
	let orchestrator: AnalyzeResponse['orchestrator'] | null = null;
	let lastSave = performance.now();
	let saveTimer: ReturnType<typeof setTimeout> | null = null;
	const t0 = performance.now();
	const hardwareConcurrency = typeof navigator !== 'undefined' ? (navigator.hardwareConcurrency ?? null) : null;

	const scheduleSave = (force: boolean) => {
		if (force) {
			if (saveTimer) clearTimeout(saveTimer);
			saveTimer = null;
			lastSave = performance.now();
			void persist(record);
			return;
		}
		if (saveTimer) return;
		const wait = Math.max(0, SAVE_INTERVAL_MS - (performance.now() - lastSave));
		saveTimer = setTimeout(() => {
			saveTimer = null;
			lastSave = performance.now();
			void persist(record);
		}, wait);
	};

	const finished = analyzeClient()
		.call<AnalyzeResponse>(
			{
				kind: 'analyze',
				alignmentText: req.alignmentText,
				treeText: req.tree.treeText,
				treeSource: req.tree.treeSource,
				inputs: { alignmentName: req.alignmentName, treeName: req.treeName, ...(req.demo ? { demo: req.demo } : {}) },
				options: req.options,
				manifestUrl: absolute(req.base, '/models/manifest.json'),
				modelsBase: absolute(req.base, '/models/'),
				ortBase: absolute(req.base, '/ort/'),
				tn93Base: absolute(req.base, '/tn93/'),
				numThreads: Math.max(1, Math.min(MAX_THREADS, hardwareConcurrency ?? 1))
			},
			{
				signal: controller.signal,
				terminateAfterMs: CANCEL_GRACE_MS,
				onProgress: (phase, done, total, message) => {
					const known = (REPORT_PHASES as readonly string[]).includes(phase) ? (phase as ReportPhase) : record.status.phase;
					record.status = { ...record.status, phase: known, done, total, message };
				},
				onSection: (name, payload, final) => {
					applySection(record, name as SectionName, payload, final);
					scheduleSave(final);
				}
			}
		)
		.then((response) => {
			orchestrator = response.orchestrator;
			mergeResponse(record, response, hardwareConcurrency, performance.now() - t0);
			record.status = { ...record.status, state: 'done', phase: 'postprocess', done: 1, total: 1, message: 'Done' };
		})
		.catch((err: unknown) => {
			const aborted = err instanceof Error && err.name === 'AbortError';
			if (aborted) {
				// A cancel during the DMS phase keeps everything else: the section is marked as such.
				if (record.status.phase === 'dms' && record.sections.dms) {
					record.sections.dms = { ...record.sections.dms, cancelled: true };
					if (!record.status.completed.includes('dms')) record.status.completed = [...record.status.completed, 'dms'];
					record.status = { ...record.status, state: 'done', message: 'Digital DMS cancelled; every other section finished.' };
				} else {
					record.status = { ...record.status, state: 'cancelled', message: 'Run cancelled.' };
				}
			} else {
				record.status = {
					...record.status,
					state: 'failed',
					message: 'Run failed.',
					error: err instanceof Error ? err.message : String(err)
				};
			}
		})
		.finally(() => {
			scheduleSave(true);
		});

	const job: LiveJob = {
		id,
		get record() {
			return record;
		},
		get orchestrator() {
			return orchestrator;
		},
		set orchestrator(v) {
			orchestrator = v;
		},
		cancel: () => controller.abort(),
		cancelDms: () => {
			if (record.status.phase === 'dms' && record.status.state === 'running') controller.abort();
		},
		finished
	};
	jobs.set(id, job);
	return id;
}

async function persist(record: ReportRecord): Promise<void> {
	try {
		// A $state proxy cannot be structured-cloned into IndexedDB; store the plain snapshot.
		await saveReport($state.snapshot(record) as ReportRecord);
	} catch (err) {
		// Storage failing must not stop the run; the page still shows the live record.
		console.warn('report not saved:', err);
	}
}

/** Put one section payload on the record and, when final, mark it completed. */
export function applySection(record: ReportRecord, name: SectionName, payload: unknown, final: boolean): void {
	if (!(name in record.sections)) return;
	if (name === 'dms' && payload && typeof payload === 'object') {
		const dms = payload as DmsSection;
		if (!dms.progress) {
			dms.progress = { done: dms.sites_swept ?? dms.plasticity?.length ?? 0, total: dms.sites_requested ?? dms.plasticity?.length ?? 0 };
		}
	}
	(record.sections as unknown as Record<string, unknown>)[name] = payload as ReportSections[typeof name];
	if (final && !record.status.completed.includes(name)) record.status.completed = [...record.status.completed, name];
}

function mergeResponse(record: ReportRecord, response: AnalyzeResponse, hardwareConcurrency: number | null, wallMs: number): void {
	const r = response.record;
	if (r.sections && typeof r.sections === 'object') {
		for (const [name, payload] of Object.entries(r.sections)) {
			if (!(name in record.sections)) continue;
			// A section the worker posted progressively is authoritative if the final record lacks it.
			if (payload == null) continue;
			applySection(record, name as SectionName, payload, true);
		}
	}
	if (r.provenance) record.provenance = r.provenance;
	if (r.timings && typeof r.timings === 'object') record.timings = { ...record.timings, ...(r.timings as ReportRecord['timings']) };
	record.runtime = {
		numThreads: response.numThreads,
		crossOriginIsolated: response.crossOriginIsolated,
		hardwareConcurrency,
		wallMs: Math.round(wallMs)
	};
}
