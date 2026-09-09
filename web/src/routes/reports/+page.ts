/*
	+page.ts (/reports) — load the temporal study: the index, the genome map, and every gene record.

	WHY THIS FILE EXISTS. REPORTS_PLAN.md §5: the /reports page is the SARS-CoV-2 temporal-selection
	study, genes as sections, prerendered by adapter-static. It reads the DAA-safe JSON the prebake
	wrote (load.ts). The route inherits `prerender = true` / `trailingSlash = 'always'` from the root
	+layout.ts, so this runs at build time and the fetched JSON is inlined into the prerendered page;
	`fetch` is SvelteKit's load `fetch`, which resolves the static assets during prerender.
*/

import type { PageLoad } from './$types';
import { loadGene, loadGenomeMap, loadIndex } from '$lib/temporal/load';

export const load: PageLoad = async ({ fetch }) => {
	const [index, genomeMap] = await Promise.all([loadIndex(fetch), loadGenomeMap(fetch)]);
	const genes = await Promise.all(index.genes.map((g) => loadGene(fetch, g.gene)));
	return { index, genomeMap, genes };
};
