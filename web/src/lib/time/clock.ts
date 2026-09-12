/**
 * clock.ts — the `/time` page's half of the clock preview: turn the reviewed dates and the
 * reader's tree into a fit, and say in words what it does and does not claim.
 *
 * WHY THIS FILE EXISTS. The arithmetic is `@veg/hyphaeon-runtime/clock` (`rootToTip.js`,
 * `clockRegression.js`), because `mcp/` and `server/` will want it verbatim the moment the dating
 * tool lands. What belongs to the page, and therefore lives here, is the DECIDING and the SAYING:
 * which of the three tree states the upload is in, whether a preview may be drawn at all, which
 * sentence goes under which number, and the verdict line.
 *
 * THE PREVIEW IS OFFERED ONLY WHEN THE UPLOAD CARRIES A TREE WITH USABLE BRANCH LENGTHS, and that
 * is a scope decision made deliberately rather than a limitation discovered late. The reference's
 * tree-free divergence is not root-to-tip on a tree at all — `compute_tree_free_divergences`
 * (dating.py:623-700) measures TN93 distance from each taxon to a synthetic, time-decay weighted
 * consensus root. Computing distances here would mean importing the runtime's pipeline and a worker
 * into a route whose whole claim is that it loads no model, and drawing a regression from distances
 * this page computed itself would be the estimator, ported early and unflagged. So the tree-free
 * majority gets one sentence saying why there is no preview, and the estimator arrives in phase 3
 * with the distances it needs.
 *
 * WHAT THE PREVIEW MUST NOT CLAIM, in four sentences, because the page prints them:
 *   - the divergence scale threatens the RATE; a rescaling c leaves `t_MRCA = t_ref - d0/mu`
 *     untouched and multiplies `mu` by c;
 *   - the root placement threatens the DATE; a root too deep adds a constant a to every divergence
 *     and moves the ancestor earlier by exactly a/mu, which is why the root sensitivity is printed;
 *   - the standard errors are delta-method standard errors, not an interval, and the run's exact
 *     interval is wider — and, measured on the seeded synthetic in
 *     `runtime/test/clock-preview.test.js`, even those standard errors UNDERSTATE the real sampling
 *     error, because root-to-tip residuals share branches and ordinary least squares assumes they
 *     do not;
 *   - on a user tree the branch-length units cannot be verified, so the rate is per tree unit.
 *
 * FORBIDDEN ON THIS SECTION (root-to-tip specification §4.1): the words *dating*, *TMRCA*,
 * *calibrated*, *confidence interval*, *molecular clock estimate*, and any download named
 * `dating.*`.
 */

import {
	CLOCK_STATUS,
	TREE_REFUSALS,
	clockRegression,
	rootSensitivity,
	treeDivergences
} from '@veg/hyphaeon-runtime/clock';
import type { DateIngestLike } from './dateReview';
import type { TimeUnits } from './types';

export interface ClockFit {
	ok: boolean;
	refusal: string | null;
	status?: string;
	n: number;
	nUndated: number;
	nDropped: number;
	mu: number;
	d0: number;
	tRef: number;
	sigma2: number;
	seMu: number;
	seD0: number;
	tMrca: number;
	seMrca: number;
	r: number;
	r2: number;
	rmse: number;
	residualSd: number;
	earliest: number;
	latest: number;
	outliers: number;
	negligible: boolean;
	tied?: number;
	rows: Array<{
		taxon: string;
		samplingDate: number;
		rootDivergence: number;
		fittedDivergence: number;
		divergenceResidual: number;
		predictedDate: number;
		temporalResidual: number;
		zScore: number;
		isOutlier: boolean;
	}>;
}

export interface ClockPreview {
	available: boolean;
	/** Why not, in the page's words, when `available` is false. */
	reason: string | null;
	code: string | null;
	fit: ClockFit | null;
	/** The divergence per taxon, in tree leaf order, for the figure. */
	points: Array<{ taxon: string; time: number; divergence: number; outlier: boolean }>;
	rootLabel: string;
	sensitivity: { values: Array<{ label: string; tMrca: number }>; spread: number; wide: boolean } | null;
	units: TimeUnits;
	/** True when branch lengths came from the reader's tree and we cannot verify their scale. */
	userScale: boolean;
}

const NO_PREVIEW: Record<string, string> = {
	[TREE_REFUSALS.NO_TREE]:
		'No tree was supplied, so there is nothing to measure divergence against. Drop a Newick tree with branch lengths beside the alignment and the preview appears.',
	[TREE_REFUSALS.UNPARSED]: 'The tree file could not be read as Newick, so no divergence could be measured.',
	[TREE_REFUSALS.TOO_FEW_TIPS]: 'The tree has fewer than three tips.',
	[TREE_REFUSALS.UNIT_BRANCH_LENGTHS]:
		'Your tree has a shape but no branch lengths, so there is nothing to regress against. Drop a tree with branch lengths, or run the analysis and read the clock there.',
	[TREE_REFUSALS.NO_BRANCH_LENGTHS]:
		'Too few of the branches carry a usable length for a regression. Drop a tree with branch lengths, or run the analysis and read the clock there.',
	[TREE_REFUSALS.NO_DIVERGENCE_SPREAD]:
		'Every tip sits the same distance from the root, so divergence carries no information here. Identical sequences do this.'
};

