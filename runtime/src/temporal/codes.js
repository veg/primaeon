/**
 * codes.js — the vocabulary of the temporal-selection pillar: diagnostic codes, the numbers this
 * layer decides with, the refusal and warning texts a reader is shown, and the one table that says
 * which of our date rules the reference's own parser also has.
 *
 * WHY THIS FILE EXISTS. It imports nothing but `fillMessage`/`nameSample` from the date layer's
 * import-free `codes.js`, for the same reason that file imports nothing and `dating/codes.js`
 * imports nothing more: a caller that only wants to know what a code MEANS — the `/time` route
 * rendering a warning, the MCP deciding whether a failure is the reader's fault or ours — must be
 * able to ask without loading a session, an eigensolver or the library.
 *
 * WHAT IT IS NOT. There is no temporal arithmetic here and there must never be. Every number on
 * this path is `@veg/hyphaeon-js`'s (`js/src/temporal.js`, ported function by function from
 * `hyphaeon/temporal.py:399-905`); this file only names things.
 *
 * THE CODES ARE NAMESPACED `TEMPORAL_*` so they never collide with `DATES_*` / `DATE_*`,
 * `DATING_*` or the library's `DIAGNOSTIC_CODES`, and `TEMPORAL_DIAGNOSTIC_CODES` is the REPORT
 * ORDER, exactly as the other two layers' lists are.
 *
 * WHY SO MANY OF THESE EXIST. Eleven of the codes below exist because the reference's own output
 * cannot say the thing they say. `hyphaeon temporal` writes a 27-column CSV in which a run that
 * confirmed nothing and a run that confirmed thirty sites through the static-LRT escape hatch look
 * identical (temporal.py:692-693 records nothing); in which every `q_perm` is at a floor the
 * permutation count cannot reach (`C/(B+1)`, 2.4 on the acceptance run); in which an invariable
 * codon reports a peak date of `t_min` because `argmax` of a row of zeros is 0; and in which
 * `mean_intensity` is the mean of the velocity. Every one of those is a true number with a false
 * reading, and result semantics is the application's half of the split (PLAN.md §5.5).
 */

import { fillMessage, nameSample } from '../dates/codes.js';

export { fillMessage, nameSample };

/**
 * Bumped when `TemporalRecord`'s shape changes in a way a stored record cannot be read under.
 * Version 1 is phase 5 of PLAN-TEMPORAL.md: the whole pillar, in one pass, with the null's achieved
 * draw count and the wave-sign convention on the record.
 */
export const TEMPORAL_SCHEMA_VERSION = 1;

/**
 * Deterministic report order. A warning whose code is not in this list sorts last, stably.
 * The order runs: what was done to the sequences and the dates before anything was measured -> what
 * the time axis and the thresholds resolved to -> what the two filters did -> what the null could
 * and could not say -> what the decomposition could and could not say -> the refusals.
 */
export const TEMPORAL_DIAGNOSTIC_CODES = Object.freeze([
	'TEMPORAL_DUPLICATES_COLLAPSED',
	'TEMPORAL_DATES_BEYOND_REFERENCE',
	'TEMPORAL_UNDATED_TAXA',
	'TEMPORAL_DATES_TIED',
	'TEMPORAL_BANDWIDTH_CLAMPED',
	'TEMPORAL_UNITS_NOT_CALENDAR',
	'TEMPORAL_ROOT_TAXON_NOT_FOUND',
	'TEMPORAL_ROOT_UNKNOWN_RESIDUES',
	'TEMPORAL_INVARIABLE_SITES_UNSCORED',
	'TEMPORAL_TAU_PEAK_OVERRIDDEN',
	'TEMPORAL_STATIC_NONE_SIGNIFICANT',
	'TEMPORAL_NO_CANDIDATES',
	'TEMPORAL_NULL_SKIPPED',
	'TEMPORAL_NULL_TRUNCATED',
	'TEMPORAL_Q_PERM_UNREACHABLE',
	'TEMPORAL_SOLITARY_REGIME',
	'TEMPORAL_GATE_VACUOUS',
	'TEMPORAL_FLAT_CANDIDATES',
	'TEMPORAL_ESCAPE_HATCH',
	'TEMPORAL_WAVES_FALLBACK_SET',
	'TEMPORAL_WAVES_NEAR_DEGENERATE',
	'TEMPORAL_WAVES_RANK_DEFICIENT',
	'TEMPORAL_WAVE_SIGN_CONVENTION',
	'TEMPORAL_TOO_FEW_DATED',
	'TEMPORAL_NO_TIME_SPAN',
	'TEMPORAL_NO_DATES'
]);

