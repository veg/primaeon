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
 * WHAT "BYTE FOR BYTE" DOES AND DOES NOT COVER — the distinction the whole file turns on:
 *
 *   FORMAT is byte-exact, and that is verified: headers, column order, key order, rounding, the
 *   float32 repr pandas uses, and the row counts (4,384 / 14,760 / 60 on the acceptance run). The
 *   library's own claim is stronger still and is about a different thing — re-parsing the
 *   REFERENCE'S OWN three CSVs and rewriting them through these writers reproduced all 780,749 /
 *   1,186,202 / 6,083 bytes.
 *
 *   CONTENT is not. MEASURED end to end on H1N1 at `-B 100 --time-points 60`, our four files
 *   against the same run's `hyphaeon temporal --cpu` output: 1 of 4,384 `_sites_summary.csv` rows
 *   is byte-identical, 17 of the 27 columns differ somewhere (`p_static` in 4,383 rows, `lrt` in
 *   4,254, each `Wave_k_loading` in 247, `q_perm` 244, `p_perm` 239, `q_static` 236, `auc` 224,
 *   `peak_intensity` 221, `mean_intensity` 218, `r2_fpca` 54, and `classification`,
 *   `cross_classification`, `is_confirmed_sweep`, `is_rescued_sweep` in 18 each), 0 of 60
 *   `_waves.csv` rows match, and `_summary.json` differs on `confirmed_sweeps` (32 against 18),
 *   `rescued_sweeps` and `fpca_wave_variance_pct`. TWO causes, and they are not the same kind of
 *   thing: everything upstream of the date shuffle is the ONNX graph against torch — agreement at
 *   strict graph class, ~1e-6 relative, which is a different decimal string in most rows — and
 *   everything downstream of it is a different pseudorandom generator, which is a different NUMBER.
 *   Both are named to a reader; neither is papered over.
 *
 * FIVE THINGS A READER MUST BE TOLD, which is why `temporalDownloadNotes` exists beside the bytes:
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
 *      matching loading column negated.
 *   4. `p_perm` and `q_perm` are 1.0 at every codon that never reached stage two — 4,138 of 4,384
 *      on the acceptance run — which is a p-value printed for a test that was not run. Upstream
 *      (temporal.py:620-621), replicated exactly, and flagged here and at `run.js`'s `spreadPerm`
 *      because the reference answered this same objection for `p_static` with NaN and not here.
 *      THE KEY TO WHICH IS WHICH IS `classification`, NOT `p_perm`, and the note used to say
 *      otherwise: a tested candidate that every shuffle beat scores exactly 1.0 too. Measured on
 *      H5N1 at B = 200, 399 of 566 rows read 1.0 against 398 non-candidates. `temporalPPermNote`
 *      is the corrected sentence and `{stage1Column: true}` writes the mask into the file itself.
 *   5. WHAT THE NULL ASSUMES: it shuffles sampling DATES across sequences, so it treats them as
 *      exchangeable and controls for nothing about shared ancestry. `TEMPORAL_NULL_ASSUMPTION` in
 *      `codes.js` carries the whole argument, and the same two strings reach the record's warning
 *      list, this note list and the `/time` page's honesty block.
 *
 * THE REPRODUCTION LINE IS NOT ALWAYS HONEST, AND SAYS SO. `temporalReferenceCommand`'s own
 * contract is written at that function; the short version is that `reproduces` is about SETTINGS AND
 * SEQUENCES plus agreement at the classes this repository documents, never about a clean diff, and
 * that the caveat naming the graph class and the measured diff above is emitted on EVERY run.
 */

import {
	temporalCurvesCsv,
	temporalSitesCsv,
	temporalSummaryJson,
	temporalWavesCsv,
	resolveTemporalBandwidth,
	TEMPORAL_SITES_COLUMNS,
	TEMPORAL_CURVES_COLUMNS,
	TEMPORAL_WAVES_COLUMNS,
	TEMPORAL_SUMMARY_KEYS
} from '@veg/hyphaeon-js';

import { TEMPORAL_NULL_ASSUMPTION, TEMPORAL_THRESHOLDS } from './codes.js';

