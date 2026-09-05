/**
 * load.ts — where the report page gets its record from: the live job in this document, IndexedDB,
 * a prebaked gallery file, or a server job.
 *
 * WHY THIS FILE EXISTS. PLAN.md §4.1 gives one route to every source: `/report/local/?id=<id>` for
 * a browser run (a live job if the run is still going in this document, else the store),
 * `/report/gallery/<name>/` for a prebaked example, and a `job:<id>` id for a run the Node server
 * did because the input exceeded the browser caps (§3.5: `GET /api/v1/jobs/{id}`, `/events` for
 * SSE progress, `/result` for the record). The page should not know which; `loadReport(id)` says
 * where the record came from so the page can label it and decide whether it is live.
 *
 * SHAPES ACCEPTED. A gallery file or a server result is a `ReportRecord` (kind 'report') when the
 * landing-gallery agent or the server produced one, or — for the Phase 1 gallery files still on
 * disk and for a bare `hyphaeon meme` document — a site-selection record, which `wrapMeme()`
 * turns into a report whose only section is `sites` (the same wrapper the store applies to v1
 * runs, so both legacy shapes read alike). A record found in the store with status `running` but
 * no live job is a run interrupted by a reload; its status becomes `interrupted` here (an app-side
 * state the page explains) rather than pretending it is still going.
 */

import { base } from '$app/paths';
import type { ReportRecord, ReportStatus } from '$lib/api';
import { normaliseRecord, type RawRecord } from '$lib/results/load';
import { emptySections } from '$lib/report/types';
import { legacyOptions, getReport, isAvailable as storageAvailable } from '$lib/storage/reports';
import { liveJob, type LiveJob } from './run.svelte';

export type { LiveJob };

export const GALLERY_PREFIX = 'gallery/';
export const JOB_PREFIX = 'job:';
/** The server's API root, relative to `base`; the same origin serves the site and the API. */
export const API_ROOT = '/api/v1';

export type ReportSource = 'live' | 'local' | 'gallery' | 'job';

/** `ReportStatus.state` plus the one app-side state the loader adds. */
export type LoadedState = ReportStatus['state'] | 'interrupted';

export interface LoadedReport {
	record: ReportRecord;
	source: ReportSource;
	/** Set when the run is still going in this document. */
	job: LiveJob | null;
	state: LoadedState;
}

export class ReportNotFound extends Error {
	constructor(
		message: string,
		public readonly source: ReportSource | 'none'
	) {
		super(message);
		this.name = 'ReportNotFound';
	}
}

export async function loadReport(id: string, fetchImpl: typeof fetch = fetch): Promise<LoadedReport> {
	if (id.startsWith(GALLERY_PREFIX)) {
		const name = id.slice(GALLERY_PREFIX.length).replace(/\/+$/, '');
		const response = await fetchImpl(`${base}/gallery/${encodeURIComponent(name)}.json`);
		if (!response.ok) throw new ReportNotFound(`No bundled example named "${name}".`, 'gallery');
		const raw = (await response.json()) as Record<string, unknown>;
		const record = coerceReport(raw, `gallery/${name}`, name);
		return { record, source: 'gallery', job: null, state: record.status.state };
	}
	if (id.startsWith(JOB_PREFIX)) {
		const jobId = id.slice(JOB_PREFIX.length);
		const record = await loadJobResult(jobId, fetchImpl);
		return { record, source: 'job', job: null, state: record.status.state };
	}
	const job = liveJob(id);
	if (job) return { record: job.record, source: 'live', job, state: job.record.status.state };
	if (!storageAvailable()) {
		throw new ReportNotFound('Local reports are not available: this browser has no IndexedDB.', 'none');
	}
	const stored = await getReport(id);
	if (!stored) throw new ReportNotFound(`No stored report with id "${id}" in this browser.`, 'local');
	const state: LoadedState = stored.status.state === 'running' ? 'interrupted' : stored.status.state;
	return { record: stored, source: 'local', job: null, state };
}

/** A ReportRecord as is, or a site-selection document wrapped as one. */
export function coerceReport(raw: Record<string, unknown>, id: string, name: string): ReportRecord {
	if (raw.kind === 'report' && raw.schema_version === 2 && raw.sections) {
		const r = raw as unknown as ReportRecord;
		return { ...r, id: r.id ?? id, name: r.name ?? name, status: r.status ?? doneStatus(r) };
	}
	return wrapMeme(raw as RawRecord, id, name);
}

