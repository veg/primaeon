/**
 * displayTree.ts — which tree the report DRAWS, and what to call it.
 *
 * WHY THIS FILE EXISTS. D22 split one thing into two. Until Phase 3 the tree in a record was the
 * tree the model was given: the site-tree modal drew it, the phenotype picker would pick on it, and
 * the provenance named it, all from `sections.sites.tree`. Now a run can have no tree at all — the
 * library takes pairwise TN93 distances straight into the MDS — while the report still needs a
 * topology to draw parsimony substitutions on and to pick a foreground from. The runtime supplies
 * one for exactly that purpose, attached to the record as a DISPLAY tree, and since Phase 4 it is
 * one of two things (runtime/src/pipeline.js `displayTreeFor`, PLAN.md D6):
 *
 *   user-topology  the reader's OWN topology when the upload carried a tree without usable branch
 *                  lengths — pruned to the taxa the model saw and written with unit lengths, which
 *                  are a drawing convention and not a fit; the model read TN93 distances
 *   nj             a neighbour-joining tree on those same TN93 distances (runtime's `nj.js`) when
 *                  the upload carried no tree at all, or the topology could not be matched
 *
 * So every place that draws a tree has to answer two questions instead of one — which Newick, and
 * whether the model ever saw it — and it must answer them the same way in the modal, in the
 * foreground picker and in the provenance block. That is this file.
 *
 * WHERE THE FIELDS ARE LOOKED FOR. The runtime puts the display tree on the `sites` section as
 * `display_tree` — `{newick, source: 'user' | 'user-topology' | 'nj', from: 'tree-text' |
 * 'alignment' | 'tn93', taxa, label?}` — and repeats its source in the preprocessing block as
 * `display_tree_source`. Both are read here, and the run's own tree (`sections.sites.tree`, or the
 * input text) is the fallback for a record written before Phase 3, which has no display tree and
 * for which the two things were the same. A Phase 3 record of a topology-only upload says `nj`
 * (that is what it drew) and keeps saying so: the label is decided by what was drawn, never
 * rewritten from what a newer runtime would draw.
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

/**
 * The caption under a `user-topology` tree. The runtime writes the same words into
 * `display_tree.label` (pipeline.js `USER_TOPOLOGY_LABEL`); this copy is for a record whose
 * runtime did not, and the two are kept identical so the modal and the MCP say one thing.
 */
export const USER_TOPOLOGY_LABEL = 'your topology; branch lengths not estimated (model used TN93 distances)';

const NJ_LABEL = 'Display only, built from the TN93 distances: this run was tree-free, so the model was given those distances and never this topology.';

function pre(record: ReportRecord): Record<string, unknown> {
	const a = (record.provenance?.preprocessing ?? {}) as Record<string, unknown>;
	const b = (record.sections.sites?.provenance?.preprocessing ?? {}) as Record<string, unknown>;
	return { ...b, ...a };
}

function text(value: unknown): string | null {
	return typeof value === 'string' && value.trim().startsWith('(') ? value.trim() : null;
}

/** The runtime's `display_tree`: an object with a `newick`, or (defensively) a bare Newick string. */
function fromDisplayTree(value: unknown): { newick: string | null; source: string | null; label: string | null } {
	if (typeof value === 'string') return { newick: text(value), source: null, label: null };
	if (value && typeof value === 'object') {
		const o = value as { newick?: unknown; source?: unknown; label?: unknown };
		return {
			newick: text(o.newick),
			source: typeof o.source === 'string' ? o.source : null,
			label: typeof o.label === 'string' && o.label.trim() ? o.label : null
		};
	}
	return { newick: null, source: null, label: null };
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
		: declaredSource === 'user-topology'
			? 'user-topology'
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
				: source === 'user-topology'
					? `Display only — ${declared.label ?? USER_TOPOLOGY_LABEL}. This run was tree-free: the model was given TN93 distances from the alignment, and the unit branch lengths drawn here are a convention, not a fit.`
					: NJ_LABEL
	};
}
