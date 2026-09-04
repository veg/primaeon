/**
 * postprocess.js — turning the graph's raw output into per-site results.
 *
 * WHY THIS FILE EXISTS. Ported from datamonkey3/src/lib/services/axomeme/postprocess.js
 * (main@fac1330) MINUS `isSiteVariable` and `siteVariability`. Those two are ALIGNMENT functions
 * (is this site variable, given the aligned codons?) and mirror the invariable-site rule of
 * hyphaeon/dataset.py:718-723, so they live in the library — `@veg/hyphaeon-js`,
 * src/preprocess/variability.js — and are imported from there and re-exported here so existing
 * callers keep one import site. What stays in this file is RESULT SEMANTICS: what to show a
 * researcher and where to draw a line on a number the model produced. That is a product decision,
 * it changes without the methods changing, and it belongs to the app (PLAN.md §5.5; the library's
 * src/README.md states the same split from its side).
 *
 * `buildPredictions` is otherwise verbatim. The original header follows; its line citations are
 * into the AxoMEME handoff driver (predict_regression_nexus.py), whose zeroing-of-invariant-sites
 * rule HyphAeon's `predict_site_lrts` (inference.py:158-192) shares: invariable sites get LRT 0
 * without the model being consulted.
 *
 * postprocess.js — turning the graph's raw output into per-site results.
 *
 * THE v1-viral GRAPH RETURNS ONE TENSOR: `lrt`. The retired 2.0 export returned five, and the extra
 * four heads (alpha, beta_neg, beta_pos, p_neg) are where the dS, dN+ and p columns came from. They
 * do not exist in this model, so those fields are no longer emitted AT ALL rather than reported as
 * zero. A zero in a dS column reads as "no synonymous change", which would be a fabricated
 * measurement; an absent column reads as what it is.
 *
 * `lrt` IS the LRT, already ordinal-decoded in-graph (the export is eval mode). It is NOT a log —
 * worth checking rather than assuming, because the reference derives
 * `predicted_log_lrt = log1p(predicted_lrt)`, so the log column is the DERIVED one.
 *
 * INVARIANT SITES ARE ZEROED, NOT SCORED. `if not is_var:` sets every prediction to 0 before the
 * model's output is consulted (predict_regression_nexus.py:1394-1399). A site where every sequence
 * codes the same amino acid reports 0, whatever the network said. This is the reference's behaviour
 * and it matters for the UI: those zeros are "not applicable", not "no selection", and they are
 * excluded from the z-score and percentile statistics for exactly that reason.
 *
 * Source: predict_regression_nexus.py:1386-1466.
 */

import { GENETIC_CODE, isSiteVariable, siteVariability } from '@veg/hyphaeon-js';
import { CALL_DEFAULTS } from './callModes.js';

/**
 * The alignment half of DM3's postprocess.js, re-exported from the library so callers that
 * imported them from here keep working (see the header).
 */
export { isSiteVariable, siteVariability };

/**
 * The tier gates live in callModes.js — a leaf with no imports — so the pre-run copy in
 * MethodSelector can state what a mode will do without dragging tokenizer.js's genetic-code table
 * into the main bundle. Re-exported here because this is where every caller already looks for them,
 * and because one definition is the point of the move.
 */
export { CALL_DEFAULTS };

export const NEUTRAL_CALL = 'Neutral';

/** Percentile rank, matching pandas `rank(pct=True) * 100` — average rank for ties. */
function percentileRanks(values) {
	const n = values.length;
	const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => values[a] - values[b]);
	const ranks = new Float64Array(n);
	let i = 0;
	while (i < n) {
		let j = i;
		while (j + 1 < n && values[order[j + 1]] === values[order[i]]) j++;
		// pandas' default tie method is 'average': tied entries share the mean of their 1-based ranks.
		const avg = (i + 1 + (j + 1)) / 2;
		for (let k = i; k <= j; k++) ranks[order[k]] = avg;
		i = j + 1;
	}
	for (let k = 0; k < n; k++) ranks[k] = (ranks[k] / n) * 100;
	return ranks;
}