export interface ClockInput {
	treeText: string | null;
	ingest: DateIngestLike | null;
	rootMode?: 'midpoint' | 'outgroup';
	outgroup?: string | null;
}

/** Parse, gate, root, walk, fit — and decide what may be shown. Synchronous; microseconds. */
export function clockPreview({ treeText, ingest, rootMode = 'midpoint', outgroup = null }: ClockInput): ClockPreview {
	const units: TimeUnits = ingest?.time_units ?? 'years';
	const empty: ClockPreview = {
		available: false,
		reason: NO_PREVIEW[TREE_REFUSALS.NO_TREE],
		code: TREE_REFUSALS.NO_TREE,
		fit: null,
		points: [],
		rootLabel: 'none',
		sensitivity: null,
		units,
		userScale: true
	};
	if (!ingest) return empty;

	const walked = treeDivergences(treeText, { root: rootMode, outgroup });
	if (!walked.ok) {
		return { ...empty, reason: NO_PREVIEW[walked.code ?? ''] ?? empty.reason, code: walked.code };
	}

	const timeOf = new Map<string, number>();
	for (const row of ingest.rows) {
		if (row.value != null && Number.isFinite(row.value)) timeOf.set(row.taxon, row.value);
	}

	const taxa: string[] = [];
	const divergence: number[] = [];
	const times: number[] = [];
	let undated = 0;
	for (let i = 0; i < walked.names.length; i++) {
		const name = walked.names[i];
		const t = timeOf.get(name);
		if (t == null) {
			undated += 1;
			continue;
		}
		taxa.push(name);
		divergence.push(walked.divergence![i]);
		times.push(t);
	}

	const fit = clockRegression({ taxa, divergence, times, undated, units }) as unknown as ClockFit;
	if (!fit.ok) {
		const reason =
			fit.refusal === 'TOO_FEW_DATED'
				? `Only ${fit.n} tip${fit.n === 1 ? '' : 's'} of this tree carry a date; at least 3 are needed for a line with any residual degrees of freedom.`
				: 'Every dated tip carries the same date, so there is no time axis to regress against.';
		return { ...empty, reason, code: fit.refusal, fit, rootLabel: walked.rootLabel };
	}

	const outlierOf = new Map(fit.rows.map((r) => [r.taxon, r.isOutlier]));
	const points = taxa.map((taxon, i) => ({
		taxon,
		time: times[i],
		divergence: divergence[i],
		outlier: outlierOf.get(taxon) === true
	}));

	// The cheap robustness check: the same O(n) fit under a second root costs one more tree walk.
	let earliestAt = 0;
	for (let i = 1; i < times.length; i++) if (times[i] < times[earliestAt]) earliestAt = i;
	const earliestTaxon = taxa[earliestAt];
	const alternative = treeDivergences(treeText, { root: 'outgroup', outgroup: earliestTaxon });
	let sensitivity: ClockPreview['sensitivity'] = null;
	if (alternative.ok) {
		const altTaxa: string[] = [];
		const altD: number[] = [];
		const altT: number[] = [];
		for (let i = 0; i < alternative.names.length; i++) {
			const t = timeOf.get(alternative.names[i]);
			if (t == null) continue;
			altTaxa.push(alternative.names[i]);
			altD.push(alternative.divergence![i]);
			altT.push(t);
		}
		const altFit = clockRegression({ taxa: altTaxa, divergence: altD, times: altT, units });
		sensitivity = rootSensitivity(
			[
				{ label: walked.rootLabel, fit },
				{ label: `earliest tip (${earliestTaxon})`, fit: altFit }
			],
			fit.latest - fit.earliest
		);
	}

	return {
		available: true,
		reason: null,
		code: null,
		fit,
		points,
		rootLabel: walked.rootLabel,
		sensitivity,
		units,
		userScale: true
	};
}

/** The one-line verdict, at the reference's own cutoffs so the preview and a run never disagree. */
export function verdict(preview: ClockPreview): string {
	const fit = preview.fit;
	if (!preview.available || !fit || !fit.ok) return '';
	if (fit.status === CLOCK_STATUS.NON_POSITIVE_RATE) {
		return 'Divergence falls as sampling time rises, so this dataset carries no clock signal in this direction.';
	}
	if (fit.status === CLOCK_STATUS.MRCA_AFTER_EARLIEST_SAMPLE) {
		return 'The fit puts the common ancestor after one of your sequences was collected. That is not possible, so no ancestor time is shown. The usual cause is a wrong date or a misplaced root.';
	}
	if (fit.negligible) {
		return `The clock signal is negligible: R² ${fit.r2.toFixed(3)} against the reference’s own 0.02 cutoff.`;
	}
	return `The dates and the tree agree: R² ${fit.r2.toFixed(3)} over ${fit.n} dated tips.`;
}

/** The rate, with the units the page is allowed to claim. */
export function rateSentence(preview: ClockPreview): string {
	const unitWord =
		preview.units === 'years' ? 'year' : preview.units === 'generations' ? 'generation' : preview.units === 'days' ? 'day' : 'time unit';
	return `tree units per ${unitWord}`;
}