function doneStatus(r: ReportRecord): ReportStatus {
	const completed = (Object.keys(r.sections) as Array<keyof typeof r.sections>).filter((k) => r.sections[k] != null);
	return { state: 'done', phase: null, done: 1, total: 1, message: null, completed };
}

/** A Phase 1 gallery file or a bare `hyphaeon meme` document as a report with a `sites` section only. */
export function wrapMeme(raw: RawRecord, id: string, name: string): ReportRecord {
	const inner = (raw.result ?? raw) as RawRecord;
	const sites = normaliseRecord(inner, { id, name: (raw.name as string | undefined) ?? inner.name ?? name });
	const sections = emptySections();
	sections.sites = sites;
	if (sites.attributions && Object.keys(sites.attributions).length) {
		sections.attribution = { attributions: sites.attributions, attribution_enabled: true };
	}
	if (sites.filter) {
		sections.filter = { artifacts_masked: sites.filter.artifacts_masked ?? [], filter_enabled: sites.filter.enabled };
	}
	const createdRaw = raw.createdAt ?? raw.created_at ?? inner.created_at;
	const createdAt = typeof createdRaw === 'number' ? createdRaw : createdRaw ? Date.parse(String(createdRaw)) : 0;
	const options = (raw.options as Record<string, unknown> | undefined) ?? {};
	const pre = sites.provenance.preprocessing;
	const completed: ReportRecord['status']['completed'] = ['sites'];
	if (sections.attribution) completed.push('attribution');
	if (sections.filter) completed.push('filter');
	const inputs = (raw.inputs as Record<string, unknown> | undefined) ?? {};
	const alignmentDigest = (inputs.alignment as ReportRecord['inputs']['alignment'] | undefined) ?? {
		name: (sites.cli?.alignment as string | undefined) ?? `${name}.fasta`,
		size: 0,
		sha256: null
	};
	return {
		schema_version: 2,
		kind: 'report',
		id,
		createdAt: Number.isFinite(createdAt) ? createdAt : 0,
		createdAtIso: Number.isFinite(createdAt) && createdAt > 0 ? new Date(createdAt).toISOString() : '',
		name: sites.name ?? name,
		inputs: {
			alignment: alignmentDigest,
			tree: (inputs.tree as ReportRecord['inputs']['tree'] | undefined) ?? null,
			treeSource: (inputs.treeSource as ReportRecord['inputs']['treeSource'] | undefined) ?? (pre.tree_source as ReportRecord['inputs']['treeSource']),
			alignmentName: alignmentDigest.name,
			treeName: (inputs.tree as { name?: string } | undefined)?.name ?? null,
			...(typeof inputs.demo === 'string' ? { demo: inputs.demo } : {})
		},
		options: legacyOptions({
			variant: (options.variant as 'general' | 'viral' | undefined) ?? ((sites.provenance.model_variant as 'general' | 'viral' | null) ?? 'general'),
			maxSpecies: (options.maxSpecies as number | undefined) ?? pre.taxon_cap ?? pre.taxa_used,
			referenceSequence: (options.referenceSequence as string | null | undefined) ?? pre.reference_sequence ?? null,
			callMode: (options.callMode as 'percentile' | 'zscore' | 'pvalue' | undefined) ?? 'percentile',
			filter: Boolean(sites.filter?.enabled),
			attribute: Boolean(sections.attribution)
		}),
		diagnostics: (raw.diagnostics as ReportRecord['diagnostics']) ?? null,
		sections,
		provenance: sites.provenance,
		timings: sites.provenance.elapsed_sec != null ? { infer: sites.provenance.elapsed_sec } : {},
		status: { state: 'done', phase: null, done: 1, total: 1, message: 'Site selection only (Phase 1 record)', completed },
		runtime: raw.runtime as ReportRecord['runtime']
	};
}

// ---- server jobs (PLAN.md §3.5) ---------------------------------------------------------------

export interface JobStatus {
	id: string;
	status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | string;
	progress?: { phase: string; done: number; total: number; message: string } | null;
	warnings?: unknown[];
	error?: string | null;
	expires_at?: string | null;
	[extra: string]: unknown;
}

