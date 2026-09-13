/**
 * time.js — the date layer, the two time pillars' refusal vocabulary, and the honesty blocks that
 * must travel with their numbers.
 *
 * WHY THIS FILE EXISTS
 *
 * Phase 6 gives the MCP what the browser's `/time` route already has: a date review stage, the
 * molecular clock (`hyphaeon dating`) and temporal selection (`hyphaeon temporal`). Three things
 * about those pillars have no precedent anywhere in `src/`, and each of them is a decision rather
 * than a wiring detail, so they live here rather than being smeared across engine.js and tools.js:
 *
 *   1. A SECOND DATA FILE THAT IS NOT SEQUENCE DATA. Every input key before this one was
 *      sequence-shaped. A date layer is an Auspice JSON *or* a delimited table *or* the FASTA
 *      headers *or* a pasted map, with delimiter sniffing, column discovery, a caller-supplied
 *      regex and a seven-tier name ladder. `ingestFor` below is the ONE call both new pillars and
 *      the review tool make, so the three tools can never disagree about what a date is.
 *   2. REFUSALS THAT ARE RETURNED, NOT THROWN. `ingestDates`, `runDating` and `runTemporal` all
 *      return `{ok: false, refusal, warnings}` objects. Every other pillar the engine wraps signals
 *      a bad input by THROWING, and `classifyEngineError` exists to read those thrown messages, so
 *      a naive wrapper resolves the tool call as a SUCCESS whose body says nothing ran. The
 *      `refusalOf` / `TIME_REFUSAL_HINTS` pair here is what engine.js turns into an EngineError.
 *   3. TWO QUESTIONS THE BROWSER ASKS A HUMAN AND AN MCP CLIENT CANNOT BE ASKED. See below; they
 *      are the reason this file has opinions at all.
 *
 * ── DECISION 1: THE BARE-NUMBER MAJORITY. ────────────────────────────────────────────────────
 * Under any non-calendar `--time-units` the reference's last header pattern (temporal.py:209) takes
 * the first delimiter-bound number in a sequence name, whatever that number means: an accession, an
 * isolate index, a patient code. MEASURED on the bundled H1N1 set in this session: under
 * `time_units: "years"` 95 of 100 sequences date by `header_decimal_year` over 2009.25-2009.91;
 * under `time_units: "generations"` 100 of 100 date, 75 of them by `header_bare_number`, and the
 * axis runs from 1 to 46,241,654 — with NO error anywhere. The units probe normally saves you
 * (`inferTimeUnits`'s calendar-majority rule, DATE_THRESHOLDS.calendarMajority), and it is bypassed
 * the moment a caller passes `time_units` explicitly, which is exactly what an MCP argument does.
 *
 * The browser answers this with a confirmation gate: the reader must say out loud that the numbers
 * mean what the axis says before the run is unlocked (`web/src/lib/time/dateReview.ts`
 * BARE_NUMBER_RULE / `bareNumbersDominate` / `readyGate`). A tool call has nobody to ask, and four
 * answers were available: (a) always accept — ships the 1-to-46-million axis silently; (b) always
 * refuse — correct but blocks a legitimate generations panel with no way through; (c) warn and
 * proceed — the exact silence this layer exists to break; (d) REFUSE WITH A STRUCTURED CODE AND A
 * NAMED OVERRIDE. This file takes (d): `DATES_BARE_NUMBER_MAJORITY` at `refuse`, overridden only by
 * an explicit `accept_bare_numbers: true` on the request, which is then RECORDED in the result's
 * `date_review.gate.overrides` and in provenance. The threshold is the browser's own 0.5 and the
 * rule is its own, ported here verbatim rather than re-derived, because two surfaces disagreeing
 * about when to ask is worse than a duplicated constant.
 *
 * WHERE IT BELONGS: in `runtime/src/dates/codes.js` beside the other thirty-one codes, so all three
 * surfaces read one number and the browser RENDERS the refusal instead of computing it. Phase 6's
 * MCP builder does not touch `runtime/src/`, so it is here, namespaced into the date layer's own
 * vocabulary and flagged for the move. The duplication is visible and deliberate; a silent second
 * threshold would not be.
 *
 * ── DECISION 2: UNDATED SEQUENCES. ───────────────────────────────────────────────────────────
 * `datesVector` fills NaN for an undated taxon and both pillars then drop it upstream, silently.
 * MEASURED here: H1N1 dates 95 of 100 from headers, korber 142 of 143, H5N1 98 of 98 — so on two
 * of the three shipped examples an unguarded run answers about a different dataset than the caller
 * uploaded. The browser blocks on this too (`readyGate`'s `coverage.undated > 0 && !dropUndated`).
 * Same shape as decision 1: `DATES_UNDATED_PRESENT` at `refuse` on the two ANALYSES, overridden by
 * an explicit `drop_undated: true` and recorded.
 *
 * IT NEVER FIRES ON `hyphaeon_dates`. That tool's entire job is to report which sequences carry a
 * date and which do not; refusing it for the thing it was asked to measure would be absurd. The
 * review tool always answers, carries the gate as `gate.blocking[]`, and a client is expected to
 * read that block before calling either analysis. That is the sequencing the task's "its output is
 * what makes the other two safe" describes.
 *
 * ── DECISION 3: THE DATES ARE A DateIngest, NEVER A BARE MAP. ────────────────────────────────
 * `resolveTemporalDates` accepts a taxon->value map — the natural JSON shape for an MCP argument —
 * and returns `byRule: null` for one, ON PURPOSE, so an unknown provenance is not reported as a
 * clean one. A run fed a map then prints `beyond_reference: {count: 0}`, a claim the input cannot
 * support, and D31's whole rule table is lost. So the tools here take a date SOURCE (a file's text,
 * or nothing and read the headers) and always hand the pillars the `DateIngest` object this file
 * produced. No tool accepts a naked map.
 *
 * ── DECISION 4: `use_model` IS A REQUEST, NOT AN AVAILABILITY ACCIDENT. ──────────────────────
 * `resolveDistanceMode('auto', hasModel)` returns `latent` when a model pass was supplied and
 * `tn93` when it was not, and the two give DIFFERENT ANSWERS on the same sequences: measured
 * upstream on korber, `t_mrca` 1938.77 model-free against 1926.81 with the dating graph, twelve
 * years apart, with the whole warning set changing. A tool whose estimator depends on whether a
 * graph happened to be on disk would answer the same request two ways on two deployments. So
 * `hyphaeon_dating` is MODEL-FREE BY DEFAULT and the model half is `use_model: true`; a build whose
 * manifest declares no `<variant>_taxa.onnx` answers `use_model: true` with its own named error
 * (`DATING_GRAPH_UNAVAILABLE`, engine.js) rather than quietly falling back to the other estimator.
 * `distance_mode` and `distance_mode_reason` are on every result.
 *
 * ── DECISION 5: reference_command IS AN OBJECT FOR THESE TWO PILLARS. ────────────────────────
 * The other six stamp a bare argv array. The runtime's `temporalReferenceCommand` returns
 * `{command, reproduces, caveats}` and sets `reproduces: false` on four grounds, the commonest
 * being simply THAT THE NULL DREW AT ALL (numpy MT19937 upstream against xoshiro256** here, D17).
 * MEASURED in this session on H5N1: `reproduces: false` with 3 caveats on a run that succeeded
 * completely. Printing the string alone makes a reproducibility promise the runtime explicitly
 * refuses to make, so these two pillars' `provenance.reference_command` is the OBJECT. The shape
 * difference is deliberate and is documented in the tool descriptions, in
 * `hyphaeon://methods/requirements` and in the interpretation prompts; a string that cannot
 * reproduce the run is worse than a shape a client has to switch on.
 *
 * `datingReferenceCommand` WAS this file's own for exactly as long as the runtime had none. It is
 * now `runtime/src/dating/results.js`'s, beside the temporal one, and this file re-exports it and
 * keeps no copy — see the block above that re-export for what the duplicate had already got wrong.
 * `datingHeadline` came with it, and is the reason a dating result carries `headline` beside its
 * `t_mrca`.
 *
 * ── DECISION 6: A TEMPORAL RECORD IS NEVER INLINE. ───────────────────────────────────────────
 * MEASURED in this session (H5N1_HA_geo, 98 taxa x 566 codons, general.onnx at 4 threads, B = 1000
 * at the reference's own `--time-points 250`): the run is 4,065 ms and the JSON-safe record is
 * 2,149,694 bytes, of which `curves` alone is 1,988,099 (92.5%) — 8.2x ANALYZE_INLINE_MAX_BYTES.
 * The engine's own H1N1 acceptance run is 7.18 MB, 27x. `top` cannot touch any of it: the site
 * columns are typed arrays, not arrays of records, so `topBy` would slice one and drop the ranking
 * silently. So `hyphaeon_temporal` is ALWAYS a job (as `hyphaeon_analyze` is), answers with the
 * summary plus the job id, and `get_results section=` pages the record through the vocabulary in
 * TEMPORAL_SECTIONS below. `curves` is the one section that cannot be served whole at any size, so
 * it is served per codon and capped: one codon's two tracks at T = 250 measured 1,038 bytes plus a
 * 2,502-byte shared time axis. That per-curve figure was wrong — see TEMPORAL_CURVES_MAX_POINTS,
 * which carries the corrected measurement and the reason the first one looked like one — and the
 * section is budgeted in numbers rather than codons because the time grid is a caller option.
 *
 * ── DECISION 7: A STOPPED NULL IS NOT A FINISHED NEGATIVE RESULT. ────────────────────────────
 * `runTemporalNull` catches its own abort, records `{completed, cancelled, skipped, reason}` and
 * leaves NaN — never 1.0 — at a candidate it did not test, so `runTemporal` resolves with a VALID
 * record at a coarser grid. Meanwhile `permutations.tested` flips true after the FIRST chunk while
 * `classification`, `is_confirmed_sweep` and the three sweep counts are still the scored payload's
 * zeros, so reading `tested` alone prints "nothing is under selection" one second into a run — and
 * prints it every time, because p at draw k is (1 + exceedances)/(k + 1) and starts near 1 for
 * every codon. `nullStateOf` / `uncalledBecause` below are ports of
 * `web/src/lib/time/temporal.ts`'s own four-state discriminator (`not-started | running | finished |
 * stopped`), and `temporalHonesty` puts all of it on the wire, unconditionally, in every result and
 * every section. No surface may invent its own clause: that is how the browser came to tell a
 * reader whose null was SKIPPED that it "has not finished".
 *
 * ── DECISION 8: THE WAVE SHARES MOVE WITH THE NULL, AND SAY SO. ──────────────────────────────
 * The fPCA decomposition runs over the CONFIRMED-SWEEP set, which is thresholded on the permutation
 * p, which comes from a different generator than the reference's. Upstream measurement: 32 confirmed
 * here against 18 there on H1N1 at B = 100, and shares 33.84/28.26/17.81/11.11 % against
 * 39.67/32.37/13.92/9.31 — 5.8 points on the leading mode, with identical arithmetic. There is also
 * a SECOND branch: with fewer than four confirmed codons the set falls back to the strongest
 * candidates by peak intensity, read off the trajectories BEFORE the null was drawn, and
 * `waves.source` says which. `temporalHonesty().wave_variance` carries the conditioning sentence
 * and the branch name wherever the shares appear.
 *
 * WHAT IS NOT HERE. No date arithmetic, no second date parser, no eigensolver, no session. The date
 * layer is imported through `@veg/hyphaeon-runtime/dates` and the clock through
 * `@veg/hyphaeon-runtime/dating`, and NEITHER of those subtrees imports `manifest.js`,
 * `predict.js`, a session or `tn93-wasm.js` — measured at 93 ms of import with zero onnxruntime
 * modules loaded. That boundary is what makes "reviewing dates costs no model byte" a fact rather
 * than a claim, and `hyphaeon_dates` runs entirely on these two imports: it never calls
 * `loadRuntime()` and never reaches `engine.session()`. `./temporal` DOES reach onnxruntime, so it
 * is resolved lazily through the engine's runtime bag and never imported at the top of this file.
 */

