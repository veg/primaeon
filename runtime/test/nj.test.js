/**
 * nj.test.js — the display-only neighbour-joining routine (runtime/src/nj.js, PLAN.md D22).
 *
 * WHY THIS FILE EXISTS. Every other numeric test in this package compares against a Python
 * fixture, because every other number has a reference. This one has none: `hyphaeon/dataset.py`
 * contains no neighbour joining, and the tree this module builds is never fed to the model. So it
 * is tested the way an algorithm with a published definition should be — against topologies whose
 * answer is known in closed form:
 *
 *   1. ADDITIVITY. Neighbour joining is provably consistent: given a distance matrix that IS the
 *      patristic matrix of some tree, it returns that tree, with its branch lengths, exactly. Two
 *      such matrices are built here (four and five taxa, both with the same internal edge that
 *      makes the "wrong" topologies wrong) and compared with the tree they came from, to 1e-12.
 *   2. THE Q CRITERION IS NOT THE NEAREST PAIR. The four-taxon case is the classic one where the
 *      two closest tips are NOT neighbours: a naive "join the smallest distance" clustering gets
 *      the topology wrong and NJ gets it right. That is the whole reason the routine exists
 *      rather than a single-linkage loop.
 *   3. NON-ADDITIVE INPUT. A real TN93 matrix is not additive, so limbs come out negative; the
 *      clamp at 0 is asserted, and so is the count the routine reports of how often it fired.
 *   4. ROUND-TRIP. Every emitted Newick is parsed back by the LIBRARY'S OWN parser
 *      (`readNewick`, the port of Bio.Phylo's NewickIO), because the consumer of these strings is
 *      the UI and the checker of last resort is the parser the rest of the app uses. Taxon names
 *      with Newick metacharacters go through the same round trip.
 */
import { describe, it, expect } from 'vitest';
import { readNewick, getTerminals, treeTaxa, findClades } from '@veg/hyphaeon-js';

import {
	neighborJoining,
	njNewick,
	njTreeFromLoaded,
	newickLabel,
	newickLength,
	newickFromTree,
	NJ_MIN_TAXA
} from '../src/nj.js';

/**
 * The patristic distance matrix of a tree given as {taxon: [edge lengths from the taxon to the
 * root, in order]} — two taxa's distance is the sum of the edges they do not share. Edges are
 * identified by their LENGTH here, so every fixture that uses this helper gives every edge a
 * distinct length; the four-taxon case below builds its matrix explicitly instead.
 */
function patristic(paths, taxa) {
	const n = taxa.length;
	const d = new Float64Array(n * n);
	for (let i = 0; i < n; i++) {
		for (let j = 0; j < n; j++) {
			if (i === j) continue;
			const a = paths[taxa[i]];
			const b = paths[taxa[j]];
			// Shared suffix (towards the root) cancels; everything else is on the path.
			let shared = 0;
			while (shared < Math.min(a.length, b.length) && a.at(-1 - shared) === b.at(-1 - shared) && a.at(-1 - shared) !== undefined) {
				// Compare by identity of the EDGE, not its length: the fixtures below use distinct
				// lengths per edge so equality of value is equality of edge.
				shared++;
			}
			const sum = (arr) => arr.slice(0, arr.length - shared).reduce((x, y) => x + y, 0);
			d[i * n + j] = sum(a) + sum(b);
		}
	}
	return d;
}

/** Every tip-to-tip distance of a parsed Newick, as a map keyed 'a|b'. */
function patristicOfNewick(text) {
	const tree = readNewick(text);
	const tips = getTerminals(tree);
	const parents = new Map();
	for (const n of findClades(tree)) for (const c of tree.children[n]) parents.set(c, n);
	const toRoot = (n) => {
		const path = [];
		let cur = n;
		while (parents.has(cur)) {
			path.push([cur, tree.branchLength[cur] ?? 0]);
			cur = parents.get(cur);
		}
		return path;
	};
	const out = new Map();
	for (let i = 0; i < tips.length; i++) {
		for (let j = i + 1; j < tips.length; j++) {
			const pa = toRoot(tips[i]);
			const pb = toRoot(tips[j]);
			const setB = new Set(pb.map(([n]) => n));
			let d = 0;
			for (const [n, len] of pa) {
				if (setB.has(n)) break;
				d += len;
			}
			const setA = new Set(pa.map(([n]) => n));
			for (const [n, len] of pb) {
				if (setA.has(n)) break;
				d += len;
			}
			const key = [tree.name[tips[i]], tree.name[tips[j]]].sort().join('|');
			out.set(key, d);
		}
	}
	return out;
}

