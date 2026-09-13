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

import { DATE_MATCH_TIERS } from '../dates/codes.js';
import { DATING_MESSAGES } from './codes.js';
import { datingHeadline } from './headline.js';
import { TAXON_COLUMNS } from './record.js';
import { DATING_CI_METHODS } from './run.js';

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
	// run_pgls_dating's own additions (dating.py:1440-1466). Every other key it carries is already
	// in the OLS set above — the two records share their shape, which is what lets the Fieller and
	// delta intervals be the same code.
	'ridge',
	'pagel_lambda',
	// the latent root's exported four (dating.py:3155-3161). `weight` and `date` are inside
	// `anchor_taxa`'s dicts: `date` is `float(times[idx])` at dating.py:816, so a whole-year date
	// must still print as `1985.0` and not as `1985`.
	'alpha',
	'temporal_r',
	'temporal_r2',
	'weight',
	'date',
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
 * The command line that would run this analysis again, and everything that stands between running
 * it and getting these two files back.
 *
 * WHY IT IS HERE, AND NOT IN A WRAPPER. `temporalReferenceCommand` has been in
 * `runtime/src/temporal/results.js` since phase 5 and every surface calls it; this pillar had no
 * equivalent anywhere in `runtime/`, so the MCP grew its own copy in `mcp/src/time.js` (whose own
 * header says it belongs here) and the `/time` page, having nothing to call, HARD-CODED the claim
 * instead: `DATING_DOWNLOAD_NOTE` opened "Both files reproduce `hyphaeon dating`'s own outputs"
 * unconditionally, while the MCP was answering `reproduces: false` on the same run. Phase 5 fixed
 * exactly that sentence for the temporal pillar; this is the same fix, in the same place, and the
 * MCP's copy can be deleted in favour of this one.
 *
 * WHAT `reproduces` MEANS, identically to `temporalReferenceCommand`'s contract:
 *
 *   TRUE  — the printed command runs the same analysis, on the same sequences, with every setting
 *           this run used expressed as a flag, and every number agrees at the classes this
 *           repository documents.
 *   FALSE — one of those fails: a setting cannot be put on the line, or the two runs are not over
 *           the same sequences.
 *
 *   NEITHER value ever means the two files diff clean. MEASURED with `{includeProvenance: false}`:
 *   the JSON has the SAME 1,821 lines in the same key order at every level as a CLI run's
 *   `out.json`, differing on `alignment`, `elapsed_seconds` and the last bits of the floats — worst
 *   4.5e-10 years on a Fieller endpoint and 1.1e-8 on the spline's date. The first caveat says so
 *   on every run, `reproduces` true or false.
 *
 * THE GROUNDS FOR FALSE, none of which is a matter of digits:
 *
 *   1. THE DATED SET. This build's date layer is the union of all three upstream parsers and reads
 *      headers `hyphaeon dating` cannot — measured on korber, 142 of 143 by `korber_isolate`, a
 *      rule the reference's parser does not have. A different dated set is a different regression.
 *      With no `-d` table on the line that is certain; WITH one it still has to be checked, because
 *      a `-d` name is not the same fact as "every date came from that file": `header_fallback` is
 *      on by default, so a table naming only some sequences leaves the rest to this build's own
 *      header ladder. Measured on H5N1_HA_geo with the metadata truncated to its first 50 rows:
 *      `sources_used ["table","header"]`, 48 of 98 dates by `header_trailing_year`. Imputation and
 *      the seven-tier name ladder move the dated set the same way and are checked with it.
 *   2. THE ESTIMATORS THIS BUILD DOES NOT RUN (`primaeon.estimators_not_built`). A line echoing
 *      `--clock-model power`, `--loocv` or `--bootstrap` would promise a reproduction this port
 *      cannot give, so those flags are never printed and the list is quoted instead.
 *
 * AND ONE THING THE COMMAND CANNOT SAY AT ALL, which is why `headline` is on the return: the
 * reference's top-level `t_mrca` is `active_model`'s, and this application does not always quote
 * it (`headline.js`). When it departs, a reader diffing the two files against what the page or the
 * tool told them will find two different dates, both correct, and the caveat says which is which.
 *
 * @param {object} run the object `runDating` returned (`{ok, record, distanceMode, pgls, ...}`)
 * @param {object} [options] the caller's options in CLI spelling (`date_col`, `root_taxon`, …)
 * @param {{alignment?: string, dates?: string|null}} [names]
 * @param {object|null} [ingest] the `DateIngest` this run was fed — the only evidence of WHERE the
 *   dates came from. The dating record carries no `dates` block the way the temporal one does, and
 *   a `-d` name on the line is not that fact. Omitted, the `-d` branch cannot fire.
 * @returns {{command: string, reproduces: boolean, caveats: string[],
 *   headline: {key: string, activeKey: string, departed: boolean, quotable: boolean}|null}}
 */