import {
  DATE_DIAGNOSTIC_CODES,
  DATE_MATCH_TIERS,
  DATE_THRESHOLDS,
  ingestDates,
  taxaForDates
} from "@veg/hyphaeon-runtime/dates";
import {
  DATING_CI_METHODS,
  DATING_DISTANCE_MODES,
  DATING_NEURAL_MAX_TAXA,
  DATING_REFUSALS,
  DATING_THRESHOLDS,
  datingHeadline,
  datingReferenceCommand
} from "@veg/hyphaeon-runtime/dating";

export { DATE_DIAGNOSTIC_CODES, DATE_MATCH_TIERS, DATE_THRESHOLDS, DATING_CI_METHODS, DATING_DISTANCE_MODES, DATING_NEURAL_MAX_TAXA, DATING_THRESHOLDS };

// ── the two gate codes this surface adds ────────────────────────────────────

/**
 * The rule name `ingestDates` records for "the first delimiter-bound number in the name, whatever
 * it means" (temporal.py:209). Ported from web/src/lib/time/dateReview.ts BARE_NUMBER_RULE.
 */
export const BARE_NUMBER_RULE = "header_bare_number";

/**
 * Fraction of DATED sequences read by that rule at or above which the gate fires. The browser's
 * own BARE_NUMBER_MAJORITY (dateReview.ts), quoted rather than re-chosen — see decision 1.
 */
export const BARE_NUMBER_MAJORITY = 0.5;

/** This surface's two gate codes, in the date layer's own namespace. See decisions 1 and 2. */
export const DATES_BARE_NUMBER_MAJORITY = "DATES_BARE_NUMBER_MAJORITY";
export const DATES_UNDATED_PRESENT = "DATES_UNDATED_PRESENT";

/**
 * The third code this surface adds: `distance_mode: 'latent'` asked for without `use_model`.
 *
 * The runtime throws a RangeError for it naming its OWN argument — "pass `neural`, the object
 * runDatingModelPass returns" (runtime/src/dating/run.js:282) — which is an internal API a tool
 * caller has no way to pass and cannot act on. The two arguments are one request on this surface
 * (decision 4: `use_model` is a request, not an availability accident), so the pair is checked
 * before the pillar runs and refused with a code and a hint naming the two arguments that exist.
 * The runtime's message is still classified as a fallback in engine.js, in case another path
 * reaches it.
 */
export const DATING_LATENT_NEEDS_MODEL = "DATING_LATENT_NEEDS_MODEL";

/**
 * `hyphaeon temporal`'s own minimum: `if N < 5: raise ValueError` at temporal.py:474, counted
 * AFTER the taxon cap, the duplicate collapse and the tree pruning. Quoted here rather than
 * imported because `@veg/hyphaeon-runtime/temporal` is the one date-layer import that reaches
 * onnxruntime (see WHAT IS NOT HERE), and this file must stay loadable without it;
 * test/temporal.test.js asserts the two are the same number, so the quote cannot drift.
 */
export const TEMPORAL_MIN_DATED_TAXA = 5;

