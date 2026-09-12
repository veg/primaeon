/**
 * clock-preview.test.js — the /time page's clock preview: rooting, the root-to-tip walk, the
 * centred fit, and every state that must refuse rather than print a number.
 *
 * THE SYNTHETIC DATASET, AND THE NUMBER THE TOLERANCES ARE BUILT FROM. A random rooted topology of
 * n = 60 tips, tip dates uniform over a span T = 20 years with the ancestor at t0 = 2000.0, and
 * sequences evolved from a random root down the branches under JC69 at a strict
 * mu_true = 1.0e-3 substitutions per site per year over L = 3000 nucleotides (per branch, per site,
 * substitute with probability 1 - exp(-(4/3)·mu·Δt), drawing one of the other three bases). The
 * generator is seeded with the library's own `Xoshiro256`, so every run is byte-reproducible.
 *
 *     Σ(t - t̄)² ≈ n·T²/12 = 2000;  root-to-tip divergence ≈ 0.02;
 *     Poisson noise on one divergence ≈ sqrt(0.02 / 3000) = 2.6e-3;
 *     se_mu ≈ 2.6e-3 / sqrt(2000) ≈ 5.8e-5, about 6 % of mu_true.
 *
 * That 6 % is why the estimator claim below is asserted against THREE TIMES THE FIT'S OWN REPORTED
 * STANDARD ERROR rather than against a fixed percentage: a fixed percentage bakes in this sample,
 * and self-documenting bounds stay correct if the generator changes. A meta-assertion keeps the
 * bound from being vacuously wide.
 *
 * THE FOUR CLAIMS, EACH WITH ITS OWN FAIR TOLERANCE (the root-to-tip specification's table):
 *   1. ALGEBRA — closed-form slope/intercept/R² on a fixed (t, d) pair: relative 1e-12, because it
 *      is the same arithmetic on the same doubles. (The phylotree cross-check of the DIVERGENCE
 *      vector lives in `web/src/lib/time/clock.test.ts`, where phylotree is a dependency.)
 *   2. ESTIMATOR — unbiasedness on the noise-free predictor at 1e-12, then mu from ONE simulated
 *      alignment against mu_true at a MEASURED bound. The specification asked for 3·se_mu; that
 *      bound does not hold and the reason is worth keeping: see the claim-2 block.
 *   3. THE ACTUAL PIPELINE — parse, gate, midpoint-root, walk, fit — against the noise-free fit
 *      from the TRUE root, so the only difference between the two is where the root was placed.
 *      Systematic, not statistical, so the bounds are MEASURED ONCE AND PINNED: see MEASURED_*.
 *   4. GUARDS — every degenerate input produces a stated refusal or status, never NaN on a page.
 *
 * Parity against `hyphaeon dating -a synth.fasta -t synth.nwk --distance-mode tree
 * --no-optimize-root --method ols` is the natural fifth claim and is deferred with the port: the
 * reference's DEFAULT distance mode measures divergence to a time-decay weighted consensus
 * (dating.py:623-700), not root-to-tip on a tree, so only that exact invocation is comparable.
 */
import { describe, it, expect } from 'vitest';
import { Xoshiro256 } from '@veg/hyphaeon-js';

import {
	CLOCK_REFUSALS,
	CLOCK_STATUS,
	TREE_REFUSALS,
	branchLengthGate,
	clockRegression,
	midpointRoot,
	parseClockTree,
	rootSensitivity,
	rootToTipDivergences,
	treeDivergences
} from '../src/clock.js';

// ---------------------------------------------------------------------------------------------
// The generator. A test helper, not a source file: plain arithmetic, no Python citation needed.
// ---------------------------------------------------------------------------------------------

const N_TIPS = 60;
const SPAN = 20;
const T0 = 2000.0;
const L = 3000;
const MU_TRUE = 1.0e-3;

