/**
 * derive.ts — the view rows of the site table and the plots, per calling mode.
 *
 * WHY THIS FILE EXISTS. A stored record carries what the model and the statistics produced
 * (`hyphaeon_lrt`, `p_value`, `q_value`, `is_invariable`). What the reader sees on top of that —
 * log LRT, local z, local percentile and a tier CALL — is presentation, and the call depends on a
 * mode the reader can switch without re-running anything. So the rows are derived here, on the
 * client, from the record and the chosen mode:
 *
 *   percentile   "Top 5% of variable sites": DM3's default (runtime/src/callModes.js, measured
 *                reasons in its header) — tier 1 at the 98th, tier 2 at the 95th percentile of
 *                the variable sites' LRTs. Computed by the runtime's own `buildPredictions`, so
 *                the browser prints the same labels the MCP and the server do.
 *   zscore       Z ≥ 2.5 / Z ≥ 2.0 over the variable sites, also `buildPredictions`.
 *   qvalue       "q ≤ 0.10": the reference CLI's own significance summary (cli.py prints counts
 *                at q ≤ 0.05 and q ≤ 0.10) applied as tiers — tier 1 q ≤ 0.05, tier 2 q ≤ 0.10 —
 *                over the float32 q the record carries. This is the one mode that is an actual
 *                test rather than a rank, and PLAN.md §4.5 names it as the toggle's other half.
 *                It is app-side until runtime's callModes carries it; `callModeOptions` prefers
 *                the record's `callModes` list when the runtime declares one.
 *
 * The invariable rule is the reference's: an invariable site is "not scored", never "0", and is
 * excluded from every local statistic (postprocess.js header, inference.py:170-186).
 */

import {
	CALL_DEFAULTS,
	NEUTRAL_CALL,
	buildPredictions,
	describeCallMode
} from '@veg/hyphaeon-runtime';
import type { AttributionRecord, MemeRecord, SiteRecord } from './types';
import { translateCodon } from './entropy';

export type CallMode = 'percentile' | 'zscore' | 'qvalue';

/** Tier gates of the q mode. cli.py's summary reports both thresholds; 0.10 is the default. */
export const Q_TIER1 = 0.05;
export const Q_TIER2 = 0.1;

export interface SiteRow {
	site: number;
	refCodon: string;
	refAa: string;
	isVariable: boolean;
	lrt: number;
	logLrt: number;
	zScore: number;
	percentile: number;
	p: number;
	q: number;
	call: string;
	/** 0 neutral, 1 strictest tier, 2 next. */
	tier: 0 | 1 | 2;
	attribution: AttributionRecord | null;
	epoch: string | null;
	topDriver: string | null;
	topMutation: string | null;
}

export interface CallModeOption {
	id: CallMode;
	label: string;
	tier1: string;
	tier2: string;
	description: string;
}

const ALL_MODES: CallModeOption[] = [
	{
		id: 'percentile',
		label: 'Top 5% of variable sites',
		tier1: `Top ${(100 - CALL_DEFAULTS.tier1Percentile).toFixed(0)}%`,
		tier2: `Top ${(100 - CALL_DEFAULTS.tier2Percentile).toFixed(0)}%`,
		description: describeCallMode('percentile')
	},
	{
		id: 'qvalue',
		label: `q ≤ ${Q_TIER2.toFixed(2)}`,
		tier1: `q ≤ ${Q_TIER1.toFixed(2)}`,
		tier2: `q ≤ ${Q_TIER2.toFixed(2)}`,
		description:
			`Flags sites with a Benjamini–Hochberg q ≤ ${Q_TIER1.toFixed(2)} as Tier 1 and ` +
			`q ≤ ${Q_TIER2.toFixed(2)} as Tier 2, where q comes from the MEME mixture p-value of the ` +
			`predicted LRT. This is a test on the predicted scale, which is compressed relative to MEME's, ` +
			`so it is conservative: on most alignments it calls few or no sites.`
	},
	{
		id: 'zscore',
		label: `Z ≥ ${CALL_DEFAULTS.tier2Zscore}`,
		tier1: `Z ≥ ${CALL_DEFAULTS.tier1Zscore}`,
		tier2: `Z ≥ ${CALL_DEFAULTS.tier2Zscore}`,
		description: describeCallMode('zscore')
	}
];

/** The modes this record can be viewed in: the runtime's list when it declares one, else all three. */
export function callModeOptions(record: MemeRecord | null): CallModeOption[] {
	const declared = record?.callModes;
	if (!declared || declared.length === 0) return ALL_MODES;
	const ids = new Set(declared.map((m) => (m === 'q' ? 'qvalue' : m)));
	const kept = ALL_MODES.filter((m) => ids.has(m.id));
	return kept.length > 0 ? kept : ALL_MODES;
}

/** The mode a record was stored with, mapped onto the options above. */
export function defaultCallMode(record: MemeRecord | null): CallMode {
	const stored = record?.summary?.callMode;
	if (stored === 'zscore') return 'zscore';
	if (stored === 'qvalue' || stored === 'q' || stored === 'pvalue') return 'qvalue';
	return 'percentile';
}

