/**
 * api.ts — the typed contract between the analyze flow (which writes) and the results page (which
 * reads): what a browser run is, what it was run on, and what it produced.
 *
 * WHY THIS FILE EXISTS. PLAN.md §4.1: local runs persist in IndexedDB and `/results/[id]` renders
 * them with the same component a server job or a gallery record uses. Three modules meet at that
 * record — `lib/analyze/run.ts` produces it, `lib/storage/results.ts` stores it, the results route
 * reads it — and none of them should learn the shape from another's implementation. The per-run
 * envelope (id, timestamp, inputs with hashes, options, timings, diagnostics) is declared here;
 * the analysis document inside it is `MemeRecord` from `lib/results/types.ts`, which is the
 * reference CLI's `hyphaeon meme` document plus PLAN.md §3.5's provenance block, so a stored run
 * and a prebaked gallery record are the same type to the page.
 *
 * `MemeRecord` mirrors `runtime/src/pipeline.js` `runMeme`'s return shape (`schema_version`,
 * `method`, `is_surrogate`, `surrogate_for`, `sites`, `summary`, `provenance`) with the site rows
 * in the CLI's column names (Appendix B: `site`, `hyphaeon_lrt`, `p_value`, `q_value`,
 * `is_invariable`, attribution columns). `lib/analyze/record.ts` is the one place that converts a
 * runtime result into it, so a change in the runtime's shape is absorbed there.
 *
 * INPUT PROVENANCE. `inputs` records names, byte sizes and the sha256 of the texts the run saw
 * (after gzip inflation, before any tree estimation), not the texts themselves: the promise on
 * every page is that sequences stay in this browser, and a record that carries a hash can still be
 * matched against a file on disk without the record being the file. The alignment and tree the
 * model actually used ARE kept inside `result` (`result.alignment`, `result.tree`) because the
 * results page needs them for the site tree and the entropy overlays; they never leave IndexedDB.
 */

import type { MemeRecord } from '$lib/results/types';

export type { MemeRecord };

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
