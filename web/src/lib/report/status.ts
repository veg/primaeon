/**
 * status.ts — what each section of a report is doing right now, derived from the record and the
 * loader's state, so every section shell renders the same vocabulary.
 *
 * WHY THIS FILE EXISTS. PLAN.md §4.5: "a section not yet present shows a compact skeleton with its
 * phase name". Whether a missing section is PENDING (the run is live and has not reached its
 * phase), RUNNING (its phase is the current one), UNAVAILABLE (the run finished without it — a
 * Phase 1 record, a bridge build, a refused pillar), SKIPPED (the runtime declined it and said why:
 * DMS over the work budget), INTERRUPTED (a reload killed the run before it got there) or FAILED
 * depends on the record's status, the live job, and the payload — the same decision for seven
 * sections, made once here.
 */

import type { ReportRecord, SectionName } from '$lib/api';
import { SECTION_ORDER, SECTION_PHASE, REPORT_PHASES } from '$lib/api';
import type { LoadedState } from './load';
import { dmsSkipped, isFailedSection, type DmsSection } from './types';

export type SectionState = 'done' | 'partial' | 'running' | 'pending' | 'skipped' | 'unavailable' | 'interrupted' | 'failed' | 'cancelled';

export interface SectionStatus {
	name: SectionName;
	state: SectionState;
	/** The orchestrator phase that produces the section, for the skeleton label. */
	phase: string | null;
	/** The runtime's reason when `skipped`/`unavailable` carries one. */
	reason: string | null;
}

export const SECTION_TITLE: Record<SectionName, string> = {
	sites: 'Sites under episodic selection',
	gene: 'Gene-level verdict',
	epistasis: 'Epistasis and sectors',
	attribution: 'Attribution',
	filter: 'Alignment-artifact filter',
	dms: 'Digital deep mutational scan',
	phenotype: 'Phenotype association'
};

export const PHASE_LABEL: Record<string, string> = {
	parse: 'parsing',
	prepare: 'preparing tensors and loading the model',
	infer: 'scoring sites',
	stats: 'p-values and q-values',
	gene: 'gene-level omnibus',
	epistasis: 'co-selection network and sectors',
	attribute: 'attribution',
	filter: 'artifact filter',
	dms: 'digital DMS',
	postprocess: 'finishing',
	total: 'total'
};

function skippedReason(payload: unknown): string | null {
	if (!payload || typeof payload !== 'object') return null;
	const s = (payload as { skipped?: unknown }).skipped;
	if (s === true) return (payload as { reason?: string }).reason ?? 'skipped';
	if (s && typeof s === 'object' && typeof (s as { reason?: unknown }).reason === 'string') return (s as { reason: string }).reason;
	return null;
}

export function sectionStatus(record: ReportRecord, state: LoadedState, name: SectionName): SectionStatus {
	const phase = SECTION_PHASE[name];
	const payload = record.sections[name];
	const completed = record.status.completed.includes(name);
	const reason = skippedReason(payload);
	// The phenotype pillar is never pending or running with the rest: it needs a trait, so its
	// section is either a result the reader asked for or an invitation to ask (PLAN.md §4.0 row 8).
	// Its shell therefore always renders its body, and the panel itself shows a failed run.
	if (name === 'phenotype') return { name, state: 'done', phase: null, reason: null };
	if (payload != null) {
		if (isFailedSection(payload)) return { name, state: 'failed', phase, reason: payload.error };
		if (reason) return { name, state: 'skipped', phase, reason };
		if (name === 'dms') {
			const dms = record.sections.dms as DmsSection;
			if (dmsSkipped(dms)) return { name, state: 'skipped', phase, reason: dmsSkipped(dms)!.reason };
			if (dms.cancelled) return { name, state: 'cancelled', phase, reason: null };
			if (!completed && state === 'running') return { name, state: 'partial', phase, reason: null };
			if (!completed && state === 'interrupted') return { name, state: 'interrupted', phase, reason: null };
		}
		return { name, state: 'done', phase, reason: null };
	}
	// No payload yet.
	if (state === 'running') {
		const current = record.status.phase;
		if (current && phase) {
			const ci = REPORT_PHASES.indexOf(current);
			const pi = REPORT_PHASES.indexOf(phase);
			if (ci === pi) return { name, state: 'running', phase, reason: null };
			// Sites are produced by infer + stats: still running while stats is on.
			if (name === 'sites' && current === 'stats') return { name, state: 'running', phase, reason: null };
			if (ci > pi) return { name, state: 'running', phase, reason: null };
		}
		return { name, state: 'pending', phase, reason: null };
	}
	if (state === 'interrupted') return { name, state: 'interrupted', phase, reason: null };
	if (state === 'failed') return { name, state: 'failed', phase, reason: record.status.error ?? null };
	if (state === 'cancelled') return { name, state: 'cancelled', phase, reason: null };
	return { name, state: 'unavailable', phase, reason: null };
}

export function allSectionStatuses(record: ReportRecord, state: LoadedState): SectionStatus[] {
	return SECTION_ORDER.map((n) => sectionStatus(record, state, n));
}

/** Seconds elapsed over the recorded phases, or the runtime wall time, whichever the record has. */
export function elapsedSeconds(record: ReportRecord): number | null {
	if (record.runtime?.wallMs) return record.runtime.wallMs / 1000;
	const total = (record.timings as Record<string, number | undefined>).total;
	if (total && Number.isFinite(total)) return total;
	const sum = Object.values(record.timings).reduce((a, b) => a + (b ?? 0), 0);
	if (sum > 0) return sum;
	return record.provenance?.elapsed_sec ?? null;
}

export function formatSeconds(s: number | null): string {
	if (s == null || !Number.isFinite(s)) return '—';
	if (s < 10) return `${s.toFixed(1)} s`;
	if (s < 90) return `${Math.round(s)} s`;
	return `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
}