/**
 * The refusals: a run that produced no trajectories at all. Every one is RETURNED as
 * `{ok: false, refusal: <code>}` with a message, never thrown — the date layer's contract and the
 * one `diagnose()` set for the whole package, so an MCP or a server can classify it as the READER'S
 * input rather than as a server fault (the mistake Phase 3 integration had to fix for
 * `TN93_UNCOMPUTABLE`).
 *
 * `TEMPORAL_NULL_SKIPPED` is deliberately NOT here. A null that does not fit the work budget
 * withholds the null and nothing else: the trajectories, velocities, peaks, widths, areas, the
 * candidate set, the wave modes and the static cross-tab are all still computed and still correct,
 * and the four-way classification degrades to three rather than disappearing.
 */
export const TEMPORAL_REFUSALS = Object.freeze({
	/** temporal.py:474-478, verbatim in spirit: fewer than five dated sequences. */
	TOO_FEW_DATED: 'TEMPORAL_TOO_FEW_DATED',
	/** temporal.py:483-484: `t_max - t_min <= 0`. */
	NO_TIME_SPAN: 'TEMPORAL_NO_TIME_SPAN',
	/** No date reached any taxon the model kept. The date layer's own `DATES_NONE`, restated here. */
	NO_DATES: 'TEMPORAL_NO_DATES'
});

/**
 * The numbers this layer decides with. Each is either the reference's own constant, cited, or a
 * judgement stated here so it can be argued with in one place.
 */
export const TEMPORAL_THRESHOLDS = Object.freeze({
	/** temporal.py:474. Five dated sequences is the reference's own floor. */
	minDatedTaxa: 5,
	/** temporal.py:404, `num_time_points`. */
	timePointsDefault: 250,
	/** temporal.py:406, `perm_alpha`. */
	permAlpha: 0.05,
	/** temporal.py:407, `min_r2_fpca`. */
	minR2Fpca: 0.35,
	/** temporal.py:408, `tau_peak`. NOTE Q1: the reference overrides this exact VALUE (see below). */
	tauPeak: 1e-4,
	/** temporal.py:409, `tau_auc`: `None` means "derive from the timespan" (temporal.py:608). */
	tauAuc: null,
	/** PLAN.md §3.5 / REPORT_DEFAULTS.seed. The reference's own is numpy's `RandomState(42)`. */
	seed: 42,
	/** temporal.py:406 default `n_permutations`, and the count the reference's own fixtures use. */
	permutationsReference: 1000,
	/**
	 * D26: the browser's FIRST answer. Not a ceiling — `TEMPORAL_PERM_ROUNDS` refines to the
	 * reference's own 1000 when the budget allows — but the count a reader is guaranteed to see.
	 * Below 200 the p grid step is `1/201 ~ 0.005 = alpha/10` and the three-sigma flip band at
	 * alpha = 0.05 is +/-0.046, which is a coin flip over most of a candidate set: MEASURED on the
	 * acceptance run at B = 100, 18 sites sit at p <= 0.05 and EIGHT MORE sit at 0.0594, one single
	 * grid step above the cut.
	 */
	permutationsDefault: 200,
	/** `TEMPORAL_PERM_B_MIN`: the count below which the answer is not worth showing. See above. */
	permutationsMin: 200,
	/** temporal.py:718, `K`. */
	waveCount: 4,
	/** temporal.py:531, and the cut both classification columns read. */
	qStaticCut: 0.10,
	/**
	 * The relative singular-value gap below which two wave modes are reported as ONE rotatable
	 * block rather than two curves (the library's `WAVE_GAP_THRESHOLD`, repeated here so a surface
	 * that only imports this file can say the number). MEASURED on the acceptance run: the four
	 * retained modes are separated by 0.097 / 0.311 / 0.108, so the flag is twice clear of firing
	 * there and is not decorative.
	 */
	waveGapThreshold: 0.05
});

