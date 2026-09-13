/**
 * caps.js — how many sequences the temporal pillar runs on, per surface, and what each of those
 * numbers actually costs.
 *
 * WHY THIS FILE EXISTS. Phase 6 shipped three surfaces that disagreed about what this pillar even
 * runs on. The `/time` page passed `maxSpecies: 256` (`TEMPORAL_MAX_SPECIES`, the report's own
 * `default_taxon_cap`); the MCP and the server passed `Infinity`, which is the reference's own
 * `-s/--max-species` default (cli.py:1850) and therefore defensible — but "no cap at all" was not
 * argued anywhere, it was the absence of an argument, and the three surfaces could not both be
 * right about a number that changes which sequences the model sees. The policy and its measurements
 * belong in one place all three import, and a cap is result semantics — it decides which data the
 * answer is about — so that place is here rather than in any one wrapper.
 *
 * THE TWO NUMBERS ARE DIFFERENT THINGS AND MUST NOT BE CONFLATED.
 *
 *   THE CAP (`cap`) is `options.maxSpecies`: above it the library reduces the alignment by Faith's
 *   phylogenetic diversity after a stride prefilter. That reduction is TIME-BLIND (D27) and can
 *   remove the early part of an epidemic — exactly the part a sweep is measured against — so a
 *   capped run is not comparable with a command-line run on the whole file. A cap is therefore a
 *   COST decision that changes the science, and `null` (no cap, the reference's own default) is the
 *   right default anywhere the wait can be afforded.
 *
 *   THE CEILING (`ceiling`) is a REFUSAL: above it the surface does not start. It changes no
 *   science, because no run happens. PLAN.md §3.5 and §4.3 set it at 1,000 sequences for every
 *   analysis this repository serves ("> 1,000 refuse"), and `mcp/src/caps.js` `MAX_TAXA` already
 *   enforces exactly that on the MCP and, through it, on the server. This file restates it so the
 *   temporal policy is readable in one object, and does not invent a second number.
 *
 * WHAT AN UNCAPPED RUN COSTS, MEASURED rather than modelled. `examples/H5N1_HA_geo.fasta` (566
 * codons) expanded to N sequences by point mutation of its own 98 — twelve random substitutions per
 * added sequence, so every sequence is unique and the duplicate collapse never fires — run through
 * `runTemporal` at `numTimePoints: 60`, `permutations: 200`, `maxSpecies: Infinity`, 4 intra-op
 * threads, `general.onnx` under onnxruntime-node, Node 22.22.0 x64 under Rosetta on an Apple M4 Pro.
 * One isolated process per row; the machine's one-minute load average was 17-26 throughout, which
 * is its ordinary state on this project and not an idle box. Peak RSS is sampled at 50 ms.
 *
 *     taxa   infer s   total s   peak RSS   stage-one candidates   codon-sequences / s
 *       97      3.46      4.28    1 729 MB      168 of 566                15 869
 *      199      6.37      7.24    1 761 MB      437 of 566                17 681
 *      399     18.07     19.58    1 710 MB      545 of 566                12 497
 *      511     25.77     28.08    1 752 MB      556 of 566                11 223
 *      799     53.83     59.18    1 346 MB      564 of 566                 8 400
 *    1 499    192.33    232.11    2 273 MB      565 of 566                 4 411
 *
 * THREE THINGS IN THAT TABLE DECIDE THE POLICY, and none of them is the one the phase assumed.
 *
 *   1. MEMORY IS NOT THE BINDING CONSTRAINT. Peak RSS is flat at 1.3-2.3 GB across a 15-fold range
 *      of N, because `resolveBatchSize` (`predict.js`) bounds the batch by a measured per-taxon-pair
 *      working set and simply hands the graph fewer sites as N grows. A 1,499-sequence run fits in
 *      2.3 GB. TIME is the constraint, and it is the only one.
 *   2. THE PASS IS NOT LINEAR IN N, and the rate constant the `/time` page quotes for its cost
 *      sentence (`TEMPORAL_MODEL_RATE`, 2.0e4 codon-sequences a second) is a LOCAL anchor near the
 *      browser's own cap, not a law. The measured rate falls 3.6-fold from 97 to 1,499 sequences,
 *      so at 1,500 that constant over-states throughput by about 4.5x — 42 s predicted against 192 s
 *      measured. Nothing here may quote it above a few hundred sequences; `temporalInferSeconds`
 *      interpolates the table above instead.
 *   3. THE PILLAR'S OWN FILTER GOES VACUOUS AS N GROWS. Stage one passed 168 of 566 codons at 97
 *      sequences and 565 of 566 at 1,499: more sequences means more variation, and the energy floor
 *      is not scale-free. At a surveillance size nearly every codon is a candidate, the null is run
 *      on all of them, and Benjamini-Hochberg's family is the whole gene rather than a shortlist.
 *      That is not an argument for capping — a cap deletes sequences, which is worse — but it is
 *      why a big run is a different reading exercise and why `temporalTaxonPlan` says so.
 *
 * THE POLICY THIS SETTLES ON, per surface, with the reason each one differs:
 *
 *   browser  cap 256, no refusal. A reader is watching a tab and a cancelled run keeps nothing of
 *            the model pass. 256 is the report's own `default_taxon_cap` (`REPORT_DEFAULTS`), and
 *            `temporalInferSeconds` puts it at 9 s of model pass on this 566-codon shape and 72 s
 *            on an H1N1-sized 4,384-codon one — interpolated between the 199- and 399-sequence rows
 *            above, not separately measured. The cap is disclosed at the point of use:
 *            `primaeon.taxon_cap: 'applied'`, an honesty note and a `-s` flag on the reproduction
 *            line.
 *   mcp      NO cap, refuse above 1,000. A tool call is synchronous and the client's own timeout is
 *            the real bound, but silently analysing a different set of sequences than the caller
 *            submitted is worse than waiting: the reference's default is no cap and this keeps it.
 *            1,000 is `mcp/src/caps.js` `MAX_TAXA`, already enforced at submission, and it prices
 *            at 85 s of model pass on this 566-codon shape (interpolated between the 799- and
 *            1,499-sequence rows) and 11 minutes on a 4,384-codon one — long for a tool call, and
 *            the reason a caller who wants an answer sooner passes `max_species` explicitly.
 *   server   NO cap, refuse above 1,000, for the same reason plus one: the job carries SSE progress,
 *            so a long wait is watchable rather than opaque. The ceiling is the same policy number,
 *            and it is NOT a claim that everything under it finishes: `HYPHAEON_JOB_TIMEOUT_MS` is
 *            600 s by default, the measured 1,499-sequence run on a 566-codon gene took 232 s, and
 *            1,000 sequences on an H1N1-sized 4,384-codon gene interpolates to about 11 MINUTES of
 *            model pass — over that timeout. Sizing is the timeout's job and refusing is the
 *            ceiling's; `temporalTaxonPlan().estimate` is what a caller prices the first against.
 *
 * WHAT IS DELIBERATELY NOT HERE. No new refusal code and no new threshold: the ceiling is PLAN.md's
 * and the surfaces already enforce it. This file names the policy, prices it, and gives all three
 * one sentence to say about it.
 */

