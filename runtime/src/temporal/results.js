/**
 * results.js — the four files `hyphaeon temporal -o <prefix>` writes, from a `TemporalRecord`, byte
 * for byte, plus the command line that would reproduce the run and the sentences that say when it
 * would not.
 *
 * WHY THIS FILE EXISTS. The WRITERS are the library's (`temporalSitesCsv`, `temporalCurvesCsv`,
 * `temporalWavesCsv`, `temporalSummaryJson` in `js/src/writers.js`), and they are byte-exact against
 * the reference's own output — verified there by re-parsing `hyphaeon temporal`'s three CSVs and
 * rewriting them, which reproduced all 780,749 / 1,186,202 / 6,083 bytes. What the library cannot
 * own is which ARRAYS go into them, what the files are called, and what a reader must be told before
 * taking them away, and that is this file.
 *
 * THE FILE NAMES ARE THE REFERENCE'S SUFFIXES with `temporal` as the prefix, so a reader who takes
 * all four holds exactly what `hyphaeon temporal -o temporal` writes and can diff them.
 *
 * THREE THINGS A READER MUST BE TOLD, which is why `temporalDownloadNotes` exists beside the bytes:
 *
 *   1. `_sites_summary.csv` is EVERY codon in site order 1...L, which is the opposite convention to
 *      the on-screen table (candidates only, sweeps first). Both are right; only one of them can be
 *      the file.
 *   2. `_curves.csv`'s `selection_intensity` and `sweep_velocity` are THE SAME ARRAY written twice
 *      (temporal.py:807-808, upstream bug TEMPORAL Q9, identical in all 14,760 rows of the
 *      acceptance run). Replicated on purpose so the file diffs clean; named on purpose so nobody
 *      reads two quantities where there is one.
 *   3. `_waves.csv` leaves the page carrying a SIGN that is this application's convention and not
 *      the reference's (D28). A command-line run may draw any of those curves upside down with the
 *      matching loading column negated, and no other number differs.
 *
 * THE REPRODUCTION LINE IS NOT ALWAYS HONEST, AND SAYS SO. Two conditions make `hyphaeon temporal`
 * unable to reproduce a run of ours, and both are reported rather than papered over: dates read by a
 * rule the reference's own parser does not have (D31 — on the Korber alignment the reference dates
 * none of 143 headers and we date 142, so the two runs are not over the same sequences at all), and
 * a draw count that is not the reference's default of 1,000.
 */

import {
	temporalCurvesCsv,
	temporalSitesCsv,
	temporalSummaryJson,
	temporalWavesCsv,
	TEMPORAL_SITES_COLUMNS,
	TEMPORAL_CURVES_COLUMNS,
	TEMPORAL_WAVES_COLUMNS,
	TEMPORAL_SUMMARY_KEYS
} from '@veg/hyphaeon-js';

import { TEMPORAL_THRESHOLDS } from './codes.js';

export { TEMPORAL_SITES_COLUMNS, TEMPORAL_CURVES_COLUMNS, TEMPORAL_WAVES_COLUMNS, TEMPORAL_SUMMARY_KEYS };

/** The reference's own four suffixes (temporal.py:792, 810, 819, 838). */
export const TEMPORAL_FILE_SUFFIXES = Object.freeze({
	sites: '_sites_summary.csv',
	curves: '_curves.csv',
	waves: '_waves.csv',
	summary: '_summary.json'
});

/** `_sites_summary.csv`: one row per codon, site order, 27 columns. */
export function temporalSitesCsvText(record) {
	const c = record.sites;
	return temporalSitesCsv({
		L: record.codons_total,
		refAas: c.ref_aa,
		derivedAas: c.derived_aa,
		mutationLabels: c.mutation_label,
		domains: c.domain,
		crossClassification: c.cross_classification ?? new Array(record.codons_total).fill(''),
		classification: c.classification ?? new Array(record.codons_total).fill(''),
		isConfirmedSweep: c.is_confirmed_sweep,
		isConcordant: c.is_concordant_sweep,
		isRescued: c.is_rescued_sweep,
		lrts: c.lrt,
		pStatic: c.p_static,
		qStatic: c.q_static,
		pPerm: c.p_perm,
		qPerm: c.q_perm,
		r2Fpca: c.r2_fpca,
		peakTimes: c.peak_date,
		peakIntensities: c.peak_intensity,
		tHalfStart: c.t_half_start,
		tHalfEnd: c.t_half_end,
		fwhm: c.fwhm_years,
		meanIntensity: c.mean_intensity,
		aucs: c.auc,
		loadings: c.wave_loadings,
		K: TEMPORAL_THRESHOLDS.waveCount
	});
}