describe('newick formatting', () => {
	it('quotes only the labels that need it, and doubles an inner quote', () => {
		expect(newickLabel('hg38')).toBe('hg38');
		expect(newickLabel('Homo:sapiens')).toBe("'Homo:sapiens'");
		expect(newickLabel('a b')).toBe("'a b'");
		expect(newickLabel("O'Brien")).toBe("'O''Brien'");
		expect(newickLabel('')).toBe("''");
	});

	it('writes short, finite lengths and never -0', () => {
		expect(newickLength(0.1)).toBe('0.1');
		expect(newickLength(-0)).toBe('0');
		expect(newickLength(1 / 3)).toBe('0.333333333333');
		expect(newickLength(NaN)).toBe('0');
		expect(newickLength(Infinity)).toBe('0');
		expect(newickLength(1.5e-7)).toBe('1.5e-7');
	});
});

describe('neighbour joining on an additive matrix', () => {
	// ((A:0.1,B:0.2)i1:0.3,(C:0.4,D:0.5)i2:0.6,E:0.7); — the five-taxon case.
	const taxa5 = ['A', 'B', 'C', 'D', 'E'];
	const paths5 = { A: [0.1, 0.3], B: [0.2, 0.3], C: [0.4, 0.6], D: [0.5, 0.6], E: [0.7] };

	it('recovers the tree it came from, topology and branch lengths, to 1e-12', () => {
		const d = patristic(paths5, taxa5);
		const got = neighborJoining(d, taxa5);
		expect(got.newick).toBe('((A:0.1,B:0.2):0.3,(C:0.4,D:0.5):0.6,E:0.7);');
		expect(got.clampedBranches).toBe(0);
		expect(got.joins).toBe(3);
		// Every pairwise distance in the emitted tree equals the input, read back by the library.
		const back = patristicOfNewick(got.newick);
		for (let i = 0; i < taxa5.length; i++) {
			for (let j = i + 1; j < taxa5.length; j++) {
				const key = [taxa5[i], taxa5[j]].sort().join('|');
				expect(Math.abs(back.get(key) - d[i * taxa5.length + j]), key).toBeLessThan(1e-12);
			}
		}
	});

	it('joins by the Q criterion, not by the smallest distance', () => {
		// The textbook counterexample: unrooted ((A:0.1,B:0.4):0.05,C:0.05,D:0.4) — the split is
		// AB|CD, but the CLOSEST pair is (A, C) at 0.2, because B and D hang off long branches.
		// A single-linkage loop joins (A, C) first and gets the topology wrong; the Q criterion,
		// which corrects each distance by the two tips' divergence from everything else, does not.
		const taxa = ['A', 'B', 'C', 'D'];
		const n = 4;
		const [a, b, c, dd, e] = [0.1, 0.4, 0.05, 0.4, 0.05];
		const d = new Float64Array(n * n);
		const set = (i, j, v) => {
			d[i * n + j] = v;
			d[j * n + i] = v;
		};
		set(0, 1, a + b); // A-B, the true neighbours: 0.5
		set(2, 3, c + dd); // C-D: 0.45
		set(0, 2, a + e + c); // A-C: 0.2, the smallest distance in the matrix
		set(0, 3, a + e + dd);
		set(1, 2, b + e + c);
		set(1, 3, b + e + dd);
		const closest = (() => {
			let best = [Infinity, -1, -1];
			for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (d[i * n + j] < best[0]) best = [d[i * n + j], i, j];
			return [taxa[best[1]], taxa[best[2]]];
		})();
		expect(closest).toEqual(['A', 'C']);
		const got = neighborJoining(d, taxa);
		expect(got.newick).toBe('((A:0.1,B:0.4):0.05,C:0.05,D:0.4);');
		expect(got.clampedBranches).toBe(0);
		const back = patristicOfNewick(got.newick);
		for (let i = 0; i < n; i++) {
			for (let j = i + 1; j < n; j++) {
				const key = [taxa[i], taxa[j]].sort().join('|');
				expect(Math.abs(back.get(key) - d[i * n + j]), key).toBeLessThan(1e-12);
			}
		}
	});

	it('is deterministic, and a float32 matrix gives the same topology to float32 precision', () => {
		const d = patristic(paths5, taxa5);
		expect(njNewick(d, taxa5)).toBe(njNewick(d, taxa5));
		// `loaded.d` is a Float32Array; rounding the input moves the LENGTHS by a float32 ulp and
		// must not move the TOPOLOGY.
		const f32 = njNewick(Float32Array.from(d), taxa5);
		const topology = (t) => t.replace(/:[-\d.e]+/g, '');
		expect(topology(f32)).toBe(topology(njNewick(d, taxa5)));
		const lengths = (t) => [...t.matchAll(/:([-\d.e]+)/g)].map((m) => Number(m[1]));
		const [exact, rounded] = [lengths(njNewick(d, taxa5)), lengths(f32)];
		expect(rounded.length).toBe(exact.length);
		for (let i = 0; i < exact.length; i++) expect(Math.abs(exact[i] - rounded[i])).toBeLessThan(1e-6);
	});

	it('reads a Float32Array (the library\'s own d) and symmetrises an asymmetric matrix', () => {
		const d = patristic(paths5, taxa5);
		const skew = Float64Array.from(d);
		skew[0 * 5 + 1] += 0.02;
		skew[1 * 5 + 0] -= 0.02;
		expect(njNewick(skew, taxa5)).toBe(njNewick(d, taxa5));
	});
});

