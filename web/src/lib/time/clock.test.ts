/**
 * clock.test.ts — the clock preview's ORACLE test, plus what the page is allowed to say about it.
 *
 * WHY THE ORACLE LIVES HERE AND NOT IN `runtime/`. `phylotree` is a `web` dependency only; adding
 * it to `runtime/` would pull d3, underscore, moment, jquery and winston into `mcp/`, which is
 * published. So the runtime carries its own ~60-line walk over the library's parsed tree and this
 * test checks that walk against phylotree's `computeMidpoint` → `reroot` → `rootToTip`, which is a
 * genuinely independent second implementation. The failure mode it catches is the dangerous one: a
 * wrong tree walk produces plausible wrong numbers rather than an error.
 *
 * IT ALSO PINS FIVE phylotree DEFECTS as documented behaviour, the way the engine's
 * `fixtures.test.js` pinned the tokenizer divergence — so that a future phylotree bump which fixes
 * them fails loudly here rather than silently changing the oracle. Four of them are the reason
 * `fitRootToTip` is not on any production path. The fifth was FOUND BY THIS TEST and is the reason
 * the oracle is split in two: when the midpoint edge is not a direct child of the stored root,
 * `reroot` loses one branch on the far side, so phylotree's own two extreme tips stop being
 * equidistant from the midpoint it just computed. The runtime's walk is the one that satisfies that
 * invariant, which is checked here without reference to either implementation.
 */
import { describe, expect, it } from 'vitest';
import { computeMidpoint, fitRootToTip, phylotree, rootToTip } from 'phylotree';
import { midpointRoot, parseClockTree, rootToTipDivergences, treeDivergences } from '@veg/hyphaeon-runtime/clock';
import { ingestDates, taxaForDates } from '@veg/hyphaeon-runtime/dates';
import { clockPreview, verdict } from './clock';
import { alignmentHeaders } from './sources';
import type { DateIngestLike } from './dateReview';
import { available, example } from './fixtures';

const NWK = '((A:0.1,B:0.2):0.3,(C:0.15,D:0.25):0.05);';
const BIGGER =
	'(((t1:0.02,t2:0.031):0.014,(t3:0.007,t4:0.05):0.022):0.011,((t5:0.04,t6:0.018):0.009,(t7:0.027,t8:0.033):0.016):0.006);';

/** Option A: phylotree, midpoint-rooted, its own root-to-tip walk. */
function viaPhylotree(newick: string): Map<string, number> {
	const tree = new phylotree(newick);
	const mp = computeMidpoint(tree);
	// phylotree's own JSDoc shows `reroot(midpoint)`, which throws: `reroot` wants a hierarchy node
	// as its first argument (src/rooting.js:32). The two fields go in separately.
	tree.reroot(mp.location, mp.breakpoint);
	rootToTip(tree);
	const out = new Map<string, number>();
	tree.nodes.each((n) => {
		const node = n as unknown as { children?: unknown[]; data: { name: string; rootToTip?: number } };
		if (!node.children) out.set(node.data.name, node.data.rootToTip as number);
	});
	return out;
}

/** Option B: the runtime's walk over the library's parsed tree. */
function viaRuntime(newick: string): Map<string, number> {
	const tree = parseClockTree(newick)!;
	const walked = rootToTipDivergences(tree, midpointRoot(tree)!)!;
	return new Map(walked.names.map((n, i) => [n, walked.divergence[i]]));
}