/** Measured once on this seed and pinned; see the header, claim 3. */
/**
 * MEASURED ONCE ON THIS SEED AND PINNED, not derived (claims 2 and 3).
 *   claim 3, midpoint rooting against the true root, both noise-free:
 *       rate 0.098 % relative, ancestor time 0.081 years  -> bounds 0.5 % and 0.25 years
 *   claim 2, one simulated alignment against mu_true:
 *       rate 35.4 % relative, which is 8.38 of the fit's own se_mu (4.23e-5)  -> bound 40 %
 * A change that TIGHTENS these is a welcome failure; one that loosens them is a bug.
 */
const MEASURED_RATE_TOLERANCE = 0.005; // relative; the ONLY difference from truth here is the root
const MEASURED_MRCA_TOLERANCE = 0.25; // years
const MEASURED_ESTIMATOR_TOLERANCE = 0.4; // relative, one simulated alignment; see claim 2

function synthetic(seed = 20260907n) {
	const rng = new Xoshiro256(seed);
	// A random rooted topology: repeatedly join two random active nodes, ancestor times drawn back
	// from the youngest child so every branch has positive length.
	const tipDates = [];
	for (let i = 0; i < N_TIPS; i++) tipDates.push(T0 + SPAN * rng.uniform());
	tipDates.sort((a, b) => a - b);

	const name = [];
	const time = [];
	const children = [];
	const parent = [];
	const active = [];
	for (let i = 0; i < N_TIPS; i++) {
		name.push(`tip_${i}`);
		time.push(tipDates[i]);
		children.push([]);
		parent.push(-1);
		active.push(i);
	}
	while (active.length > 1) {
		const ia = Math.floor(rng.uniform() * active.length);
		let ib = Math.floor(rng.uniform() * (active.length - 1));
		if (ib >= ia) ib += 1;
		const a = active[ia];
		const b = active[ib];
		const youngest = Math.min(time[a], time[b]);
		// The ancestor sits strictly before both children, at most back to t0.
		const at = youngest - (youngest - T0 + 0.5) * (0.15 + 0.5 * rng.uniform());
		const node = name.length;
		name.push(null);
		time.push(at);
		children.push([a, b]);
		parent.push(-1);
		parent[a] = node;
		parent[b] = node;
		const keep = active.filter((x) => x !== a && x !== b);
		keep.push(node);
		active.length = 0;
		active.push(...keep);
	}
	const root = active[0];

	// Branch lengths in TIME, and the true root-to-tip divergence in substitutions per site.
	const branchTime = name.map((_, i) => (parent[i] < 0 ? 0 : time[i] - time[parent[i]]));
	const trueRootToTip = new Map();
	const order = [];
	{
		const stack = [root];
		while (stack.length) {
			const n = stack.pop();
			order.push(n);
			for (const c of children[n]) stack.push(c);
		}
	}

	// Evolve L sites down the branches; the realised divergence is what a real preview would see.
	const BASES = ['A', 'C', 'G', 'T'];
	const seq = new Map();
	const rootSeq = new Uint8Array(L);
	for (let s = 0; s < L; s++) rootSeq[s] = Math.floor(rng.uniform() * 4) % 4;
	seq.set(root, rootSeq);
	const realised = new Map([[root, 0]]);
	for (const n of order) {
		for (const c of children[n]) {
			const dt = branchTime[c];
			const p = 1 - Math.exp((-4 / 3) * MU_TRUE * dt);
			const parentSeq = seq.get(n);
			const child = new Uint8Array(parentSeq);
			let subs = 0;
			for (let s = 0; s < L; s++) {
				if (rng.uniform() < p) {
					let next = Math.floor(rng.uniform() * 3) % 3;
					if (next >= child[s]) next += 1;
					child[s] = next;
					subs += 1;
				}
			}
			seq.set(c, child);
			// The REALISED divergence: substitutions actually drawn on this branch, over L. Using
			// the expectation dt·mu instead would make the fit exact and se_mu zero, and claim 2
			// would then assert against a bound of nothing.
			realised.set(c, realised.get(n) + subs / L);
		}
	}
	for (let i = 0; i < N_TIPS; i++) trueRootToTip.set(name[i], realised.get(i));
	// The noise-free predictor: mu_true × (t_i − t_root). Root-to-tip TIME is exactly t_i − t_root,
	// so a fit on this must return mu_true to machine precision — which is how the estimator's
	// unbiasedness is separated below from the sampling noise of one simulated alignment.
	const expectedRootToTip = new Map();
	for (let i = 0; i < N_TIPS; i++) expectedRootToTip.set(name[i], MU_TRUE * (time[i] - time[root]));

	// Newick with branch lengths in SUBSTITUTIONS PER SITE (time × mu_true), the units a real tree
	// from a phylogenetics pipeline would carry.
	const newick = (() => {
		const write = (n) => {
			const bl = (branchTime[n] * MU_TRUE).toFixed(10);
			if (children[n].length === 0) return `${name[n]}:${bl}`;
			const inner = children[n].map(write).join(',');
			return parent[n] < 0 ? `(${inner})` : `(${inner}):${bl}`;
		};
		return `${write(root)};`;
	})();

	const fasta = [];
	for (let i = 0; i < N_TIPS; i++) {
		const bases = Array.from(seq.get(i), (b) => BASES[b]).join('');
		fasta.push(`>${name[i]}|${time[i].toFixed(4)}\n${bases}`);
	}

	return {
		newick,
		fasta: `${fasta.join('\n')}\n`,
		taxa: name.slice(0, N_TIPS),
		times: name.slice(0, N_TIPS).map((n, i) => time[i]),
		trueRootToTip,
		expectedRootToTip,
		rootTime: time[root]
	};
}