/**
 * Every refusal the three runtime code tables can produce, plus this surface's two, with the hint
 * that names the fix. EVERY ONE OF THEM IS `kind: "input"` — each is a property of the caller's
 * metadata or alignment, and none of them changes if the operator restarts the server. Phase 3
 * classified exactly one refusal of this shape (the runtime's TN93 message) as a SERVER fault and
 * Phase 4 had to fix it with TN93_UNCOMPUTABLE; the comment at engine.js's `tn93Refusal` exists so
 * the mistake is not repeated, and this table is that comment applied to thirty more codes.
 *
 * The hint must name the METADATA fix (a date column, a pattern, more sampling spread), never the
 * alignment fix the engine's generic input hint gives: "check that the alignment is in frame" is
 * useless advice to someone whose CSV has the wrong column name.
 */
export const TIME_REFUSAL_HINTS = Object.freeze({
  // --- the date layer (runtime/src/dates/codes.js, severity 'refuse') ---
  DATES_SOURCE_UNREADABLE:
    "The metadata file did not parse as the kind it was read as. Check the file is complete, or set date_source_kind to say what it is (auspice | json-map | table).",
  DATES_SOURCE_KIND_UNKNOWN:
    "The metadata is neither a Nextstrain Auspice JSON, a name-to-date JSON object, nor a delimited table. Export a two-column CSV (sequence name, date), or omit dates_file and let the headers be read.",
  DATES_BEAST_XML_UNSUPPORTED:
    "BEAST XML is read by the reference (dating.py:433-434) and not by this build. Export the taxon dates as a two-column CSV and pass it as dates_file.",
  DATES_TABLE_NO_DATE_COLUMN:
    "Name the date column explicitly with date_col (and the sequence-name column with strain_col), or rename it to one of the candidates the error lists.",
  DATES_AUSPICE_NO_TIPS:
    "The JSON parsed but no tip carries a name. A Nextstrain v2 build has a `tree` whose childless nodes carry `name` and `node_attrs`; export one of those, or supply a CSV instead.",
  DATE_REGEX_INVALID: "Fix date_pattern: it could not be compiled as a regular expression.",
  DATE_REGEX_NO_GROUP:
    "date_pattern needs a capturing group: the date is taken from group 1, so put the date part of the name in parentheses, e.g. `_(\\\\d{4}-\\\\d{2}-\\\\d{2})$`.",
  DATES_TABLE_NO_MATCH:
    "No name in the metadata's name column matched any sequence, at any tier. Check strain_col names the right column and that the two files use the same identifiers.",
  DATES_NONE:
    "Nothing in this dataset carries a time coordinate. Supply dates_file (an Auspice JSON or a CSV/TSV with a name column and a date column), or date_pattern to match your header convention.",
  DATES_TOO_FEW:
    "At least " + DATE_THRESHOLDS.minDatedTaxa + " sequences must carry a date: two points define a line with no residual degrees of freedom. Add dates, or widen the match (strain_col / date_pattern).",
  DATES_NO_SPAN:
    "Every dated sequence carries the same date, so there is no time axis to regress against. A clock needs sequences sampled at different times.",
  [DATES_BARE_NUMBER_MAJORITY]:
    "Most of these dates were read as a bare number in the sequence name, a rule that claims any number it finds (an accession reads as a generation). Supply the dates as a metadata table (dates_file), or pass accept_bare_numbers: true to confirm those numbers are the time coordinate you mean.",
  [DATES_UNDATED_PRESENT]:
    "Some sequences carry no date and would be dropped silently. Call hyphaeon_dates to see which, then pass drop_undated: true to run on the dated set, or supply dates for them.",

  // --- the clock (runtime/src/dating/codes.js DATING_REFUSALS) ---
  DATING_ALIGNMENT_EMPTY: "No sequences were read. Submit an in-frame codon alignment as FASTA, NEXUS or PHYLIP.",
  DATING_ALIGNMENT_RAGGED: "The sequences are not all the same length. Align them to a common column register before dating.",
  DATING_ALIGNMENT_NOT_CODING: "This does not read as an in-frame codon alignment. Check the reading frame and the alphabet.",
  DATING_TOO_FEW_DATED:
    "At least " + DATING_THRESHOLDS.minDatedTaxa + " sequences must carry a date. Run hyphaeon_dates to see which sequences the date layer could and could not read, and widen the match from there.",
  DATING_NO_TIME_SPAN: "The dated sequences share one date, so the root-to-tip regression has no time axis. Sequences sampled at different times are required.",
  DATING_TN93_UNCOMPUTABLE:
    "The pairwise TN93 distances this estimator needs do not exist for at least one pair (saturated, or no overlapping unambiguous position). This is a property of the sequences, not of the server; drop the pairs hyphaeon_validate's TN93_SATURATED_PAIRS names.",
  [DATING_LATENT_NEEDS_MODEL]:
    "`distance_mode: \"latent\"` is the MODEL'S representation space, so it needs the graph pass: re-send with " +
    "use_model: true, or drop distance_mode (the default `auto` is `tn93` model-free and `latent` with the model). " +
    "They are different answers on the same data, not two qualities of one answer — measured twelve years apart on " +
    "the korber example — so neither is substituted for the other.",
  DATING_MODEL_TOO_MANY_TAXA:
    "The model-based estimators are refused above " + DATING_NEURAL_MAX_TAXA + " sequences. The reference silently falls back to OLS at that size (dating.py:2745-2747) and this build will not, because the fallback and the thing you asked for are different answers under one name: re-run with use_model: false to get the OLS answer deliberately, or submit fewer sequences.",

  // --- temporal selection (runtime/src/temporal/codes.js TEMPORAL_REFUSALS) ---
  TEMPORAL_NO_DATES:
    "No sequence that survived loading carries a date. Run hyphaeon_dates on the same alignment to see what the date layer read, and supply dates_file if the headers carry none.",
  TEMPORAL_TOO_FEW_DATED:
    "Temporal surveillance needs at least " + TEMPORAL_MIN_DATED_TAXA + " dated sequences (temporal.py:474). Note that the taxon cap, the duplicate collapse and the tree pruning all run BEFORE this count: hyphaeon_dates reports the dates on the file as submitted, this counts the ones the model kept.",
  TEMPORAL_NO_TIME_SPAN: "The dated sequences that survived loading share one date, so there is no time axis. Sequences sampled at different times are required."
});

/** The refusal codes, as a set, for a membership test that does not care about the hint. */
export const TIME_REFUSAL_CODES = Object.freeze(Object.keys(TIME_REFUSAL_HINTS));

/**
 * The refusal a returned-not-thrown pillar result carries, or null when it succeeded.
 *
 * Both new pillars answer a bad input with `{ok: false, refusal, message}` and never throw, which
 * is the whole reason this function exists: `result = rt.jsonSafe(out)` applied to one of those
 * produces a SUCCESSFUL tool result whose body is `{ok: false, refusal: "DATING_TOO_FEW_DATED",
 * record: null}` with a full provenance block and no isError, and a client reads "the analysis ran"
 * and finds nulls where the numbers should be.
 *
 * @param {object|null} out
 * @returns {{code: string, message: string, data: object}|null}
 */
export function refusalOf(out) {
  if (!out || typeof out !== "object") return null;
  if (out.ok !== false) return null;
  const code = typeof out.refusal === "string" ? out.refusal : "UNKNOWN_REFUSAL";
  const fromWarning = Array.isArray(out.warnings) ? out.warnings.find((w) => w && w.code === code && w.severity === "refuse") : null;
  return {
    code,
    message: out.message || (fromWarning && fromWarning.message) || "The run was refused: " + code + ".",
    data: out.data || (fromWarning && fromWarning.data) || {}
  };
}

/** The hint for a refusal code, or the generic one that still names the right file. */
export function refusalHint(code) {
  return (
    TIME_REFUSAL_HINTS[code] ||
    "Run hyphaeon_dates on the same alignment and metadata: it reports, per sequence, which rule dated it, what did not match and what was imputed, and it loads no model."
  );
}

// ── the date layer ──────────────────────────────────────────────────────────