export function datingReferenceCommand(run, options = {}, names = {}, ingest = null) {
	const record = run?.record ?? {};
	const aln = names.alignment ?? record.alignment ?? '<alignment.fasta>';
	const datesFile = names.dates ?? null;
	const has = (k) => options[k] !== undefined && options[k] !== null;

	const parts = ['hyphaeon dating', `-a ${aln}`];
	// D34: this pillar takes no tree at all, on any surface. That is `--no-tree` upstream and NOT a
	// default (cli.py:1898): a command printed without it asks for patristic distances this run
	// never computed and, with no tree to find, would not run.
	parts.push('--no-tree');
	parts.push(`--distance-mode ${run?.distanceMode ?? 'tn93'}`);
	if (datesFile) parts.push(`-d ${datesFile}`);
	if (has('date_col')) parts.push(`--date-col ${options.date_col}`);
	if (has('strain_col')) parts.push(`--strain-col ${options.strain_col}`);
	if (has('date_pattern')) parts.push(`--date-regex ${JSON.stringify(options.date_pattern)}`);
	if (has('root_taxon')) parts.push(`--root-taxon ${options.root_taxon}`);
	if (has('decay_gamma')) parts.push(`--decay-gamma ${options.decay_gamma}`);
	// `--method` is the reference's estimator switch: this build runs OLS always and the PGLS half
	// only with the dating graph, which is exactly `all` against `ols`.
	parts.push(`--method ${run?.pgls ? 'all' : 'ols'}`);
	parts.push(`--clock-model ${record.clock_model ?? 'auto'}`);
	parts.push(`--ci-method ${record.ci_method ?? 'fieller'}`);
	if (has('model_variant')) parts.push(`--model-variant ${options.model_variant}`);
	parts.push('--cpu', '-o <out.json>', '-c <out.csv>');

	let reproduces = true;
	const caveats = [
		'Running this does not make the two files diff clean, and `reproduces` above never claims it does. ' +
			'With `{includeProvenance: false}` the JSON has the SAME 1,821 lines in the same key order as a CLI run, ' +
			'differing only on `alignment`, `elapsed_seconds` and the last bits of the floats (worst measured: ' +
			'4.5e-10 years on a Fieller endpoint, 1.1e-8 on the spline\'s date). Compare numerically, not with `diff`.'
	];

	if (!datesFile) {
		reproduces = false;
		caveats.push(
			'The dates on this run were read from the sequence names by this build\'s own date layer, which is the ' +
				'union of all three upstream parsers and reads headers `hyphaeon dating` cannot (measured on korber: ' +
				'142 of 143 by the `korber_isolate` rule, which the reference\'s parser does not have). A different ' +
				'dated set is a different regression. Export the dates as a two-column CSV and pass it with `-d` to ' +
				'reproduce this run.'
		);
	} else if (ingest) {
		const used = Array.isArray(ingest.sources_used) ? ingest.sources_used : [];
		const elsewhere = used.filter((s) => s !== 'table' && s !== 'auspice' && s !== 'map');
		const imputed = ingest.coverage?.imputed ?? 0;
		const tiers = ingest.match_tiers ?? {};
		const fuzzy = Object.entries(tiers).reduce((n, [tier, count]) => (tier === 'exact' ? n : n + (count || 0)), 0);
		if (elsewhere.length > 0) {
			reproduces = false;
			caveats.push(
				`\`-d ${datesFile}\` is on the line above, but not every date on this run came from it: ` +
					`${ingest.coverage?.dated ?? 'some'} sequence(s) were dated from ${used.join(' and ')} ` +
					'(`header_fallback` is on by default, the reference\'s own behaviour), so the rest were read from the ' +
					'sequence names by this build\'s own ladder. A different dated set is a different regression. Refuse ' +
					'rather than fill in, or export a complete two-column CSV.'
			);
		}
		if (imputed > 0) {
			reproduces = false;
			caveats.push(
				`${imputed} of the dates on this run were IMPUTED — a missing month or day filled in by this build's own ` +
					'rule — so the time coordinates the regression used are not the strings in the metadata. Supply full ' +
					'dates to reproduce this run.'
			);
		}
		if (fuzzy > 0) {
			reproduces = false;
			caveats.push(
				`${fuzzy} metadata name(s) were matched to a sequence at a tier below \`exact\` (this build's ` +
					`seven-tier ladder: ${DATE_MATCH_TIERS.join(', ')}), which the reference's join does not do. Rename ` +
					'those rows to match the sequence names exactly to reproduce this run.'
			);
		}
	}

	const notBuilt = record.primaeon?.estimators_not_built ?? [];
	if (notBuilt.length > 0) {
		caveats.push(
			`This build does not estimate ${notBuilt.map((e) => e.name).join(', ')}, so no flag for them is printed ` +
				'above: a command echoing `--clock-model power`, `--loocv` or `--bootstrap` would promise a reproduction ' +
				'this port cannot give. `record.primaeon.estimators_not_built` says why for each.'
		);
	}
	if (record.ci_method && record.ci_method !== 'fieller') {
		caveats.push(
			`\`--ci-method ${record.ci_method}\` is one of the three interval methods this build ports ` +
				`(${DATING_CI_METHODS.join(', ')}); the reference's poisson, residual-boot, site-boot and jackknife ` +
				'intervals each need a bit-compatible mirror of numpy\'s PCG64 and are refused here rather than silently ' +
				'substituted.'
		);
	}

	const head = datingHeadline(record);
	if (head?.departed) {
		caveats.push(
			`\`out.json\`'s top-level \`t_mrca\` is ${record.active_model}'s and this application quotes ${head.key}'s ` +
				'instead, so the date in the file and the date you were shown are different numbers from the same run. ' +
				`Why: ${DATING_MESSAGES.SPLINE_NO_INTERVAL} Both fits are in the file under their own keys; neither is hidden.`
		);
	}
	if (head && !head.quotable) {
		caveats.push(head.refutation);
	}

	return {
		command: parts.join(' '),
		reproduces,
		caveats,
		headline: head ? { key: head.key, activeKey: head.activeKey, departed: head.departed, quotable: head.quotable } : null
	};
}

