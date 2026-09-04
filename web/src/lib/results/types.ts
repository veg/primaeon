/**
 * types.ts — the site-selection result record the results page renders.
 *
 * WHY THIS FILE EXISTS. One shape for every source a result can come from: a browser run stored
 * in IndexedDB (web/src/lib/storage/results.ts, written by the analyze pipeline), a static gallery
 * record (static/gallery/<name>.json, converted from the reference CLI's `hyphaeon meme` JSON),
 * and later a server job. The per-site fields are the reference CLI's names (PLAN.md Appendix B:
 * `site`, `hyphaeon_lrt`, `p_value`, `q_value`, `is_invariable`, the four attribution columns and
 * `attribution_details`) so a gallery record IS a CLI document plus provenance; the DM3-derived
 * view columns (log LRT, local z, local percentile, tier call) are DERIVED here in derive.ts from
 * `hyphaeon_lrt` and never stored — they change with the call mode the reader picks.
 *
 * Optional fields are optional because the sources differ, not because the page can do without
 * them: the tree modal needs `tree`, the entropy overlays and the spark bars need `alignment`
 * (the selected taxa, in the order the model saw them). A record without them renders the plots
 * and the table with those affordances disabled and says so.
 */

/** One codon site, as `hyphaeon meme` writes it (cli.py:280-296) plus the optional view columns. */
export interface SiteRecord {
	/** 1-indexed codon site in reference coordinates. */
	site: number;
	/** The model's predicted LRT (clamped at 0; float32 on every surface). */
	hyphaeon_lrt: number;
	/** MEME mixture p (stats.py:16-32), float32 as cmd_meme writes it. */
	p_value: number;
	/** Benjamini-Hochberg q over the float32 p, float32. */
	q_value: number;
	/** True when the site was never scored (dataset.py:718-723 rule): its LRT is "not applicable". */
	is_invariable: boolean;
	/** Reference codon / amino acid at this site; absent from a bare CLI document. */
	ref_codon?: string;
	ref_aa?: string;
	/** Attribution columns (cli.py:284-291), present only for attributed sites. */
	evolutionary_epoch?: string;
	adaptation_mode?: string;
	top_driver?: string | null;
	top_mutation?: string | null;
	attribution_details?: AttributionRecord;
	/** The same two, as the prebake writes them (DM3's camelCase); derive.ts accepts either. */
	refCodon?: string;
	refAa?: string | number;
	/** DM3 view columns, when a runtime stored them; derive.ts recomputes them per call mode. */
	log_lrt?: number;
	z_score?: number;
	percentile?: number;
	call?: string;
}

/** attribution.py's per-site record (js/src/attribution.js AttributionRecord). */
export interface AttributionRecord {
	site_0indexed: number;
	site_1indexed: number;
	predicted_lrt: number;
	consensus_codon: string;
	consensus_aa: string;
	num_mutated_taxa: number;
	driving_species: DrivingSpecies[];
	when_selection_occurred: {
		evolutionary_epoch: string;
		mode_of_adaptation: string;
		weighted_patristic_depth: number;
		tree_depth_ratio: number;
	};
}

export interface DrivingSpecies {
	taxon: string;
	taxon_index: number;
	observed_codon: string;
	observed_aa: string;
	consensus_codon: string;
	consensus_aa: string;
	delta_lrt: number;
	pct_signal_explained: number;
	mean_patristic_depth: number;
}

/** `cmd_meme --filter`'s `artifacts_masked` record (filter.js CliArtifactRecord), 1-indexed. */
export interface MaskedPatch {
	start: number;
	end: number;
	span: number;
	outlier_taxon: string;
	consecutive_mismatches: number;
	oci: number;
	/** run_alignment_filter's richer record carries these; shown when present. */
	outlier_aa_sequence?: string;
	consensus_aa_sequence?: string;
	p_hypergeom?: number;
	significant_sites_k?: number;
	mean_raw_patch_lrt?: number;
}

export interface FilterBlock {
	enabled: boolean;
	artifacts_masked: MaskedPatch[];
	/** `masked_codon_ranges_1idx_by_taxon` from the filter result, when the runtime kept it. */
	masked_codon_ranges_1idx_by_taxon?: Record<string, number[][]>;
	/** The alignment before masking, for the before/after snippet; absent when not kept. */
	raw_alignment?: AlignmentBlock;
	/** Per-site raw LRT/p/q before masking (filter.js `sites[].raw_*`), when kept. */
	raw_sites?: { site: number; raw_lrt: number; raw_p_value: number; raw_q_value: number }[];
	raw_metrics?: FilterMetrics;
	cleaned_metrics?: FilterMetrics;
}

