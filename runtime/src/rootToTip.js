/**
 * rootToTip.js — rooting a supplied tree and accumulating root-to-tip distances, for the /time
 * page's clock PREVIEW.
 *
 * WHY THIS FILE EXISTS. PLAN-TEMPORAL.md's date layer ends with one question a reader cannot answer
 * from a table of dates: *are these dates any good?* The answer is a regression of divergence on
 * sampling time, and its predictor is a root-to-tip distance. This file is the predictor half:
 * parse the tree the reader supplied, refuse the trees a regression cannot be run on, place a root,
 * and walk the branch lengths. `clockRegression.js` is the other half.
 *
 * THIS IS APP-SIDE, LIKE `nj.js`, AND IT MIRRORS NO PYTHON FUNCTION. `hyphaeon/dating.py:494-621`
 * (`extract_tree_root_to_tip`) does the same job in the reference, and PLAN-TEMPORAL.md phase 3
 * will port it into `@veg/hyphaeon-js` beside `run_ols_dating`. When that lands, THIS FILE IS NOT
 * THE THING TO DELETE: it is the independent second implementation the port is checked against,
 * exactly as `web/src/lib/time/clock.test.ts` checks it today against phylotree's own
 * `computeMidpoint` + `rootToTip`. Reconciling the two into one would remove the check.
 *
 * WHY NOT phylotree, WHICH IS ALREADY A `web` DEPENDENCY. Because `runtime/` is imported by `mcp/`
 * (which is published) and by `server/`, and phylotree pulls d3, underscore, moment, jquery and
 * winston behind it — for two walks over a structure `@veg/hyphaeon-js` already parses
 * (`js/src/preprocess/tree.js` `parseNewickTrees` → `{name, branchLength, children, parent, root}`,
 * the same structure `pipeline.js`'s `unitTopologyNewick` walks). phylotree keeps one job, as the
 * oracle in the web test.
 *
 * THREE THINGS THIS FILE REFUSES, AND WHY EACH WOULD OTHERWISE PRODUCE A PLAUSIBLE WRONG NUMBER.
 *
 *   1. A TREE WITH NO USABLE BRANCH LENGTHS. `new Phylotree(nwk)` silently sets every branch to 1
 *      and warns on the console (phylotree `src/main.js:186-192`); the app's own D6 display trees
 *      are written with `:1` on every branch as a DRAWING convention (`pipeline.js`
 *      `unitTopologyNewick`). A regression on either measures tip depth in nodes, not divergence.
 *      So the gate is on the numbers, never on what a constructor hands back.
 *   2. A TREE THAT PASSES THE MODEL'S GATE BUT NOT A REGRESSION'S. The library's
 *      `hasNonzeroBranchLengths(tree, minPosRatio = 0.05)` accepts a tree with 5 % of branches
 *      positive — deliberately loosened upstream for dense outbreak trees. That decides whether the
 *      MODEL can use a tree. `MIN_POSITIVE_RATIO` here is 0.8, and it is a different question.
 *   3. A ROOT-TO-TIP VECTOR WITH NO SPREAD. Identical sequences give identical distances; a
 *      regression on a constant predictor is not an estimate. `MIN_DIVERGENCE_SD` is 1e-8, the same
 *      floor `dating.py:1263` puts on its Pearson guard.
 *
 * ROOTING IS THE DECISION THAT MOVES THE ANSWER, so it is explicit and reported. A tree's own root
 * is never used: an NJ tree is unrooted and its stored root is an artefact of the join order, and a
 * user's tree is rooted wherever their pipeline left it. `midpointRoot` is the default and
 * `outgroupRoot` is the reader's override. Useful algebra, stated once because the page prints it:
 * if divergence is rescaled by c, the rate scales by c and `t_MRCA = t_ref - d0/mu` does NOT move;
 * if the root is too deep every divergence gains a constant a and the ancestor date moves earlier
 * by exactly a/mu. The scale threatens the rate; the root threatens the date.
 *
 * THE FRACTION CONVENTION IS phylotree's, measured rather than assumed: `tree.reroot(node, f)`
 * places the root at `f * branchLength(node)` FROM THE NODE, toward its parent. Verified on
 * `((A:0.1,B:0.2):0.3,(C:0.15,D:0.25):0.05);` — `computeMidpoint` returns the AB clade with
 * breakpoint 0.6667, and the resulting root-to-tip vector is A 0.3, B 0.4, C 0.3, D 0.4, i.e. the
 * root sits 0.2 from the AB node. Keeping the same convention is what lets the web oracle test
 * compare the two implementations element by element.
 */

