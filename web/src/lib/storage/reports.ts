/**
 * reports.ts — browser-local persistence of reports (ReportRecord v2), over the same IndexedDB
 * database as the Phase 1 runs, plus the wrapper that reads a Phase 1 run as a report.
 *
 * WHY THIS FILE EXISTS. PLAN.md §4.1: "Local reports persist in IndexedDB". A report is written
 * MANY times during one run — once when it is created (status `running`, no sections), once per
 * section as `runEverything` posts it, and every few progressive DMS updates — so that a reload
 * mid-run reopens the report with whatever had finished (lib/report/run.svelte.ts owns that
 * cadence; this module only puts and gets). The `reports` store is created by the additive
 * upgrade in results.ts (DB_VERSION 2); the connection, the request wrapper and the quota message
 * are shared with it.
 *
 * THE PHENOTYPE SECTION IS WRITTEN ON ITS OWN (Phase 3). Every other section arrives while the run
 * is in flight, so `saveReport` puts the whole live record. The phenotype pillar runs later —
 * minutes or days later, from a report the page loaded back out of this store — and the record the
 * panel holds may be a copy the loader made. `savePhenotypeSection` therefore does a
 * read-modify-write against the stored row instead of putting the page's whole record, so a run
 * that is still streaming cannot be rolled back by a phenotype result, and a report that is not in
 * this store (a gallery example, a server job, a Phase 1 run) is left alone and says so by
 * returning false rather than minting a local copy of something the reader did not run.
 *
 * MIGRATION OF PHASE 1 RUNS. The v1 `runs` store holds `ResultRecord`s (one `meme` run each).
 * They are not rewritten: `getReport(id)` looks in `reports` first and, when the id is a v1 run,
 * returns `wrapLegacyRun()` — a ReportRecord whose only section is `sites` (the v1 `result`),
 * whose options carry the Phase 2 defaults for the fields v1 had no notion of, and whose status
 * is `done` with the other sections absent (the section skeletons say "not part of this run"
 * rather than "pending"). A v1 record has no input texts, so its report cannot be re-run; the
 * disclosure says so. `listReports()` merges both stores newest first, so the history a later
 * page shows is complete.
 */

import type {
	ReportListing,
	ReportOptions,
	ReportRecord,
	ReportSections,
	ResultRecord,
	SectionName
} from '$lib/api';
import { emptySections } from '$lib/report/types';
import { CREATED_INDEX, REPORTS_STORE, RUNS_STORE, openDb, requestToPromise, translate } from './results';

export { isAvailable, newRunId as newReportId } from './results';

/** Phase 2 defaults for the option fields a v1 record did not have (PLAN.md §4.0, PHASE2A). */
export const DEFAULT_SEED = 42;
export const DEFAULT_PERMUTATIONS = 1000;
/** 19·L·N² forward-pass work the browser accepts for the digital DMS before it says "run on the server". */
export const DEFAULT_DMS_WORK_BUDGET = 2.5e9;

/** Store a report; `put`, so every progressive save replaces the previous one. Resolves to the id. */
export async function saveReport(record: ReportRecord): Promise<string> {
	if (!record.id) throw new Error('saveReport: record.id is required');
	const db = await openDb();
	const tx = db.transaction(REPORTS_STORE, 'readwrite');
	await requestToPromise(tx.objectStore(REPORTS_STORE).put(record));
	return record.id;
}

/**
 * Store just the phenotype section against the report with this id. Returns false when the report
 * is not in the `reports` store (nothing is written in that case). See the header.
 *
 * @param section the section to store, or null to remove one the reader cleared.
 */
export async function savePhenotypeSection(id: string, section: ReportSections['phenotype']): Promise<boolean> {
	const db = await openDb();
	const store = db.transaction(REPORTS_STORE, 'readonly').objectStore(REPORTS_STORE);
	const found = (await requestToPromise(store.get(id))) as ReportRecord | undefined;
	if (!found) return false;
	found.sections = { ...found.sections, phenotype: section };
	const completed = found.status.completed.filter((n) => n !== 'phenotype');
	found.status = { ...found.status, completed: section ? [...completed, 'phenotype'] : completed };
	const tx = db.transaction(REPORTS_STORE, 'readwrite');
	await requestToPromise(tx.objectStore(REPORTS_STORE).put(found));
	return true;
}

/** The report, a wrapped v1 run, or null when the id is unknown in both stores. */
export async function getReport(id: string): Promise<ReportRecord | null> {
	const db = await openDb();
	const found = await requestToPromise(db.transaction(REPORTS_STORE, 'readonly').objectStore(REPORTS_STORE).get(id));
	if (found) return found as ReportRecord;
	if (!db.objectStoreNames.contains(RUNS_STORE)) return null;
	const legacy = await requestToPromise(db.transaction(RUNS_STORE, 'readonly').objectStore(RUNS_STORE).get(id));
	return legacy ? wrapLegacyRun(legacy as ResultRecord) : null;
}

