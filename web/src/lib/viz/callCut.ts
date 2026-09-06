/**
 * callCut.ts — the active call threshold, read off the rows the active mode produced.
 *
 * WHY THIS FILE EXISTS. DESIGN.md §3 asks every site plot to draw ONE labelled rule at the active
 * call cut, so a reader can see why site 452 at LRT 2.2 was not called while 279 at 3.3 was. The
 * cut is not a number the mode publishes (percentile and z modes gate on statistics local to the
 * alignment; the q mode gates on BH q), but every mode is monotone in the predicted LRT, so the
 * lowest called LRT IS the cut, exactly. The label is the loosest called tier's own string
 * ("Top 5%", "q ≤ 0.10", "Z ≥ 2"), so the plot names the rule the table used. Nothing is drawn
 * when the mode called nothing: there is no cut to show, and the caption says so.
 */

import type { SiteRow } from '$lib/results/derive';

export interface CallCut {
	/** The lowest predicted LRT the active mode called. */
	lrt: number;
	/** "top 5 % of variable sites, LRT ≥ 3.29" / "q ≤ 0.10, LRT ≥ 1.87" / "Z ≥ 2, LRT ≥ 2.41". */
	label: string;
}

export function activeCut(rows: readonly SiteRow[]): CallCut | null {
	let lrt = Infinity;
	let loosest: SiteRow | null = null;
	for (const r of rows) {
		if (!r.isVariable || r.tier === 0) continue;
		if (r.lrt < lrt) lrt = r.lrt;
		if (!loosest || r.tier > loosest.tier) loosest = r;
	}
	if (!loosest || !Number.isFinite(lrt)) return null;
	const call = loosest.call;
	const at = `LRT ≥ ${lrt.toFixed(2)}`;
	const label = /^top\s/i.test(call)
		? `${call.replace(/^Top/, 'top').replace('%', ' %')} of variable sites, ${at}`
		: `${call}, ${at}`;
	return { lrt, label };
}