/**
 * WHICH OF OUR DATE RULES THE REFERENCE'S OWN TEMPORAL PARSER ALSO HAS (D31, PLAN-TEMPORAL §7b).
 *
 * `runtime/src/dates/` is deliberately WIDER than `temporal.py:73-330`: it is the union of all three
 * upstream parsers, so it dates files `hyphaeon temporal` refuses outright — the Korber HIV
 * alignment being the known case, where the reference reads none of the 143 headers and we read 142.
 * That is a good thing and it is also a comparability hazard, because a different dated set means a
 * different time axis, a different kernel, a different candidate set and a different null. The rule
 * this repository works to is that we must never SILENTLY do better: the record carries
 * `dates.beyond_reference`, and the page says so.
 *
 * The membership test is the citation in the library's own `DATE_RULES` table
 * (`../../HyphAeon/js/src/dates.js:154-201`): a rule documented against `temporal.py` is one the
 * temporal parser has; a rule documented against `dating.py` is a lab convention it lacks.
 * `unparsed`, `out_of_range` and `none` are in neither set — they are the absence of a date.
 */
export const TEMPORAL_REFERENCE_RULES = Object.freeze([
	'non_calendar_numeric',
	'non_calendar_embedded',
	'numeric',
	'decimal_year',
	'ymd',
	'header_iso',
	'header_decimal_year',
	'header_year_month',
	'header_trailing_year',
	'header_unit_token',
	'header_unit_suffix',
	'header_bare_number'
]);

/** Rules only the app's wider ingestion has; a date read by one of these the reference cannot read. */
export const TEMPORAL_BEYOND_REFERENCE_RULES = Object.freeze([
	'archival_1959',
	'korber_isolate',
	'lanl_pipe_year',
	'wpi',
	'dpi',
	'flexible_numeric'
]);