describe('degenerate and hostile inputs', () => {
	it('handles one and two taxa without pretending to have a topology', () => {
		expect(neighborJoining([0], ['only']).newick).toBe('(only:0);');
		const two = neighborJoining(Float64Array.of(0, 0.4, 0.4, 0), ['a', 'b']);
		expect(two.newick).toBe('(a:0.2,b:0.2);'); // one edge, drawn at its midpoint
		expect(NJ_MIN_TAXA).toBe(3);
	});

	it('clamps a negative limb at 0 and says how often it had to', () => {
		// A triplet that violates the triangle inequality: d(A,B) is far larger than d(A,C)+d(C,B).
		const taxa = ['A', 'B', 'C', 'D'];
		const n = 4;
		const d = new Float64Array(n * n);
		const set = (i, j, v) => {
			d[i * n + j] = v;
			d[j * n + i] = v;
		};
		set(0, 1, 1.0);
		set(0, 2, 0.05);
		set(0, 3, 0.05);
		set(1, 2, 0.05);
		set(1, 3, 0.05);
		set(2, 3, 0.05);
		const got = neighborJoining(d, taxa);
		expect(got.clampedBranches).toBeGreaterThan(0);
		expect(got.mostNegativeBranch).toBeLessThan(0);
		const lengths = [...got.newick.matchAll(/:(-?[\d.e-]+)/g)].map((m) => Number(m[1]));
		expect(lengths.every((x) => x >= 0)).toBe(true);
		expect(() => readNewick(got.newick)).not.toThrow();
	});

	it('refuses a non-finite distance and a matrix of the wrong size', () => {
		expect(() => neighborJoining(Float64Array.of(0, NaN, NaN, 0), ['a', 'b'])).toThrow(/not finite/);
		expect(() => neighborJoining([0, 1, 1, 0], ['a', 'b', 'c'])).toThrow(/expected 9/);
		expect(() => neighborJoining(new Float64Array(4), ['a', 'b'], { maxTaxa: 1 })).toThrow(/display limit/);
	});

	it('round-trips taxon names that carry Newick metacharacters', () => {
		const taxa = ['Homo:sapiens', "O'Brien", 'a b', 'plain'];
		const n = 4;
		const d = new Float64Array(n * n);
		for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (i !== j) d[i * n + j] = 0.1 * (i + 1) + 0.1 * (j + 1);
		const text = njNewick(d, taxa);
		expect(new Set(treeTaxa(readNewick(text)))).toEqual(new Set(taxa));
	});
});

describe('njTreeFromLoaded and newickFromTree', () => {
	it('builds from a LoadedAlignment-shaped object and returns null instead of throwing', () => {
		const taxa = ['A', 'B', 'C', 'D'];
		const n = 4;
		const d = new Float32Array(n * n);
		for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (i !== j) d[i * n + j] = 0.1 + 0.01 * (i + j);
		const got = njTreeFromLoaded({ d, taxa, N: n });
		expect(got.source).toBe('nj');
		expect(new Set(treeTaxa(readNewick(got.newick)))).toEqual(new Set(taxa));
		// A report must never be lost to a decoration.
		expect(njTreeFromLoaded({ d, taxa: ['A', 'B'], N: 2 })).toBe(null);
		expect(njTreeFromLoaded(null)).toBe(null);
		expect(njTreeFromLoaded({ d: new Float32Array(4), taxa, N: 4 })).toBe(null);
	});

	it('serialises a parsed tree back to Newick, deep enough to overflow a recursive writer', () => {
		const source = '((a:0.1,b:0.2)inner:0.05,(c:0.3,d:0.4):0.06,e:0.7);';
		expect(newickFromTree(readNewick(source))).toBe(source);
		// A 400-tip ladder: ((((t0,t1),t2),t3)...). Depth is the point of the iterative walk.
		let ladder = 't0:0.01';
		for (let i = 1; i < 400; i++) ladder = `(${ladder},t${i}:0.01):0.01`;
		const deep = readNewick(`${ladder};`);
		const text = newickFromTree(deep);
		expect(treeTaxa(readNewick(text)).length).toBe(400);
		expect(() => newickFromTree({})).toThrow(/not a parsed tree/);
	});
});
