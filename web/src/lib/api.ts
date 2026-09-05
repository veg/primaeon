/**
 * api.ts — the typed contract between the analyze flow (which writes), the storage layer, and the
 * report page (which reads): what a browser run is, what it was run on, and what it produced.
 *
 * WHY THIS FILE EXISTS. PLAN.md §4.0 / D21: the only user action is uploading a dataset, and one
 * report fills in as the analyses finish. Everything that runs on that dataset is one record —
 * `ReportRecord` (schema_version 2) — whose `sections` are filled one at a time by the runtime's
 * `runEverything` orchestrator (runtime/src/analyze.js) as it posts them from the analyze worker.
 * Four modules meet at that record: `lib/report/run.svelte.ts` produces it, `lib/storage/reports.ts`
 * stores it, `lib/report/load.ts` reads it back from IndexedDB, the gallery or a server job, and the
 * report route renders it. None of them should learn the shape from another's implementation, so
 * the envelope (id, timestamp, inputs with hashes, options, timings, diagnostics, status) is declared
 * here and the per-section payloads in `lib/report/types.ts`, using the Python reference's result
 * key names (`hyphaeon meme` / `busted` / `epistasis` / `dms` documents) so a stored section and a
 * CLI document read alike.
 *
 * PHASE 1's `ResultRecord` (schema_version 1: one `meme` run per record) stays declared below
 * because the IndexedDB `runs` store still holds such records; `lib/storage/reports.ts` wraps one
 * as a v2 report whose only section is `sites` when the report page asks for its id.
 *
 * INPUT PROVENANCE. `inputs` records names, byte sizes and the sha256 of the texts the run saw
 * (after gzip inflation, before any tree estimation). The v2 record ALSO keeps the texts
 * themselves (`inputs.alignmentText`, `inputs.treeText`) because the report's "Re-run with…"
 * disclosure re-runs everything on the same inputs with new options, and a report reopened after
 * a reload has no other copy. They live in IndexedDB only; nothing leaves the browser (the promise
 * on every page), and the JSON download strips them.
 */

import type { MemeRecord } from '$lib/results/types';
import type { ReportSections } from '$lib/report/types';

export type { MemeRecord, ReportSections };

/** Model variants the manifest ships (PLAN.md D10; `models/manifest.json` `variants`). */
export type Variant = 'general' | 'viral';

/** Tier-calling modes (runtime/src/callModes.js; PLAN.md D11). `pvalue` is the CLI's q-based call. */
export type CallMode = 'percentile' | 'zscore' | 'pvalue';

/** Where the tree the model used came from (PLAN.md §3.5 `tree_source`). */
export type TreeSource = 'user' | 'embedded' | 'hyphy-hky85' | 'nj' | 'tn93';

/** The options a run is submitted with; stored verbatim so the run can be reproduced. */
export interface RunOptions {
	variant: Variant;
	/** Taxon cap, 3..512; default 256 (manifest `default_taxon_cap`). */
	maxSpecies: number;
	/** Name of the sequence whose coordinates the site table uses. */
	referenceSequence: string | null;
	callMode: CallMode;
	/** `hyphaeon meme --filter`: mask alignment artifacts and re-score. */
	filter: boolean;
	/** `hyphaeon meme --attribute`: per-taxon counterfactual attribution on selected sites. */
	attribute: boolean;
}

/** One input file or paste, hashed. `sha256` is null only when Web Crypto was unavailable. */
export interface InputDigest {
	/** File name, or a synthetic name for a paste (`pasted.fasta`) or a demo (`bat_oas1.fasta`). */
	name: string;
	/** UTF-8 byte length of the text after inflation. */
	size: number;
	sha256: string | null;
}

export interface RunInputs {
	alignment: InputDigest;
	/** Null when no tree was supplied (embedded in the alignment, or estimated). */
	tree: InputDigest | null;
	/** How the tree the model used was obtained. */
	treeSource: TreeSource;
	/** Set when the run came from a demo/gallery button rather than an upload. */
	demo?: string;
}

