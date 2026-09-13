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
 *
 * THE PHENOTYPE FILES ARE WRITTEN HERE AND NOT BY THE LIBRARY, unlike every other download on this
 * page. `cmd_phenotype` prints its record with `json.dumps` and writes no CSV at all (there is no
 * `writers.py` entry for it), so there are no reference bytes to reproduce: the JSON is the record
 * as the runtime returned it, and the CSV is its `sites` rows in the record's own key order, which
 * is the order phenotype.py:527 pushes them in. A reader who wants the CLI's file gets it from the
 * JSON; the CSV is for a spreadsheet.
 */

import type { ReportRecord } from '$lib/api';
import type { PhenotypeSection, PhenotypeSiteRecord } from './types';
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

/** The phenotype record as `cmd_phenotype` would print it (json.dumps, indent 2). */
export function phenotypeJsonText(section: PhenotypeSection): string {
	return JSON.stringify(section, replacer, 2);
}

/** The 17 site columns in the record's own order; `p_assoc_perm` is empty when it is null. */
export const PHENOTYPE_CSV_COLUMNS: readonly (keyof PhenotypeSiteRecord)[] = [
	'site',
	'ref_aa',
	'derived_aa',
	'hyphaeon_lrt',
	'p_lrt',
	'attribution_norm',
	'fg_mean_attn',
	'bg_mean_attn',
	'association_rho',
	'p_value',
	'q_value',
	'p_assoc',
	'p_assoc_parametric',
	'p_assoc_perm',
	'score',
	'foreground_freq_pct',
	'background_freq_pct'
];

function csvCell(value: unknown): string {
	if (value === null || value === undefined) return '';
	const text = String(value);
	return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function phenotypeCsvText(section: PhenotypeSection): string {
	const lines = [PHENOTYPE_CSV_COLUMNS.join(',')];
	for (const row of section.sites) lines.push(PHENOTYPE_CSV_COLUMNS.map((c) => csvCell(row[c])).join(','));
	return `${lines.join('\n')}\n`;
}
