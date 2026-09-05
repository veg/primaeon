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

/**
 * Where the DISTANCES the model used came from (PLAN.md §3.5 `tree_source`, D22).
 *
 *   user      a tree file with branch lengths, used as is
 *   embedded  a tree with branch lengths carried in the alignment, used as is
 *   tn93      tree-free: no tree, or a tree without usable branch lengths, so pairwise
 *             Tamura-Nei 93 distances feed the MDS directly (the reference's `--use-tn93`)
 *
 * A neighbour-joining tree built on those same TN93 distances is DISPLAY ONLY (`displayTreeSource`
 * below); the model never sees it, so it is not a `TreeSource`.
 *
 * Records written before D22 carry two further values — a neighbour-joining source and one naming
 * the WebAssembly branch-length fit that Phase 3 removed. They are not in this union: nothing
 * produces them any more, and `treeSourceLabel()` renders any unknown string as a legacy
 * estimated-tree source rather than pretending the value is current.
 */
export type TreeSource = 'user' | 'embedded' | 'tn93';

/** Where the tree DRAWN in the report came from: the user's, or the app's NJ tree on TN93 distances. */
export type DisplayTreeSource = 'user' | 'embedded' | 'nj';

/** One line naming a run's distance source, for the strip, the provenance block and the tree modal. */
export function treeSourceLabel(source: string | null | undefined): string {
	switch (source) {
		case 'user':
			return 'uploaded tree, used as given';
		case 'embedded':
			return 'tree embedded in the alignment, used as given';
		case 'tn93':
			return 'tree-free (TN93 distances)';
		case null:
		case undefined:
		case '':
			return 'not recorded';
		default:
			return `estimated tree (${source}; a pre-Phase-3 record)`;
	}
}

/** Why a run went tree-free, as the library reports it in `TREE_FREE_TN93.data.reason`. */
export type TreeFreeReason = 'no_tree' | 'no_branch_lengths' | 'requested';

export const TREE_FREE_REASON_TEXT: Record<TreeFreeReason, string> = {
	no_tree: 'no tree',
	no_branch_lengths: 'no branch lengths',
	requested: 'tree-free requested'
};

/** "tree-free (TN93) — no branch lengths", the one string the strip and the provenance both print. */
export function treeFreeLabel(reason: string | null | undefined): string {
	const text = TREE_FREE_REASON_TEXT[reason as TreeFreeReason];
	return text ? `tree-free (TN93) — ${text}` : 'tree-free (TN93)';
}

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

/**
 * The six steps of the Phase 1 progress checklist (PLAN.md §4.2: "like axomeme3's, with measured
 * time"). `distances` was the branch-length fit until D22 removed it: what is timed there now is
 * the choice between the tree's patristic distances and tree-free TN93 ones.
 */
export type StepId = 'parse' | 'tree' | 'distances' | 'prepare' | 'infer' | 'postprocess';

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

// ---- Phase 3: the phenotype request (PLAN.md §4.0 row 8, §4.5 "phenotype") ----------------------

/**
 * How the reader described the trait. The four cases are the library's three sources
 * (`resolvePhenotypeVector`: a preset, an inline foreground list or pattern, or a table) with the
 * app's tree-picking folded into the inline case — clicking tips builds a comma-separated list of
 * exact names, which is what the reference would have been given on the command line.
 *
 * `preset` and `list` are what the panel offers first because they are the two the reference's own
 * README uses; `csv` carries the CONTENT of the file, because the library does no I/O, plus the
 * file NAME, because the reference derives the separator and the description from it.
 */
export type TraitKind = 'preset' | 'list' | 'csv';

export interface TraitSpec {
	kind: TraitKind;
	/** `kind: 'preset'` — a key of the library's PRESETS. */
	preset?: string;
	/**
	 * `kind: 'list'` — the foreground as the CLI takes it: names or patterns separated by commas,
	 * or by `|` when the string contains no comma. Each pattern is tried as a REGULAR EXPRESSION
	 * first (phenotype.py:249-256), so `pan*` matches `papAnu`; the panel warns about it.
	 */
	foreground?: string;
	/** `kind: 'csv'` — the table's text and its file name (the name decides TAB vs comma). */
	phenotypeCsv?: string;
	phenotypeFile?: string;
	/** Column names, when the reader overrode the reference's own column guessing. */
	speciesCol?: string | null;
	traitCol?: string | null;
	/** Continuous trait: z-scored by the library rather than split into foreground/background. */
	continuous?: boolean;
}

/** The knobs the phenotype run takes beyond the trait itself; every default is the reference's. */
export interface PhenotypeRunOptions {
	/** Brownian-motion permulations B for the gene-level empirical p; 0 (and forced 0 tree-free). */
	permulations: number;
	/** `hyphaeon phenotype --seed`, default 42. */
	seed: number;
	/** BH level for the called sites and the trait-sector input, default 0.05. */
	alpha: number;
	/** Sites need this many sequenced taxa to be scored, default 4. */
	minTaxaPerSite: number;
}

export const PHENOTYPE_DEFAULTS: PhenotypeRunOptions = {
	permulations: 0,
	seed: 42,
	alpha: 0.05,
	minTaxaPerSite: 4
};

/**
 * The panel's `TraitSpec` as `resolvePhenotypeVector` / `runPhenotype` take it. One function, used
 * by the panel's live preview on the main thread and by the worker that runs the pillar, so the
 * trait the reader previewed is character for character the trait the run resolves.
 *
 * The three cases ARE the reference's three sources, tried in its own priority order (a table wins
 * over a preset, which wins over an inline list): only one key group is ever set, so the priority
 * never comes into play here.
 */
export function traitToPhenotypeOptions(trait: TraitSpec): Record<string, unknown> {
	switch (trait.kind) {
		case 'preset':
			return { preset: trait.preset ?? '', continuous: false };
		case 'list':
			return { foreground: trait.foreground ?? '', continuous: Boolean(trait.continuous) };
		case 'csv':
			return {
				phenotypeCsv: trait.phenotypeCsv ?? '',
				phenotypeFile: trait.phenotypeFile ?? 'phenotype.csv',
				speciesCol: trait.speciesCol ?? null,
				traitCol: trait.traitCol ?? null,
				continuous: Boolean(trait.continuous)
			};
	}
}