/** How many of the dates came from the bare-number rule. Ported from dateReview.ts. */
export function bareNumberDates(ingest) {
  return (ingest && ingest.by_rule && ingest.by_rule[BARE_NUMBER_RULE]) || 0;
}

/** Does that rule account for most of what was dated? See decision 1. */
export function bareNumbersDominate(ingest) {
  if (!ingest || !ingest.coverage) return false;
  const bare = bareNumberDates(ingest);
  return bare > 0 && bare >= ingest.coverage.dated * BARE_NUMBER_MAJORITY;
}

/**
 * Run the date layer for a tool call.
 *
 * NOTHING HERE OPENS A FILE. `ingestDates` takes TEXT the caller already read — which is exactly
 * what an MCP argument is, and why one helper serves the review tool and both analyses.
 *
 * @param {object} args
 * @param {string} args.alignment          the alignment TEXT (names are read from it)
 * @param {string} [args.dates_file]       the metadata TEXT (Auspice JSON, JSON map, CSV/TSV)
 * @param {string|null} [args.dates_file_name]
 * @param {object} [args.options]          the tool's date options, in CLI spelling
 * @returns {object} the DateIngest, unchanged
 */
export function ingestFor({ alignment, dates_file = undefined, dates_file_name = null, options = {} }) {
  return ingestDates({
    taxa: taxaForDates(alignment),
    source: typeof dates_file === "string" && dates_file.length ? dates_file : null,
    sourceName: dates_file_name || (dates_file ? "metadata" : null),
    sourceKind: options.date_source_kind || "auto",
    timeUnits: options.time_units ?? null,
    strainCol: options.strain_col ?? null,
    dateCol: options.date_col ?? null,
    delimiter: options.delimiter ?? null,
    dateRegex: options.date_pattern ?? null,
    regexFlags: options.date_pattern_flags ?? "",
    archival1959: options.archival_1959 === true,
    headerFallback: options.header_fallback !== false
  });
}

/** How many per-taxon rows a review returns before it starts sampling. */
export const DATE_ROWS_MAX = 2000;

/**
 * The compact review block every time result carries: what the browser's review stage shows a
 * human, as data.
 *
 * The per-taxon rows are the point — "which of your 100 sequences got a date, and by what rule" is
 * the question the whole layer exists to answer — so they are returned in full up to DATE_ROWS_MAX
 * and, above it, the UNDATED and IMPUTED rows are kept first (the ones a reader must see) with the
 * clean rows sampled after. A sequence is never silently omitted from the counts.
 *
 * @param {object} ingest
 * @param {{rows?: boolean, rowsMax?: number}} [opts]
 */
export function dateReview(ingest, { rows = true, rowsMax = DATE_ROWS_MAX } = {}) {
  const all = Array.isArray(ingest.rows) ? ingest.rows : [];
  const problem = all.filter((r) => !Number.isFinite(r.value) || r.imputed || (r.match_tier && r.match_tier !== "exact"));
  const clean = all.filter((r) => !problem.includes(r));
  const kept = all.length <= rowsMax ? all : [...problem.slice(0, rowsMax), ...clean.slice(0, Math.max(0, rowsMax - problem.length))];
  const out = {
    schema_version: ingest.schema_version,
    ok: ingest.ok,
    time_units: ingest.time_units,
    time_units_source: ingest.time_units_source,
    time_units_evidence: ingest.time_units_evidence,
    source: ingest.source,
    sources_used: ingest.sources_used,
    source_name: ingest.source_name,
    source_kind: ingest.source_kind,
    coverage: ingest.coverage,
    by_rule: ingest.by_rule,
    span: ingest.span,
    match_tier: ingest.match_tier,
    match_tiers: ingest.match_tiers,
    ambiguous: ingest.ambiguous,
    unmatched_metadata: ingest.unmatched_metadata,
    unmatched_taxa: ingest.unmatched_taxa,
    table: ingest.table,
    auspice: ingest.auspice,
    regex: ingest.regex,
    headers: ingest.headers,
    warnings: ingest.warnings
  };
  if (rows) {
    out.rows = kept.map((r) => ({
      taxon: r.taxon,
      raw: r.raw,
      value: Number.isFinite(r.value) ? r.value : null,
      rule: r.rule,
      source: r.source,
      imputed: r.imputed,
      imputations: r.imputations,
      matched_name: r.matched_name,
      match_tier: r.match_tier
    }));
    out.rows_returned = kept.length;
    out.rows_total = all.length;
    if (kept.length < all.length) {
      out.rows_note =
        "Showing " + kept.length + " of " + all.length + " rows: every undated, imputed or fuzzily matched sequence first, then a sample of the clean ones. The coverage block above counts all " + all.length + ".";
    }
  }
  return out;
}

/**
 * The gate the two ANALYSES apply and the review tool only REPORTS. See decisions 1 and 2.
 *
 * @param {object} ingest
 * @param {{accept_bare_numbers?: boolean, drop_undated?: boolean}} [overrides]
 * @returns {{ok: boolean, blocking: Array<{code: string, message: string, hint: string}>,
 *   overrides: {accept_bare_numbers: boolean, drop_undated: boolean}, applied: string[]}}
 */
export function dateGate(ingest, overrides = {}) {
  const acceptBare = overrides.accept_bare_numbers === true;
  const dropUndated = overrides.drop_undated === true;
  const blocking = [];
  const applied = [];
  const c = (ingest && ingest.coverage) || { dated: 0, undated: 0, taxa_total: 0 };

  // The date layer's own refusals come through `ingest.warnings` and are raised by the caller as
  // engine errors; this gate is only the two questions the browser puts to a human.
  if (bareNumbersDominate(ingest)) {
    if (acceptBare) applied.push(DATES_BARE_NUMBER_MAJORITY);
    else
      blocking.push({
        code: DATES_BARE_NUMBER_MAJORITY,
        message:
          bareNumberDates(ingest) + " of the " + c.dated + " dates were read as a bare number in the sequence name (rule `" + BARE_NUMBER_RULE +
          "`), which claims any number it finds — an accession or an isolate index reads as a time coordinate just as well as a generation. The axis these dates produce runs " +
          (ingest.span ? ingest.span.min + " to " + ingest.span.max : "over an unknown range") + " in " + ingest.time_units + ".",
        hint: refusalHint(DATES_BARE_NUMBER_MAJORITY)
      });
  }
  if (c.undated > 0) {
    if (dropUndated) applied.push(DATES_UNDATED_PRESENT);
    else
      blocking.push({
        code: DATES_UNDATED_PRESENT,
        message:
          c.undated + " of " + c.taxa_total + " sequence(s) carry no date and would be dropped from the analysis without being mentioned in its numbers.",
        hint: refusalHint(DATES_UNDATED_PRESENT)
      });
  }
  return { ok: blocking.length === 0, blocking, overrides: { accept_bare_numbers: acceptBare, drop_undated: dropUndated }, applied };
}

/** The one-line summary `hyphaeon_dates` leads with, and the analyses echo. */
export function dateHeadline(ingest) {
  const c = ingest.coverage;
  const rules = Object.entries(ingest.by_rule || {})
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([r, n]) => n + " by " + r)
    .join(", ");
  const span = ingest.span && Number.isFinite(ingest.span.span) ? ingest.span.min + " to " + ingest.span.max + " (" + ingest.time_units + ")" : "no span";
  return (
    c.dated + " of " + c.taxa_total + " sequence(s) dated from " + (ingest.source || "nothing") + " — " + (rules || "no rule matched") + "; " + span +
    (c.imputed ? "; " + c.imputed + " imputed" : "") + ". Units " + ingest.time_units + " (" + ingest.time_units_source + ")."
  );
}

