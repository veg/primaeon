/*
	load.ts — fetch the study index, genome map, and per-gene temporal records from static/temporal/.

	WHY THIS FILE EXISTS. REPORTS_PLAN.md §5: the /reports page reads the DAA-safe JSON the prebake
	wrote under web/static/temporal/, through `base` so the same build works at the origin root and
	under a sub-path (svelte.config.js), exactly as report/load.ts fetches a gallery record from
	`${base}/gallery/<name>.json`. No computation, no per-sequence data — just the aggregates.
*/

import { base } from '$app/paths';
import type { GenomeMap, TemporalGeneRecord, TemporalIndex } from './types';

async function fetchJson<T>(fetchImpl: typeof fetch, path: string): Promise<T> {
	const response = await fetchImpl(`${base}${path}`);
	if (!response.ok) throw new Error(`temporal: ${path} -> ${response.status}`);
	return (await response.json()) as T;
}

export function loadIndex(fetchImpl: typeof fetch): Promise<TemporalIndex> {
	return fetchJson<TemporalIndex>(fetchImpl, '/temporal/index.json');
}

export function loadGenomeMap(fetchImpl: typeof fetch): Promise<GenomeMap> {
	return fetchJson<GenomeMap>(fetchImpl, '/temporal/genome-map.json');
}

export function loadGene(fetchImpl: typeof fetch, gene: string): Promise<TemporalGeneRecord> {
	return fetchJson<TemporalGeneRecord>(fetchImpl, `/temporal/${encodeURIComponent(gene)}.json`);
}