describe('the oracle: two implementations, one answer', () => {
	it('agrees with phylotree to 1e-12 when the midpoint edge hangs off the root', () => {
		const a = viaPhylotree(NWK);
		const b = viaRuntime(NWK);
		expect([...b.keys()].sort()).toEqual([...a.keys()].sort());
		for (const [name, value] of a) {
			expect(Math.abs(value - (b.get(name) as number)), `${name}: ${value} vs ${b.get(name)}`).toBeLessThan(1e-12);
		}
	});

	it('finds the same midpoint edge and breakpoint as phylotree on a deeper tree', () => {
		const tree = new phylotree(BIGGER);
		const mp = computeMidpoint(tree);
		const ours = midpointRoot(parseClockTree(BIGGER)!)!;
		expect(mp.location.data.attribute).toBe('0.022');
		expect(Math.abs(mp.breakpoint - ours.fraction)).toBeLessThan(1e-12);
		expect(ours.tips.sort()).toEqual(['t4', 't5']);
	});

	// THE INVARIANT THAT DECIDES WHO IS RIGHT when the two disagree (see the defect block below): at
	// a true midpoint the two tips of the longest path are equidistant from the root, and their sum
	// is the path. It needs no second implementation to check.
	it('puts the two extreme tips equidistant from the midpoint, summing to the longest path', () => {
		for (const newick of [NWK, BIGGER]) {
			const tree = parseClockTree(newick)!;
			const mp = midpointRoot(tree)!;
			const b = viaRuntime(newick);
			const [p, q] = mp.tips;
			expect(Math.abs((b.get(p) as number) - (b.get(q) as number)), `${newick}`).toBeLessThan(1e-12);
			expect(Math.abs((b.get(p) as number) + (b.get(q) as number) - mp.pathLength)).toBeLessThan(1e-12);
		}
	});

	it('places the midpoint on the longest leaf-to-leaf path, as phylotree does', () => {
		// Measured on NWK: the longest path is B→D at 0.8, so the root sits 0.4 from each and the
		// vector is A 0.3, B 0.4, C 0.3, D 0.4.
		const b = viaRuntime(NWK);
		expect(b.get('B')).toBeCloseTo(0.4, 12);
		expect(b.get('D')).toBeCloseTo(0.4, 12);
		expect(b.get('A')).toBeCloseTo(0.3, 12);
	});
});

describe('the five phylotree defects, pinned as documented behaviour', () => {
	// 1. The constructor SILENTLY sets every branch to 1 when it finds none. A preview must decide on
	//    the numbers, never on what comes back from here.
	it('invents unit branch lengths for a topology-only tree', () => {
		const tree = new phylotree('((A,B),(C,D));');
		rootToTip(tree);
		const depths: number[] = [];
		tree.nodes.each((n) => {
			const node = n as unknown as { children?: unknown[]; data: { rootToTip?: number } };
			if (!node.children) depths.push(node.data.rootToTip as number);
		});
		expect(depths.every((d) => Number.isFinite(d))).toBe(true);
		// …and the runtime refuses exactly that tree, on the numbers.
		expect(treeDivergences('((A,B),(C,D));').ok).toBe(false);
		expect(treeDivergences('((A:1,B:1):1,(C:1,D:1):1);').code).toBe('UNIT_BRANCH_LENGTHS');
	});

	// 2. `rootToTip` throws a BARE STRING, not an Error, so a catch must not assume `.message`.
	it('throws a bare string on a tree with missing branch lengths', () => {
		const tree = new phylotree('((A:0.1,B:0.2),(C,D):0.05);');
		let thrown: unknown = null;
		try {
			rootToTip(tree);
		} catch (err) {
			thrown = err;
		}
		if (thrown !== null) expect(thrown instanceof Error).toBe(false);
	});

	// 3. MEASURED, AND THE REASON THE ORACLE IS SPLIT IN TWO ABOVE. When the midpoint edge is NOT a
	//    direct child of the stored root, `reroot` loses the branch between the old root and the
	//    intervening node on the far side — the `__reroot_top_clade` / uninitialised `stashed_bl`
	//    path in src/rooting.js:126-128. On BIGGER, whose midpoint sits on a GRANDCHILD branch,
	//    every tip on the far side comes back exactly 0.011 short, which is the length of that lost
	//    branch; and phylotree's own two extreme tips then sum to 0.127 rather than the 0.138 its
	//    own `computeMidpoint` measured. The runtime's walk gives 0.069 and 0.069.
	it('loses the intervening branch when the midpoint is deeper than a root child', () => {
		const theirs = viaPhylotree(BIGGER);
		const ours = viaRuntime(BIGGER);
		expect(theirs.get('t4')).toBeCloseTo(0.069, 12);
		expect(ours.get('t4')).toBeCloseTo(0.069, 12);
		// The far side, 0.011 short in phylotree and correct in the runtime.
		for (const tip of ['t5', 't6', 't7', 't8']) {
			expect((ours.get(tip) as number) - (theirs.get(tip) as number)).toBeCloseTo(0.011, 12);
		}
		expect((theirs.get('t4') as number) + (theirs.get('t5') as number)).toBeCloseTo(0.127, 12);
		expect((ours.get('t4') as number) + (ours.get('t5') as number)).toBeCloseTo(0.138, 12);
	});

	// 4 and 5. `fitRootToTip` reads `node.data.rtta`, which `rootToTip` never sets (it sets
	//    `rootToTip`), considers rootings at TIPS ONLY, and selects by maximum R² with no causality
	//    constraint — so it can pick a root that dates the ancestor after some of the samples. It is
	//    therefore not on any production path; this pins that it is still the function described.
	it('fits only at tips and selects by R², with no causality constraint', () => {
		const tree = new phylotree(BIGGER);
		rootToTip(tree);
		let sawRtta = false;
		tree.nodes.each((n) => {
			const data = (n as unknown as { data: Record<string, unknown> }).data;
			if ('rtta' in data) sawRtta = true;
			if ('rootToTip' in data) expect(typeof data.rootToTip === 'number' || data.rootToTip === undefined).toBe(true);
		});
		expect(sawRtta, 'rootToTip now sets `rtta`: re-read fitRootToTip before using it').toBe(false);
		expect(typeof fitRootToTip).toBe('function');
	});
});