/** Does this date set carry a clock at all — the question the review tool is asked. */
export function clockReadiness(ingest) {
  const c = ingest.coverage;
  const span = ingest.span;
  const reasons = [];
  if (c.dated < DATE_THRESHOLDS.minDatedTaxa) reasons.push("only " + c.dated + " dated sequence(s); " + DATE_THRESHOLDS.minDatedTaxa + " are needed for any clock");
  if (span && span.span === 0) reasons.push("every dated sequence carries the same date, so there is no time axis");
  const dating = reasons.length === 0;
  const temporalReasons = [...reasons];
  if (c.dated < TEMPORAL_MIN_DATED_TAXA)
    temporalReasons.push(
      "temporal surveillance needs at least " + TEMPORAL_MIN_DATED_TAXA +
        " dated sequences (temporal.py:474), and the taxon cap, duplicate collapse and tree pruning all run before that count"
    );
  return {
    has_clock: dating,
    dating_possible: dating,
    temporal_possible: temporalReasons.length === 0,
    reasons: reasons,
    temporal_reasons: temporalReasons
  };
}

// ── dating: the reproduction line, and which fit a surface may quote ────────

/**
 * `datingReferenceCommand` AND `datingHeadline` ARE THE RUNTIME'S, NOT THIS FILE'S.
 *
 * Decision 5 (see the header) explains why this pillar's `reference_command` is an object rather
 * than the argv array the other six stamp. It also recorded that the implementation was HERE only
 * because the runtime had none and phase 6's MCP brief excluded `runtime/src/`, and flagged it for
 * the move. Phase 6's review moved it: `runtime/src/dating/results.js` now exports
 * `datingReferenceCommand` under the same four-argument signature, and this file's copy is gone
 * rather than kept beside it.
 *
 * IT HAD ALREADY DIVERGED, which is the argument for deleting a duplicate rather than syncing one.
 * The runtime's version emits two caveats this one never learned, both of them about the date the
 * caller is shown:
 *
 *   - WHEN THIS APPLICATION DOES NOT QUOTE THE REFERENCE'S OWN `t_mrca`. `out.json`'s top-level
 *     `t_mrca` is `active_model`'s, and `datingHeadline` refuses to headline a fit whose `ci_mrca`
 *     is a point estimate `[x, x]` — which every spline fit is, because the spline's bootstrap
 *     never runs upstream (numpy's `rcond=` passed to scipy's `lstsq`, whose keyword is `cond=`,
 *     dating.py:1912). A reader diffing `out.json` against what this tool told them would otherwise
 *     find two different dates from one run and nothing saying which is which.
 *   - WHEN THE CLOCK HAS NO SIGNAL AT ALL (`ols.p_value >= 0.05`). The date is still reported —
 *     the reference prints it and refusing would be a divergence — with its refutation attached.
 *
 * Both of those are ALSO why `datingSummary` and `datingHonesty` below carry a `headline` block:
 * a client that reads `summary.t_mrca` and prints it is doing what the browser's `/time` route
 * deliberately does not, and until this review the MCP gave it no way to know that.
 */
export { datingHeadline, datingReferenceCommand };

/**
 * `datingHeadline` projected for the wire: the model OBJECT it returns is already in the record
 * under its own key, so only the choice and the sentences cross.
 *
 * @param {object} record
 */
function datingHeadlineBlock(record) {
  const head = datingHeadline(record);
  if (!head) return null;
  return {
    key: head.key,
    active_model: head.activeKey,
    departed: head.departed,
    quotable: head.quotable,
    t_mrca: head.model ? head.model.t_mrca ?? null : null,
    ci_mrca: head.model ? head.model.ci_mrca ?? null : null,
    refutation: head.refutation,
    clock_signal: head.signal
  };
}

/** The honesty block every dating result carries beside its numbers. */
export function datingHonesty(run, options = {}, names = {}, ingest = null) {
  const record = (run && run.record) || {};
  return {
    distance_mode: run.distanceMode ?? record.distance_mode ?? null,
    distance_mode_reason: run.distanceModeReason ?? null,
    model_pass: Boolean(run.pgls),
    estimators_not_built: (record.primaeon && record.primaeon.estimators_not_built) || [],
    // WHICH DATE THIS RESULT MAY BE QUOTED ON. `record.t_mrca` is `active_model`'s and is NOT
    // always the one to print — see the block above `datingReferenceCommand`'s re-export. Same
    // rule, same function and same words as the `/time` page's `headlineOf`.
    headline: datingHeadlineBlock(record),
    reference_command: datingReferenceCommand(run, options, names, ingest),
    note:
      "`t_mrca` moves with `distance_mode`: on the same sequences and the same dates the model-free (tn93) and " +
      "model-based (latent) estimators are different answers, measured twelve years apart on the korber example " +
      "(1938.77 against 1926.81). Quote the mode with the date, never the date alone."
  };
}

/** The numbers a reader needs from a dating record before pulling the per-taxon table. */
export function datingSummary(run) {
  const record = (run && run.record) || {};
  const rows = Array.isArray(run && run.rows) ? run.rows : [];
  const outliers = rows.filter((r) => r && r.is_outlier).length;
  return {
    alignment: record.alignment,
    taxa_count: record.taxa_count,
    dated: rows.length,
    timespan: record.timespan,
    distance_mode: record.distance_mode,
    active_model: record.active_model,
    clock_model: record.clock_model,
    selected_clock: record.selected_clock,
    ci_method: record.ci_method,
    t_mrca: record.t_mrca,
    ci_mrca: record.ci_mrca,
    // THE TWO RAW KEYS ABOVE ARE THE RECORD'S, AND `headline` SAYS WHETHER TO PRINT THEM. They stay
    // where they were — a summary that hid `active_model`'s own numbers would be a second kind of
    // dishonesty — but a client that prints `summary.t_mrca` flat is doing what the browser refuses
    // to do on two kinds of fit. `summary_only` keeps this block for the same reason it keeps `ok`.
    headline: datingHeadlineBlock(record),
    mu: record.mu,
    root_description: record.root_description,
    latent_root: record.latent_root,
    ols: record.ols,
    pgls: record.pgls,
    spline: record.spline,
    ensemble: record.ensemble,
    taxa_summary_rows: rows.length,
    outliers,
    // The rows a reader looks at first: flagged, then held out, then |z| descending, then by name
    // — the runtime's own `rankTaxonRows` order, applied to a COPY, because the table itself stays
    // in alignment order so a download diffs against a CLI run.
    top_outliers: [...rows]
      .sort(
        (a, b) =>
          Number(b.is_outlier) - Number(a.is_outlier) ||
          Number(b.is_holdout) - Number(a.is_holdout) ||
          (Number.isFinite(b.z_score) ? Math.abs(b.z_score) : -Infinity) - (Number.isFinite(a.z_score) ? Math.abs(a.z_score) : -Infinity) ||
          String(a.taxon).localeCompare(String(b.taxon))
      )
      .slice(0, 10)
      .map((r) => ({
        taxon: r.taxon,
        sampling_date: r.sampling_date,
        predicted_date: r.predicted_date,
        temporal_residual: r.temporal_residual,
        z_score: r.z_score,
        is_outlier: r.is_outlier,
        is_holdout: r.is_holdout,
        prediction_method: r.prediction_method
      })),
    elapsed_seconds: record.elapsed_seconds,
    warnings: Array.isArray(run && run.warnings) ? run.warnings.map((w) => w.code + "/" + w.severity) : []
  };
}

// ── temporal: the null's four states, and the record's sections ─────────────

/**
 * `permutations.tested && stage is neither complete nor stopped` — draws are arriving and nothing
 * downstream of them exists yet. Ported from web/src/lib/time/temporal.ts `nullInFlight`.
 */
export function nullInFlight(record) {
  const tested = Boolean(record && record.permutations && record.permutations.tested);
  return tested && record.stage !== "complete" && record.stage !== "stopped";
}