/**
 * `_curves.csv`: long format over the stage-one candidates, T rows each — or, when nothing passed
 * the floor, the first `min(L, 20)` codons (temporal.py:797-799). The `exportSites` rule is the
 * reference's and is reproduced exactly, including that fallback, which no real example reaches.
 */
export function temporalCurvesCsvText(record) {
	const L = record.codons_total;
	const exportSites =
		record.candidates.length > 0
			? Int32Array.from(record.candidates, (site) => site - 1)
			: Int32Array.from({ length: Math.min(L, 20) }, (_, i) => i);
	return temporalCurvesCsv({
		exportSites,
		mutationLabels: record.sites.mutation_label,
		denseT: record.curves.time,
		velocity: record.curves.velocity,
		curves: record.curves.prevalence,
		T: record.curves.T
	});
}

/** `_waves.csv`: the time axis and four modes, zero-padded. Carries the sign convention with it. */
export function temporalWavesCsvText(record) {
	const w = record.waves;
	return temporalWavesCsv({
		denseT: record.curves.time,
		waves: w ? w.data : new Float64Array(TEMPORAL_THRESHOLDS.waveCount * record.curves.T),
		nWaves: w ? w.count : 0,
		T: record.curves.T
	});
}

/** `_summary.json`: the reference's eighteen keys, in its order, with its rounding. */
export function temporalSummaryJsonText(record) {
	return temporalSummaryJson({
		alignment: record.alignment ?? '',
		tree: record.tree ?? null,
		taxaTotal: record.taxa_total,
		taxaTimestamped: record.taxa_timestamped,
		codonsTotal: record.codons_total,
		codonsVariable: record.codons_variable,
		codonsInvariable: record.codons_invariable,
		timespan: record.timespan_years,
		tMin: record.t_min,
		tMax: record.t_max,
		bandwidth: record.bandwidth_years,
		sigStaticQ10: record.sig_static_q10,
		stage1Candidates: record.stage1_candidates,
		confirmedSweeps: record.confirmed_sweeps,
		concordantSweeps: record.concordant_sweeps,
		rescuedSweeps: record.rescued_sweeps,
		filteredStaticNoise: record.filtered_static_noise,
		varExplained: record.fpca_wave_variance_pct.map((v) => v / 100),
		runtimeSec: record.runtime_sec ?? null
	});
}

/**
 * The command line that would reproduce this run, and — when it would not — the reason.
 *
 * @param {object} record
 * @param {{alignment?: string, tree?: string|null, dates?: string|null, prefix?: string}} [names]
 * @returns {{command: string, reproduces: boolean, caveats: string[]}}
 */