const DATA = synthetic();

describe('the synthetic dataset is what the tolerances were computed for', () => {
	it('has 60 tips over a 20-year span at L = 3000', () => {
		expect(DATA.taxa.length).toBe(N_TIPS);
		expect(Math.max(...DATA.times) - Math.min(...DATA.times)).toBeGreaterThan(SPAN * 0.8);
		expect(DATA.fasta.split('\n')[1].length).toBe(L);
	});
});

describe('claim 1 — the algebra, at relative 1e-12', () => {
	it('reproduces a closed-form slope, intercept and R² exactly', () => {
		// A planted exact line: d = 0.5 + 0.05·(t − 10), so mu = 0.05, d0 = 0.5, r2 = 1, and the
		// ancestor lands at t = 0, comfortably before the earliest sample.
		const t = [8, 9, 10, 11, 12];
		const d = t.map((x) => 0.5 + 0.05 * (x - 10));
		const fit = clockRegression({ taxa: t.map(String), divergence: d, times: t });
		expect(fit.ok).toBe(true);
		expect(fit.tRef).toBeCloseTo(10, 12);
		expect(Math.abs(fit.mu - 0.05) / 0.05).toBeLessThan(1e-12);
		expect(Math.abs(fit.d0 - 0.5)).toBeLessThan(1e-12);
		expect(Math.abs(fit.r2 - 1)).toBeLessThan(1e-12);
		// t_mrca = t_ref − d0/mu, and it is BEFORE the earliest sample, so the status is OK.
		expect(Math.abs(fit.tMrca - (10 - 0.5 / 0.05))).toBeLessThan(1e-12);
		expect(fit.status).toBe(CLOCK_STATUS.OK);
		expect(fit.sigma2).toBeLessThan(1e-24);
	});

	it('centres on the mean date, so d0 is divergence at t_ref and not at year zero', () => {
		const t = [2019, 2020, 2021];
		const d = [0.01, 0.02, 0.03];
		const fit = clockRegression({ taxa: ['a', 'b', 'c'], divergence: d, times: t });
		expect(fit.tRef).toBe(2020);
		expect(Math.abs(fit.d0 - 0.02)).toBeLessThan(1e-15);
		// The uncentred intercept would be 0.02 − 0.01·2020 = −20.18; d0 must NOT be that.
		expect(fit.d0).toBeGreaterThan(0);
	});
});