export interface FilterMetrics {
	cct_p_value: number;
	sig_sites_p05: number;
	sig_sites_q10: number;
	mean_lrt: number;
}

/** The taxa the model saw, in the order it saw them, with their aligned sequences. */
export interface AlignmentBlock {
	names: string[];
	sequences: string[];
}

export interface ProvenanceWarning {
	code: string;
	severity: 'info' | 'warn' | 'error' | string;
	message: string;
	[extra: string]: unknown;
}

/** PLAN.md §3.5's provenance block, as runtime/src/pipeline.js writes it. */
export interface Provenance {
	schema_version: number;
	surface: 'browser' | 'node-server' | 'mcp-stdio' | 'mcp-http' | 'python-reference' | string;
	hyphaeon_js_version: string | null;
	reference_version: string | null;
	model_version: string | null;
	model_variant: string | null;
	artifact_sha256: string | null;
	artifact_verified?: boolean;
	is_surrogate: boolean;
	surrogate_for: string;
	seed: number | null;
	elapsed_sec: number | null;
	options: Record<string, unknown>;
	preprocessing: {
		taxa_in_alignment: number;
		taxa_used: number;
		dropped_taxa: string[];
		duplicates_collapsed: number;
		pd_subsampled: boolean;
		taxon_cap?: number;
		reference_sequence: string | null;
		tree_source: string;
		branch_lengths_estimated: boolean;
		distance_rescaled: boolean;
		distances_clamped?: number;
		codons_trimmed: number;
		unknown_codon_fraction: number;
		in_frame_stops: number | null;
		[extra: string]: unknown;
	};
	/** loadAlignmentAndTree's notices (branchLengthsMissing, ...), when the runtime kept them. */
	notices?: Record<string, unknown>;
	warnings: ProvenanceWarning[];
	/** Version strings the surface knows about (ORT, threads, browser), free-form. */
	versions?: Record<string, string | number | null>;
	[extra: string]: unknown;
}

export interface ResultSummary {
	totalSites: number;
	variableSites: number;
	calledSites?: number;
	speciesUsed: number;
	speciesInAlignment: number;
	referenceSequence?: string | null;
	callMode?: string;
	matchedFromTree?: boolean;
	duplicateSelections?: number;
	clampedDistances?: number;
	mostNegativeDistance?: number;
	treeWarnings?: string[];
	[extra: string]: unknown;
}

/** A stored or bundled site-selection result. */
export interface MemeRecord {
	/** Storage id (IndexedDB key) or gallery name. */
	id?: string;
	/** Display name: the alignment file name or the gallery example. */
	name?: string;
	/** ISO timestamp of the run, when stored. */
	created_at?: string;
	schema_version: number;
	method: 'meme';
	is_surrogate: boolean;
	surrogate_for: string;
	sites: SiteRecord[];
	summary: ResultSummary;
	provenance: Provenance;
	/** The Newick tree ACTUALLY used (estimated or supplied), for the site tree and the download. */
	tree?: string | null;
	/** The selected taxa and sequences the model saw, for entropy, spark bars and tip states. */
	alignment?: AlignmentBlock | null;
	filter?: FilterBlock | null;
	/** attribution.py records keyed by the 1-indexed site as a string (cli.py:307). */
	attributions?: Record<string, AttributionRecord> | null;
	/** Which tier-calling modes the runtime supports; derive.ts falls back to its own list. */
	callModes?: string[];
	/** `hyphaeon meme` top-level fields kept verbatim from a CLI document, when converted. */
	cli?: Record<string, unknown>;
	/**
	 * The runtime's per-site arrays (`lrt`, `p_value`, `q_value`, `invariable`, float32 as the
	 * CLI casts them) and its attribution map, when the record came from runMeme; the downloads
	 * hand these to runtime/src/results.js so the files are the CLI's bytes.
	 */
	arrays?: {
		lrt: ArrayLike<number>;
		p_value: ArrayLike<number>;
		q_value: ArrayLike<number>;
		invariable: ArrayLike<number | boolean>;
		raw?: unknown;
	} | null;
	attributionRecords?: Record<string, AttributionRecord> | null;
}

/** What the MCP tool call would need to reproduce this run (mcpSnippet.ts reads it). */
export interface ReproductionInputs {
	alignmentName: string;
	treeName: string | null;
	options: Record<string, unknown>;
}