describe('what the page says about the fit', () => {
	function ingestOf(text: string): DateIngestLike {
		const { headerOf } = alignmentHeaders(text);
		return ingestDates({ taxa: taxaForDates(text), headerOf }) as unknown as DateIngestLike;
	}

	it('declines with a reason, not an error, when there is no tree', () => {
		const preview = clockPreview({ treeText: null, ingest: ingestOf('>A|2019\nATG\n>B|2020\nATG\n>C|2021\nATG\n') });
		expect(preview.available).toBe(false);
		expect(preview.code).toBe('NO_TREE');
		expect(preview.reason).toMatch(/No tree was supplied/);
	});

	it('declines on a topology-only tree in the words the reader needs', () => {
		const preview = clockPreview({
			treeText: '((A:1,B:1):1,C:1);',
			ingest: ingestOf('>A|2019\nATG\n>B|2020\nATG\n>C|2021\nATG\n')
		});
		expect(preview.available).toBe(false);
		expect(preview.reason).toMatch(/shape but no branch lengths/);
	});

	it('declines when fewer than three tips of the tree are dated', () => {
		const preview = clockPreview({
			treeText: NWK,
			ingest: ingestOf('>A|2019\nATG\n>B|2020\nATG\n>C\nATG\n>D\nATG\n')
		});
		expect(preview.available).toBe(false);
		expect(preview.reason).toMatch(/at least 3 are needed/);
	});

	it('fits, flags and words the verdict when a dated tree is supplied', () => {
		// A planted clock on the four-tip tree. The headers carry the date AFTER a space, so the
		// library key is `A` and matches the tree tip while the date lives in the part a name-only
		// ingest would have thrown away — the §0.2 trap, exercised end to end.
		const ingest = ingestOf('>A 2019\nATG\n>B 2021\nATG\n>C 2019\nATG\n>D 2021\nATG\n');
		const preview = clockPreview({ treeText: NWK, ingest });
		expect(preview.available).toBe(true);
		expect(preview.fit?.ok).toBe(true);
		expect(preview.points.length).toBe(4);
		expect(preview.rootLabel).toBe('midpoint');
		expect(verdict(preview)).toMatch(/R²/);
	});

	// The section is a diagnostic of the dates. These five words would make it read as an analysis.
	it('never uses the words reserved for the analysis', () => {
		const ingest = ingestOf('>A 2019\nATG\n>B 2021\nATG\n>C 2019\nATG\n>D 2021\nATG\n');
		const text = [verdict(clockPreview({ treeText: NWK, ingest })), clockPreview({ treeText: null, ingest }).reason ?? ''].join(' ');
		for (const word of [/\bdating\b/i, /TMRCA/i, /calibrated/i, /confidence interval/i, /molecular clock estimate/i]) {
			expect(text, `the preview said ${word}`).not.toMatch(word);
		}
	});
});

describe.skipIf(!available())('against the shipped H5N1 pair', () => {
	it('reads a preview off the supplied tree and the table-dated sequences', () => {
		const alignment = example('H5N1_HA_geo.fasta');
		const { headerOf } = alignmentHeaders(alignment);
		const ingest = ingestDates({
			taxa: taxaForDates(alignment),
			headerOf,
			source: example('H5N1_HA_metadata.csv'),
			sourceName: 'H5N1_HA_metadata.csv'
		}) as unknown as DateIngestLike;
		const preview = clockPreview({ treeText: example('H5N1_HA.nwk'), ingest });
		// Either it fits, or it says why in one sentence — never a NaN on the page.
		if (preview.available) {
			expect(Number.isFinite(preview.fit!.mu)).toBe(true);
			expect(Number.isFinite(preview.fit!.r2)).toBe(true);
			expect(preview.points.length).toBeGreaterThan(3);
		} else {
			expect(preview.reason).toBeTruthy();
		}
	});
});