/** Whether the call columns, the sweep counts and the wave modes on this record are final. */
export function callsAreFinal(record) {
  return Boolean(record && record.permutations && record.permutations.tested) && record.stage === "complete";
}

/**
 * THE NULL HAS FOUR STATES, NOT THREE. Ported from `web/src/lib/time/temporal.ts` `nullState`:
 *
 *   not-started  no shuffle drawn and the run may still reach one
 *   running      draws arriving; nothing downstream of them exists yet
 *   finished     the record is complete and its calls, counts and wave modes are final — INCLUDING
 *                a run stopped by the caller that kept at least one draw, because the runtime
 *                catches its own abort, classifies at the achieved count and returns a complete
 *                record, so those labels are results and not a half-answer
 *   stopped      the null ended and produced nothing usable (declined over budget, stopped before
 *                a draw finished). Saying "has not finished" here is false: nothing is coming.
 */
export function nullStateOf(record) {
  const perm = record && record.permutations;
  if (record && record.stage === "stopped") return "stopped";
  if (!perm) return "not-started";
  if (perm.skipped) return "stopped";
  if (nullInFlight(record)) return "running";
  if (record.stage !== "complete") return "not-started";
  if (perm.tested) return "finished";
  return perm.cancelled ? "stopped" : "not-started";
}

/** Why nothing is called, as a clause a client drops into "..., because <clause>". */
export function uncalledBecause(record) {
  const state = nullStateOf(record);
  if (state === "finished") return null;
  if (state === "running") return "the date-shuffling null has not finished";
  if (state === "not-started") return "the date-shuffling null has not been drawn";
  const perm = record && record.permutations;
  if (record && record.stage === "stopped") {
    // TWO STOPS, NOT ONE: between the scored payload and the first chunk there is a window in
    // which the record carries NO permutation block at all, and telling that reader the null "was
    // being drawn" names a thing that had not started.
    return perm && perm.completed > 0
      ? "this run was stopped while the null was being drawn, and the calls are computed only at the end"
      : "this run was stopped before the null drew a single shuffle, and the calls are computed only at the end";
  }
  if (perm && perm.skipped) return "the date-shuffling null was declined before it started, as over the work budget";
  return "the date-shuffling null was stopped before a single shuffle was drawn";
}

/**
 * Whether the wave loadings and R2 on this record are still the interim ZEROS rather than numbers.
 * `runtime/src/temporal/record.js` fills both with zero arrays until the decomposition runs, and
 * the decomposition runs once, at the end — so mid-null a hard 0 is indistinguishable from a
 * measured 0.
 */
export function waveColumnsPending(record) {
  return record != null && record.waves == null && record.stage !== "complete";
}

/**
 * A STOPPED RUN IS AN ANSWER AT A SMALLER B, AND MUST SAY WHICH. Decision 7 keeps the record a
 * cancelled run resolved with; this is the sentence that keeps it from reading as a full one.
 * Null when the null drew everything it was asked for (or never drew at all — `uncalled_because`
 * covers that case, and a run with no draws has no achieved count to report).
 *
 * `completed` is the count `p_perm` and `q_perm` were actually estimated at: the runtime's
 * `nullPayload` computes them from the ACHIEVED draws, never the requested ones, and per-draw
 * substreams make the numbers bit-identical to a run configured at that B — which is the reason a
 * stopped run is worth keeping rather than a claim about it.
 *
 * @param {object} record the JSON-safe TemporalRecord
 * @returns {{completed: number, requested: number, grid_step: number|null, q_rank1_bound: number|null, note: string}|null}
 */
export function temporalPartialNote(record) {
  const perm = record && record.permutations;
  if (!perm || !perm.cancelled || !(perm.completed > 0)) return null;
  return {
    completed: perm.completed,
    requested: perm.requested,
    grid_step: Number.isFinite(perm.grid_step) ? perm.grid_step : null,
    q_rank1_bound: Number.isFinite(perm.q_rank1_bound) ? perm.q_rank1_bound : null,
    note:
      "THIS RUN WAS STOPPED: the date-shuffling null drew " + perm.completed + " of the " + perm.requested +
      " shuffles it was asked for, and every call, sweep count and wave mode on this record was computed at " +
      perm.completed + ". They are results, not a half-answer — the runtime classifies at the achieved count and " +
      "per-draw substreams make this bit-identical to a run configured at -B " + perm.completed + " — but they are " +
      "results at a COARSER GRID: `p_perm` cannot be finer than 1/(" + perm.completed + " + 1)" +
      (Number.isFinite(perm.grid_step) ? " = " + Number(perm.grid_step).toPrecision(3) : "") +
      ", and `q_perm` has a floor no candidate can reach below it. Quote the achieved count with the counts, never " +
      "the requested one (TEMPORAL_NULL_TRUNCATED is in `warnings` for the same reason)."
  };
}

/**
 * WHICH ROWS CARRY A MEASURED `p_perm`, for this surface.
 *
 * THE CLAIM THIS REPLACES was written here and was half true in a way that invited a false reading:
 * "a CANDIDATE whose null did not run carries NaN, never 1.0, so `not tested` and `not a sweep`
 * stay distinguishable". The literal half is true — `spreadPerm` does write NaN — but the reading
 * it invites, that a 1.0 means untested, is false, and it was the SAME honesty block that disproved
 * it: `download_notes` carries `temporalPPermNote`, whose MEASURED counter-example is H5N1 at
 * B = 200, where 399 of 566 rows read exactly 1.0 against 398 non-candidates, the extra row being a
 * tested candidate that every one of the 200 shuffles beat and so scored (1 + 200) / 201 = 1.0. Two
 * fields of one object said opposite things.
 *
 * So the note is the RUNTIME's now (`temporalPPermNote`, runtime/src/temporal/results.js), and what
 * is added here is the only part that is about this surface: which call serves the mask, and the
 * one place the port really does depart from the reference's fill — a null that was DECLINED or
 * STOPPED leaves NaN at a candidate it never reached, which JSON writes as `null`. Upstream that
 * case cannot arise, because B always completes.
 *
 * The fallback sentence exists for the same reason `optional()` does in engine.js: a runtime
 * checkout older than this MCP must still answer something true rather than throw inside a result.
 *
 * @param {object} record
 * @param {{temporalPPermNote?: Function}} rt
 */
function pPermFill(record, rt) {
  const untested = Math.max(0, (record.codons_total || 0) - (record.stage1_candidates || 0));
  const base =
    typeof rt.temporalPPermNote === "function"
      ? rt.temporalPPermNote(record)
      : "`p_perm` and `q_perm` are 1.0 at the " + untested + " codon(s) that never reached stage two, which is the " +
        "reference's own fill (temporal.py:620-621), reproduced so the files diff clean, and is not a measurement. " +
        "THE COLUMN THAT TELLS THE TWO APART IS `classification`, not `p_perm`: `INVARIABLE` and `FLAT_NO_SIGNAL` " +
        "are codons the null never tested, `TEMPORAL_NOISE` and `CONFIRMED_SWEEP` are candidates it did. A 1.0 does " +
        "NOT mean untested — a tested candidate that every shuffle beat scores (1 + B) / (B + 1) = 1.0 exactly.";
  return (
    base +
    " ON THIS SURFACE the mask is `get_results section=candidates`, which lists the " + (record.stage1_candidates || 0) +
    " 1-indexed codon(s) stage one passed; `section=sites` carries `classification` on every row it returns. And one " +
    "case the reference cannot reach: where the null was DECLINED over the work budget or STOPPED early, a candidate " +
    "it never got to carries NaN — JSON `null`, not 1.0 and not 0 — so an unfinished null stays distinguishable from " +
    "a finished one."
  );
}

