/**
 * alignmentBlock.ts — the taxa and sequences the site views draw on, for ANY report record.
 *
 * WHY THIS FILE EXISTS. Three views need the aligned sequences of the taxa the model saw: the
 * site-tree modal (tip states and Fitch substitutions), the Manhattan entropy overlays and spark
 * bars (`siteCompositions`), and the phenotype panel (the taxon list a preset or a pasted
 * foreground is matched against). They all read `sections.sites.alignment`, an `AlignmentBlock`
 * `{names, sequences}` — which the gallery prebake and the server write, and a browser run never
 * did. PHASE3.md gap 6: the reader who just ran a report, and in particular the reader who
 * supplied no tree and wants to see the tree that was drawn for them, got "this record does not
 * carry the tree and the sequences".
 *
 * A browser record DOES carry the sequences: `inputs.alignmentText` (and `inputs.treeText`) are
 * kept in IndexedDB for "Re-run with…" (lib/report/run.svelte.ts, api.ts `ReportInputs`). So the
 * block is DERIVED here from that text, through the library's own parser, and filtered to the
 * taxa the runtime kept (`provenance.preprocessing.dropped_taxa`), exactly as
 * `web/scripts/prebake-gallery.mjs` `alignmentBlock()` builds it for the bundled examples — same
 * parser, same filter, same order (the alignment's) — so a live report and a prebaked one show the
 * same tips.
 *
 * WHY DERIVE RATHER THAN STORE THE BLOCK TOO (Phase 4, measured on the prebaked records):
 *
 *   record                Smc6 (20 × 1,097)     HIV1_RT (476 → 256 × 335)
 *   sections + text       2.01 MB (text 67 KB)  1.73 MB (text 484 KB)
 *   + alignment block     +66 KB (+3 %)         +261 KB (+15 %)
 *   codon-column store    69 KB — same bytes as the block, nothing gained
 *
 * The text is already there for the re-run and the phenotype pillar, the block is a pure function
 * of it, and parsing 0.5 MB of FASTA takes milliseconds on open. Storing the block as well would
 * carry every sequence twice per record for no view the text does not already serve. Records from
 * before Phase 2 (no text, no block) get null here and the views keep their existing notices.
 */

import { parseAlignmentSequences } from '@veg/hyphaeon-js';
import type { ReportRecord } from '$lib/api';
import type { AlignmentBlock, MemeRecord } from '$lib/results/types';

/** `preprocessing` of the record, or of its sites section (a wrapped CLI document keeps it there). */
function preprocessing(record: ReportRecord): Record<string, unknown> {
	const a = (record.provenance?.preprocessing ?? {}) as Record<string, unknown>;
	const b = (record.sections.sites?.provenance?.preprocessing ?? {}) as Record<string, unknown>;
	return { ...b, ...a };
}

/**
 * The alignment block from the stored text: every parsed sequence except the taxa the runtime
 * dropped (unmatched against the tree, collapsed duplicates, the taxon cap), in alignment order.
 * Null when the text is absent or parses to nothing. Never throws — a malformed stored text is a
 * view without overlays, not a broken report page.
 */
export function alignmentBlockFromText(alignmentText: string | null | undefined, droppedTaxa: readonly string[] = []): AlignmentBlock | null {
	if (typeof alignmentText !== 'string' || !alignmentText.trim()) return null;
	try {
		const seqs = parseAlignmentSequences(alignmentText) as Map<string, string>;
		const dropped = new Set(droppedTaxa);
		const names = Array.from(seqs.keys()).filter((n) => !dropped.has(n));
		if (names.length === 0) return null;
		return { names, sequences: names.map((n) => seqs.get(n) ?? '') };
	} catch {
		return null;
	}
}

/**
 * The block for this record: the stored one when the producer wrote it (gallery, server), else
 * derived from `inputs.alignmentText` (a browser run), else null (a pre-Phase-2 record or a bare
 * CLI document).
 */
export function alignmentBlockFor(record: ReportRecord): AlignmentBlock | null {
	const stored = record.sections.sites?.alignment;
	if (stored && stored.names.length > 0 && stored.sequences.length === stored.names.length) return stored;
	const dropped = preprocessing(record).dropped_taxa;
	return alignmentBlockFromText(record.inputs.alignmentText, Array.isArray(dropped) ? (dropped as string[]) : []);
}

/**
 * The sites section with its `alignment` filled in from wherever this record keeps it, or the
 * section as it is when nothing can supply one. The object identity is kept when nothing changes,
 * so a `$derived` over it does not re-render the table for no reason.
 */
export function sitesWithAlignment(record: ReportRecord, sites: MemeRecord | null = record.sections.sites): MemeRecord | null {
	if (!sites) return null;
	if (sites.alignment && sites.alignment.names.length > 0) return sites;
	const block = alignmentBlockFor(record);
	return block ? { ...sites, alignment: block } : sites;
}