/** The messages, with `{placeholders}` `fillMessage` substitutes. */
export const TEMPORAL_MESSAGES = Object.freeze({
	TOO_FEW_DATED:
		'Temporal selection needs at least {min} dated sequences and this run has {dated}. ' +
		'Supply dates for more sequences — a metadata table, an Auspice JSON, or a date in the header — ' +
		'or use the dating pillar, which asks a different question of the same data.',
	NO_TIME_SPAN:
		'Every dated sequence in this run carries the same time coordinate ({value}), so there is no ' +
		'time axis to smooth along. Temporal selection needs sequences sampled at different times.',
	NO_DATES:
		'No sequence the model kept carries a date, so there is nothing to place on a time axis. ' +
		'Section 1 says which sequences were read and which rule matched each one.',
	DUPLICATES_COLLAPSED:
		'{count} identical sequence(s) were collapsed into {kept} before the model ran, and the ' +
		'collapse keeps only one date each. In a surveillance set the same haplotype sampled on ' +
		'different days is exactly what a sweep looks like, so this silently deletes time points. ' +
		'Re-run with duplicates kept if that is what happened here. (The reference collapses them too: ' +
		'temporal.py:441, `prune_dups = not (keep_duplicates or non_calendar)`.)',
	DATES_BEYOND_REFERENCE:
		'{count} of the {dated} dates on this run were read by a rule `hyphaeon temporal` does not ' +
		'have ({rules}). This page\'s date layer is the union of all three upstream parsers; the ' +
		'temporal pillar\'s own parser reads none of those headers. The trajectories and the null here ' +
		'are therefore computed over a different set of sequences than the reference would use, and ' +
		'the two are not comparable sequence by sequence.',
	UNDATED_TAXA:
		'{count} of the {total} sequences the model scored carry no date and are off the time axis ' +
		'({sample}). They still count towards which codons are variable — that mask is computed over ' +
		'every sequence (dataset.py:1132) — so a codon that varies only among undated sequences is ' +
		'treated as variable and gets a flat trajectory.',
	DATES_TIED:
		'{tied} sequences share the commonest sampling date and only {unique} distinct dates cover ' +
		'{dated} sequences. The kernel can only resolve what the sampling resolves.',
	BANDWIDTH_CLAMPED:
		'The smoothing bandwidth resolved to {bandwidth} {unit}, which is the {edge} of the reference\'s ' +
		'own clamp rather than 5 % of the {timespan}-{unit} span (temporal.py:489-491). Every trajectory ' +
		'on this page is smoothed at that width.',
	UNITS_NOT_CALENDAR:
		'The time axis is in {units}, so this run takes the reference\'s `fixation` branch: the sweep ' +
		'metric is the cumulative shift from the first grid point rather than the positive part of the ' +
		'derivative, the energy floors are the dimensionless ones, and the null tests correlation with ' +
		'time rather than the variance of the velocity.',
	ROOT_TAXON_NOT_FOUND:
		'No dated sequence is named {name}, so the root was inferred from the earliest samples instead. ' +
		'Every trajectory on this page is measured against that root.',
	ROOT_UNKNOWN_RESIDUES:
		'{count} position(s) of the root sequence {name} are a gap or an ambiguity, and the reference ' +
		'turns each of those into ALANINE rather than a sentinel (temporal.py:355). At those positions ' +
		'every other residue reads as a difference from the root, so codons that do not vary at all ' +
		'acquire trajectories, peaks and wave loadings, and their mutation labels are wrong. ' +
		'Replicated deliberately; upstream bug TEMPORAL Q2.',
	INVARIABLE_SITES_UNSCORED:
		'{count} invariable codon(s) were not sent to the model, so their static LRT and p-value are ' +
		'ABSENT rather than zero. Nothing else changes: under a consensus root the attribution at an ' +
		'invariable codon is identically zero, so its trajectory, velocity, peak, width, area and wave ' +
		'loadings are exactly zero whatever the model would have said.',
	TAU_PEAK_OVERRIDDEN:
		'The peak-energy floor was supplied as {supplied}, which is the reference\'s own documented ' +
		'default, and the reference therefore silently replaces it with {resolved} — its override tests ' +
		'the VALUE rather than whether a caller supplied one (temporal.py:604, 610). Replicated ' +
		'deliberately; upstream bug TEMPORAL Q1.',
	STATIC_NONE_SIGNIFICANT:
		'The ordinary static scan calls NO codon at q <= {cut} on this alignment, so every confirmed ' +
		'sweep below is classified "found only in time" by arithmetic rather than by biology. The ' +
		'cross-classification is a function of an FDR threshold over a family of {family} variable ' +
		'codons; read it as such.',
	NO_CANDIDATES:
		'No codon passed the sweep-energy floor (peak >= {tauPeak}, area >= {tauAuc}), so there was ' +
		'nothing to test and the null was not run. Every codon is either invariable or flat.',
	NULL_SKIPPED:
		'Testing {C} candidate codon(s) against {B} shuffled date sets over {N} dated sequences and ' +
		'{T} grid points is about {work} units of work, above this surface\'s budget of {budget}. ' +
		'The trajectories, velocities, peaks, widths, areas, the candidate set and the wave modes below ' +
		'are all complete; only the significance test was withheld.',
	NULL_TRUNCATED:
		'The null stopped after {done} of {requested} shuffles. The p-values below are the same ' +
		'estimator on a coarser grid — (1 + exceedances) / ({done} + 1), so the smallest value it can ' +
		'report is {gridStep} — and everything upstream of the shuffle is complete.',
	Q_PERM_UNREACHABLE:
		'With {C} candidate codons and {B} shuffles, the smallest permutation q-value Benjamini-Hochberg ' +
		'can return is {floor}, so `q_perm` carries no information at this draw count and the sweep call ' +
		'is made on p (temporal.py:687-689). Reaching q <= 0.10 would need about {needed} shuffles. ' +
		'Upstream observation TEMPORAL Q11, reported rather than fixed.',
	SOLITARY_REGIME:
		'The wave-alignment gate was not applied: {reason}. A confirmed sweep here needed only the ' +
		'permutation test (temporal.py:684-686).',
	GATE_VACUOUS:
		'The wave-alignment gate cannot discriminate with exactly four candidates: the rows are ' +
		'mean-centred, so their span has rank at most three and the top-four subspace contains all of ' +
		'it. Every candidate scores R2 = 1 by construction (temporal.py:672). Upstream bug TEMPORAL Q8.',
	FLAT_CANDIDATES:
		'{count} candidate codon(s) have a perfectly flat velocity, which the standardisation turns ' +
		'into a row of zeros and the gate then scores R2 = 1 — a pass on no signal at all ' +
		'(temporal.py:669, the `+1e-8`). Upstream bug TEMPORAL Q7.',
	ESCAPE_HATCH:
		'No codon cleared the confirmation thresholds, so the reference\'s fallback selection fired: ' +
		'the {count} codon(s) called below are candidates with p_perm <= 0.10 OR a static LRT >= 3.84, ' +
		'not sites that passed the test (temporal.py:692-693). The reference records this in none of ' +
		'its output files; this record carries it as `escape_hatch_used`. Upstream bug TEMPORAL Q5.',
	WAVES_FALLBACK_SET:
		'Fewer than four codons were confirmed, so the wave modes were extracted from the {count} ' +
		'strongest candidate(s) by peak intensity rather than from the confirmed set ' +
		'(temporal.py:721-724). The reference selects them with an UNSTABLE sort over all codons, most ' +
		'of which are tied at exactly zero; this run uses a stable (value, index) sort, which is a ' +
		'deliberate divergence and is why the selected set is reproducible here and is not upstream. ' +
		'Upstream bug TEMPORAL Q4.',
	WAVES_NEAR_DEGENERATE:
		'Wave(s) {pairs} are separated by less than {threshold} of the leading singular value, so the ' +
		'pair can rotate into each other and neither is individually a property of the data. Read them ' +
		'together or not at all; the combined share is meaningful and the split is not.',
	WAVES_RANK_DEFICIENT:
		'{count} of the four reported wave modes carry no variance and are arbitrary directions in a ' +
		'null space. The reference writes them into `_waves.csv` as if they were modes; this record ' +
		'marks them.',
	WAVE_SIGN_CONVENTION:
		'A wave and its negative describe the same mode. The sign here is fixed by a convention this ' +
		'record states and `hyphaeon temporal` does not have ({convention}: the element of largest ' +
		'magnitude is made positive, applied to the singular vector BEFORE the loadings are computed, ' +
		'so a wave and its loading column always flip together). A command-line run may therefore draw ' +
		'any of these curves upside down, with the matching loading column negated. Nothing else ' +
		'differs: no singular value, no variance share, no R2 and no classification reads a sign. ' +
		'See WAVE_SIGN.md; PLAN-TEMPORAL D28.'
});

/** A warning in this package's one warning shape. */
export function temporalWarning(code, severity, message, data = {}) {
	return { code, severity, message, data };
}

/** `TEMPORAL_DIAGNOSTIC_CODES` order, stable, unknown codes last. */
export function sortTemporalWarnings(warnings) {
	const rank = new Map(TEMPORAL_DIAGNOSTIC_CODES.map((c, i) => [c, i]));
	return Array.from(warnings ?? []).map((w, i) => [w, i]).sort((a, b) => {
		const ra = rank.get(a[0].code) ?? TEMPORAL_DIAGNOSTIC_CODES.length;
		const rb = rank.get(b[0].code) ?? TEMPORAL_DIAGNOSTIC_CODES.length;
		return ra === rb ? a[1] - b[1] : ra - rb;
	}).map(([w]) => w);
}