import { TEMPORAL_THRESHOLDS } from './codes.js';

/**
 * The measured cost table above, as data, so a caller can price a run without re-reading a comment.
 * `taxa` is the count AFTER duplicate collapse (what the model actually saw); `codons` is fixed at
 * 566 because every row is the same alignment.
 */
export const TEMPORAL_TAXON_COST = Object.freeze([
	Object.freeze({ taxa: 97, codons: 566, inferSeconds: 3.46, totalSeconds: 4.28, peakRssMb: 1729, candidates: 168 }),
	Object.freeze({ taxa: 199, codons: 566, inferSeconds: 6.37, totalSeconds: 7.24, peakRssMb: 1761, candidates: 437 }),
	Object.freeze({ taxa: 399, codons: 566, inferSeconds: 18.07, totalSeconds: 19.58, peakRssMb: 1710, candidates: 545 }),
	Object.freeze({ taxa: 511, codons: 566, inferSeconds: 25.77, totalSeconds: 28.08, peakRssMb: 1752, candidates: 556 }),
	Object.freeze({ taxa: 799, codons: 566, inferSeconds: 53.83, totalSeconds: 59.18, peakRssMb: 1346, candidates: 564 }),
	Object.freeze({ taxa: 1499, codons: 566, inferSeconds: 192.33, totalSeconds: 232.11, peakRssMb: 2273, candidates: 565 })
]);

