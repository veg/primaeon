/**
 * sources.ts — telling the dropped files apart, and the sequence-name/header pair the date layer
 * is fed.
 *
 * WHY THIS FILE EXISTS, PART ONE. `/time` accepts up to four kinds of file at one drop target: an
 * alignment, a Newick tree, a metadata table and a Nextstrain JSON. `lib/analyze/sniff.ts` already
 * tells FASTA from NEXUS from PHYLIP, and the runtime's `detectDateSourceKind` already tells an
 * Auspice build from a flat name-to-date JSON from a delimited table. Neither knows about the
 * other's files, and the routing decision — "which of these four did the reader just give me" — is
 * the page's. It is made from the CONTENT, with the file name as a hint only, because the two
 * reference pillars disagree about extensions (temporal.py:274 sniffs, dating.py:445 decides by
 * suffix) and a tab-separated `.csv` is common enough to be worth getting right.
 *
 * WHY THIS FILE EXISTS, PART TWO, AND IT IS THE TRAP THIS PHASE MOST HAD TO AVOID.
 * `sniff.ts:sequenceNames()` takes a FASTA name as the header UP TO THE FIRST WHITESPACE, and the
 * library's own parser does the same. But the library's header date patterns accept whitespace as a
 * date delimiter (`[\|/_\s]`), so in `>A/Darwin/6 2021` the date lives in exactly the part the name
 * throws away. A page that fed the date layer its names would report "no date found" on a file the
 * command line dates correctly, and would do it silently.
 *
 * So the ingest contract is a PAIR per sequence: the KEY (what the library will index by, what
 * matches a tree tip and a metadata row) and the HEADER (the whole `>` line, which is what a date
 * is read from). `alignmentHeaders()` builds both, `headerOf` is handed to `ingestDates`, and the
 * review table shows the key in column 1 and the matched substring in column 6.
 */

import { detectDateSourceKind } from '@veg/hyphaeon-runtime/dates';
import { sniffFormat } from '$lib/analyze/sniff';

/** What a dropped file is, for routing. `date-source` splits further via `dateSourceKind`. */
export type DroppedKind = 'alignment' | 'tree' | 'table' | 'auspice' | 'json-map' | 'beast' | 'unknown';

const TREE_EXT = /\.(nwk|newick|tree|tre)$/i;
const TABLE_EXT = /\.(csv|tsv|tab|txt)$/i;

/**
 * Classify one dropped file from its first bytes, with the name as a hint.
 *
 * The order matters: an alignment is recognised first (a `>` or `#NEXUS` or a PHYLIP dimensions
 * line is unambiguous), then JSON by its first non-space character, then a Newick tree, and a
 * delimited table last — because "text with separators in it" is the loosest test of the four and
 * would otherwise claim everything.
 */
export function classifyDropped(text: string, fileName = ''): DroppedKind {
	const head = text.slice(0, 4096);
	const trimmed = head.replace(/^﻿/, '').trimStart();

	if (/\.xml$/i.test(fileName) || /^<\?xml|^<beast/i.test(trimmed)) return 'beast';

	if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
		const kind = detectDateSourceKind(text, fileName);
		return kind === 'auspice' || kind === 'json-map' ? kind : 'unknown';
	}

	const format = sniffFormat(text);
	if (format === 'fasta' || format === 'nexus' || format === 'phylip') return 'alignment';

	// A Newick tree: opens with '(' and closes with ';'. `.nwk` alone is not enough — the landing
	// page's own routing already treats a NEXUS file carrying a TREES block as an alignment.
	if (trimmed.startsWith('(') && /\)\s*[^;]*;/.test(trimmed)) return 'tree';
	if (TREE_EXT.test(fileName) && trimmed.startsWith('(')) return 'tree';

	const kind = detectDateSourceKind(text, fileName);
	if (kind === 'table') return 'table';
	if (TABLE_EXT.test(fileName) && /[\t,;|]/.test(head)) return 'table';
	return 'unknown';
}

/** True for the three things the date layer can read dates out of. */
export function isDateSource(kind: DroppedKind): boolean {
	return kind === 'table' || kind === 'auspice' || kind === 'json-map';
}

export interface AlignmentNames {
	/** The identifiers the library will index by, in file order. */
	keys: string[];
	/** key → the whole header line (minus the `>`); see the header, part two. */
	headerOf: Map<string, string>;
	/** True where at least one header carries more than its key — the whitespace case. */
	headersDiffer: boolean;
}

/**
 * The `{key, header}` pairs, from the alignment text alone.
 *
 * FASTA only carries a header beyond the name; NEXUS and PHYLIP names ARE the whole record, so for
 * those the header equals the key and `headersDiffer` is false. The key is the first
 * whitespace-delimited token, which is what `parseAlignmentSequences` uses.
 */
export function alignmentHeaders(text: string): AlignmentNames {
	const keys: string[] = [];
	const headerOf = new Map<string, string>();
	let headersDiffer = false;
	if (sniffFormat(text) !== 'fasta') {
		return { keys, headerOf, headersDiffer };
	}
	for (const line of text.split(/\r?\n/)) {
		if (!line.startsWith('>')) continue;
		const header = line.slice(1).trim();
		if (!header) continue;
		const key = header.split(/\s+/)[0] ?? '';
		if (!key) continue;
		if (!headerOf.has(key)) {
			keys.push(key);
			headerOf.set(key, header);
		}
		if (header !== key) headersDiffer = true;
	}
	return { keys, headerOf, headersDiffer };
}
