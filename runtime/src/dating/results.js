/**
 * results.js — `hyphaeon dating -o out.json`'s own two files, written from a browser run.
 *
 * WHY THIS FILE EXISTS. `dating.py:3145-3186` writes a JSON (`json.dump(indent=2)`) and a per-taxon
 * CSV (`pd.DataFrame(taxon_records).to_csv(index=False)`). A reader who runs the pillar here and a
 * reader who runs it on a command line must be able to diff their outputs and see nothing but the
 * fields a browser cannot know — which is why the record's key set, key ORDER and number FORMATTING
 * are the reference's, and why the app's own additions travel behind options that default to OFF:
 * `primaeon` (the run's provenance, a key the reference does not use and therefore cannot collide
 * with) and `prediction_method` (our per-row column). The same discipline `results.js` applies to
 * the selection pillar's downloads, for the same reason.
 *
 * WHAT A DIFF AGAINST A CLI RUN ACTUALLY SHOWS, MEASURED on the acceptance example with
 * `{ includeProvenance: false }`: the two files have the SAME 1821 lines in the same order, and the
 * differences are `alignment`, `elapsed_seconds` and the last bits of the floats — worst 4.5e-10
 * years on a Fieller endpoint and 1.1e-8 on the spline's date, the fixtures' own 1e-9 class and
 * DATING Q5's conditioning respectively. Byte equality of the NUMBERS is not achievable across two
 * language runtimes and is not claimed; byte equality of the SHAPE is, and is what this file is for.
 *
 * THE NUMBER FORMATTING IS NOT JSON.stringify. Python prints floats with `repr` (shortest
 * round-trip, exponent form below 1e-4) and ints without a decimal point, and the two differ from
 * JavaScript in both directions: `JSON.stringify(1e-5)` is `0.00001` where Python writes `1e-05`,
 * and a float that happens to be integral must still print as `1.0`. The library's `pyJsonDumps` and
 * `dataFrameCsv` already mirror both, so this file supplies only the SCHEMA — which keys are floats
 * — because that is the part that is specific to this pillar's record.
 *
 * `DATING_FLOAT_KEYS` INCLUDES THE THREE MODEL NAMES. `ensemble.weights` is `{"ols": 1.0}`: a dict
 * whose KEYS are model names and whose values are floats, so without `ols`/`pgls`/`spline` in the
 * float set the weight prints as `1` and the file stops being byte-equal. The keys also name the
 * model dicts themselves, which are objects and take no number formatting, so listing them costs
 * nothing.
 *
 * THE CSV IS IN ALIGNMENT ORDER, NOT THE READER'S. `dates.csv` writes what the reader is looking at;
 * this one writes what the reference wrote, so it diffs. A page that offers both must say so.
 */

import { dataFrameCsv, pyJsonDumps, PY_FLOAT_KEYS, PY_INT_KEYS } from '@veg/hyphaeon-js';

import { TAXON_COLUMNS } from './record.js';

/** Every key in the dating record whose value Python built as a float. */
export const DATING_FLOAT_KEYS = new Set([
	...PY_FLOAT_KEYS,
	// run_mrca_dating's own top level
	't_mrca',
	'ci_mrca',
	'timespan',
	'mu',
	// the model names, for `ensemble.weights` (see the header)
	'ols',
	'pgls',
	'spline',
	'power',
	// run_ols_dating (dating.py:1271-1292)
	'd0',
	't_ref',
	'se_mu',
	'se_d0',
	'se_mrca',
	'ci_fieller',
	'fieller_g',
	'ci_delta',
	'ci_bootstrap',
	'r',
	'r2',
	'p_value',
	'sigma2',
	'rmse',
	// run_restricted_spline_clock_dating (dating.py:1956-1972)
	'rate_ancestral',
	'ci_rate_ancestral',
	'rate_recent',
	'ci_rate_recent',
	'rate_ratio',
	'beta_0',
	'beta_1',
	'beta_2',
	'beta',
	'ci_beta_2',
	'knots',
	'rss',
	'aic',
	'rss_linear',
	'aic_linear',
	'delta_aic',
	'f_stat',
	'p_f_test',
	// the per-taxon records (dating.py:3052-3062)
	'sampling_date',
	'root_divergence',
	'fitted_divergence',
	'predicted_date',
	'divergence_residual',
	'temporal_residual',
	'z_score'
]);

/** `n` is `int(...)` on every record that carries it; `taxa_count` is already in the library's set. */
export const DATING_INT_KEYS = new Set([...PY_INT_KEYS, 'n']);

/**
 * The reference's `out.json`: the same keys, in the same order, formatted the same way. See the
 * header for what a diff against a CLI run shows and what it does not.
 *
 * @param {Record<string, any>} record from `buildDatingRecord`
 * @param {{includeProvenance?: boolean, predictionMethod?: boolean}} [options]
 *   `includeProvenance: false` drops `primaeon` and `predictionMethod: false` (the default) drops
 *   our per-row column, which together give a file whose shape is exactly the CLI's.
 * @returns {string}
 */
export function datingJsonText(record, options = {}) {
	let payload = options.includeProvenance === false ? withoutKey(record, 'primaeon') : record;
	if (!options.predictionMethod) {
		payload = { ...payload, taxa_summary: (payload.taxa_summary ?? []).map((r) => withoutKey(r, 'prediction_method')) };
	}
	// No trailing newline: `json.dump` writes none, and `memeJsonText` already follows that.
	return pyJsonDumps(payload, { indent: 2, floatKeys: DATING_FLOAT_KEYS, intKeys: DATING_INT_KEYS });
}

/**
 * The reference's `out.csv`: the ten `taxa_summary` columns, in the reference's header names and
 * order, in ALIGNMENT order. `prediction_method` — ours, and the column that says which rows came
 * from a different model — is dropped by default so the file diffs against a CLI run, and added by
 * `{ predictionMethod: true }` for a reader who wants it.
 *
 * @param {object[]} rows
 * @param {{predictionMethod?: boolean}} [options]
 * @returns {string}
 */
export function datingCsvText(rows, options = {}) {
	const columns = options.predictionMethod ? [...TAXON_COLUMNS, 'prediction_method'] : [...TAXON_COLUMNS];
	return dataFrameCsv(rows, { columns, floatKeys: DATING_FLOAT_KEYS, intKeys: DATING_INT_KEYS });
}

/**
 * The download list a page offers for a finished dating run, in the shape `downloadsFor` already
 * uses for the selection pillar.
 *
 * @param {object} run the object `runDating` returned
 * @param {{stem?: string}} [options]
 */
export function datingDownloads(run, options = {}) {
	const stem = options.stem ?? 'dating';
	if (!run?.ok) return [];
	return [
		{ name: `${stem}.json`, type: 'application/json', text: datingJsonText(run.record) },
		{ name: `${stem}.csv`, type: 'text/csv', text: datingCsvText(run.rows) }
	];
}

function withoutKey(record, key) {
	const out = {};
	for (const [k, v] of Object.entries(record)) if (k !== key) out[k] = v;
	return out;
}
