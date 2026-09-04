/**
 * types.ts — the shape of static/gallery/index.json, as web/scripts/prebake-gallery.mjs writes it.
 *
 * WHY THIS FILE EXISTS. The gallery index is GENERATED at build (PLAN.md §4.1 "Six bundled
 * examples with prebaked results"; §6 "prebake at build", the datamonkey-metrics pattern) by
 * `web/scripts/prebake-gallery.mjs`, which runs site selection on the bundled examples under
 * Node and writes one result document per example beside this index. The index is served as a
 * plain file too — the /gallery page reads it at prerender time and the MCP's
 * `hyphaeon://examples/{name}` resource can read the same document — so its shape is pinned here,
 * in one place, and the prebake script's `INDEX_SCHEMA_VERSION` must match `schema_version` below.
 *
 * Phase 0 hand-maintained a `schema_version: 1` index that listed every file under
 * `HyphAeon/examples/` including three results-only epistasis datasets (β-globin, rbcL, REDIC1).
 * Phase 1b replaces it: an entry now IS a prebaked site-selection run, with the numbers a card
 * shows taken from that run rather than from the README, and datasets without an alignment are
 * out until their pillar (epistasis, Phase 2) has a result page to open.
 */

export type TreeSource = 'file' | 'embedded';

/** How branch lengths were obtained when the bundled tree carried none (PLAN.md D6). */
export type BranchLengthMethod = 'hyphy-hky85' | 'library-default' | null;

export type EntryStatus = 'ok' | 'failed' | 'missing';

/** Pillars a prebaked result can exist for. Phase 1b bakes `meme` only. */
export type Pillar = 'meme' | 'busted' | 'epistasis' | 'dms' | 'phenotype';

export interface GalleryInputs {
	/** File name under `static/gallery/inputs/`. */
	alignment: string;
	/** File name under `static/gallery/inputs/`, or null when the tree is embedded in the alignment. */
	tree: string | null;
	format: 'fasta' | 'nexus';
	alignment_sha256: string;
	tree_sha256: string | null;
}

/** Counts a card shows; all over the sites the prebaked run scored. */
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

export interface GallerySummary {
	taxa_in_alignment: number;
	/** Taxa the model saw after duplicate pruning and the taxon cap. */
	taxa_used: number;
	codons: number;
	variable_sites: number;
	invariable_sites: number;
	max_lrt: number;
	called: GalleryCalled;
	/** Wall seconds of the prebake run (parse → prepare → infer → postprocess), this machine. */
	runtime_sec: number;
}

export interface GalleryPrebake {
	at: string;
	surface: string;
	node: string;
	threads: number;
	/** Whether the graph's sha256 matched the manifest before scoring. */
	artifact_verified: boolean;
}

export interface GalleryEntry {
	/** Stable id, equal to the example's file stem in `HyphAeon/examples/`. */
	id: string;
	name: string;
	gene: string;
	/** The one-line description from the HyphAeon README's example table. */
	description: string;
	/** Where the paper places it: organism group and regime, for the card's eyebrow. */
	regime: string;
	/** Rows and columns as the README table records them (before pruning and the cap). */
	paper: { taxa: number; codons: number };
	/** Measured wall time of the Python reference for `meme` on a laptop CPU, PLAN.md §1. */
	reference_runtime_sec: number | null;
	inputs: GalleryInputs;
	tree_source: TreeSource;
	/**
	 * Pillars for which a prebaked result exists beside the index (`['meme']` when `status` is
	 * `ok`, else empty). The results route's `entries()` prerenders `/results/gallery/<id>/` for
	 * every entry listing `meme`.
	 */
	analyses: Pillar[];
	branch_lengths_estimated: boolean;
	branch_length_method: BranchLengthMethod;
	status: EntryStatus;
	/** Present when `status` is `failed`. */
	error?: string;
	/** File name of the result document beside the index, or null when the run did not complete. */
	result: string | null;
	summary: GallerySummary | null;
	prebake: GalleryPrebake | null;
}

export interface GalleryIndex {
	schema_version: 2;
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
	};
	/** The options every entry was run with (the app's defaults). */
	options: { variant: string; maxSpecies: number; pruneDuplicates: boolean };
	entries: GalleryEntry[];
}
