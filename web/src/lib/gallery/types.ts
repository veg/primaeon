/**
 * types.ts — the shape of static/gallery/index.json.
 *
 * WHY THIS FILE EXISTS. The gallery index is hand-maintained JSON in static/ so it can be served
 * as-is and read by the MCP's `hyphaeon://examples/{name}` resource later without a build step.
 * This is its type, and the one place to change when the index gains a field.
 */

export type Pillar = 'meme' | 'busted' | 'epistasis' | 'dms' | 'phenotype';

export interface GalleryEntry {
	/** Stable id, equal to the example's file stem in `HyphAeon/examples/`. */
	id: string;
	name: string;
	gene: string;
	/** One line: organism group and the biology the example is known for. */
	description: string;
	/** Rows and columns of the alignment as the reference run saw them; null when not shipped. */
	taxa: number | null;
	codons: number | null;
	/** Where the tree comes from. `none` means the example ships results only. */
	tree: 'file' | 'embedded' | 'none';
	/**
	 * `full`: alignment (and tree) are bundled, so the example can be re-run in the browser.
	 * `results-only`: only the reference run's outputs are bundled; the alignment is not shipped.
	 */
	kind: 'full' | 'results-only';
	/** Pillars for which a prebaked result exists in `HyphAeon/examples/`. */
	analyses: Pillar[];
	/** Source files in `HyphAeon/examples/`, relative to that directory. */
	sources: {
		alignment?: string;
		tree?: string;
		results: string[];
	};
	/** Measured wall time of the Python reference on a laptop CPU, PLAN.md §1, when recorded. */
	reference_seconds?: Partial<Record<Pillar, number>>;
}

export interface GalleryIndex {
	schema_version: 1;
	/** Engine commit the sources and results were taken from. */
	engine_commit: string;
	entries: GalleryEntry[];
}