/**
 * The notes that must travel with the two files, `temporalDownloadNotes`'s counterpart. Every
 * surface renders these; the `/time` page's `DATING_DOWNLOAD_NOTE` is the join of them.
 *
 * @param {object} run the object `runDating` returned
 * @param {{predictionMethod?: boolean, includeProvenance?: boolean}} [options] what the caller is
 *   actually writing, so the note describes the files the reader will get rather than the defaults.
 * @returns {string[]}
 */
export function datingDownloadNotes(run, options = {}) {
	const withMethod = options.predictionMethod !== false;
	const withProvenance = options.includeProvenance !== false;
	const notes = [
		'`dating.json` carries `hyphaeon dating -o out.json`\'s own top-level keys in its own order, with the ' +
			'estimators this build does not run left null, and `dating.csv` carries `taxa_summary`\'s ten columns ' +
			'under the reference\'s own header names. The CSV is in ALIGNMENT order — the opposite convention to ' +
			'the dates CSV, which is in the order you are reading it.'
	];
	if (withProvenance || withMethod) {
		const added = [
			withProvenance ? 'a `primaeon` block naming the alignment, the options and the sequences excluded' : null,
			withMethod ? 'a `prediction_method` column saying which model produced each predicted date' : null
		].filter(Boolean);
		notes.push(
			`Each file adds one thing the reference has no place for — ${added.join(', and ')}. A file carrying either ` +
				'is NOT what `hyphaeon dating` writes; drop them to diff.'
		);
	}
	const head = datingHeadline(run?.record);
	if (head?.departed) {
		notes.push(
			`The file's top-level \`t_mrca\` is ${run.record.active_model}'s and is not the date this application quotes ` +
				`(${head.key}'s). Both fits are in the file under their own keys; the difference is which one is read as ` +
				'the answer, and why is in the section above.'
		);
	}
	if (head && !head.quotable) notes.push(head.refutation);
	return notes;
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