export { TEMPORAL_SITES_COLUMNS, TEMPORAL_CURVES_COLUMNS, TEMPORAL_WAVES_COLUMNS, TEMPORAL_SUMMARY_KEYS };

/** The reference's own four suffixes (temporal.py:827, 831, 835, 839). */
export const TEMPORAL_FILE_SUFFIXES = Object.freeze({
	sites: '_sites_summary.csv',
	curves: '_curves.csv',
	waves: '_waves.csv',
	summary: '_summary.json'
});

/**
 * `_sites_summary.csv`: one row per codon, site order, 27 columns.
 *
 * `{ stage1Column: true }` APPENDS A TWENTY-EIGHTH, `stage1`, which is 1 at a codon the null
 * actually tested and 0 at one it never reached. It is off by default and must stay off by default:
 * the reference writes 27 columns and a file with 28 does not diff against `hyphaeon temporal`.
 * It exists because the note beside these files makes a claim the 27 columns can only half keep —
 * see `temporalDownloadNotes`, and the measurement there.
 */
export function temporalSitesCsvText(record, options = {}) {
	const c = record.sites;
	const text = temporalSitesCsv({
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
	if (!options.stage1Column) return text;
	// Appended rather than threaded through the library's writer, because the writer's whole job is
	// to be byte-equal to pandas on the reference's own 27 columns and an app-side column has no
	// business inside it. The mask is `sites.stage1`; a record taken before stage one has none, and
	// then every row reads 0, which is true of that record.
	const mask = c.stage1 ?? null;
	const lines = text.split('\n');
	const last = lines.length - 1;
	// The writers end with a trailing newline, so the final element is the empty string after it.
	const tail = lines[last] === '' ? 1 : 0;
	lines[0] += ',stage1';
	for (let i = 1; i < lines.length - tail; i++) lines[i] += `,${mask && mask[i - 1] ? 1 : 0}`;
	return lines.join('\n');
}

/**
 * `_curves.csv`: long format over the stage-one candidates, T rows each — or, when nothing passed
 * the floor, the first `min(L, 20)` codons (temporal.py:796). The `exportSites` rule is the
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

/**
 * `_summary.json`: the reference's eighteen keys, in its order, with its rounding.
 *
 * `alignment` and `tree` come from `runTemporal`'s `inputs` and from nowhere else, which makes that
 * option load-bearing rather than decorative: this file's whole job is to say what was analysed.
 * `runTemporal` therefore THROWS on an `inputs` key it does not recognise (`assertInputNames`), so
 * the one way to reach `""` here is a run that genuinely had no file name — a pasted alignment in
 * the browser — and not a caller's typo. `""` means "this run had no name", never "we lost it".
 */
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
 * The command line that would run this analysis again, and everything that stands between running it
 * and getting these files back.
 *
 * WHAT `reproduces` MEANS, exactly, because a boolean called that will be read as a promise:
 *
 *   TRUE  — the printed command runs the same analysis, on the same sequences, with every setting
 *           this run used expressed as a flag; and every number it produces agrees with ours at the
 *           classes this repository documents everywhere else: strict graph class (~1e-6 relative)
 *           for everything the model computes, and exact for everything that is a choice rather than
 *           a computation.
 *   FALSE — one of those fails: a setting cannot be put on the command line, the two runs are not
 *           over the same sequences, or a column of ours is at STATISTICAL class only, meaning a
 *           different number rather than a different last digit.
 *
 *   NEITHER value ever means the four files diff clean. They do not — 1 of 4,384 rows on the
 *   measured H1N1 run — and the first caveat says so on EVERY run, `reproduces` true or false,
 *   because that is the claim a reader actually acts on when they run the command.
 *
 * THE FOUR THINGS THAT SET IT FALSE, and why each one is not a matter of digits:
 *
 *   1. THE GENERATOR. `hyphaeon temporal` draws its date shuffles from numpy's MT19937 at a
 *      hard-coded `RandomState(42)` (temporal.py:651); the library standardises on xoshiro256**
 *      per-draw substreams (D17), as the phenotype permulations already do. Different permutations
 *      are different draws, so `p_perm`, `q_perm`, `is_confirmed_sweep`, both classification columns
 *      and the three sweep counts are statistical class ONLY. MEASURED on H1N1 at `-B 100`:
 *      `confirmed_sweeps` 32 against the reference's 18. Any run whose null actually drew is
 *      therefore not reproducible in the strict sense, and this is by far the commonest cause.
 *   2. DATES READ BY A RULE THE REFERENCE HAS NOT (D31). On the Korber alignment the reference dates
 *      none of 143 headers and we date 142, so the two runs are not over the same sequences at all.
 *   3. A NULL THAT PRODUCED NOTHING — refused above the work budget, cancelled before its first
 *      shuffle finished, at zero completed draws for any other reason, or not yet started at all on
 *      an interim record — or a model pass that skipped the invariable codons: our file is missing
 *      numbers the reference's has. Every no-draw state is ONE branch below, because `skipped` alone
 *      does not cover a cancel at draw zero: that run is `completed === 0, cancelled, not skipped`
 *      and used to print `reproduces: true`.
 *   4. A SETTING WITH NO FLAG. There is none left — `-s`, `-bw`, `--tau-peak`, `--tau-auc`,
 *      `--sweep-mode`, `--keep-duplicates` and the TREE-FREE flag are all emitted below when this
 *      run departed from the reference's own defaults — and this clause stays here so the next
 *      option added is either printed or declared. The tree-free path is the one this clause got
 *      wrong: under D22 a run with no tree, or with a tree carrying no usable branch lengths, takes
 *      pairwise TN93 distances straight into the MDS, which is `hyphaeon temporal --no-tree` /
 *      `--use-tn93` (cli.py:1829-1830) and NOT the default. Printed without it, the command asked
 *      for patristic distances the run never computed and, with no tree to find, would not run at
 *      all. `record.primaeon.tree_free` is what says so.
 *
 * @param {object} record
 * @param {{alignment?: string, tree?: string|null, dates?: string|null, prefix?: string}} [names]
 *   Names for the three input files. Each falls back to what the run itself recorded —
 *   `record.alignment`, `record.tree` and `record.dates.file`, all three written from `runTemporal`'s
 *   own `inputs` — so a caller that already passed `inputs` never has to repeat itself here.
 * @returns {{command: string, reproduces: boolean, caveats: string[]}}
 */
export function temporalReferenceCommand(record, names = {}) {
	const aln = names.alignment ?? record.alignment ?? '<alignment.fasta>';
	const tree = names.tree ?? record.tree ?? null;
	const datesFile = names.dates ?? record.dates?.file ?? null;
	const prefix = names.prefix ?? 'temporal';
	const perm = record.permutations ?? null;
	// HOW MANY SHUFFLES THIS RUN ACTUALLY DREW, or null when there is no count to have: no
	// permutation block at all, or a block whose `completed` is missing. `?? REF` is load-bearing —
	// without it a block without `completed` printed the literal string `-B undefined`.
	const drawn = perm && Number.isFinite(perm.completed) ? perm.completed : null;
	const nullRan = drawn !== null && drawn > 0;
	// WHAT TO PRINT. A run that drew nothing has no count to offer and `-B 0` is not an analysis
	// anyone wants, so the command carries the reference's own default and the branch below says
	// plainly that the printed null is the reference's and not this run's.
	const B = nullRan ? drawn : TEMPORAL_THRESHOLDS.permutationsReference;
	const floors = record.floors ?? {};
	const regime = record.regime ?? {};
	// D22: no tree, or a tree with no usable branch lengths, took pairwise TN93 distances straight
	// into the MDS. That is a FLAG upstream, not a default (cli.py:1829-1830), and a command missing
	// it asks for patristic distances this run never computed.
	const treeFree = record.primaeon?.tree_free ?? null;

	const parts = ['hyphaeon temporal', `-a ${aln}`];
	// A tree-free run that was HANDED a tree still prints `-t`: the reference takes both and ignores
	// the tree, which is exactly what happened here.
	if (tree) parts.push(`-t ${tree}`);
	if (treeFree) parts.push('--use-tn93');
	if (datesFile) parts.push(`-d ${datesFile}`);
	// `-s` is the reference's own PD downsampling (cli.py:1850), which is what this surface's taxon
	// cap is a port of, so the cap is expressible; the count to pass is the post-cap taxon total.
	if (record.primaeon?.taxon_cap === 'applied') parts.push(`-s ${record.taxa_total}`);
	// ALWAYS, in both states: a command that names no `-B` describes a 1,000-draw null whether or
	// not that is what ran, and a reader comparing the printed line with the record should not have
	// to know the reference's default to see which.
	parts.push(`-B ${B}`);
	parts.push(`--time-points ${record.grid.time_points}`);
	if (regime.time_units && regime.time_units !== 'years') parts.push(`--time-units ${regime.time_units}`);
	// The RESOLVED mode, never `auto`: `auto` resolves identically on both sides, and naming the
	// resolved one also covers a caller that overrode it (cli.py:1844).
	if (regime.sweep_mode) parts.push(`--sweep-mode ${regime.sweep_mode}`);
	// `--keep-duplicates` is auto-enabled by a non-calendar `--time-units` on both sides, so it is
	// only worth printing when the calendar path had the collapse turned off explicitly.
	if (regime.prune_duplicates === false && regime.non_calendar !== true) parts.push('--keep-duplicates');
	if (record.root.taxon) parts.push(`--root-taxon ${record.root.taxon}`);
	// `-bw` only when the resolved bandwidth is NOT what the reference's own auto rule
	// (temporal.py:486-492) would produce for this run. Recomputing that rule from the record's own
	// timespan, units and grid is bit-identical to the computation `run.js` already did, so a
	// supplied bandwidth that happens to equal the auto value correctly prints nothing.
	const autoBandwidth = resolveTemporalBandwidth(record.timespan_years, {
		timeUnits: regime.time_units ?? 'years',
		numTimePoints: record.grid.time_points
	});
	if (Number.isFinite(record.bandwidth_years) && record.bandwidth_years !== autoBandwidth) {
		parts.push(`-bw ${record.bandwidth_years}`);
	}
	// `tau_peak_overridden` is true exactly when the effective floor came from the reference's own
	// substitution for its documented default (upstream TEMPORAL Q1), which omitting the flag
	// reproduces; false means a caller named a value, and then the value is the resolved one.
	if (floors.tau_peak_overridden === false) parts.push(`--tau-peak ${floors.tau_peak}`);
	if (floors.tau_auc_defaulted === false) parts.push(`--tau-auc ${floors.tau_auc}`);
	parts.push(`--perm-alpha ${floors.perm_alpha}`, `--min-r2 ${floors.min_r2_fpca}`, `-o ${prefix}`);

	let reproduces = true;
	// Caveat zero, on every run: what the command does and does not buy. Emitted first, and before
	// any branch can turn `reproduces` false, so it is present in both states.
	const caveats = [
		'Running this does not make the four files diff clean, and `reproduces` above never claims it ' +
			'does. Every column the model computes agrees with `hyphaeon temporal` at graph class — the ' +
			'ONNX graph against torch, ~1e-6 relative — which is a different decimal string in most rows. ' +
			'MEASURED on H1N1 at `-B 100 --time-points 60`: 1 of 4,384 `_sites_summary.csv` rows byte-identical, ' +
			'17 of 27 columns differing somewhere, 0 of 60 `_waves.csv` rows matching. Compare numerically, ' +
			'not with `diff`.'
	];

	if (nullRan) {
		reproduces = false;
		caveats.push(
			`The ${drawn} date shuffles this run drew came from ${perm.rng ?? 'xoshiro256**'} per-draw ` +
				'substreams (D17); `hyphaeon temporal` draws from numpy\'s MT19937 at a hard-coded `RandomState(42)` ' +
				'(temporal.py:651). Both are valid nulls at the same B and the same estimator, and neither is the ' +
				'other: `p_perm`, `q_perm`, `is_confirmed_sweep`, `classification`, `cross_classification` and the ' +
				'three sweep counts are statistical class only, not different last digits. MEASURED on H1N1 at ' +
				'`-B 100`: 32 confirmed sweeps here against the reference\'s 18.'
		);
	}
	const beyond = record.dates?.beyond_reference;
	if (beyond && beyond.count > 0) {
		reproduces = false;
		caveats.push(
			`${beyond.count} of the ${record.taxa_timestamped} dates on this run were read by a rule ` +
				`\`hyphaeon temporal\` does not have (${Object.keys(beyond.rules).join(', ')}). The command above ` +
				'will not reproduce this run; supply the dates as a metadata table with `-d` and it will.'
		);
	}
	if (nullRan && B !== TEMPORAL_THRESHOLDS.permutationsReference) {
		caveats.push(
			`\`-B ${B}\` is the count this run actually drew; the command line's own default is ` +
				`${TEMPORAL_THRESHOLDS.permutationsReference}. Fewer draws do not bias the p-value, they coarsen its grid ` +
				`to 1/${B + 1}.`
		);
	}
	if (nullRan && perm.cancelled) {
		caveats.push(`The null was stopped after ${drawn} of ${perm.requested} shuffles.`);
	}
	// EVERY NO-DRAW STATE, in one branch. `skipped` alone used to carry this, which left a null
	// cancelled at draw zero (`completed === 0`, `cancelled`, NOT `skipped`) claiming `reproduces:
	// true` on a run that produced no permutation number at all. A record with no permutation block
	// AT ALL is the same claim about the same absence — `runTemporal` only ever returns one on the
	// interim `stage: 'scored'` payload, published before the null starts — so it is the same branch.
	if (!nullRan) {
		reproduces = false;
		const how = !perm
			? 'carries no permutation block at all (an interim record, taken before the null started)'
			: perm.skipped
				? 'was not run at all on this surface (above its work budget)'
				: perm.cancelled
					? `was stopped before its first shuffle finished (0 of ${perm.requested} requested)`
					: 'completed no shuffles';
		caveats.push(
			`The null ${how}, so this run holds NO permutation numbers: \`p_perm\` and \`q_perm\` are absent at ` +
				`every candidate rather than measured. \`-B ${B}\` on the line above is the command's own default, ` +
				'not a count this run drew — running it produces the columns this run does not have.'
		);
	}
	if (record.primaeon?.taxon_cap === 'applied') {
		caveats.push(
			`This run was capped at ${record.taxa_total} taxa, so \`-s ${record.taxa_total}\` is on the command line. ` +
				'That flag is the reference\'s own Faith\'s-PD downsampling and this surface runs a port of it, so the ' +
				'two runs select the same taxa — but they analyse a SUBSET, and a different cap is a different analysis.'
		);
	}
	if (record.waves && record.waves.count > 0) {
		caveats.push(
			`Wave signs follow this application's \`${record.waves.sign}\` convention (D28, WAVE_SIGN.md); ` +
				'`hyphaeon temporal` has none and writes its solver\'s raw signs, so a curve in `_waves.csv` and ' +
				'its `Wave_k_loading` column may both come back negated. Nothing downstream reads a sign — not the ' +
				'singular values, the variance shares, R² or any classification — so the sign is the only thing this ' +
				'convention changes. It is not the only thing that differs between the two runs; see the first note.'
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

/**
 * WHICH ROWS OF `_sites_summary.csv` CARRY A MEASURED `p_perm`, and which carry the reference's
 * fill. Exported on its own because three surfaces have to say the same thing about it and one of
 * them (the MCP's honesty block) says it outside the download list.
 *
 * THE CLAIM THIS REPLACES was that a candidate is told from an untested codon by `p_perm`: 1.0
 * means untested, anything else means measured. That is wrong in one direction and the file cannot
 * keep it. MEASURED on `examples/H5N1_HA_geo.fasta` at `-B 200` (98 sequences, 566 codons, 168
 * stage-one candidates): 399 rows read exactly 1.0 against 398 non-candidates, because a candidate
 * every one of the 200 shuffles beat scores `(1 + 200) / 201 = 1.0` exactly. The column that IS the
 * key is `classification`, which partitions the file four ways with the candidate/non-candidate
 * split running straight through the middle of it, and it is in every row of every run.
 *
 * The RECORD has `sites.stage1` and that is the mask a surface returning JSON should carry; a
 * reader holding only the CSV has no such key unless it was written with `{stage1Column: true}`.
 *
 * @param {object} record
 * @returns {string}
 */
export function temporalPPermNote(record) {
	const untested = Math.max(0, record.codons_total - record.stage1_candidates);
	return (
		`\`p_perm\` and \`q_perm\` are 1.0 at the ${untested} codon(s) that never reached stage two, which is a ` +
		'p-value printed for a test that was not run. That is the reference\'s own fill (temporal.py:620-621), ' +
		'reproduced so the files diff clean, and it is not a measurement. THE COLUMN THAT TELLS THE TWO APART IS ' +
		'`classification`, not `p_perm`: `INVARIABLE` and `FLAT_NO_SIGNAL` are codons the null never tested, ' +
		'`TEMPORAL_NOISE` and `CONFIRMED_SWEEP` are candidates it did. A 1.0 in `p_perm` does NOT mean untested — ' +
		'a tested candidate that every shuffle beat scores (1 + B) / (B + 1) = 1.0 exactly, and one does: measured ' +
		'on H5N1 at B = 200, 399 of 566 rows read 1.0 against 398 non-candidates. Read `p_perm` and `q_perm` only ' +
		`at the ${record.stage1_candidates} row(s) whose \`classification\` is a candidate label, or take the file with ` +
		'`stage1Column` and read the appended 1/0 mask directly.'
	);
}

/** The notes that must travel with the files. See the header. */
export function temporalDownloadNotes(record) {
	return [
		`\`${TEMPORAL_FILE_SUFFIXES.sites}\` is every one of the ${record.codons_total} codons in site order — the opposite ` +
			`convention to the table on this page, which shows the ${record.stage1_candidates} candidates with the sweeps first.`,
		// The qualifier the app's copy inherits from here (see the header's FORMAT / CONTENT split).
		'These files match `hyphaeon temporal`\'s FORMAT byte for byte — headers, column and key order, ' +
			'rounding, row counts — and that is what "byte for byte" is a claim about. They do not match its ' +
			'CONTENT: measured on H1N1, 1 of 4,384 `_sites_summary.csv` rows was byte-identical to a command-line ' +
			'run of the same analysis, because the model columns agree at ~1e-6 rather than digit for digit and the ' +
			'permutation columns come from a different generator. Diff these against another run of THIS build; ' +
			'compare them numerically against `hyphaeon temporal`.',
		'`_curves.csv` writes `selection_intensity` and `sweep_velocity` from the same array, so the two columns are ' +
			'identical in every row. That is an upstream bug (temporal.py:807-808) reproduced on purpose so the file ' +
			'diffs clean against `hyphaeon temporal`; there is one quantity there, not two.',
		temporalPPermNote(record),
		// X1: what the null assumes, in the same words the page and the record use. One constant,
		// three surfaces; see `TEMPORAL_NULL_ASSUMPTION` in `codes.js`.
		`${TEMPORAL_NULL_ASSUMPTION.lead} ${TEMPORAL_NULL_ASSUMPTION.rest}`,
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
export function temporalDownloads(record, { prefix = 'temporal', stage1Column = false } = {}) {
	return [
		{ name: `${prefix}${TEMPORAL_FILE_SUFFIXES.sites}`, mime: 'text/csv', text: temporalSitesCsvText(record, { stage1Column }) },
		{ name: `${prefix}${TEMPORAL_FILE_SUFFIXES.curves}`, mime: 'text/csv', text: temporalCurvesCsvText(record) },
		{ name: `${prefix}${TEMPORAL_FILE_SUFFIXES.waves}`, mime: 'text/csv', text: temporalWavesCsvText(record) },
		{ name: `${prefix}${TEMPORAL_FILE_SUFFIXES.summary}`, mime: 'application/json', text: temporalSummaryJsonText(record) }
	];
}