/** PLAN.md §3.5 / §4.3, and `mcp/src/caps.js` `MAX_TAXA`. Restated, never re-derived. */
export const TEMPORAL_TAXON_CEILING = 1000;

/**
 * The default `options.maxSpecies` per surface. `null` means NO downsampling, which is the
 * reference's own `-s` default; a number means Faith's-PD reduction above it, which is time-blind
 * (D27) and must be disclosed wherever it bites.
 *
 * `runtime` is what a bare `runTemporal` caller gets — the parity runner, a test, a script — and it
 * is `null` for the same reason the MCP's is: a parity comparison against `hyphaeon temporal` may
 * never run on a different set of sequences than the reference did.
 *
 * THE KEYS ARE THE STRINGS THE SURFACES ACTUALLY STAMP, not four readable nicknames. The first
 * version of this table was keyed `browser | mcp | server | runtime`, and exactly one of those —
 * `browser` — is a value any caller passes: `provenance.surface` is `web-time` on the `/time` page,
 * `mcp-stdio` or `mcp-http` on the MCP and `node-server` on the server. Every lookup but the
 * browser's therefore missed and fell through to the runtime's default. It fell through to the
 * RIGHT answer, because all three are `null` today, which is precisely what makes the bug worth
 * fixing now rather than when someone changes one of them: a table nobody can hit reads as policy
 * and behaves as a no-op. The nicknames are kept as aliases so a caller may use either.
 */
export const TEMPORAL_TAXON_CAPS = Object.freeze({
	// the readable names, for a caller naming a policy rather than a run
	browser: TEMPORAL_THRESHOLDS.browserTaxonCap,
	mcp: null,
	server: null,
	runtime: null,
	// the strings `provenance.surface` actually carries
	'web-time': TEMPORAL_THRESHOLDS.browserTaxonCap,
	'mcp-stdio': null,
	'mcp-http': null,
	'node-server': null,
	'python-reference': null
});

/** The cap for a surface; an unknown surface gets the runtime's (no cap), never the browser's. */
export function temporalTaxonCap(surface) {
	return Object.prototype.hasOwnProperty.call(TEMPORAL_TAXON_CAPS, surface)
		? TEMPORAL_TAXON_CAPS[surface]
		: TEMPORAL_TAXON_CAPS.runtime;
}

/**
 * Seconds of model pass, INTERPOLATED in log-log on the measured table rather than fitted to a law.
 *
 * Between two measured rows the interpolation is exact at both ends and monotone between them;
 * outside them it extends the nearest measured segment, which is an extrapolation and is flagged as
 * one on the return. Codons scale LINEARLY, which is the weakest assumption here and is the one the
 * `/time` page's own measurements support: 4,384 x 95 codon-sequences is 7.6 times 566 x 97 and took
 * 5.5-8.4 times the seconds across nine runs. This is an anchor, not a bound: the machine it was
 * measured on was never idle, and on an idle one every figure is smaller.
 *
 * @param {number} taxa sequences the model will see, after duplicate collapse
 * @param {number} codons codons in the alignment
 * @returns {{seconds: number, extrapolated: boolean}|null} null when either count is unusable
 */