import { extractTree, parseNewickTrees } from '@veg/hyphaeon-js';

/** Fraction of non-root branches that must be strictly positive; see the header, point 2. */
export const MIN_POSITIVE_RATIO = 0.8;

/** Floor on the standard deviation of the root-to-tip vector; `dating.py:1263`'s own guard value. */
export const MIN_DIVERGENCE_SD = 1e-8;

/** Why a tree cannot carry a clock preview. Rendered by the page; never thrown. */
export const TREE_REFUSALS = Object.freeze({
	NO_TREE: 'NO_TREE',
	UNPARSED: 'UNPARSED',
	TOO_FEW_TIPS: 'TOO_FEW_TIPS',
	NO_BRANCH_LENGTHS: 'NO_BRANCH_LENGTHS',
	UNIT_BRANCH_LENGTHS: 'UNIT_BRANCH_LENGTHS',
	NO_DIVERGENCE_SPREAD: 'NO_DIVERGENCE_SPREAD'
});

/**
 * The tree text a reader supplied, or an alignment carrying an embedded one. `extractTree` is the
 * library's own `extract_tree_from_string_or_file` (dataset.py:366-428), so a NEXUS TREES block and
 * a bare Newick both work and neither is re-implemented here.
 *
 * @param {string|null|undefined} text
 * @returns {object|null} the library's PhyloTree, or null
 */
export function parseClockTree(text) {
	if (typeof text !== 'string' || text.trim() === '') return null;
	try {
		const direct = parseNewickTrees(text);
		if (direct.length === 1 && direct[0].name.length > 1) return direct[0];
	} catch {
		// fall through to the embedded-tree path
	}
	try {
		return extractTree(text);
	} catch {
		return null;
	}
}

/** Indices of the tree's terminal nodes, in the parser's own (pre-order) order. */
export function leafIndices(tree) {
	const out = [];
	for (let i = 0; i < tree.children.length; i++) if (tree.children[i].length === 0) out.push(i);
	return out;
}

