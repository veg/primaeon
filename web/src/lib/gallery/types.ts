/**
 * types.ts — the shape of static/gallery/index.json, as web/scripts/prebake-gallery.mjs writes it,
 * and of the example catalogue beside it (examples.json).
 *
 * WHY THIS FILE EXISTS. The gallery index is GENERATED at build (PLAN.md §4.1: the example
 * chips on `/` open `/report/gallery/<name>/`, "gallery reports are prebaked"; §6 "prebake at
 * build", the datamonkey-metrics pattern) by `web/scripts/prebake-gallery.mjs`, which runs the
 * runtime's `runEverything` — every analysis of PLAN.md §4.0, in that order — on each bundled
 * example under Node and writes one ReportRecord (schema_version 2, `web/src/lib/api.ts`) per
 * example beside this index. The index is served as a plain file too: the report route's
 * `entries()` reads it at prerender time to know which `/report/gallery/<id>/` pages to emit,
 * and the MCP's `hyphaeon://gallery` resource reads the same document. Its shape is pinned here,
 * in one place, and the prebake script's `INDEX_SCHEMA_VERSION` must match `schema_version`.
 *
 * Phase 1 wrote `schema_version: 2`, one `meme` run per entry, for the retired `/gallery` cards.
 * Phase 2 (this file) writes `schema_version: 3`: an entry now IS a full prebaked report, and the
 * summary carries what the landing chips and an overview need without opening the 1–3 MB record —
 * dimensions, called sites, the gene verdict, epistasis edge and sector counts, DMS coverage and
 * the per-phase timings. Field names that the routes' `entries()` generators depend on (`id`,
 * `status`, `result`) are unchanged from schema 2.
 */

import type { ReportOptions, ReportPhase, SectionName } from '$lib/api';

/** One row of examples.json (see that file's header). */
export interface GalleryExample {
	/** Stable id, equal to the example's file stem in `HyphAeon/examples/`. */
	id: string;
	name: string;
	gene: string;
	/** The README table's one-line description, verbatim. */
	description: string;
	/** Organism group and regime, for an eyebrow. */
	regime: string;
	alignment: string;
	/** Newick file, or null when the tree is embedded in the alignment (NEXUS). */
	tree: string | null;
	format: 'fasta' | 'nexus';
	/** N and L as the README records them (before pruning and the cap). */
	paper: { taxa: number; codons: number };
	reference_runtime_sec: number | null;
}

export type TreeSource = 'file' | 'embedded';

/** How branch lengths were obtained when the bundled tree carried none (PLAN.md D6). */
export type BranchLengthMethod = 'hyphy-hky85' | 'library-default' | null;

export type EntryStatus = 'ok' | 'failed' | 'missing';

export interface GalleryInputs {
	/** File name under `static/gallery/inputs/`. */
	alignment: string;
	/** File name under `static/gallery/inputs/`, or null when the tree is embedded in the alignment. */
	tree: string | null;
	format: 'fasta' | 'nexus';
	alignment_sha256: string;
	tree_sha256: string | null;
}

/** Counts over the sites the prebaked run scored (the `sites` section). */
export interface GalleryCalled {
	/** Sites with Benjamini–Hochberg q ≤ 0.10 (the reference CLI's own report line). */
	q_le_0_10: number;
	/** Sites with q ≤ 0.05. */
	q_le_0_05: number;
	/** Sites with raw MEME-mixture p ≤ 0.05. */
	p_le_0_05: number;
	/** Sites in the top 5 % of variable sites by LRT (the app's default percentile tier, D11). */
	top_5pct: number;
}

export interface GallerySitesSummary {
	variable_sites: number;
	invariable_sites: number;
	max_lrt: number;
	called: GalleryCalled;
}

/**
 * The gene-level omnibus (the `gene` section, `hyphaeon busted`'s statistical fields). `verdict`
 * is APP-SIDE: `'selection'` when `p_value_acat` ≤ 0.05, `'no-evidence'` otherwise, `null` when
 * the section is absent. The neural head's fields are not summarised (not reproducible upstream,
 * runtime/src/busted.js).
 */
