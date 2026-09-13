/*
	+page.ts (/reports) — load the study index: the gene catalogue and the genome map ONLY.

	WHY THIS FILE EXISTS. REPORTS_PLAN.md §5 (revised): /reports is the study INDEX — the genome
	overview and one card per gene, each linking to /reports/<gene>/. It must NOT load every gene
	record: rendering all 22 genes' panels and per-site tables on one page produced a ~326,000 px
	page the browser could not lay out (S alone is 861 rows). The heavy per-gene content moved to
	the [gene] route. This loader stays tiny: index.json + genome-map.json. Prerendered via the root
	+layout.ts (`prerender = true`, `trailingSlash = 'always'`).
*/

import type { PageLoad } from './$types';
import { loadGenomeMap, loadIndex } from '$lib/temporal/load';

export const load: PageLoad = async ({ fetch }) => {
	const [index, genomeMap] = await Promise.all([loadIndex(fetch), loadGenomeMap(fetch)]);
	return { index, genomeMap };
};
