/**
 * newick.ts — find the Newick STRING embedded in an alignment, for the tools that want text.
 *
 * WHY THIS FILE EXISTS. The library's `extractTree` (js/src/preprocess/tree.js, mirroring
 * dataset.py:161-212 `extract_tree_from_string_or_file`) returns a parsed PhyloTree, which is
 * what the model pipeline needs. Two app-side consumers need the Newick text instead: the
 * prescreen (runtime/src/prescreen, DM3's XGBoost gate, which reads a Newick string) and HyPhy's
 * HKY85 script (which is handed the tree as text), plus the stored record's `tree` field for an
 * embedded tree. This is the same two-step search as the reference — the NEXUS/HyPhy `TREE x =
 * (...);` command first (HyPhy `{...}` tags and `[...]` comments stripped, dataset.py:171-173),
 * else the first line that starts with '(' and holds at least two '(' (dataset.py:178-190) —
 * returning the text rather than the parse.
 */

/** `tree <name> = (...);` — tree.js's TREE_COMMAND_RE. */
const TREE_COMMAND_RE = /tree\s+[^=]+=\s*(\([^;]+;)/iu;

function cleanNewick(s: string): string {
	return s.replace(/\{[^}]*\}/g, '').replace(/\[[^\]]*\]/g, '');
}

/** The embedded Newick text, or null when the alignment carries none. */
export function embeddedNewick(alignmentText: string): string | null {
	const m = TREE_COMMAND_RE.exec(alignmentText);
	if (m) return cleanNewick(m[1]).trim();
	for (const line of alignmentText.split(/\r?\n/)) {
		const t = line.trim();
		if (t.startsWith('(') && (t.match(/\(/g) ?? []).length >= 2) {
			return cleanNewick(t.endsWith(';') ? t : `${t};`);
		}
	}
	return null;
}