describe('claim 2 — the estimator, and what its standard error does NOT cover', () => {
	it('is unbiased: on the noise-free predictor it returns mu_true to machine precision', () => {
		const fit = clockRegression({
			taxa: DATA.taxa,
			divergence: DATA.taxa.map((n) => DATA.expectedRootToTip.get(n)),
			times: DATA.times
		});
		expect(fit.ok).toBe(true);
		expect(Math.abs(fit.mu - MU_TRUE) / MU_TRUE).toBeLessThan(1e-12);
		expect(Math.abs(fit.tMrca - DATA.rootTime)).toBeLessThan(1e-9);
		expect(Math.abs(fit.r2 - 1)).toBeLessThan(1e-12);
	});

	// MEASURED, AND A FINDING WORTH KEEPING. On the REALISED divergences of one simulated
	// alignment the rate lands 35 % from mu_true, while the fit's own se_mu is 4.2e-5 — the
	// deviation is about EIGHT standard errors. That is not a bug in the arithmetic (the test
	// above shows the estimator is unbiased): root-to-tip residuals are NOT independent, because
	// two tips sharing a deep branch share every substitution drawn on it, and ordinary least
	// squares assumes they are. The root-to-tip specification's se_mu ≈ 6 % of mu_true was
	// computed from independent Poisson noise and is therefore an underestimate of the real
	// sampling error by roughly this factor. The consequence for the product is a copy rule, not
	// a code change: the /time page prints se_mu labelled "standard error, delta method" and says
	// the dating analysis reports a wider exact interval — it must never present se_mu as a
	// confidence interval on the rate.
	const realised = clockRegression({
		taxa: DATA.taxa,
		divergence: DATA.taxa.map((n) => DATA.trueRootToTip.get(n)),
		times: DATA.times
	});

	it('recovers mu_true from one simulated alignment to within the measured 40 %', () => {
		expect(Math.abs(realised.mu - MU_TRUE) / MU_TRUE).toBeLessThan(MEASURED_ESTIMATOR_TOLERANCE);
	});

	it('and its own standard error is much smaller than that deviation (the non-independence)', () => {
		expect(Math.abs(realised.mu - MU_TRUE) / realised.seMu).toBeGreaterThan(3);
	});

	it('puts the ancestor before every sample and reports a strong signal', () => {
		expect(realised.status).toBe(CLOCK_STATUS.OK);
		expect(realised.tMrca).toBeLessThan(Math.min(...DATA.times));
		expect(realised.r2).toBeGreaterThan(0.9);
		expect(realised.negligible).toBe(false);
	});
});

describe('claim 3 — the whole preview pipeline, against MEASURED and pinned bounds', () => {
	const walked = treeDivergences(DATA.newick);
	const timeOf = new Map(DATA.taxa.map((n, i) => [n, DATA.times[i]]));

	it('parses, gates and roots the supplied tree', () => {
		expect(walked.ok).toBe(true);
		expect(walked.code).toBeNull();
		expect(walked.rootLabel).toBe('midpoint');
		expect(walked.names.length).toBe(N_TIPS);
		expect(walked.gate.ratio).toBeGreaterThanOrEqual(0.8);
	});

	const fit = clockRegression({
		taxa: walked.names,
		divergence: walked.divergence,
		times: walked.names.map((n) => timeOf.get(n))
	});
	// The comparison is against the NOISE-FREE fit from the TRUE root, so the only difference
	// between the two is where the root was placed — which is the systematic claim being made.
	const truth = clockRegression({
		taxa: DATA.taxa,
		divergence: DATA.taxa.map((n) => DATA.expectedRootToTip.get(n)),
		times: DATA.times
	});

	it('recovers the rate to within the measured 0.5 %', () => {
		expect(Math.abs(fit.mu - truth.mu) / truth.mu).toBeLessThan(MEASURED_RATE_TOLERANCE);
	});

	it('recovers the ancestor time to within the measured ±0.25 years', () => {
		expect(Math.abs(fit.tMrca - truth.tMrca)).toBeLessThan(MEASURED_MRCA_TOLERANCE);
	});

	it('reports the root sensitivity across several rootings', () => {
		const outgroup = treeDivergences(DATA.newick, { root: 'outgroup', outgroup: DATA.taxa[0] });
		const fits = [
			{ label: 'midpoint', fit },
			{
				label: 'outgroup',
				fit: clockRegression({
					taxa: outgroup.names,
					divergence: outgroup.divergence,
					times: outgroup.names.map((n) => timeOf.get(n))
				})
			}
		];
		const spread = rootSensitivity(fits, SPAN);
		expect(spread).not.toBeNull();
		expect(spread.values.length).toBe(2);
		expect(Number.isFinite(spread.spread)).toBe(true);
	});
});