export interface GalleryGeneSummary {
	verdict: 'selection' | 'no-evidence' | null;
	p_value_acat: number | null;
	p_value_simes: number | null;
	omnibus_lrt: number | null;
	sig_sites_p05: number | null;
	sig_sites_p10: number | null;
}

/** The `epistasis` section: co-selection edges and TSE sectors, with the seeded permutation null. */
export interface GalleryEpistasisSummary {
	edges: number;
	sectors: number;
	/** Sectors with `p_perm` ≤ 0.05 at the bake's B (noisy at B = 1000, PHASE2A.md). */
	significant_sectors: number;
	permutations: number;
}

/**
 * The `dms` section. `coverage` is `sites_swept / sites_total`; below 1 the bake hit the work
 * budget or was cancelled, and the report says so (PLAN.md §4.0 row 7).
 */
export interface GalleryDmsSummary {
	sites_swept: number;
	sites_total: number;
	coverage: number;
	complete: boolean;
	cancelled: boolean;
	/** runtime/src/dms.js: over the budget, nothing ran. */
	skipped: boolean;
	/** runtime/src/dms.js: the budget stopped a partial sweep. */
	capped: boolean;
	/** 19 · L · N² for the requested sweep, in the units the cap is written in (PLAN.md §3.5). */
	work: number | null;
	/** The work budget the run was judged against, when the runtime reports it. */
	work_budget: number | null;
}

export interface GallerySummary {
	taxa_in_alignment: number;
	/** Taxa the model saw after duplicate pruning and the taxon cap. */
	taxa_used: number;
	codons: number;
	sites: GallerySitesSummary | null;
	gene: GalleryGeneSummary | null;
	epistasis: GalleryEpistasisSummary | null;
	dms: GalleryDmsSummary | null;
	/** Number of attributed sites (`attribution` section), or null. */
	attributed_sites: number | null;
	/** Number of masked alignment-artifact patches (`filter` section), or null. */
	artifacts_masked: number | null;
	/** Wall seconds per phase, as the orchestrator measured them (plus its own `total`). */
	timings: Partial<Record<ReportPhase | 'total', number>>;
	/** Total wall seconds of the prebake run for this example, this machine. */
	runtime_sec: number;
}

export interface GalleryPrebake {
	at: string;
	surface: string;
	node: string;
	threads: number;
	/** Whether the backbone graph's sha256 matched the manifest before scoring. */
	artifact_verified: boolean;
	/** Freshness stamp over inputs, graphs, options, library and runtime sources; see the script. */
	stamp: string;
	/**
	 * Storage reductions applied to keep the record small; `stripped` names the model-internal
	 * matrices never written (attention, root_repr, the tensor bundle), `dms_alias_dropped` the
	 * duplicated `selection_dms_plasticity` list, `dms_mutant_deltas_digits` a rounding of the ΔLRTs.
	 */
	storage: { dms_mutant_deltas_digits?: number; dms_alias_dropped?: boolean; stripped?: string[] };
	/** When each section (and the runtime's `diagnostics` event) reached `final: true`, in wall seconds from the start. */
	sections: { name: SectionName | 'diagnostics'; at: number }[];
}

export interface GalleryEntry extends GalleryExample {
	inputs: GalleryInputs;
	tree_source: TreeSource;
	/** Sections with a non-null payload in the prebaked report; empty unless `status` is `ok`. */
	analyses: SectionName[];
	branch_lengths_estimated: boolean;
	branch_length_method: BranchLengthMethod;
	status: EntryStatus;
	/** Present when `status` is `failed` or `missing`. */
	error?: string;
	/** File name of the ReportRecord beside the index, or null when the run did not complete. */
	result: string | null;
	summary: GallerySummary | null;
	prebake: GalleryPrebake | null;
}

export interface GalleryIndex {
	schema_version: 3;
	generated_at: string;
	engine: {
		commit: string | null;
		reference_version: string | null;
		hyphaeon_js_version: string | null;
	};
	model: {
		model_version: string | null;
		variant: string;
		artifact_sha256: string | null;
		busted_head_sha256: string | null;
	};
	/** The options every entry was run with (the app's defaults; the report's "Re-run with…" starts here). */
	options: ReportOptions & { pruneDuplicates: boolean };
	entries: GalleryEntry[];
}