/** Terminal names, quote-stripped the way `treeTaxa` does, in leaf order. */
export function leafNames(tree) {
	return leafIndices(tree).map((i) => String(tree.name[i] ?? '').replace(/^['"]|['"]$/g, ''));
}

/** The branch length above node `i`, as a number; the root's is 0. */
function lengthOf(tree, i) {
	if (i === tree.root) return 0;
	const v = tree.branchLength[i];
	return typeof v === 'number' && Number.isFinite(v) ? v : Number.NaN;
}

/**
 * Whether this tree can carry a regression. Separate from the library's model gate; see the header.
 *
 * @param {object} tree
 * @returns {{ok: boolean, code: string|null, branches: number, positive: number, ratio: number,
 *   nonFinite: number, unit: boolean, tips: number}}
 */
export function branchLengthGate(tree) {
	const tips = leafIndices(tree).length;
	let branches = 0;
	let positive = 0;
	let nonFinite = 0;
	let allOne = true;
	for (let i = 0; i < tree.children.length; i++) {
		if (i === tree.root) continue;
		branches += 1;
		const v = lengthOf(tree, i);
		if (!Number.isFinite(v)) {
			nonFinite += 1;
			allOne = false;
			continue;
		}
		if (v > 0) positive += 1;
		if (v !== 1) allOne = false;
	}
	const ratio = branches === 0 ? 0 : positive / branches;
	let code = null;
	if (tips < 3) code = TREE_REFUSALS.TOO_FEW_TIPS;
	else if (branches > 0 && allOne) code = TREE_REFUSALS.UNIT_BRANCH_LENGTHS;
	else if (nonFinite > 0 || ratio < MIN_POSITIVE_RATIO) code = TREE_REFUSALS.NO_BRANCH_LENGTHS;
	return { ok: code === null, code, branches, positive, ratio, nonFinite, unit: allOne && branches > 0, tips };
}

/** Undirected adjacency: for each node, `[neighbour, branch length]` pairs. */
function adjacency(tree) {
	const adj = tree.children.map(() => /** @type {Array<[number, number]>} */ ([]));
	for (let i = 0; i < tree.children.length; i++) {
		if (i === tree.root) continue;
		const p = tree.parent[i];
		if (p < 0) continue;
		const w = lengthOf(tree, i);
		adj[i].push([p, w]);
		adj[p].push([i, w]);
	}
	return adj;
}

/** Distances from `start` to every node, never crossing back through `blocked`. Iterative. */
function distancesFrom(adj, start, blocked, offset) {
	const dist = new Float64Array(adj.length).fill(Number.NaN);
	dist[start] = offset;
	const stack = [start];
	const seen = new Uint8Array(adj.length);
	seen[start] = 1;
	if (blocked >= 0) seen[blocked] = 1;
	while (stack.length > 0) {
		const node = /** @type {number} */ (stack.pop());
		for (const [next, w] of adj[node]) {
			if (seen[next]) continue;
			seen[next] = 1;
			dist[next] = dist[node] + w;
			stack.push(next);
		}
	}
	return dist;
}

/**
 * The true midpoint: the longest leaf-to-leaf path, halved. Two sweeps, O(n).
 *
 * @param {object} tree
 * @returns {{node: number, fraction: number, pathLength: number, tips: [string, string]}|null}
 */
export function midpointRoot(tree) {
	const leaves = leafIndices(tree);
	if (leaves.length < 2) return null;
	const adj = adjacency(tree);
	const farthest = (from) => {
		const d = distancesFrom(adj, from, -1, 0);
		let best = leaves[0];
		let bestD = -Infinity;
		for (const l of leaves) {
			if (Number.isFinite(d[l]) && d[l] > bestD) {
				bestD = d[l];
				best = l;
			}
		}
		return { node: best, dist: bestD, d };
	};
	const u = farthest(leaves[0]).node;
	const v = farthest(u);
	const half = v.dist / 2;
	if (!Number.isFinite(half) || half <= 0) return null;

	// Walk the u→v path by climbing parents from v back toward u, using the distance field from u.
	const path = [];
	{
		// Both endpoints' ancestor chains meet at their lowest common ancestor.
		const chain = (x) => {
			const out = [];
			for (let i = x; i >= 0; i = tree.parent[i]) out.push(i);
			return out;
		};
		const cu = chain(u);
		const cv = chain(v.node);
		const inV = new Map(cv.map((n, i) => [n, i]));
		let lcaAt = -1;
		for (const n of cu) {
			if (inV.has(n)) {
				lcaAt = n;
				break;
			}
		}
		for (const n of cu) {
			path.push(n);
			if (n === lcaAt) break;
		}
		const down = [];
		for (const n of cv) {
			if (n === lcaAt) break;
			down.push(n);
		}
		down.reverse();
		path.push(...down);
	}

	let cum = 0;
	for (let step = 0; step + 1 < path.length; step++) {
		const a = path[step];
		const b = path[step + 1];
		const child = tree.parent[a] === b ? a : b;
		const w = lengthOf(tree, child);
		if (!Number.isFinite(w)) return null;
		if (cum + w >= half) {
			const along = half - cum; // distance from `a`
			const fromChild = child === a ? along : w - along;
			const fraction = w > 0 ? Math.min(1, Math.max(0, fromChild / w)) : 0;
			return {
				node: child,
				fraction,
				pathLength: v.dist,
				tips: [
					String(tree.name[u] ?? '').replace(/^['"]|['"]$/g, ''),
					String(tree.name[v.node] ?? '').replace(/^['"]|['"]$/g, '')
				]
			};
		}
		cum += w;
	}
	return null;
}

/**
 * Root at `fraction` along the branch above the named tip (phylotree's convention: measured FROM
 * the node). Returns null when the name is not a node of this tree or names the root.
 */
export function outgroupRoot(tree, name, fraction = 0.5) {
	const want = String(name);
	for (let i = 0; i < tree.name.length; i++) {
		const n = String(tree.name[i] ?? '').replace(/^['"]|['"]$/g, '');
		if (n === want) {
			if (i === tree.root) return null;
			return { node: i, fraction: Math.min(1, Math.max(0, fraction)) };
		}
	}
	return null;
}

/**
 * Root-to-tip distances from a root placed on the branch above `rooting.node`.
 *
 * @param {object} tree
 * @param {{node: number, fraction: number}} rooting
 * @returns {{names: string[], divergence: Float64Array}|null}
 */
export function rootToTipDivergences(tree, rooting) {
	if (!rooting) return null;
	const k = rooting.node;
	if (k === tree.root) return null;
	const p = tree.parent[k];
	if (p < 0) return null;
	const w = lengthOf(tree, k);
	if (!Number.isFinite(w)) return null;
	const fromChild = w * Math.min(1, Math.max(0, rooting.fraction));
	const fromParent = w - fromChild;

	const adj = adjacency(tree);
	const below = distancesFrom(adj, k, p, fromChild);
	const above = distancesFrom(adj, p, k, fromParent);

	const leaves = leafIndices(tree);
	const names = [];
	const divergence = new Float64Array(leaves.length);
	for (let i = 0; i < leaves.length; i++) {
		const l = leaves[i];
		names.push(String(tree.name[l] ?? '').replace(/^['"]|['"]$/g, ''));
		const d = Number.isFinite(below[l]) ? below[l] : above[l];
		divergence[i] = Number.isFinite(d) ? d : Number.NaN;
	}
	return { names, divergence };
}

/** Population standard deviation, the `ddof = 0` numpy default `dating.py:3057` uses. */
export function populationStd(values) {
	const finite = Array.from(values).filter((v) => Number.isFinite(v));
	if (finite.length === 0) return 0;
	const mean = finite.reduce((a, b) => a + b, 0) / finite.length;
	let ss = 0;
	for (const v of finite) ss += (v - mean) * (v - mean);
	return Math.sqrt(ss / finite.length);
}

/**
 * The whole predictor step: parse, gate, root, walk. One call for the page.
 *
 * @param {string|null} treeText
 * @param {{root?: 'midpoint'|'outgroup', outgroup?: string|null}} [options]
 * @returns {{ok: boolean, code: string|null, tree: object|null, gate: object|null,
 *   rooting: object|null, rootLabel: string, names: string[], divergence: Float64Array|null,
 *   sd: number}}
 */
export function treeDivergences(treeText, options = {}) {
	const empty = {
		ok: false,
		code: TREE_REFUSALS.NO_TREE,
		tree: null,
		gate: null,
		rooting: null,
		rootLabel: 'none',
		names: [],
		divergence: null,
		sd: 0
	};
	if (typeof treeText !== 'string' || treeText.trim() === '') return empty;
	const tree = parseClockTree(treeText);
	if (!tree) return { ...empty, code: TREE_REFUSALS.UNPARSED };
	const gate = branchLengthGate(tree);
	if (!gate.ok) return { ...empty, code: gate.code, tree, gate };

	let rooting = null;
	let rootLabel = 'midpoint';
	if (options.root === 'outgroup' && options.outgroup) {
		rooting = outgroupRoot(tree, options.outgroup);
		rootLabel = rooting ? `outgroup ${options.outgroup}` : 'midpoint';
	}
	if (!rooting) {
		rooting = midpointRoot(tree);
		rootLabel = 'midpoint';
	}
	const walked = rooting ? rootToTipDivergences(tree, rooting) : null;
	if (!walked) return { ...empty, code: TREE_REFUSALS.NO_BRANCH_LENGTHS, tree, gate };
	const sd = populationStd(walked.divergence);
	if (!(sd > MIN_DIVERGENCE_SD)) {
		return {
			ok: false,
			code: TREE_REFUSALS.NO_DIVERGENCE_SPREAD,
			tree,
			gate,
			rooting,
			rootLabel,
			names: walked.names,
			divergence: walked.divergence,
			sd
		};
	}
	return {
		ok: true,
		code: null,
		tree,
		gate,
		rooting,
		rootLabel,
		names: walked.names,
		divergence: walked.divergence,
		sd
	};
}
