/*
	+page.ts (/reports/[gene]) — load one gene's temporal record.

	WHY THIS FILE EXISTS. REPORTS_PLAN.md §5 (revised): each gene's full report is its own page so
	the browser never has to lay out all 22 at once. `entries()` lists the genes for the prerenderer
	(adapter-static builds one HTML file per returned param); it reads index.json so the set always
	matches what the prebake wrote. `load` fetches just that gene's record. Prerendered via the root
	+layout.ts. A gene not in the index 404s (error()).
*/

import { error } from '@sveltejs/kit';
import type { EntryGenerator, PageLoad } from './$types';
import { loadGene, loadIndex } from '$lib/temporal/load';
import indexJson from '../../../../static/temporal/index.json';

export const entries: EntryGenerator = () => {
	// Enumerate genes for the prerenderer straight from the committed index (no fetch at build).
	return (indexJson as { genes: { gene: string }[] }).genes.map((g) => ({ gene: g.gene }));
};

export const load: PageLoad = async ({ fetch, params }) => {
	const index = await loadIndex(fetch);
	const entry = index.genes.find((g) => g.gene === params.gene);
	if (!entry) throw error(404, `No temporal report for region “${params.gene}”.`);
	const record = await loadGene(fetch, params.gene);
	return { record, index };
};