/** The six steps of the progress checklist (PLAN.md §4.2: "like axomeme3's, with measured time"). */
export type StepId = 'parse' | 'tree' | 'branch-lengths' | 'prepare' | 'infer' | 'postprocess';

export type StepStatus = 'pending' | 'active' | 'done' | 'skipped' | 'failed';

export interface StepRecord {
	id: StepId;
	label: string;
	status: StepStatus;
	/** Latest progress line for the step. */
	message: string | null;
	/** Wall-clock milliseconds the step took; null until done. */
	elapsedMs: number | null;
	/** Batch progress for the inference step, when the runtime reports it. */
	done?: number;
	total?: number;
}

/** A diagnostic in the library's shape (`@veg/hyphaeon-js` diagnose), kept with the record. */
export interface DiagnosticWarning {
	code: string;
	severity: 'info' | 'warn' | 'refuse';
	message: string;
	data: Record<string, unknown>;
}

/** The library's `diagnose()` result as the panel showed it before the run. */
export interface DiagnosisSnapshot {
	ok: boolean;
	warnings: DiagnosticWarning[];
	summary: Record<string, unknown>;
}

/** The persisted envelope: one browser run. `id` is the IndexedDB key and the `/results/<id>/` segment. */
export interface ResultRecord {
	id: string;
	/** Epoch milliseconds. */
	createdAt: number;
	/** ISO form of createdAt, for display without a Date round-trip. */
	createdAtIso: string;
	/** The same ISO timestamp under the CLI-style key the results loader reads first. */
	created_at: string;
	/** Display name: the alignment file name, or the demo name. */
	name: string;
	method: 'meme';
	inputs: RunInputs;
	options: RunOptions;
	/** Step timings as the checklist showed them. */
	steps: StepRecord[];
	/** The pre-run diagnostics, so the results page can restate the regime line. */
	diagnostics: DiagnosisSnapshot | null;
	/** Threads ORT actually used, and whether the page was cross-origin isolated (PLAN.md D13). */
	runtime: {
		numThreads: number;
		crossOriginIsolated: boolean;
		hardwareConcurrency: number | null;
		/** Total wall time, first model download included. */
		wallMs: number;
	};
	result: MemeRecord;
}

/** A listing row: the envelope without the (large) result document. */
export type ResultListing = Omit<ResultRecord, 'result'> & {
	sites: number;
	taxaUsed: number;
};

/**
 * The route a stored run is opened at, relative to `base`. Defined once so both sides agree.
 *
 * `/results/local/?id=<id>` rather than `/results/<id>/`: the site is fully prerendered by
 * adapter-static in strict mode (svelte.config.js), so the results route (`/results/[...id]`)
 * can only emit the pages it knows at build time — the gallery records and one `local` shell.
 * A client-side `goto('/results/<uuid>/')` would render in-app, but a reload or a pasted link
 * would 404 on the static host; the `local` shell with the id in the query survives both.
 * The results route's `+page.ts` reads `?id=` on the `local` shell.
 */
export function resultsPath(id: string): string {
	return `/results/local/?id=${encodeURIComponent(id)}`;
}


// ---- Phase 2: the report (PLAN.md §4.0, §4.5) ----------------------------------------------------

/** The phases `runEverything` reports (orchestrator contract), in the order they run. */
export type ReportPhase =
	| 'parse'
	| 'prepare'
	| 'infer'
	| 'stats'
	| 'gene'
	| 'epistasis'
	| 'attribute'
	| 'filter'
	| 'dms'
	| 'postprocess';

export const REPORT_PHASES: readonly ReportPhase[] = [
	'parse',
	'prepare',
	'infer',
	'stats',
	'gene',
	'epistasis',
	'attribute',
	'filter',
	'dms',
	'postprocess'
];

/** Section names, in the order PLAN.md §4.0 renders them. */
export type SectionName = 'sites' | 'gene' | 'epistasis' | 'attribution' | 'filter' | 'dms' | 'phenotype';

export const SECTION_ORDER: readonly SectionName[] = ['sites', 'gene', 'epistasis', 'attribution', 'filter', 'dms', 'phenotype'];

