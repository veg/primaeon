/**
 * downloads.ts — the files a report offers: the whole record as JSON, the site table as the CLI's
 * CSV, the co-selection network as GraphML, and the tree as Newick.
 *
 * WHY THIS FILE EXISTS. PLAN.md §4.5: downloads on every page, written by the library's writers so
 * they are the reference CLI's bytes (parity class "exact"). The site CSV and the `hyphaeon meme`
 * JSON come from lib/results/downloads.ts unchanged (the `sites` section IS a MemeRecord). New
 * here: the GraphML is the library's `graphml(edges)` — `nx.write_graphml` in its lxml layout,
 * cli.py:821-833, over the `edges` the epistasis section carries — and the report JSON is the
 * ReportRecord with the input TEXTS removed (`inputs.alignmentText`, `inputs.treeText` live in
 * IndexedDB for the re-run; a downloaded report should carry the hashes, not the sequences, so the
 * file can be shared the way the record cannot).
 */

import type { ReportRecord } from '$lib/api';
import { downloadText, fileStem as memeStem, resultCsvText, resultJsonText } from '$lib/results/downloads';

export { downloadText };

export function reportStem(record: ReportRecord): string {
	const name = record.name || record.inputs.alignmentName || 'hyphaeon';
	return name.replace(/(\.nex|\.nexus|\.fasta|\.fas|\.fa|\.fna|\.faa|\.phy|\.phylip)(\.gz)?$/i, '') || 'hyphaeon';
}

/** The report without the input texts, as `JSON.stringify(indent 2)`. */
export function reportJsonText(record: ReportRecord): string {
	const { alignmentText, treeText, ...inputs } = record.inputs;
	void alignmentText;
	void treeText;
	const doc = { ...record, inputs };
	return JSON.stringify(doc, replacer, 2);
}

/** Typed arrays (a stored `arrays` block) as plain arrays; Maps as objects. */
function replacer(_key: string, value: unknown): unknown {
	if (value instanceof Map) return Object.fromEntries(value);
	if (ArrayBuffer.isView(value) && !(value instanceof DataView)) return Array.from(value as unknown as ArrayLike<number>);
	return value;
}

export async function sitesCsvText(record: ReportRecord): Promise<string | null> {
	if (!record.sections.sites) return null;
	return resultCsvText(record.sections.sites);
}

export async function sitesJsonText(record: ReportRecord): Promise<string | null> {
	if (!record.sections.sites) return null;
	return resultJsonText({ ...record.sections.sites, name: record.sections.sites.name ?? memeStem(record.sections.sites) });
}

/** cli.py:821-833's GraphML over the epistasis edges; null when the section has none. */
export async function graphmlText(record: ReportRecord): Promise<string | null> {
	const edges = record.sections.epistasis?.edges;
	if (!edges || edges.length === 0) return null;
	const { graphml } = await import('@veg/hyphaeon-js');
	return graphml(edges);
}

export function newickText(record: ReportRecord): string | null {
	const tree = record.sections.sites?.tree ?? record.inputs.treeText ?? null;
	return tree ? tree.trim() + '\n' : null;
}