/**
 * Build the per-site result table.
 *
 * @param {{lrt: ArrayLike<number>}} outputs raw graph output, one entry per site
 * @param {{refCodons: string[], variable: boolean[]}} sites reference codon and variability per site
 * @param {object} [callOptions] overrides for CALL_DEFAULTS
 * @returns {Array<object>} one row per codon site, 1-indexed `site`
 */
export function buildPredictions(outputs, sites, callOptions = {}) {
	const cfg = { ...CALL_DEFAULTS, ...callOptions };
	const n = sites.refCodons.length;
	const rows = [];

	for (let i = 0; i < n; i++) {
		const isVar = Boolean(sites.variable[i]);
		const refCodon = (sites.refCodons[i] ?? '').toUpperCase();
		// translate_codon() rejects gaps, N and '?' before the table lookup, so a gapped reference
		// codon has no amino acid rather than an accidental one.
		const refAa =
			refCodon.length === 3 &&
			!refCodon.includes('-') &&
			!refCodon.includes('N') &&
			!refCodon.includes('?')
				? (GENETIC_CODE.get(refCodon) ?? '?')
				: '?';

		if (!isVar) {
			// Everything zeroed BEFORE the model is consulted. These zeros mean "not applicable".
			rows.push({
				site: i + 1,
				refCodon,
				refAa,
				isVariable: false,
				lrt: 0,
				logLrt: 0,
				zScore: 0,
				percentile: 0,
				call: NEUTRAL_CALL
			});
			continue;
		}

		const lrt = Math.max(0, Number(outputs.lrt[i]));
		rows.push({
			site: i + 1,
			refCodon,
			refAa,
			isVariable: true,
			lrt,
			logLrt: Math.log1p(lrt),
			zScore: 0,
			percentile: 0,
			call: NEUTRAL_CALL
		});
	}

	// Local statistics are computed over VARIABLE SITES ONLY. Including the zeroed invariant sites
	// would drag the mean down and inflate every z-score, which is the whole reason they are excluded.
	const varIdx = rows.map((r, i) => (r.isVariable ? i : -1)).filter((i) => i >= 0);
	if (varIdx.length === 0) return rows;

	const varLrts = varIdx.map((i) => rows[i].lrt);
	const mean = varLrts.reduce((a, b) => a + b, 0) / varLrts.length;
	// Population standard deviation — np.std, not pandas' sample std.
	const variance = varLrts.reduce((a, b) => a + (b - mean) ** 2, 0) / varLrts.length;
	const std = Math.sqrt(variance);

	const pct = percentileRanks(varLrts);
	varIdx.forEach((rowIdx, k) => {
		rows[rowIdx].zScore = std > 0 ? (varLrts[k] - mean) / std : 0;
		rows[rowIdx].percentile = pct[k];
	});

	const tierLabels =
		cfg.mode === 'zscore'
			? { tier1: `Z \u2265 ${cfg.tier1Zscore}`, tier2: `Z \u2265 ${cfg.tier2Zscore}` }
			: cfg.mode === 'pvalue'
				? { tier1: `LRT \u2265 ${cfg.tier1LrtGate}`, tier2: `LRT \u2265 ${cfg.tier2LrtGate}` }
				: {
						tier1: `Top ${(100 - cfg.tier1Percentile).toFixed(0)}%`,
						tier2: `Top ${(100 - cfg.tier2Percentile).toFixed(0)}%`
					};

	for (const i of varIdx) {
		const r = rows[i];
		let t1 = false;
		let t2 = false;
		if (cfg.mode === 'zscore') {
			t1 = r.zScore >= cfg.tier1Zscore;
			t2 = !t1 && r.zScore >= cfg.tier2Zscore;
		} else if (cfg.mode === 'percentile') {
			t1 = r.percentile >= cfg.tier1Percentile;
			t2 = !t1 && r.percentile >= cfg.tier2Percentile;
		} else {
			t1 = r.lrt >= cfg.tier1LrtGate;
			t2 = !t1 && r.lrt >= cfg.tier2LrtGate;
		}
		// Labels say what the tier MEANS rather than how confident it sounds. "High" and "Medium"
		// imply a calibrated confidence the model does not have; "Top 2%" is exactly what percentile
		// mode computed, and a reader can tell at a glance that it is relative to this alignment.
		if (t1) r.call = tierLabels.tier1;
		else if (t2) r.call = tierLabels.tier2;
	}

	return rows;
}