export async function fetchJobStatus(jobId: string, fetchImpl: typeof fetch = fetch): Promise<JobStatus> {
	const response = await fetchImpl(`${base}${API_ROOT}/jobs/${encodeURIComponent(jobId)}`);
	if (response.status === 404) throw new ReportNotFound(`No server job "${jobId}" (it may have expired).`, 'job');
	if (!response.ok) throw new Error(`Job status failed: HTTP ${response.status}`);
	return (await response.json()) as JobStatus;
}

/** The job's result as a ReportRecord; a non-report result is wrapped as a `sites`-only report. */
export async function loadJobResult(jobId: string, fetchImpl: typeof fetch = fetch): Promise<ReportRecord> {
	const status = await fetchJobStatus(jobId, fetchImpl);
	if (status.status !== 'done') {
		// Not finished: a placeholder record whose status mirrors the server's; the page subscribes to SSE.
		return {
			schema_version: 2,
			kind: 'report',
			id: `${JOB_PREFIX}${jobId}`,
			createdAt: Date.now(),
			createdAtIso: new Date().toISOString(),
			name: `Server job ${jobId.slice(0, 8)}`,
			inputs: { alignment: { name: 'alignment', size: 0, sha256: null }, tree: null, treeSource: 'user', alignmentName: 'alignment', treeName: null },
			options: legacyOptions({ variant: 'general', maxSpecies: 512, referenceSequence: null, callMode: 'percentile', filter: false, attribute: false }),
			diagnostics: null,
			sections: emptySections(),
			provenance: null,
			timings: {},
			status: {
				state: status.status === 'failed' ? 'failed' : status.status === 'cancelled' ? 'cancelled' : 'running',
				phase: (status.progress?.phase as ReportRecord['status']['phase']) ?? null,
				done: status.progress?.done ?? 0,
				total: status.progress?.total ?? 1,
				message: status.progress?.message ?? status.status,
				error: status.error ?? undefined,
				completed: []
			}
		};
	}
	const response = await fetchImpl(`${base}${API_ROOT}/jobs/${encodeURIComponent(jobId)}/result`);
	if (!response.ok) throw new Error(`Job result failed: HTTP ${response.status}`);
	const raw = (await response.json()) as Record<string, unknown>;
	const record = coerceReport(raw, `${JOB_PREFIX}${jobId}`, `Server job ${jobId.slice(0, 8)}`);
	if (record.provenance) record.provenance.surface = record.provenance.surface ?? 'node-server';
	return record;
}

/**
 * Subscribe to a job's SSE progress (`/events`). Calls `onProgress` for each event and `onDone`
 * when the stream reports a terminal status; returns the closer. Falls back to polling every 3 s
 * when EventSource is unavailable or the stream errors.
 */
export function watchJob(
	jobId: string,
	handlers: { onProgress: (p: JobStatus['progress']) => void; onDone: (status: JobStatus) => void },
	fetchImpl: typeof fetch = fetch
): () => void {
	let closed = false;
	let source: EventSource | null = null;
	let pollTimer: ReturnType<typeof setTimeout> | null = null;
	const poll = async () => {
		if (closed) return;
		try {
			const status = await fetchJobStatus(jobId, fetchImpl);
			handlers.onProgress(status.progress ?? null);
			if (status.status === 'done' || status.status === 'failed' || status.status === 'cancelled') {
				handlers.onDone(status);
				return;
			}
		} catch {
			// keep polling
		}
		pollTimer = setTimeout(poll, 3000);
	};
	if (typeof EventSource !== 'undefined') {
		try {
			source = new EventSource(`${base}${API_ROOT}/jobs/${encodeURIComponent(jobId)}/events`);
			source.onmessage = (ev) => {
				try {
					const data = JSON.parse(ev.data) as JobStatus & { phase?: string };
					if (data.progress || data.phase) handlers.onProgress(data.progress ?? (data as unknown as JobStatus['progress']));
					if (data.status === 'done' || data.status === 'failed' || data.status === 'cancelled') {
						handlers.onDone(data);
						source?.close();
					}
				} catch {
					// ignore malformed events
				}
			};
			source.onerror = () => {
				source?.close();
				source = null;
				if (!closed) void poll();
			};
		} catch {
			void poll();
		}
	} else {
		void poll();
	}
	return () => {
		closed = true;
		source?.close();
		if (pollTimer) clearTimeout(pollTimer);
	};
}