/** Reference codons per site: the record's, else sliced from the reference sequence. */
export function referenceCodons(record: MemeRecord): string[] {
	const L = record.sites.length;
	const fromSites = record.sites.map((s) => s.ref_codon ?? s.refCodon);
	if (fromSites.every((c) => typeof c === 'string')) return fromSites as string[];
	const alignment = record.alignment;
	if (!alignment || alignment.sequences.length === 0) return new Array(L).fill('');
	const refName = record.summary?.referenceSequence ?? record.provenance?.preprocessing?.reference_sequence;
	let idx = refName ? alignment.names.indexOf(refName) : -1;
	if (idx < 0) idx = 0;
	const seq = alignment.sequences[idx] ?? '';
	return Array.from({ length: L }, (_, i) => seq.slice(i * 3, i * 3 + 3).toUpperCase());
}

/**
 * Build the rows for a mode. Percentile and z use the runtime's `buildPredictions` on the stored
 * LRTs; q applies the gates above. Local z and percentile are always computed (they are columns).
 */
export function deriveRows(record: MemeRecord, mode: CallMode): SiteRow[] {
	const sites = record.sites;
	const refCodons = referenceCodons(record);
	const variable = sites.map((s) => !s.is_invariable);
	const lrt = sites.map((s) => (s.is_invariable ? 0 : Math.max(0, Number(s.hyphaeon_lrt) || 0)));
	const runtimeMode = mode === 'qvalue' ? 'percentile' : mode;
	const predictions = buildPredictions({ lrt }, { refCodons, variable }, { mode: runtimeMode });
	const attributions = attributionMap(record);

	return sites.map((s, i) => {
		const pred = predictions[i];
		const attribution = s.attribution_details ?? attributions.get(s.site) ?? null;
		let call = pred.call;
		let tier: 0 | 1 | 2 = 0;
		if (mode === 'qvalue') {
			call = NEUTRAL_CALL;
			if (!s.is_invariable && Number.isFinite(s.q_value)) {
				if (s.q_value <= Q_TIER1) call = ALL_MODES[1].tier1;
				else if (s.q_value <= Q_TIER2) call = ALL_MODES[1].tier2;
			}
		}
		if (call !== NEUTRAL_CALL) {
			const opt = ALL_MODES.find((m) => m.id === mode)!;
			tier = call === opt.tier1 ? 1 : 2;
		}
		const refCodon = pred.refCodon || refCodons[i] || '';
		// A stored refAa that is not a letter (the prebake once wrote the AA token) is ignored.
		const storedAa = typeof s.ref_aa === 'string' ? s.ref_aa : typeof s.refAa === 'string' ? s.refAa : null;
		const refAa = storedAa ?? (pred.refAa !== '?' ? pred.refAa : translateCodon(refCodon));
		return {
			site: s.site,
			refCodon,
			refAa,
			isVariable: !s.is_invariable,
			lrt: pred.lrt,
			logLrt: pred.logLrt,
			zScore: pred.zScore,
			percentile: pred.percentile,
			p: Number(s.p_value),
			q: Number(s.q_value),
			call,
			tier,
			attribution,
			epoch: s.evolutionary_epoch ?? attribution?.when_selection_occurred?.evolutionary_epoch ?? null,
			topDriver: s.top_driver ?? attribution?.driving_species?.[0]?.taxon ?? null,
			topMutation:
				s.top_mutation ??
				(attribution && attribution.driving_species.length > 0
					? `${attribution.consensus_aa}->${attribution.driving_species[0].observed_aa}`
					: null)
		};
	});
}

/** The record's attribution records keyed by 1-indexed site (cli.py:307 keys them as strings). */
export function attributionMap(record: MemeRecord): Map<number, AttributionRecord> {
	const out = new Map<number, AttributionRecord>();
	const attr = record.attributions;
	if (attr) for (const [k, v] of Object.entries(attr)) out.set(Number(k), v);
	for (const s of record.sites) if (s.attribution_details) out.set(s.site, s.attribution_details);
	return out;
}

export { NEUTRAL_CALL };

/** Sort helper used by the table: numbers numerically, strings case-insensitively, NaN last. */
export function compareRows(a: SiteRow, b: SiteRow, key: keyof SiteRow, ascending: boolean): number {
	const va = a[key];
	const vb = b[key];
	let c = 0;
	if (typeof va === 'number' && typeof vb === 'number') {
		const na = Number.isNaN(va);
		const nb = Number.isNaN(vb);
		c = na && nb ? 0 : na ? 1 : nb ? -1 : va - vb;
	} else if (typeof va === 'boolean' && typeof vb === 'boolean') {
		c = Number(va) - Number(vb);
	} else {
		c = String(va ?? '').toLowerCase().localeCompare(String(vb ?? '').toLowerCase());
	}
	return ascending ? c : -c;
}

/** A bare-CLI site record is one without the optional view or attribution fields. */
export function isBareSite(s: SiteRecord): boolean {
	return s.ref_codon === undefined && s.refCodon === undefined && s.log_lrt === undefined;
}
