/**
 * fitch.ts — Fitch parsimony reconstruction of a site's states on a rooted tree.
 *
 * WHY THIS FILE EXISTS. The site tree modal colours the branches along which the codon (or amino
 * acid) changed under maximum parsimony, counts those substitutions, and collapses clades with
 * none. Ported from axomeme3/index.html `updatePopupTree` (the two passes at lines 3887-3958 and
 * the collapse pass at 3960-3995): a bottom-up pass builds each node's state set (intersection of
 * the children's sets when non-empty, else their union), a top-down pass picks the parent's state
 * when it is in the set and otherwise the first non-'?' member, and a substitution is a branch
 * whose two ends carry different states neither of which is '?'. The result is one of the
 * equally parsimonious assignments, as in the original; ties resolve in child order.
 *
 * The functions take any d3-hierarchy-shaped node (`children`, `parent`, `data.name`) so they run
 * over phylotree.js's `nodes` without importing it, and they annotate the nodes in place with
 * `stateSet`, `state`, `leafState`, `hasSubtreeSubstitutions` and `collapsed`, the fields the
 * modal's stylers read.
 */

export interface FitchNode {
	children?: FitchNode[] | null;
	parent?: FitchNode | null;
	data: { name: string; [k: string]: unknown };
	stateSet?: Set<string>;
	state?: string;
	leafState?: string;
	hasSubtreeSubstitutions?: boolean;
	collapsed?: boolean;
	[k: string]: unknown;
}

export const UNKNOWN_STATE = '?';

export function isLeaf(node: FitchNode): boolean {
	return !node.children || node.children.length === 0;
}

function eachAfter(node: FitchNode, fn: (n: FitchNode) => void): void {
	for (const c of node.children ?? []) eachAfter(c, fn);
	fn(node);
}

function eachBefore(node: FitchNode, fn: (n: FitchNode) => void): void {
	fn(node);
	for (const c of node.children ?? []) eachBefore(c, fn);
}

function firstKnown(states: Iterable<string>): string {
	let first: string | undefined;
	for (const s of states) {
		if (first === undefined) first = s;
		if (s !== UNKNOWN_STATE) return s;
	}
	return first ?? UNKNOWN_STATE;
}

/** A substitution is inferred on a branch when both ends are known and differ. */
export function isSubstitution(parentState: string | undefined, childState: string | undefined): boolean {
	return (
		parentState !== undefined &&
		childState !== undefined &&
		parentState !== childState &&
		parentState !== UNKNOWN_STATE &&
		childState !== UNKNOWN_STATE
	);
}

export interface FitchResult {
	/** Branches with a state change, both ends known. */
	substitutions: number;
	/** The leaf states as assigned, by taxon name. */
	leafStates: Map<string, string>;
}

/**
 * Assign states to every node of `root` for one site.
 *
 * @param root the tree root (annotated in place)
 * @param leafState the observed state of a tip by name; '?' when unknown
 * @param collapseUnchanged mark the highest internal nodes with no substitution below them
 *   `collapsed` (phylotree.js draws such a clade as a triangle), as the original modal does
 */
export function fitchReconstruct(
	root: FitchNode,
	leafState: (name: string) => string,
	collapseUnchanged = true
): FitchResult {
	const leafStates = new Map<string, string>();

	// Bottom-up: state sets.
	eachAfter(root, (d) => {
		if (isLeaf(d)) {
			const state = leafState(d.data.name) ?? UNKNOWN_STATE;
			d.stateSet = new Set([state]);
			d.leafState = state;
			leafStates.set(d.data.name, state);
			return;
		}
		const children = d.children!;
		let intersection = new Set(children[0].stateSet);
		for (let i = 1; i < children.length; i++) {
			const next = children[i].stateSet!;
			const merged = new Set<string>();
			for (const item of intersection) if (next.has(item)) merged.add(item);
			intersection = merged;
		}
		if (intersection.size > 0) {
			d.stateSet = intersection;
		} else {
			const union = new Set<string>();
			for (const c of children) for (const item of c.stateSet!) union.add(item);
			d.stateSet = union;
		}
	});

	// Top-down: one assignment, counting changes.
	let substitutions = 0;
	eachBefore(root, (d) => {
		if (!d.parent) {
			d.state = firstKnown(d.stateSet!);
			return;
		}
		const parentState = d.parent.state;
		if (parentState !== undefined && d.stateSet!.has(parentState)) d.state = parentState;
		else d.state = firstKnown(d.stateSet!);
		if (isSubstitution(parentState, d.state)) substitutions++;
	});

	// Bottom-up: does any branch below this node carry a substitution?
	eachAfter(root, (d) => {
		if (isLeaf(d)) {
			d.hasSubtreeSubstitutions = false;
			return;
		}
		d.hasSubtreeSubstitutions = d.children!.some(
			(c) => c.hasSubtreeSubstitutions || isSubstitution(d.state, c.state)
		);
	});

	if (collapseUnchanged) {
		const ancestorCollapsed = (n: FitchNode): boolean => {
			let p = n.parent;
			while (p) {
				if (p.collapsed) return true;
				p = p.parent;
			}
			return false;
		};
		eachBefore(root, (d) => {
			if (isLeaf(d) || !d.parent) {
				d.collapsed = false;
				return;
			}
			d.collapsed = !d.hasSubtreeSubstitutions && !ancestorCollapsed(d);
		});
	}

	return { substitutions, leafStates };
}