export function temporalInferSeconds(taxa, codons) {
	if (!(taxa > 0) || !(codons > 0)) return null;
	const rows = TEMPORAL_TAXON_COST;
	let lo = 0;
	let hi = rows.length - 1;
	let extrapolated = false;
	if (taxa <= rows[0].taxa) {
		lo = 0;
		hi = 1;
		extrapolated = taxa < rows[0].taxa;
	} else if (taxa >= rows[hi].taxa) {
		lo = rows.length - 2;
		extrapolated = taxa > rows[hi].taxa;
	} else {
		while (rows[lo + 1].taxa < taxa) lo++;
		hi = lo + 1;
	}
	const a = rows[lo];
	const b = rows[hi === lo ? lo + 1 : hi];
	const t = (Math.log(taxa) - Math.log(a.taxa)) / (Math.log(b.taxa) - Math.log(a.taxa));
	const seconds = Math.exp(Math.log(a.inferSeconds) + t * (Math.log(b.inferSeconds) - Math.log(a.inferSeconds)));
	return { seconds: (seconds * codons) / a.codons, extrapolated };
}

/**
 * What a surface should do with an alignment of this size: the cap to pass, whether to refuse, and
 * the one sentence that says why. Every surface calls this instead of holding its own number.
 *
 * @param {{surface?: string, taxa: number, codons?: number|null}} args
 * @returns {{cap: number|null, refuse: boolean, ceiling: number, capApplies: boolean,
 *   estimate: {seconds: number, extrapolated: boolean}|null, reason: string}}
 */
export function temporalTaxonPlan({ surface = 'runtime', taxa, codons = null }) {
	const cap = temporalTaxonCap(surface);
	const ceiling = TEMPORAL_TAXON_CEILING;
	const refuse = Number.isFinite(taxa) && taxa > ceiling;
	const capApplies = cap != null && Number.isFinite(taxa) && taxa > cap;
	const used = capApplies ? cap : taxa;
	const estimate = codons ? temporalInferSeconds(used, codons) : null;
	let reason;
	if (refuse) {
		reason =
			`This alignment has ${taxa} sequences and the refusal ceiling is ${ceiling} (PLAN.md §3.5). ` +
			'The pillar would run — memory is flat and a 1,499-sequence run was measured at 232 s — but a run ' +
			'that size is a batch job, not a request. Reduce the alignment yourself, so you choose which ' +
			'sequences go, rather than letting a time-blind reduction choose for you.';
	} else if (capApplies) {
		reason =
			`This surface caps the model at ${cap} sequences and the alignment has ${taxa}, so ${taxa - cap} will be ` +
			'removed by Faith\'s phylogenetic diversity before the model sees anything. That reduction is time-blind ' +
			'(D27) and can take the early part of an epidemic with it, so this run is not comparable with a ' +
			'command-line run on the whole file.';
	} else if (cap == null) {
		reason =
			`All ${taxa} sequences go to the model: this surface applies no cap, which is \`hyphaeon temporal\`'s own ` +
			'default (cli.py:1850). Nothing is downsampled and nothing is time-blind.';
	} else {
		reason = `All ${taxa} sequences go to the model: the cap on this surface is ${cap} and this alignment is under it.`;
	}
	return { cap, refuse, ceiling, capApplies, estimate, reason };
}

/**
 * The sentence a big run needs beside its candidate count, because the stage-one floor is not
 * scale-free and the table above is the evidence. Returned only when it applies, so a surface can
 * push it straight onto a note list.
 *
 * @param {{taxa: number, candidates: number, codons: number}} args
 * @returns {string|null}
 */
export function temporalScaleNote({ taxa, candidates, codons }) {
	if (!(taxa > 0) || !(codons > 0)) return null;
	const share = candidates / codons;
	if (share < 0.5) return null;
	return (
		`${candidates} of ${codons} codons passed the sweep-energy floor, which is ${Math.round(share * 100)} % of the ` +
		'alignment. The floor is an energy threshold, not a quantile, so it is not scale-free: measured on one ' +
		'566-codon gene, stage one passed 168 codons at 97 sequences and 565 at 1,499, because more sequences means ' +
		`more variation at every codon. With ${candidates} candidates the permutation test is being run on nearly the ` +
		'whole gene and Benjamini-Hochberg\'s family is the whole gene with it, so `q_perm` is correspondingly weaker ' +
		'than it would be on a shortlist. Read the trajectories and the effect sizes, not the candidate count.'
	);
}
