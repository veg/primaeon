/**
 * nj.js — neighbour joining on the TN93 distance matrix, for DISPLAY ONLY.
 *
 * WHY THIS FILE EXISTS. PLAN.md D22 (resolved 2026-09-05) removed HyPhy from the product: no
 * tree, or a tree without usable branch lengths, now means the reference's own tree-free path —
 * pairwise TN93 distances straight into the MDS (`@veg/hyphaeon-js` `tn93.js` /
 * `loadAlignmentAndTree`). The model therefore never needs a tree again. The INTERFACE still
 * does: the report draws a site tree, and a user picks foreground taxa for the phenotype pillar
 * by clicking tips. D22's answer is "a small JS neighbour-joining routine on the same distances
 * provides a topology for display only", and this is that routine.
 *
 * THIS IS APP-SIDE, NOT A MIRROR OF ANY PYTHON. `hyphaeon/dataset.py` has no neighbour joining:
 * where the reference lacks branch lengths it shells out to HyPhy, and where `--use-tn93` is
 * given it uses no topology at all. So nothing here is checked against a fixture, nothing here
 * carries a `dataset.py:NNN` citation, and — the load-bearing part —
 *
 *     NOTHING THIS FILE PRODUCES IS EVER FED TO THE MODEL.
 *
 * The graph's `dist_matrix` and `mds_coords` come from `loadAlignmentAndTree` (the user's tree
 * when it has branch lengths, else the TN93 matrix). A tree built here is attached to the run as
 * `displayTree` (pipeline.js `prepareRun`) and is consumed only by the UI. If it were ever fed
 * back into a distance computation, the result would be a second-order estimate of numbers the
 * pipeline already has exactly, which is why the separation is stated this loudly.
 *
 * THE ALGORITHM is Saitou & Nei 1987 with the Studier–Keppler 1988 O(n^3) formulation, the
 * textbook one:
 *
 *   r_i     = sum over active j of d(i, j)                          (the divergence of i)
 *   Q(i, j) = (m - 2) * d(i, j) - r_i - r_j                          m = number of active nodes
 *   join the pair minimising Q into a new node u, with limb lengths
 *   d(i, u) = d(i, j) / 2 + (r_i - r_j) / (2 * (m - 2)),   d(j, u) = d(i, j) - d(i, u)
 *   d(u, k) = (d(i, k) + d(j, k) - d(i, j)) / 2                      for every other active k
 *
 * and it stops at THREE active nodes rather than two, resolving them with the three-point
 * formula (d(i, c) = (d_ij + d_ik - d_jk) / 2 and its rotations) so the result is a proper
 * unrooted tree with a trifurcating root — the shape a viewer expects from NJ, and the shape
 * that carries all 2n-3 branch lengths. Two taxa give one edge split at its midpoint; one taxon
 * gives a single tip. Ties in Q are broken by the lowest (i, j) in the input's taxon order, so
 * the same matrix always gives the same Newick.
 *
 * BRANCH LENGTHS ARE CLAMPED AT 0. The NJ limb formulae are subtractions and produce negatives
 * on any triplet that violates the triangle inequality — TN93 distances are not additive, so
 * this is normal, not exceptional. datamonkey3 shipped the unclamped values and
 * `treeSanitation.js` exists in this repository because a downstream consumer crashed on them
 * (`log(dist + 0.1)` of a negative). A negative branch is also meaningless to draw. Clamping
 * changes the tree, so it is done HERE, in the display-only routine, and nowhere near a number
 * the model or a result table sees; `neighborJoining` reports how many limbs were clamped and by
 * how much, so a caller can say so.
 *
 * COST. O(n^3) time, O(n^2) memory, in float64. At the app's taxon cap (512, PLAN.md §3.3) that
 * is ~1.3e8 multiply-adds and a 2 MB matrix — tens of milliseconds. `NJ_MAX_TAXA` refuses
 * anything beyond 2,000 rather than freezing a tab; `prepareRun` treats a refusal as "no display
 * tree", never as a failed run.
 */

/** Fewer than three taxa cannot make an unrooted tree; the app's own floor is 3 anyway. */
export const NJ_MIN_TAXA = 3;

/**
 * Above this many taxa the O(n^3) join loop is no longer a "draw the tree" cost. The pipeline's
 * hard taxon cap is 512, so this is only reached by a caller that passed an uncapped matrix.
 */
export const NJ_MAX_TAXA = 2000;

