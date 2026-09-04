/**
 * sniff.ts — cheap, header-only inspection of a pasted or dropped alignment, for the upload card.
 *
 * WHY THIS FILE EXISTS. The /analyze page needs three things before the pipeline exists: the list
 * of sequence names (to populate the reference-sequence dropdown), whether the file carries an
 * embedded tree (to say "tree found, upload optional"), and whether a dropped file is gzipped (to
 * inflate it with pako before showing it). None of that is parsing. The real parsers — FASTA,
 * NEXUS, PHYLIP, the HyPhy WASM conversion fallback — are `@veg/hyphaeon-js`'s and land in Phase 1
 * (PLAN.md §4.2, §5.1 `dataset.py` row); this file must never grow into a second copy of them.
 *
 * Everything here is deliberately lossy: FASTA names are the header up to the first whitespace,
 * NEXUS names are read from TAXLABELS only, PHYLIP names are the first token of each body line
 * after the dimensions line. When the sniff disagrees with the library later, the library wins.
 */

/** Gzip magic bytes, RFC 1952 §2.3.1: ID1 = 0x1f, ID2 = 0x8b. */
export function looksLikeGzip(bytes: Uint8Array): boolean {
	return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

export type AlignmentFormat = 'fasta' | 'nexus' | 'phylip' | 'unknown';

/** Format from the first non-blank line, the way a person would tell them apart. */
export function sniffFormat(text: string): AlignmentFormat {
	const first = text.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? '';
	if (first.startsWith('>')) return 'fasta';
	if (/^#NEXUS/i.test(first)) return 'nexus';
	// PHYLIP: "<ntaxa> <nsites>" and nothing else on the first line.
	if (/^\d+\s+\d+$/.test(first)) return 'phylip';
	return 'unknown';
}

/** True when a NEXUS file carries a TREES block (RHO.fasta in the bundled examples does). */
export function hasEmbeddedTree(text: string): boolean {
	return /^\s*BEGIN\s+TREES\s*;/im.test(text);
}

/** Sequence names in file order, or [] when the format is not recognised. */
export function sequenceNames(text: string): string[] {
	switch (sniffFormat(text)) {
		case 'fasta':
			return fastaNames(text);
		case 'nexus':
			return nexusNames(text);
		case 'phylip':
			return phylipNames(text);
		default:
			return [];
	}
}

function fastaNames(text: string): string[] {
	const names: string[] = [];
	for (const line of text.split(/\r?\n/)) {
		if (line.startsWith('>')) {
			const name = line.slice(1).trim().split(/\s+/)[0] ?? '';
			if (name) names.push(name);
		}
	}
	return names;
}

function nexusNames(text: string): string[] {
	const m = /TAXLABELS\s+([\s\S]*?);/i.exec(text);
	if (!m) return [];
	return m[1]
		.split(/\s+/)
		.map((t) => t.replace(/^'|'$/g, ''))
		.filter((t) => t.length > 0);
}

function phylipNames(text: string): string[] {
	const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
	const header = /^(\d+)\s+\d+$/.exec(lines[0]?.trim() ?? '');
	if (!header) return [];
	const n = Number(header[1]);
	const names: string[] = [];
	for (const line of lines.slice(1, 1 + n)) {
		const name = line.trim().split(/\s+/)[0] ?? '';
		if (name) names.push(name);
	}
	return names;
}

/**
 * Rough codon length of the first sequence, for the summary line only. Counts every character
 * that is not whitespace on the sequence lines of the first FASTA record; other formats return
 * null rather than a guess.
 */
export function approximateCodonLength(text: string): number | null {
	if (sniffFormat(text) !== 'fasta') return null;
	let inFirst = false;
	let length = 0;
	for (const line of text.split(/\r?\n/)) {
		if (line.startsWith('>')) {
			if (inFirst) break;
			inFirst = true;
			continue;
		}
		if (inFirst) length += line.replace(/\s+/g, '').length;
	}
	return length > 0 ? Math.floor(length / 3) : null;
}
