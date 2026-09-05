/**
 * displayTree.ts — which tree the report DRAWS, and what to call it.
 *
 * WHY THIS FILE EXISTS. D22 split one thing into two. Until Phase 3 the tree in a record was the
 * tree the model was given: the site-tree modal drew it, the phenotype picker would pick on it, and
 * the provenance named it, all from `sections.sites.tree`. Now a run can have no tree at all — the
 * library takes pairwise TN93 distances straight into the MDS — while the report still needs a
 * topology to draw parsimony substitutions on and to pick a foreground from. The runtime supplies
 * one for exactly that purpose: a neighbour-joining tree on the same TN93 distances (runtime's
 * `nj.js`), attached to the record as a DISPLAY tree.
 *
 * So every place that draws a tree has to answer two questions instead of one — which Newick, and
 * whether the model ever saw it — and it must answer them the same way in the modal, in the
 * foreground picker and in the provenance block. That is this file.
 *
 * WHERE THE FIELDS ARE LOOKED FOR. The runtime puts the display tree on the `sites` section as
 * `display_tree` — `{newick, source: 'user' | 'nj', from: 'tree-text' | 'alignment' | 'tn93',
 * taxa}` (runtime/src/pipeline.js `displayTreeFor`) — and repeats its source in the preprocessing
 * block as `display_tree_source`. Both are read here, and the run's own tree
 * (`sections.sites.tree`, or the input text) is the fallback for a record written before Phase 3,
 * which has no display tree and for which the two things were the same.
 *
 * `modelSawIt` is decided by `tree_source`, not by the display tree's own `source`: the runtime
 * calls a tree it took from the alignment 'user' (its `from` says which), and the one question this
 * file exists to answer is whether the topology on screen is the object the numbers came from.
 */

import type { DisplayTreeSource, ReportRecord } from '$lib/api';

export interface DisplayTree {
	/** The Newick to draw, or null when the record carries none. */
	newick: string | null;
	source: DisplayTreeSource | null;
	/** False when the model was given distances instead of this topology (a tree-free run). */
	modelSawIt: boolean;
	/** One line for a caption, always safe to print. */
	label: string;
}

function pre(record: ReportRecord): Record<string, unknown> {
	const a = (record.provenance?.preprocessing ?? {}) as Record<string, unknown>;
	const b = (record.sections.sites?.provenance?.preprocessing ?? {}) as Record<string, unknown>;
	return { ...b, ...a };
}

function text(value: unknown): string | null {
	return typeof value === 'string' && value.trim().startsWith('(') ? value.trim() : null;
}

/** The runtime's `display_tree`: an object with a `newick`, or (defensively) a bare Newick string. */
function fromDisplayTree(value: unknown): { newick: string | null; source: string | null } {
	if (typeof value === 'string') return { newick: text(value), source: null };
	if (value && typeof value === 'object') {
		const o = value as { newick?: unknown; source?: unknown };
		return { newick: text(o.newick), source: typeof o.source === 'string' ? o.source : null };
	}
	return { newick: null, source: null };
}

export function displayTree(record: ReportRecord): DisplayTree {
	const block = pre(record);
	const sites = record.sections.sites as (typeof record.sections.sites & { display_tree?: unknown }) | null;
	const treeFree = record.inputs.treeSource === 'tn93' || block.tree_source === 'tn93';
	const declared = fromDisplayTree(sites?.display_tree);
	const newick = declared.newick ?? text(sites?.tree) ?? text(record.inputs.treeText) ?? null;
	const declaredSource = declared.source ?? (typeof block.display_tree_source === 'string' ? block.display_tree_source : null);
	const source: DisplayTreeSource | null = !newick
		? null
		: treeFree || declaredSource === 'nj'
			? 'nj'
			: record.inputs.treeSource === 'embedded' || block.tree_source === 'embedded'
				? 'embedded'
				: 'user';
	const modelSawIt = Boolean(newick) && !treeFree;
	return {
		newick,
		source,
		modelSawIt,
		label: !newick
			? 'No tree is stored with this report.'
			: modelSawIt
				? source === 'embedded'
					? 'The tree embedded in the alignment — the one the model was given.'
					: 'The tree supplied with the alignment — the one the model was given.'
				: 'Display only, built from the TN93 distances: this run was tree-free, so the model was given those distances and never this topology.'
	};
}