/** Newick metacharacters that force a quoted label (whitespace included). */
const NEEDS_QUOTES = /[\s(),:;'"[\]]/;

/**
 * A taxon name as a Newick label: quoted with `'` when it carries a metacharacter, with inner
 * `'` doubled, as the Newick grammar (and `Bio.Phylo`'s reader) expects.
 *
 * @param {string} name
 * @returns {string}
 */
export function newickLabel(name) {
	const s = String(name ?? '');
	if (s.length === 0) return "''";
	if (!NEEDS_QUOTES.test(s)) return s;
	return `'${s.replaceAll("'", "''")}'`;
}

/**
 * A branch length as Newick text: short, round-trippable, and never `-0` or an exponent-free
 * rendering of a denormal. 12 significant digits is well inside float64 and keeps a 512-taxon
 * tree small enough to store beside a report.
 *
 * @param {number} x
 * @returns {string}
 */
export function newickLength(x) {
	if (!Number.isFinite(x)) return '0';
	const v = Number(x.toPrecision(12));
	return Object.is(v, -0) ? '0' : String(v);
}

/** Read `dist` (row-major n x n, any ArrayLike) into a float64 working matrix, checked. */
function workingMatrix(dist, n) {
	if (!dist || dist.length < n * n) {
		throw new Error(`neighborJoining: distance matrix has ${dist ? dist.length : 0} entries, expected ${n * n}`);
	}
	const d = new Float64Array(n * n);
	for (let i = 0; i < n; i++) {
		for (let j = 0; j < n; j++) {
			const v = Number(dist[i * n + j]);
			if (!Number.isFinite(v)) {
				throw new Error(`neighborJoining: distance (${i}, ${j}) is not finite (${String(dist[i * n + j])})`);
			}
			d[i * n + j] = i === j ? 0 : v;
		}
	}
	// The matrix the library produces is symmetric by construction; a caller's need not be, and an
	// asymmetric input would make the join order depend on which triangle was read. Symmetrise by
	// the mean rather than by picking a triangle, so neither half is silently discarded.
	for (let i = 0; i < n; i++) {
		for (let j = i + 1; j < n; j++) {
			const m = 0.5 * (d[i * n + j] + d[j * n + i]);
			d[i * n + j] = m;
			d[j * n + i] = m;
		}
	}
	return d;
}

/**
 * @typedef {{
 *   newick: string,
 *   taxa: string[],
 *   n: number,
 *   joins: number,
 *   clampedBranches: number,
 *   mostNegativeBranch: number
 * }} NjTree
 */

/**
 * Neighbour joining (Saitou–Nei, Studier–Keppler update) on a symmetric distance matrix.
 *
 * @param {ArrayLike<number>} dist row-major n x n distances (the library's `loaded.d` in tree-free
 *   mode is exactly this: the TN93 matrix as Float32Array)
 * @param {ArrayLike<string>} taxa the labels, in the matrix's own row order (`loaded.taxa`)
 * @param {{maxTaxa?: number}} [options]
 * @returns {NjTree}
 */
export function neighborJoining(dist, taxa, options = {}) {
	const names = Array.from(taxa ?? [], (t) => String(t));
	const n = names.length;
	const maxTaxa = options.maxTaxa ?? NJ_MAX_TAXA;
	if (n === 0) throw new Error('neighborJoining: no taxa');
	if (n > maxTaxa) {
		throw new Error(`neighborJoining: ${n} taxa exceeds the display limit of ${maxTaxa}`);
	}
	const d = workingMatrix(dist, n);

	/** The Newick text of each active node's subtree; index i is the matrix row i. */
	const sub = names.map((name) => newickLabel(name));
	/** Matrix rows still in play, in ascending order (so ties break on the input's taxon order). */
	let active = Array.from({ length: n }, (_, i) => i);

	let joins = 0;
	let clampedBranches = 0;
	let mostNegativeBranch = 0;
	/** Clamp a limb at 0, counting what that cost. */
	const limb = (x) => {
		if (x < 0) {
			clampedBranches++;
			if (x < mostNegativeBranch) mostNegativeBranch = x;
			return 0;
		}
		return x;
	};

	// One taxon: a tip. Two: one edge, drawn split at its midpoint.
	if (n === 1) return { newick: `(${sub[0]}:0);`, taxa: names, n, joins, clampedBranches, mostNegativeBranch };
	if (n === 2) {
		const half = limb(d[1] / 2);
		return {
			newick: `(${sub[0]}:${newickLength(half)},${sub[1]}:${newickLength(half)});`,
			taxa: names,
			n,
			joins,
			clampedBranches,
			mostNegativeBranch
		};
	}

	const r = new Float64Array(n);
	while (active.length > 3) {
		const m = active.length;
		// r_i = sum over active j of d(i, j). The diagonal is 0, so it costs nothing to include.
		for (const i of active) {
			let acc = 0;
			const base = i * n;
			for (const j of active) acc += d[base + j];
			r[i] = acc;
		}
		// The pair minimising Q. `active` is ascending, so the first minimum found is the lowest
		// (i, j) in taxon order and the tie-break is deterministic.
		let bestA = -1;
		let bestB = -1;
		let bestQ = Infinity;
		const scale = m - 2;
		for (let ai = 0; ai < m; ai++) {
			const i = active[ai];
			const base = i * n;
			for (let bi = ai + 1; bi < m; bi++) {
				const j = active[bi];
				const q = scale * d[base + j] - r[i] - r[j];
				if (q < bestQ) {
					bestQ = q;
					bestA = i;
					bestB = j;
				}
			}
		}

		const dab = d[bestA * n + bestB];
		const limbA = limb(dab / 2 + (r[bestA] - r[bestB]) / (2 * scale));
		const limbB = limb(dab - (dab / 2 + (r[bestA] - r[bestB]) / (2 * scale)));

		// The new node reuses row bestA; bestB leaves the active set.
		for (const k of active) {
			if (k === bestA || k === bestB) continue;
			const v = 0.5 * (d[bestA * n + k] + d[bestB * n + k] - dab);
			d[bestA * n + k] = v;
			d[k * n + bestA] = v;
		}
		d[bestA * n + bestA] = 0;
		sub[bestA] = `(${sub[bestA]}:${newickLength(limbA)},${sub[bestB]}:${newickLength(limbB)})`;
		active = active.filter((x) => x !== bestB);
		joins++;
	}

	// Three left: the three-point formula gives the unrooted trifurcation.
	const [i, j, k] = active;
	const dij = d[i * n + j];
	const dik = d[i * n + k];
	const djk = d[j * n + k];
	const li = limb((dij + dik - djk) / 2);
	const lj = limb((dij + djk - dik) / 2);
	const lk = limb((dik + djk - dij) / 2);
	joins++;
	return {
		newick: `(${sub[i]}:${newickLength(li)},${sub[j]}:${newickLength(lj)},${sub[k]}:${newickLength(lk)});`,
		taxa: names,
		n,
		joins,
		clampedBranches,
		mostNegativeBranch
	};
}

/** `neighborJoining(...).newick` for a caller that wants only the string. */
export function njNewick(dist, taxa, options = {}) {
	return neighborJoining(dist, taxa, options).newick;
}

/**
 * The display tree for a loaded alignment, built from the distance matrix the model was given
 * (`loaded.d`) over the taxa the model actually saw (`loaded.taxa`). In tree-free mode that
 * matrix IS the TN93 matrix, which is what D22 asks for; on the tree path a caller should draw
 * the user's own tree instead and never come here.
 *
 * Returns null rather than throwing when a tree cannot be built (too few taxa, too many, a
 * non-finite distance): a report must not be lost to a decoration.
 *
 * @param {{d: ArrayLike<number>, taxa: string[], N: number}} loaded the library's LoadedAlignment
 * @param {{maxTaxa?: number}} [options]
 * @returns {(NjTree & {source: 'nj'})|null}
 */
export function njTreeFromLoaded(loaded, options = {}) {
	if (!loaded || !loaded.d || !Array.isArray(loaded.taxa)) return null;
	if (loaded.N < NJ_MIN_TAXA) return null;
	try {
		return { ...neighborJoining(loaded.d, loaded.taxa, options), source: /** @type {'nj'} */ ('nj') };
	} catch {
		return null;
	}
}

/**
 * A `PhyloTree` (the library's parsed Newick, preprocess/tree.js) back to Newick text, so a run
 * whose tree came EMBEDDED in the alignment can still hand the UI a display tree without the
 * caller keeping the original substring. Iterative post-order: a 512-tip ladder is 512 deep and
 * would overflow a recursive serialiser.
 *
 * The root's own branch length is not written (`Bio.Phylo` does not write one either); every
 * other clade gets `:length`, with a missing length written as 0 rather than omitted, because a
 * viewer that reads no length draws a cladogram and this tree is supposed to be a phylogram.
 * Lengths are NOT clamped here: this is the user's own tree, reproduced, not a computed one.
 *
 * @param {import('@veg/hyphaeon-js').PhyloTree|{name: (string|null)[], branchLength: (number|null)[], children: number[][], root: number}} tree
 * @returns {string}
 */
export function newickFromTree(tree) {
	if (!tree || !Array.isArray(tree.children)) throw new Error('newickFromTree: not a parsed tree');
	/** @type {string[]} */
	const text = new Array(tree.children.length).fill('');
	/** @type {Array<[number, number]>} */
	const stack = [[tree.root, 0]];
	while (stack.length > 0) {
		const frame = stack[stack.length - 1];
		const [node, visited] = frame;
		const kids = tree.children[node] ?? [];
		if (visited < kids.length) {
			frame[1] = visited + 1;
			stack.push([kids[visited], 0]);
			continue;
		}
		stack.pop();
		const name = tree.name[node];
		const label = name ? newickLabel(name) : '';
		if (kids.length === 0) text[node] = label;
		else text[node] = `(${kids.map((k) => text[k]).join(',')})${label}`;
		if (node !== tree.root) {
			const bl = tree.branchLength[node];
			text[node] += `:${newickLength(bl == null ? 0 : bl)}`;
		}
	}
	return `${text[tree.root]};`;
}