/**
 * The honesty block every temporal result and every temporal section carries. Decisions 7 and 8.
 *
 * @param {object} record the TemporalRecord (JSON-safe)
 * @param {{temporalReferenceCommand?: Function, temporalDownloadNotes?: Function,
 *   temporalPPermNote?: Function}} rt
 */
export function temporalHonesty(record, rt = {}) {
  const state = nullStateOf(record);
  const perm = record.permutations || null;
  const out = {
    stage: record.stage,
    null_state: state,
    calls_are_final: callsAreFinal(record),
    uncalled_because: uncalledBecause(record),
    wave_columns_pending: waveColumnsPending(record),
    // A run stopped mid-null is `finished` on purpose (the calls at the achieved count ARE the
    // answer, decision 7) — which is exactly why the count has to travel beside the word. Null on
    // every run that drew what it was asked for.
    null_truncated: temporalPartialNote(record),
    permutations: perm,
    p_perm_fill: pPermFill(record, rt),
    escape_hatch_used: record.escape_hatch_used,
    solitary_regime: record.solitary_regime,
    gate_vacuous: record.gate_vacuous
  };
  if (record.escape_hatch_used) {
    out.escape_hatch_note =
      "Nothing cleared confirmation, so the reference's own fallback selected candidates at `p_perm <= 0.10 OR static LRT >= 3.84` " +
      "(temporal.py:692-693) and records that fact in no output file. A run that confirmed nothing and one that confirmed thirty " +
      "through this hatch look identical in `_sites_summary.csv`; this flag is the only place the difference is visible.";
  }
  out.wave_variance = record.waves
    ? {
        shares_pct: record.fpca_wave_variance_pct,
        source: record.waves.source,
        sign: record.waves.sign,
        conditioned_on:
          record.waves.source === "confirmed-sweeps"
            ? "the confirmed-sweep set, which is thresholded on the permutation p"
            : "the strongest candidates by peak intensity, read off the trajectories BEFORE the null was drawn",
        note:
          "The fPCA decomposition runs over " +
          (record.waves.source === "confirmed-sweeps"
            ? "the confirmed sweeps, so these shares MOVE WITH THE NULL: the arithmetic is identical to the reference's and the answer still differs, because a different generator confirms a different set. Measured upstream on H1N1 at B = 100: 32 confirmed here against 18 there, shares 33.84/28.26/17.81/11.11 % against 39.67/32.37/13.92/9.31 — 5.8 points on the leading mode. Compare shapes and ordering, not digits."
            : "fewer than four confirmed codons, so it fell back to the strongest candidates by peak intensity (`TEMPORAL_WAVES_FALLBACK_SET`). Those shares are NOT thresholded on p — but the null still decided WHICH BRANCH was taken, and a run that had confirmed four would decompose a different matrix entirely.") +
          " Wave signs follow this build's `" + record.waves.sign + "` convention (D28); the reference has none and writes its solver's raw signs, so a mode and its negative are the same mode."
      }
    : {
        shares_pct: record.fpca_wave_variance_pct,
        source: null,
        conditioned_on: null,
        note: "The decomposition has not run on this record: the wave loadings and R2 columns are interim ZERO arrays, not measured zeros."
      };
  if (typeof rt.temporalReferenceCommand === "function") out.reference_command = rt.temporalReferenceCommand(record);
  if (typeof rt.temporalDownloadNotes === "function") out.download_notes = rt.temporalDownloadNotes(record);
  return out;
}

/** The eighteen reference summary keys plus this build's own, for `summary_only` and the job reply. */
export function temporalSummary(record) {
  if (!record || typeof record !== "object") return {};
  return {
    analysis: "temporal",
    stage: record.stage,
    alignment: record.alignment,
    tree: record.tree,
    taxa_total: record.taxa_total,
    taxa_timestamped: record.taxa_timestamped,
    codons_total: record.codons_total,
    codons_variable: record.codons_variable,
    codons_invariable: record.codons_invariable,
    timespan_years: record.timespan_years,
    t_min: record.t_min,
    t_max: record.t_max,
    bandwidth_years: record.bandwidth_years,
    sig_static_q10: record.sig_static_q10,
    stage1_candidates: record.stage1_candidates,
    confirmed_sweeps: record.confirmed_sweeps,
    concordant_sweeps: record.concordant_sweeps,
    rescued_sweeps: record.rescued_sweeps,
    filtered_static_noise: record.filtered_static_noise,
    fpca_wave_variance_pct: record.fpca_wave_variance_pct,
    runtime_sec: record.runtime_sec,
    regime: record.regime,
    grid: record.grid,
    floors: record.floors,
    root: record.root,
    dates: record.dates ? { file: record.dates.file, dated: record.dates.dated, undated: record.dates.undated, source: record.dates.source, by_rule: record.dates.by_rule, beyond_reference: record.dates.beyond_reference, span: record.dates.span } : null,
    candidates: Array.isArray(record.candidates) ? record.candidates.length : 0,
    warnings: Array.isArray(record.warnings) ? record.warnings.map((w) => w.code + "/" + w.severity) : [],
    primaeon: record.primaeon
  };
}

/**
 * The section vocabulary `get_results section=` serves for a temporal job. See decision 6: the
 * record is never inline, so this list is how a caller reaches any of it.
 */
export const TEMPORAL_SECTIONS = Object.freeze([
  "summary",
  "sites",
  "curves",
  "waves",
  "permutations",
  "dates",
  "candidates",
  "warnings",
  "honesty",
  "provenance"
]);

/**
 * The `curves` section's budget, in NUMBERS rather than in codons, because the record's time grid
 * is a caller option (`--time-points`, 2 to 2000) and a fixed codon count bounds nothing.
 *
 * RE-MEASURED AT PHASE 6 REVIEW, AND THE OLD FIGURE WAS 17 % LOW. The constant used to record
 * "15.3 bytes at T = 60 and 15.2 at T = 250 — stable", taken from two curves. Measured again
 * through the running tool on H5N1_HA_geo (566 codons, 168 candidates, general.onnx at 4 threads),
 * this time over every curve the section actually serves rather than a sample of two:
 *
 *   T     curves   section     fixed head   bytes per number: min / median / max / mean
 *   60    83       196,582 B   13,212 B     13.70 / 18.66 / 22.64 / 18.41
 *   120   41       184,458 B   not split    section total 18.75; 18.44 marginal over 20 curves
 *   250   20       183,026 B   16,683 B     13.52 / 16.29 / 19.85 / 16.63
 *
 * A curve is a run of JSON doubles and its width is the width of ITS OWN numbers: an invariable
 * codon writes `0,` (two characters) and a real trajectory writes `0.00019534273816851262`
 * (22), so a per-curve figure from one or two codons is a sample of a 13.5-to-22.6 distribution,
 * not a constant. That is the same mistake the earlier note caught itself making with codon 1 and
 * then made again with a sample of two: the honest number here is the WORST per-number cost, 22.7,
 * because the caller chooses which codons the section is about.
 *
 * THE BUDGET FOLLOWS FROM THE WORST CASE, not the mean. The envelope is ANALYZE_INLINE_MAX_BYTES
 * (262,144) and the section carries a fixed head — the selection sentence, the truncation note,
 * the shared time axis and the honesty block with its reproduction command, five download notes
 * and (since this review) the truncated-null block — measured at 13.2-16.7 KB before that block
 * and 15.2-18.7 KB after it, and budgeted at 20 KB. 9,000 x 22.7 + 20,480 = 224,780 B, 86 % of the
 * envelope; the old 10,000 left 7 % of margin against the same worst case, and the head growing by
 * 2 KB in this very review is what that margin would have been spent on.
 * MEASURED after the change, through test/temporal.test.js's own size logs: the widest `curves`
 * section this example produces is 179,193-179,225 B at T = 60 (75 curves) and 168,550-168,812 B
 * at T = 250 (18 curves), and no other section of either run is bigger. The test re-derives the
 * bound on every run, so a wider number or a fatter head fails rather than overflows.
 *
 * That is 75 codons at T = 60 and 18 at T = 250. The WHOLE store is 1,988,099 bytes on this
 * 566-codon example and 6.37 MB on the engine's 4,384-codon acceptance run, which is why it is
 * never served whole at any T.
 */