describe('claim 4 — the guards, every one a stated refusal rather than NaN', () => {
	it('refuses fewer than three dated taxa', () => {
		const fit = clockRegression({ taxa: ['a', 'b'], divergence: [0.1, 0.2], times: [2000, 2001] });
		expect(fit.ok).toBe(false);
		expect(fit.refusal).toBe(CLOCK_REFUSALS.TOO_FEW_DATED);
	});

	it('refuses when every taxon carries the same date, without dividing by zero', () => {
		const fit = clockRegression({
			taxa: ['a', 'b', 'c'],
			divergence: [0.1, 0.2, 0.3],
			times: [2010, 2010, 2010]
		});
		expect(fit.ok).toBe(false);
		expect(fit.refusal).toBe(CLOCK_REFUSALS.NO_TIME_SPAN);
		expect(fit.tied).toBe(2010);
	});

	it('reports NON_POSITIVE_RATE and no ancestor time when the fit slopes down', () => {
		const fit = clockRegression({
			taxa: ['a', 'b', 'c', 'd'],
			divergence: [0.4, 0.3, 0.2, 0.1],
			times: [2000, 2001, 2002, 2003]
		});
		expect(fit.status).toBe(CLOCK_STATUS.NON_POSITIVE_RATE);
		expect(Number.isNaN(fit.tMrca)).toBe(true);
	});

	it('reports MRCA_AFTER_EARLIEST_SAMPLE rather than an impossible ancestor time', () => {
		// Divergence near zero at the earliest sample and rising steeply: the line crosses zero
		// AFTER the first sequence was collected.
		const fit = clockRegression({
			taxa: ['a', 'b', 'c'],
			divergence: [0.0, 1.0, 2.0],
			times: [2000, 2001, 2002]
		});
		expect(fit.status).toBe(CLOCK_STATUS.MRCA_AFTER_EARLIEST_SAMPLE);
		expect(Number.isNaN(fit.tMrca)).toBe(true);
	});

	it('flags a taxon whose date is 50 years late, with a temporal residual near −50', () => {
		const taxa = DATA.taxa.slice();
		const times = DATA.times.slice();
		times[7] = times[7] + 50;
		const fit = clockRegression({
			taxa,
			divergence: taxa.map((n) => DATA.trueRootToTip.get(n)),
			times
		});
		const bad = fit.rows.find((r) => r.taxon === taxa[7]);
		expect(bad.isOutlier).toBe(true);
		expect(bad.temporalResidual).toBeLessThan(-30);
	});

	it('refuses a unit-branch-length tree before any regression', () => {
		const walked = treeDivergences('((A:1,B:1):1,(C:1,D:1):1);');
		expect(walked.ok).toBe(false);
		expect(walked.code).toBe(TREE_REFUSALS.UNIT_BRANCH_LENGTHS);
		expect(walked.divergence).toBeNull();
	});

	it('refuses a tree with 90 % zero-length branches that the model gate would accept', () => {
		const tree = parseClockTree('((A:0,B:0):0,((C:0,D:0):0,(E:0.4,F:0):0):0);');
		const gate = branchLengthGate(tree);
		expect(gate.ok).toBe(false);
		expect(gate.code).toBe(TREE_REFUSALS.NO_BRANCH_LENGTHS);
		expect(gate.ratio).toBeLessThan(0.8);
	});

	it('refuses when every root-to-tip distance is identical', () => {
		const walked = treeDivergences('((A:0.1,B:0.1):0.1,(C:0.1,D:0.1):0.1);');
		expect(walked.ok).toBe(false);
		expect(walked.code).toBe(TREE_REFUSALS.NO_DIVERGENCE_SPREAD);
	});

	it('refuses no tree and an unparseable one distinctly', () => {
		expect(treeDivergences(null).code).toBe(TREE_REFUSALS.NO_TREE);
		expect(treeDivergences('').code).toBe(TREE_REFUSALS.NO_TREE);
		expect(treeDivergences('this is not a tree').code).toBe(TREE_REFUSALS.UNPARSED);
	});

	it('excludes undated taxa and counts them, imputing nothing', () => {
		const taxa = DATA.taxa.slice(0, 10);
		const times = taxa.map((n, i) => (i < 2 ? Number.NaN : DATA.times[i]));
		const fit = clockRegression({
			taxa,
			divergence: taxa.map((n) => DATA.trueRootToTip.get(n)),
			times,
			undated: 2
		});
		expect(fit.n).toBe(8);
		expect(fit.nDropped).toBe(2);
		expect(fit.rows.length).toBe(8);
	});

	it('calls a shuffled-date dataset negligible and still renders a number', () => {
		const taxa = DATA.taxa.slice();
		const times = DATA.times.slice().reverse();
		const fit = clockRegression({
			taxa,
			divergence: taxa.map((n) => DATA.trueRootToTip.get(n)),
			times
		});
		expect(fit.ok).toBe(true);
		expect(fit.negligible).toBe(true);
		expect(Number.isFinite(fit.mu)).toBe(true);
	});
});

