/**
 * downloads.ts — JSON, CSV and Newick downloads of a result.
 *
 * WHY THIS FILE EXISTS. The files a reader downloads must be the files the reference CLI writes,
 * byte for byte where the library can manage it (PLAN.md §5.4: writers are parity class "exact"),
 * so a browser result feeds `hyphaeon evaluate` and the parity harness unchanged. The writers are
 * the library's `memeJson` / `memeCsv` (js/src/writers.js, `json.dump(indent=2)` and pandas
 * `to_csv` semantics), reached two ways depending on what the record carries:
 *
 *   - A record from the runtime (the analyze flow, the gallery prebake) keeps runMeme's `arrays`
 *     (float32 lrt / p / q / invariable) and `attributionRecords`; runtime/src/results.js's
 *     `memeJsonText` / `memeCsvText` build the CLI document from those, so the bytes are exactly
 *     the CLI's for the same numbers. Preferred whenever `arrays` is present.
 *   - A record without them (a converted CLI document, an older store) is reduced to the CLI's
 *     site fields here (`cliDocument`) and handed to the library writers directly.
 *
 * Both paths are dynamic imports, so the results page bundle does not carry the writers until a
 * download is clicked. The JSON document is the CLI's shape (memeResult in writers.js:
 * alignment, tree, taxa_count, codon_count, runtime_sec, filter_enabled, artifacts_masked,
 * attribution_enabled, attributions, sites) with the app's `provenance` block appended, which
 * `parity.py` ignores as an extra key (PARITY.md "Extra keys ... are ignored"). Site records are
 * reduced to the CLI's fields so the app's view columns never leak into a file that claims parity.
 *
 * Downloads use a Blob URL and a synthetic click as axomeme3 does (setupDownloadCSV, line 4400).
 */

import type { MemeRecord, SiteRecord } from './types';

const CLI_SITE_KEYS = [
	'site',
	'hyphaeon_lrt',
	'p_value',
	'q_value',
	'is_invariable',
	'evolutionary_epoch',
	'adaptation_mode',
	'top_driver',
	'top_mutation',
	'attribution_details'
] as const;

/** A site reduced to what `hyphaeon meme` writes (cli.py:280-296). */
export function cliSite(s: SiteRecord): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const k of CLI_SITE_KEYS) if (s[k] !== undefined) out[k] = s[k];
	return out;
}

/** The CLI document for this record, plus provenance. */
export function cliDocument(record: MemeRecord): Record<string, unknown> {
	const treeSource = record.provenance?.preprocessing?.tree_source;
	return {
		alignment: record.name ?? (record.cli?.alignment as string | undefined) ?? 'alignment',
		tree:
			(record.cli?.tree as string | undefined) ??
			(treeSource === 'embedded' ? 'embedded_in_alignment' : treeSource ? `${treeSource}.nwk` : null),
		taxa_count: record.summary?.speciesUsed ?? record.provenance?.preprocessing?.taxa_used ?? null,
		codon_count: record.sites.length,
		runtime_sec: record.provenance?.elapsed_sec ?? null,
		filter_enabled: Boolean(record.filter?.enabled),
		artifacts_masked: record.filter?.artifacts_masked ?? [],
		attribution_enabled: Boolean(record.attributions && Object.keys(record.attributions).length > 0),
		attributions: record.attributions ?? {},
		sites: record.sites.map(cliSite),
		provenance: record.provenance
	};
}

/** Whether the record carries runMeme's arrays, so the runtime writers can take it as is. */
export function isRuntimeShaped(record: MemeRecord): boolean {
	const a = record.arrays;
	return Boolean(a && a.lrt && a.p_value && a.q_value && a.invariable && a.lrt.length === record.sites.length);
}

export async function resultJsonText(record: MemeRecord): Promise<string> {
	if (isRuntimeShaped(record)) {
		const { memeJsonText } = await import('@veg/hyphaeon-runtime');
		return memeJsonText(record, { alignment: record.name ?? (record.cli?.alignment as string | undefined) });
	}
	const { memeJson } = await import('@veg/hyphaeon-js');
	return memeJson(cliDocument(record));
}

export async function resultCsvText(record: MemeRecord): Promise<string> {
	if (isRuntimeShaped(record)) {
		const { memeCsvText } = await import('@veg/hyphaeon-runtime');
		return memeCsvText(record);
	}
	const { memeCsv } = await import('@veg/hyphaeon-js');
	return memeCsv(record.sites.map(cliSite));
}

/** File-name stem from the record name, as axomeme3 strips the alignment extension. */
export function fileStem(record: MemeRecord): string {
	const name = record.name ?? record.id ?? 'hyphaeon';
	return name.replace(/(\.nex|\.nexus|\.fasta|\.fas|\.fa|\.fna|\.faa|\.phy|\.phylip)(\.gz)?$/i, '') || 'hyphaeon';
}

/** Trigger a browser download of `text`. */
export function downloadText(filename: string, text: string, type = 'text/plain;charset=utf-8'): void {
	const blob = new Blob([text], { type });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}