export async function deleteReport(id: string): Promise<void> {
	const db = await openDb();
	await requestToPromise(db.transaction(REPORTS_STORE, 'readwrite').objectStore(REPORTS_STORE).delete(id));
	if (db.objectStoreNames.contains(RUNS_STORE)) {
		await requestToPromise(db.transaction(RUNS_STORE, 'readwrite').objectStore(RUNS_STORE).delete(id));
	}
}

/** Every report (v2 and wrapped v1) without its sections, newest first. */
export async function listReports(): Promise<ReportListing[]> {
	const db = await openDb();
	const rows: ReportListing[] = [];
	const read = (store: string, wrap: (v: unknown) => ReportRecord) =>
		new Promise<void>((resolve, reject) => {
			if (!db.objectStoreNames.contains(store)) return resolve();
			const cursor = db.transaction(store, 'readonly').objectStore(store).index(CREATED_INDEX).openCursor(null, 'prev');
			cursor.onerror = () => reject(translate(cursor.error));
			cursor.onsuccess = () => {
				const c = cursor.result;
				if (!c) return resolve();
				rows.push(toListing(wrap(c.value)));
				c.continue();
			};
		});
	await read(REPORTS_STORE, (v) => v as ReportRecord);
	await read(RUNS_STORE, (v) => wrapLegacyRun(v as ResultRecord));
	rows.sort((a, b) => b.createdAt - a.createdAt);
	return rows;
}

function toListing(r: ReportRecord): ReportListing {
	const { sections, inputs, ...envelope } = r;
	const { alignmentText, treeText, ...inputsRest } = inputs;
	void alignmentText;
	void treeText;
	return {
		...envelope,
		inputs: inputsRest,
		sites: sections.sites?.summary?.totalSites ?? sections.sites?.sites?.length ?? 0,
		taxaUsed: sections.sites?.summary?.speciesUsed ?? r.provenance?.preprocessing?.taxa_used ?? 0
	};
}

/** The Phase 2 options a v1 run implies. */
export function legacyOptions(v1: ResultRecord['options']): ReportOptions {
	return {
		variant: v1.variant,
		maxSpecies: v1.maxSpecies,
		referenceSequence: v1.referenceSequence,
		callMode: v1.callMode,
		seed: DEFAULT_SEED,
		dms: { enabled: false, workBudget: DEFAULT_DMS_WORK_BUDGET },
		permutations: DEFAULT_PERMUTATIONS
	};
}

/** A Phase 1 run as a report whose only section is `sites`. Pure; used by the loader and the tests. */
export function wrapLegacyRun(run: ResultRecord): ReportRecord {
	const sections = emptySections();
	sections.sites = run.result;
	if (run.result?.attributions && Object.keys(run.result.attributions).length) {
		sections.attribution = { attributions: run.result.attributions, attribution_enabled: true };
	}
	if (run.result?.filter) {
		sections.filter = {
			artifacts_masked: run.result.filter.artifacts_masked ?? [],
			filter_enabled: run.result.filter.enabled,
			raw_metrics: run.result.filter.raw_metrics,
			cleaned_metrics: run.result.filter.cleaned_metrics,
			masked_codon_ranges_1idx_by_taxon: run.result.filter.masked_codon_ranges_1idx_by_taxon
		};
	}
	const completed: SectionName[] = ['sites'];
	if (sections.attribution) completed.push('attribution');
	if (sections.filter) completed.push('filter');
	const timings: ReportRecord['timings'] = {};
	for (const s of run.steps ?? []) {
		if (s.elapsedMs == null) continue;
		const phase = s.id === 'infer' ? 'infer' : s.id === 'prepare' ? 'prepare' : s.id === 'postprocess' ? 'postprocess' : 'parse';
		timings[phase] = (timings[phase] ?? 0) + s.elapsedMs / 1000;
	}
	return {
		schema_version: 2,
		kind: 'report',
		id: run.id,
		createdAt: run.createdAt,
		createdAtIso: run.createdAtIso ?? new Date(run.createdAt).toISOString(),
		name: run.name,
		inputs: {
			alignment: run.inputs.alignment,
			tree: run.inputs.tree,
			treeSource: run.inputs.treeSource,
			alignmentName: run.inputs.alignment.name,
			treeName: run.inputs.tree?.name ?? null,
			...(run.inputs.demo ? { demo: run.inputs.demo } : {})
		},
		options: legacyOptions(run.options),
		diagnostics: run.diagnostics,
		sections,
		provenance: run.result?.provenance ?? null,
		timings,
		status: { state: 'done', phase: null, done: 1, total: 1, message: 'Phase 1 site-selection run', completed },
		runtime: run.runtime
	};
}

/** True for a report that came from the v1 store (no texts to re-run, and only `sites` ran). */
export function isLegacyReport(r: ReportRecord): boolean {
	return r.status.message === 'Phase 1 site-selection run' && r.inputs.alignmentText === undefined;
}