/** Which phase produces which section (for the skeleton's phase label and for progress routing). */
export const SECTION_PHASE: Record<SectionName, ReportPhase | null> = {
	sites: 'infer',
	gene: 'gene',
	epistasis: 'epistasis',
	attribution: 'attribute',
	filter: 'filter',
	dms: 'dms',
	phenotype: null
};

/**
 * The options `runEverything` takes (orchestrator contract). Defaults come from diagnostics
 * (variant from tree depth) and the manifest (taxon cap); the report's "Re-run with…" disclosure
 * edits them and re-runs on the same inputs.
 */
export interface ReportOptions {
	variant: Variant;
	/** Taxon cap, 3..512; default 256 (manifest `default_taxon_cap`). */
	maxSpecies: number;
	referenceSequence: string | null;
	callMode: CallMode;
	/** Seed for the sector permutation null (`hyphaeon epistasis --seed`, default 42). */
	seed: number;
	/** Digital DMS: on by default; `workBudget` is the 19·L·N² forward-pass budget the browser allows. */
	dms: { enabled: boolean; workBudget: number };
	/** Permutations B for the sector null (`--n-permutations`; the CLI's 1000, the function's 10000). */
	permutations: number;
}

/** The inputs a report was run on: digests for display, texts for the re-run. */
export interface ReportInputs {
	alignment: InputDigest;
	tree: InputDigest | null;
	treeSource: TreeSource;
	alignmentName: string;
	treeName: string | null;
	demo?: string;
	/** Kept in IndexedDB for "Re-run with…"; absent from gallery records and stripped from downloads. */
	alignmentText?: string;
	/** The tree the model was given (with branch lengths; estimated when the input had none). */
	treeText?: string | null;
}

export type ReportState = 'running' | 'done' | 'failed' | 'cancelled';

/** Where the run is right now; persisted so a reload mid-run shows what finished. */
export interface ReportStatus {
	state: ReportState;
	phase: ReportPhase | null;
	done: number;
	total: number;
	message: string | null;
	/** Set when `state` is `failed`. */
	error?: string;
	/** Sections that reached `final: true`, in arrival order. */
	completed: SectionName[];
}

/** PLAN.md §3.5's provenance block; the runtime writes it, the report shows it. */
export type ReportProvenance = MemeRecord['provenance'];

/** The persisted report: one dataset, every analysis. `id` is the IndexedDB key and the `?id=` segment. */
export interface ReportRecord {
	schema_version: 2;
	kind: 'report';
	id: string;
	/** Epoch milliseconds. */
	createdAt: number;
	createdAtIso: string;
	/** Display name: the alignment file name, or the demo name. */
	name: string;
	inputs: ReportInputs;
	options: ReportOptions;
	diagnostics: DiagnosisSnapshot | null;
	sections: ReportSections;
	provenance: ReportProvenance | null;
	/** Wall seconds per phase, as the orchestrator measured them. */
	timings: Partial<Record<ReportPhase, number>>;
	status: ReportStatus;
	/** Threads ORT actually used, and whether the page was cross-origin isolated (PLAN.md D13). */
	runtime?: {
		numThreads: number;
		crossOriginIsolated: boolean;
		hardwareConcurrency: number | null;
		wallMs: number;
	};
}

/** A listing row: the envelope without the (large) sections. */
export type ReportListing = Omit<ReportRecord, 'sections' | 'inputs'> & {
	inputs: Omit<ReportInputs, 'alignmentText' | 'treeText'>;
	sites: number;
	taxaUsed: number;
};

/**
 * The route a report is opened at, relative to `base`: `/report/local/?id=<id>` for a browser run
 * (same reasoning as `resultsPath`: the static host can only serve the shells the build knew),
 * `/report/gallery/<name>/` for a prebaked example, and `/report/local/?id=job:<id>` for a server
 * job, which the loader recognises by its prefix.
 */
export function reportPath(id: string): string {
	if (id.startsWith('gallery/')) return `/report/${id.replace(/\/+$/, '')}/`;
	return `/report/local/?id=${encodeURIComponent(id)}`;
}