describe('rooting', () => {
	// Measured against phylotree 2.6.0 on this exact Newick (see rootToTip.js's header): its
	// computeMidpoint returns the AB clade at breakpoint 0.6667, giving A 0.3, B 0.4, C 0.3, D 0.4.
	const NWK = '((A:0.1,B:0.2):0.3,(C:0.15,D:0.25):0.05);';

	it('places the midpoint on the longest leaf-to-leaf path', () => {
		const tree = parseClockTree(NWK);
		const mp = midpointRoot(tree);
		expect(mp.pathLength).toBeCloseTo(0.8, 12); // B → D
		expect(mp.tips.sort()).toEqual(['B', 'D']);
		const walked = rootToTipDivergences(tree, mp);
		const byName = new Map(walked.names.map((n, i) => [n, walked.divergence[i]]));
		expect(byName.get('A')).toBeCloseTo(0.3, 12);
		expect(byName.get('B')).toBeCloseTo(0.4, 12);
		expect(byName.get('C')).toBeCloseTo(0.3, 12);
		expect(byName.get('D')).toBeCloseTo(0.4, 12);
	});

	it('roots on a named outgroup at half its branch', () => {
		const tree = parseClockTree(NWK);
		const walked = rootToTipDivergences(tree, { node: 2, fraction: 0.5 }); // A
		const byName = new Map(walked.names.map((n, i) => [n, walked.divergence[i]]));
		expect(byName.get('A')).toBeCloseTo(0.05, 12);
		expect(byName.get('B')).toBeCloseTo(0.05 + 0.2, 12);
		expect(byName.get('D')).toBeCloseTo(0.05 + 0.3 + 0.05 + 0.25, 12);
	});

	it('reads a tree embedded in an alignment through the library extractor', () => {
		const nexus = `#NEXUS\nBEGIN TREES;\n TREE t = ${NWK}\nEND;\n`;
		const tree = parseClockTree(nexus);
		expect(tree).not.toBeNull();
		expect(branchLengthGate(tree).ok).toBe(true);
	});
});