export function temporalReferenceCommand(record, names = {}) {
	const aln = names.alignment ?? record.alignment ?? '<alignment.fasta>';
	const tree = names.tree ?? record.tree ?? null;
	const prefix = names.prefix ?? 'temporal';
	const B = record.permutations?.completed ?? TEMPORAL_THRESHOLDS.permutationsReference;
	const parts = ['hyphaeon temporal', `-a ${aln}`];
	if (tree) parts.push(`-t ${tree}`);
	if (names.dates) parts.push(`-d ${names.dates}`);
	if (B > 0) parts.push(`-B ${B}`);
	parts.push(`--time-points ${record.grid.time_points}`);
	if (record.regime.time_units !== 'years') parts.push(`--time-units ${record.regime.time_units}`);
	if (record.root.taxon) parts.push(`--root-taxon ${record.root.taxon}`);
	parts.push(`--perm-alpha ${record.floors.perm_alpha}`, `--min-r2 ${record.floors.min_r2_fpca}`, `-o ${prefix}`);

	const caveats = [];
	let reproduces = true;
	const beyond = record.dates?.beyond_reference;
	if (beyond && beyond.count > 0) {
		reproduces = false;
		caveats.push(
			`${beyond.count} of the ${record.taxa_timestamped} dates on this run were read by a rule ` +
				`\`hyphaeon temporal\` does not have (${Object.keys(beyond.rules).join(', ')}). The command above ` +
				'will not reproduce this run; supply the dates as a metadata table with `-d` and it will.'
		);
	}
	if (B !== TEMPORAL_THRESHOLDS.permutationsReference) {
		caveats.push(
			`\`-B ${B}\` is the count this run actually drew; the command line's own default is ` +
				`${TEMPORAL_THRESHOLDS.permutationsReference}. Fewer draws do not bias the p-value, they coarsen its grid ` +
				`to 1/${B + 1}.`
		);
	}
	if (record.permutations?.cancelled) {
		caveats.push(`The null was stopped after ${record.permutations.completed} of ${record.permutations.requested} shuffles.`);
	}
	if (record.permutations?.skipped) {
		reproduces = false;
		caveats.push('The null was not run at all on this surface (above its work budget), so no p-value below came from a shuffle.');
	}
	if (record.waves && record.waves.count > 0) {
		caveats.push(
			`Wave signs follow this application's \`${record.waves.sign}\` convention (D28, WAVE_SIGN.md); ` +
				'`hyphaeon temporal` has none and writes its solver\'s raw signs, so a curve in `_waves.csv` and ' +
				'its `Wave_k_loading` column may both come back negated. No other number differs.'
		);
	}
	if (record.primaeon && record.primaeon.score_invariable_sites === false) {
		reproduces = false;
		caveats.push(
			`${record.codons_total - record.primaeon.scored_codons} invariable codon(s) were not sent to the model on ` +
				'this surface, so their `lrt` and `p_static` cells are empty rather than scored. Everything else is ' +
				'identical: under a consensus root those codons contribute exactly zero to every trajectory.'
		);
	}
	return { command: parts.join(' '), reproduces, caveats };
}

/** The three notes that must travel with the files. See the header. */
export function temporalDownloadNotes(record) {
	return [
		`\`${TEMPORAL_FILE_SUFFIXES.sites}\` is every one of the ${record.codons_total} codons in site order — the opposite ` +
			`convention to the table on this page, which shows the ${record.stage1_candidates} candidates with the sweeps first.`,
		'`_curves.csv` writes `selection_intensity` and `sweep_velocity` from the same array, so the two columns are ' +
			'identical in every row. That is an upstream bug (temporal.py:807-808) reproduced on purpose so the file ' +
			'diffs clean against `hyphaeon temporal`; there is one quantity there, not two.',
		'`_waves.csv` and the four `Wave_k_loading` columns carry a sign this page fixes by convention and the ' +
			'reference does not (D28). A wave and its negative are the same mode; nothing else in these files reads a sign.'
	];
}

/**
 * The four files, named and ready to download.
 *
 * @param {object} record
 * @param {{prefix?: string}} [options]
 * @returns {Array<{name: string, mime: string, text: string}>}
 */
export function temporalDownloads(record, { prefix = 'temporal' } = {}) {
	return [
		{ name: `${prefix}${TEMPORAL_FILE_SUFFIXES.sites}`, mime: 'text/csv', text: temporalSitesCsvText(record) },
		{ name: `${prefix}${TEMPORAL_FILE_SUFFIXES.curves}`, mime: 'text/csv', text: temporalCurvesCsvText(record) },
		{ name: `${prefix}${TEMPORAL_FILE_SUFFIXES.waves}`, mime: 'text/csv', text: temporalWavesCsvText(record) },
		{ name: `${prefix}${TEMPORAL_FILE_SUFFIXES.summary}`, mime: 'application/json', text: temporalSummaryJsonText(record) }
	];
}