export const TEMPORAL_CURVES_MAX_POINTS = 9000;

/** How many codons one `curves` call can carry at this record's grid. */
export function temporalCurvesMaxSites(T) {
  return Math.max(1, Math.floor(TEMPORAL_CURVES_MAX_POINTS / (2 * Math.max(1, T))));
}

/**
 * How many site rows one `section: "sites"` call returns by default. MEASURED through the running
 * tool on the same example: a row is 780-783 bytes at both grids (the row holds no time series),
 * so 300 rows is about 235 KB and, with the honesty block, inside the same 262,144-byte envelope.
 */
export const TEMPORAL_SITES_MAX_ROWS = 300;

/**
 * One section of a TemporalRecord, as a tool result body.
 *
 * @param {object} record the JSON-safe TemporalRecord
 * @param {string} name one of TEMPORAL_SECTIONS
 * @param {object} args `{sites, top, summary_only, fields}` from the tool call
 * @param {object} rt the runtime bag (`siteRow`, `candidateSiteIndices`, ...)
 */
export function temporalSection(record, name, args = {}, rt = {}) {
  const honesty = temporalHonesty(record, rt);
  const head = { analysis: "temporal", section: name, stage: record.stage, honesty };
  // `sites` NAMES CODONS, and only two sections are about codons. Passed to any other one it does
  // nothing, and doing nothing in silence is how a caller comes to believe a whole-record answer
  // was the three codons it asked about (the same defect get_results refuses `sites` for on a
  // non-temporal job).
  if (Array.isArray(args.sites) && args.sites.length && name !== "sites" && name !== "curves") {
    head.ignored = {
      sites: "`sites` selects codons and section `" + name + "` is not a per-codon view, so it was not applied. The sections that take it are `sites` and `curves`."
    };
  }

  if (name === "summary") return Object.assign(head, { summary: temporalSummary(record) });
  if (name === "permutations") return Object.assign(head, { permutations: record.permutations, null_state: honesty.null_state });
  if (name === "dates") return Object.assign(head, { dates: record.dates });
  if (name === "candidates") return Object.assign(head, { candidates: record.candidates, stage1_candidates: record.stage1_candidates });
  if (name === "warnings") return Object.assign(head, { warnings: record.warnings });
  if (name === "provenance") return Object.assign(head, { primaeon: record.primaeon, regime: record.regime, grid: record.grid, floors: record.floors, root: record.root });
  if (name === "waves") {
    return Object.assign(head, {
      waves: record.waves,
      fpca_wave_variance_pct: record.fpca_wave_variance_pct,
      wave_variance: honesty.wave_variance,
      wave_columns_pending: honesty.wave_columns_pending
    });
  }

  if (name === "sites") {
    const wanted = siteSelection(record, args, rt);
    const rows = wanted.indices.map((s) => rt.siteRow(record, s));
    const capped = args.top !== undefined ? rows.slice(0, args.top) : rows.slice(0, TEMPORAL_SITES_MAX_ROWS);
    const out = Object.assign(head, {
      rows: capped,
      rows_returned: capped.length,
      rows_available: wanted.indices.length,
      codons_total: record.codons_total,
      selection: wanted.how
    });
    if (capped.length < wanted.indices.length) {
      out.truncated = {
        rows: { returned: capped.length, total: wanted.indices.length, ranked_by: wanted.rankedBy },
        note: "Pass `sites` to name the codons you want, or `top` to raise the cap (the default is " + TEMPORAL_SITES_MAX_ROWS + ")."
      };
    }
    return out;
  }

  if (name === "curves") {
    const wanted = siteSelection(record, args, rt);
    const T = record.curves.T;
    const maxSites = temporalCurvesMaxSites(T);
    const indices = wanted.indices.slice(0, maxSites);
    const out = Object.assign(head, {
      time: record.curves.time,
      time_points: T,
      curves: indices.map((s) => ({
        site: s + 1,
        prevalence: record.curves.prevalence.slice(s * T, s * T + T),
        velocity: record.curves.velocity.slice(s * T, s * T + T)
      })),
      curves_returned: indices.length,
      curves_available: wanted.indices.length,
      selection: wanted.how,
      duplicate_column_note:
        "`velocity` is the sweep metric. The reference's `_curves.csv` writes it into TWO differently named columns, " +
        "`selection_intensity` and `sweep_velocity`, from the same array (temporal.py:807-808) — an upstream bug " +
        "replicated in the CSV writers so the files diff clean. There is one quantity here, not two."
    });
    if (indices.length < wanted.indices.length) {
      out.truncated = {
        curves: { returned: indices.length, total: wanted.indices.length, ranked_by: wanted.rankedBy },
        note:
          "The whole [codons x time] store is megabytes (measured: 1.99 MB on this example's 566 codons, 6.37 MB on a " +
          "4,384-codon run), so this section is budgeted in NUMBERS rather than codons — " + TEMPORAL_CURVES_MAX_POINTS +
          " of them, which at this run's " + T + " time points is " + maxSites + " codon(s) per call. Pass `sites` to name the ones you want."
      };
    }
    return out;
  }

  return Object.assign(head, {
    available: false,
    note: "Unknown section. Temporal sections are: " + TEMPORAL_SECTIONS.join(", ") + "."
  });
}

/**
 * Which codons a `sites` / `curves` call is about: the caller's list, else the candidates ranked by
 * peak intensity, else every codon.
 *
 * THE DEFAULT IS THE CANDIDATE SET, NOT EVERY CODON, and that is the honest default rather than a
 * convenience: `p_perm` is the reference's assumed 1.0 at every non-candidate (see
 * `temporalHonesty().p_perm_fill`), so a default view of all L codons hands back thousands of rows
 * whose two permutation columns were never measured.
 */
function siteSelection(record, args, rt) {
  const L = record.codons_total;
  if (Array.isArray(args.sites) && args.sites.length) {
    const bad = args.sites.filter((s) => !Number.isInteger(s) || s < 1 || s > L);
    if (bad.length) {
      const err = new Error("sites: " + bad.length + " codon(s) out of range 1.." + L + " (" + bad.slice(0, 5).join(", ") + (bad.length > 5 ? ", ..." : "") + ").");
      err.name = "TemporalSiteRangeError";
      throw err;
    }
    return { indices: args.sites.map((s) => s - 1), how: "the codons you named", rankedBy: "input order" };
  }
  // `candidateSiteIndices` returns the candidates in CODON ORDER, not in rank order, so the
  // ranking is applied here — otherwise a truncated view would keep the first 128 codons of the
  // gene rather than the 128 strongest, and `ranked_by` would be a false label.
  const cand = typeof rt.candidateSiteIndices === "function" ? Array.from(rt.candidateSiteIndices(record)) : Array.from(record.candidates || [], (s) => s - 1);
  if (cand.length) {
    const intensity = record.sites && record.sites.peak_intensity;
    const ranked = intensity ? [...cand].sort((a, b) => (intensity[b] ?? -Infinity) - (intensity[a] ?? -Infinity) || a - b) : cand;
    return {
      indices: ranked,
      how:
        "the " + cand.length + " stage-one candidate codon(s), strongest peak intensity first (pass `sites` to name others; " +
        "`p_perm` at a NON-candidate is the reference's assumed 1.0, not a measurement)",
      rankedBy: intensity ? "peak_intensity" : "site"
    };
  }
  return { indices: Array.from({ length: L }, (_, i) => i), how: "every codon (this run produced no stage-one candidate)", rankedBy: "site" };
}
