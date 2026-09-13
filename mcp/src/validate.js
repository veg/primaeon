/**
 * validate.js — hyphaeon_validate: the library's "Before you run" diagnostics plus this
 * server's caps.
 *
 * WHY THIS FILE EXISTS
 *
 * PLAN.md 4.3 and 2 (hard truth 4) want ONE implementation of the pre-flight checks, run before
 * the model on every surface, producing the same `warnings[]` codes. Phase 1a put that
 * implementation in the library: `diagnose()` in veg/HyphAeon js/src/diagnostics.js — 23 codes,
 * thresholds with their sources in that file's header, built on the dataset.py mirror so the
 * numbers it reports are the numbers the model is then given (taxa after matching and haplotype
 * collapse, the rescaled patristic distances, the unknown-codon fraction of the tokens). Phase 0's
 * hand-written parsers and tree statistics that lived here are gone; what remains is what only
 * this server knows:
 *
 *   - the size caps and the sync/job decision (src/caps.js): CAPS_EXCEEDED (refuse) and RUN_MODE
 *     (info) are APP codes, not library ones, and say so in CODES;
 *   - the cost line, which is honest about the engine that would run (always in-process now).
 *
 * D22 CHANGED THE TREE VOCABULARY. `TREE_MISSING` (refuse) and `BRANCH_LENGTHS_MISSING` (warn) do
 * not exist any more: a missing tree and a tree without usable branch lengths both take the
 * library's tree-free path (pairwise TN93 distances straight into the MDS, `dataset.py:493-571`
 * and `598-636`) and are reported as `TREE_FREE_TN93` at INFO level with the reason, beside
 * `TN93_SATURATED_PAIRS` when a pair came back at the saturation sentinel. Nothing in this file
 * asks whether the process can estimate branch lengths any more, because nothing estimates them:
 * HyPhy is gone from the product (PLAN.md D22, phase 3). `use_tn93` / `no_tree` is still accepted
 * and now forces the tree-free path even when a usable tree WAS supplied, which is exactly what
 * the reference's `--use-tn93` does.
 *
 * The library's `summary` is camelCase and model-level; the tool's `summary` is snake_case and
 * adds the app fields (work, mode, estimated_seconds, engine). Both `warnings[]` keep the
 * library's `{code, severity, message, data}` shape. Severity is info | warn | refuse; `ok` is
 * false when anything refuses.
 *
 * PHASE 6: VALIDATE READS THE DATES TOO, FOR THE THREE ANALYSES THAT HAVE THEM. It used not to,
 * and the consequence was measured: `hyphaeon_validate {analysis: "temporal"}` on Smc6.fasta — a
 * file with no date anywhere, in a header or otherwise — answered `ok: true` with
 * `summary.mode: "job"` and `estimated_seconds: 2.12`, and then `hyphaeon_temporal` refused the
 * same bytes with DATES_NONE. Validate is the call a client makes precisely so that does not
 * happen, so for `dates`, `dating` and `temporal` it now runs the SAME three checks the analysis
 * dispatcher runs, in the same order and from the same functions (src/time.js `ingestFor`,
 * `dateGate`, `clockReadiness`): the date layer's own refusals, this surface's two override gates,
 * and whether the dated set carries a clock at all. One difference, and it is the review tool's
 * whole purpose: the two OVERRIDE gates are reported at `refuse` for `dating` / `temporal` and at
 * `info` for `dates`, because reporting which sequences are undated is what that tool is for.
 *
 * The date arguments are the same keys the analyses take, so a client can validate with the exact
 * arguments it is about to run with. Nothing here loads a graph — `@veg/hyphaeon-runtime/dates`
 * imports no session and no onnxruntime — and the check stays the cheap one it was: MEASURED
 * warm through `diagnose` on the bundled examples, the date half adds 0 to 72 ms to a call whose
 * alignment diagnostics already cost 41 ms (Smc6) to 951 ms (H1N1).
 *
 * This module has no I/O and no SDK import. It calls pure library functions on strings.
 */

import {
  diagnose as libraryDiagnose,
  DIAGNOSTIC_CODES,
  DIAGNOSTIC_THRESHOLDS,
  sniffAlignmentFormat,
  parseAlignmentSequences,
  extractTree
} from "@veg/hyphaeon-js";
import {
  DATE_THRESHOLDS,
  bareNumberDates,
  clockReadiness,
  dateGate,
  dateHeadline,
  ingestFor,
  refusalHint,
  TEMPORAL_MIN_DATED_TAXA
} from "./time.js";
import {
  MAX_TAXA,
  TAXON_CAP,
  NATIVE_ANALYSES,
  classifyRun,
  estimateSeconds,
  probeSequences,
  workFor
} from "./caps.js";

/**
 * Every analysis runs in-process (runtime/ over onnxruntime-node: meme, busted, epistasis, dms,
 * phenotype, evaluate, and the whole-report `analyze`). One list, in src/caps.js, shared with
 * src/engine.js and src/tools.js.
 */
export { NATIVE_ANALYSES };

/**
 * Every code hyphaeon_validate can emit: the library's DIAGNOSTIC_CODES (descriptions here are
 * summaries; the thresholds and sources are in js/src/diagnostics.js) plus the two app codes.
 * Kept as an object so the hyphaeon://methods/requirements resource can publish the list.
 */
const LIBRARY_DESCRIPTIONS = {
  FORMAT_UNKNOWN: "No sequences could be parsed; FASTA, PHYLIP and NEXUS are read",
  ALPHABET_U_TO_T: "U characters read as T (RNA alphabet)",
  NON_ACGT_FRACTION: "Fraction of characters that are not A/C/G/T; refuse when it does not look like nucleotides",
  LENGTH_NOT_MULTIPLE_OF_3: "A sequence length is not divisible by 3; trailing bases are trimmed",
  IN_FRAME_STOPS: "Internal stop codons; refuse above 1% of internal codons",
  FRAMESHIFT_SUSPECTED: "Frame-0 internal stops exceed the other frames in some sequences",
  UNKNOWN_CODON_FRACTION: "More than 5% of codons are gaps, ambiguous or unrecognised (dataset.py:706-709)",
  UNEQUAL_LENGTHS: "Sequences differ in length; the site count comes from the first matched taxon",
  DUPLICATE_SEQUENCES: "Identical sequences collapsed to one haplotype each",
  TOO_FEW_TAXA: "Fewer than 3 usable taxa (issue #7)",
  TAXA_OVER_CAP: "More unique taxa than the model cap; Faith's-PD subsampling applies",
  TAXA_OVER_LIMIT: "More than 1,000 taxa; refused",
  TREE_UNPARSEABLE: "The tree TEXT could not be parsed as Newick or a NEXUS TREE block (a bad tree, not a missing one)",
  TREE_FREE_TN93:
    "[D22] Tree-free mode: no tree, no usable branch lengths, or use_tn93 — pairwise TN93 distances feed the MDS " +
    "directly and every alignment sequence is kept, in alignment order (data.reason says which)",
  TAXA_NOT_IN_TREE: "Alignment sequences with no tree tip, or matched only by case/quote folding (issue #9)",
  TIPS_NOT_IN_ALIGNMENT: "Tree tips with no sequence of that name",
  NEGATIVE_BRANCH_LENGTHS: "Negative branch lengths raised to 1e-4 (dataset.py:289-300)",
  DISTANCE_RESCALED: "Maximum patristic distance above 10; distances divided by the codon count (dataset.py:678-681)",
  TN93_SATURATED_PAIRS: "[D22] Taxon pairs at the TN93 saturation sentinel, or a distance matrix that could not be computed",
  SHALLOW_TREE: "Median pairwise distance below 0.05: the viral variant's regime",
  DEEP_LARGE_TREE: "Deep tree with 100 or more taxa: elevated false-positive regime",
  STAR_LIKE: "Fewer than 5 haplotypes or mean pairwise divergence below 0.005 (issue #33)",
  COST_ESTIMATE: "Codons x taxa_used^2 work and the reference-path seconds it implies"
};

/**
 * The date layer's own codes (runtime/src/dates/codes.js DATE_DIAGNOSTIC_CODES, in its report
 * order) plus this surface's two gates. hyphaeon_validate does NOT emit these — it never reads a
 * date — but `hyphaeon://methods/requirements` publishes the whole vocabulary a client may see,
 * and a code with no published description is a code a client has to guess at. The refusals are
 * marked because every one of them is `kind: "input"` when it reaches an error envelope.
 */
const DATE_DESCRIPTIONS = Object.freeze({
  DATES_SOURCE_UNREADABLE: "[refuse] The metadata file did not parse as the kind it was read as",
  DATES_SOURCE_KIND_UNKNOWN: "[refuse] Not an Auspice JSON, a name-to-date JSON object, or a delimited table",
  DATES_BEAST_XML_UNSUPPORTED: "[refuse] BEAST XML: the reference reads one (dating.py:433-434), this build does not",
  DATES_TABLE_NO_DATE_COLUMN: "[refuse] No date column was found in the table; name it with date_col",
  DATES_TABLE_COLUMN_GUESSED: "A name or date column was discovered rather than named; the review says which and why",
  DATES_DELIMITER_GUESSED: "The column separator was read from the file's own content",
  DATES_TABLE_NO_MATCH: "[refuse, or warn when header fallback rescued the run] No metadata name matched any sequence at any tier",
  DATES_FUZZY_MATCH: "Some names matched only after quote-stripping, case folding, first-token or field containment",
  DATES_AMBIGUOUS_MATCH: "A metadata name matched more than one sequence at the same tier",
  DATES_UNMATCHED_METADATA: "Metadata rows that named no sequence in this alignment",
  DATES_DUPLICATE_METADATA: "The metadata names the same sequence more than once",
  DATES_AUSPICE_NO_TIPS: "[refuse] The JSON parsed but carries no named tip",
  DATES_AUSPICE_TIP_NAME_FALLBACK: "Tip names were taken from a fallback attribute",
  DATE_REGEX_INVALID: "[refuse] date_pattern could not be compiled (an empty or over-long pattern is refused unrun)",
  DATE_REGEX_NO_GROUP: "[refuse] date_pattern has no capturing group; the date is taken from group 1",
  DATE_REGEX_EXTRA_GROUPS:
    "date_pattern has more than one capturing group and only the FIRST is read as the date (dating.py:478, " +
    "`m.group(1)`); the others match and are discarded. The pattern runs exactly as the reference would run it, so " +
    "this is a note, not a refusal",
  DATE_REGEX_NO_MATCH: "date_pattern matched no name",
  DATES_HEADER_FALLBACK: "Sequences the supplied metadata did not name were dated from their headers instead",
  DATES_PARTIAL_COVERAGE: "Below 90% of sequences dated",
  DATES_IMPUTED: "A missing month or day was filled in",
  DATES_DAY_CLAMPED: "A day-of-month beyond the month's length was clamped",
  DATES_OUT_OF_RANGE: "A parsed date falls outside a plausible range",
  DATES_UNITS_INFERRED: "The time units were inferred from the values, not supplied",
  DATES_MIXED_SCALE: "The dated values span more than 1000x, so the column holds two different time axes",
  DATES_ARCHIVAL_1959_AVAILABLE: "Names carrying the archival-1959 convention were seen; archival_1959 would apply it",
  DATES_ARCHIVAL_1959_APPLIED: "The archival-1959 offset was applied",
  DATES_TIED: "More than half the dated sequences share one value",
  DATES_SPAN_SHORT: "The calendar span is under a year",
  DATES_DROPPED_BY_CAP: "Dated sequences were removed by the taxon cap, the duplicate collapse or tree pruning",
  DATES_NONE: "[refuse] No sequence could be dated",
  DATES_TOO_FEW: "[refuse] Fewer than 3 dated sequences",
  DATES_NO_SPAN: "[refuse] Every dated sequence carries the same date",
  DATES_BARE_NUMBER_MAJORITY:
    "[refuse, app] Half or more of the dates were read as a bare number in the sequence name, a rule that claims any " +
    "number it finds; hyphaeon_dating / hyphaeon_temporal refuse until accept_bare_numbers is set. The browser asks a " +
    "human this question (web/src/lib/time/dateReview.ts); a tool call has nobody to ask",
  DATES_UNDATED_PRESENT:
    "[refuse, app] Sequences carry no date and would be dropped silently; hyphaeon_dating / hyphaeon_temporal refuse " +
    "until drop_undated is set. hyphaeon_dates never refuses on either: reporting them is its job",
  DATING_LATENT_NEEDS_MODEL:
    "[refuse, app] distance_mode 'latent' was asked for without use_model, so there is no model pass to take a latent " +
    "root from. The runtime raises for this naming its own internal argument; this surface refuses it before the run " +
    "with the two arguments a caller actually has"
});

export const CODES = Object.freeze(
  Object.assign(
    Object.fromEntries(DIAGNOSTIC_CODES.map((c) => [c, LIBRARY_DESCRIPTIONS[c] || "See js/src/diagnostics.js"])),
    DATE_DESCRIPTIONS,
    {
      CAPS_EXCEEDED: "[app] The run is above this server's hard caps (src/caps.js); refused",
      RUN_MODE: "[app] Whether the run answers inside the tool call or as a job"
    }
  )
);

export { DIAGNOSTIC_THRESHOLDS };

/**
 * Parse an alignment with the library's dataset.py mirror, for the sizing probe: the format the
 * reference would sniff and `{name, seq}` pairs in file order. Never throws; an unparseable text
 * yields no sequences (dataset.py raises on the same input, and hyphaeon_validate reports it as
 * FORMAT_UNKNOWN).
 *
 * @param {string} text
 * @returns {{format: "phylip"|"fasta"|"nexus"|"unknown", sequences: Array<{name: string, seq: string}>}}
 */
export function parseAlignment(text) {
  if (typeof text !== "string" || !text.trim()) return { format: "unknown", sequences: [] };
  let seqDict;
  try {
    seqDict = parseAlignmentSequences(text);
  } catch {
    return { format: "unknown", sequences: [] };
  }
  const sequences = [];
  for (const [name, seq] of seqDict) sequences.push({ name, seq });
  return { format: sequences.length ? sniffAlignmentFormat(text) : "unknown", sequences };
}

/**
 * Does the text carry a tree the reference would find (dataset.py:161-212)?
 * @param {string} text
 */
export function hasEmbeddedTree(text) {
  if (typeof text !== "string" || !text.trim()) return false;
  try {
    return extractTree(text) !== null;
  } catch {
    return false;
  }
}

/**
 * The `preprocessing.tree_source` a run WILL record, decided the same way the engine decides it
 * (src/engine.js `treeSourceFor`): the library's tree-free notice wins, then a supplied tree, then
 * one embedded in the alignment. Exported so hyphaeon_validate can say in advance what the run
 * will do with the tree it was (or was not) given.
 *
 * @param {{treeGiven?: boolean, embedded?: boolean, treeFree?: boolean}} facts
 * @returns {"user"|"embedded"|"tn93"}
 */
export function treeSourceFrom({ treeGiven = false, embedded = false, treeFree = false }) {
  if (treeFree) return "tn93";
  if (treeGiven) return "user";
  if (embedded) return "embedded";
  return "tn93";
}

function snakeSummary(s) {
  return {
    format: s.format,
    sequence_count: s.taxaInAlignment,
    taxa_matched: s.taxaMatched,
    unique_haplotypes: s.uniqueHaplotypes,
    taxa_used: s.taxaUsed,
    codons: s.codons,
    tree_source: s.treeSource,
    match_tier: s.matchTier,
    median_patristic: s.medianPatristic,
    mean_pairwise_divergence: s.meanPairwiseDivergence,
    branch_lengths: s.branchLengths || null
  };
}

/**
 * Run the "Before you run" checks on inline text.
 *
 * @param {{alignment: string, tree?: string, analysis?: string, use_tn93?: boolean,
 *   max_species?: number, dates?: object}} input  `dates` holds the date arguments (dates_file,
 *   date_pattern, time_units, strain_col, date_col, accept_bare_numbers, drop_undated, ...) in the
 *   tools' own spelling; it is read only for the analyses in DATE_ANALYSES.
 * @returns {{ok: boolean, warnings: Array<{code: string, severity: string, message: string, data: object}>, summary: object}}
 */
/** The three analyses that read a date layer, and therefore the three validate checks dates for. */
export const DATE_ANALYSES = Object.freeze(["dates", "dating", "temporal"]);

/**
 * The date half of a pre-flight check: the same three gates the analysis dispatcher applies, as
 * `warnings[]` entries.
 *
 * @param {string} alignment
 * @param {string} analysis  one of DATE_ANALYSES
 * @param {object} options   the date arguments, in the tools' own spelling
 * @returns {{warnings: Array<object>, summary: object|null}}
 */
function diagnoseDates(alignment, analysis, options) {
  const warnings = [];
  let ingest;
  try {
    ingest = ingestFor({ alignment, dates_file: options.dates_file, dates_file_name: options.dates_file_name || null, options });
  } catch (e) {
    // A pattern that will not compile, a metadata file that is not any of the three kinds: the
    // date layer raises before it can report, and the analysis would raise on the same bytes.
    warnings.push({
      code: "DATES_SOURCE_UNREADABLE",
      severity: "refuse",
      message: "The date layer could not read this metadata: " + ((e && e.message) || e),
      data: { analysis }
    });
    return { warnings, summary: null };
  }

  // 1. The layer's own refusals (DATES_NONE, DATES_TOO_FEW, DATE_REGEX_*, ...), verbatim, with
  //    this surface's hint beside each one.
  for (const w of ingest.warnings) {
    if (w.severity === "refuse") warnings.push(Object.assign({}, w, { hint: refusalHint(w.code) }));
  }

  // 2. The two gates a tool call has nobody to ask (src/time.js decisions 1 and 2). On
  //    `hyphaeon_dates` they are INFORMATION — that tool exists to report exactly this — and on
  //    the two analyses they are the refusal the run will answer with.
  const gate = dateGate(ingest, options);
  const gateSeverity = analysis === "dates" ? "info" : "refuse";
  for (const b of gate.blocking) {
    warnings.push({
      code: b.code,
      severity: gateSeverity,
      message: analysis === "dates" ? b.message + " hyphaeon_dates reports this; hyphaeon_dating and hyphaeon_temporal refuse it." : b.message,
      hint: b.hint,
      data: { analysis, override: b.code === "DATES_UNDATED_PRESENT" ? "drop_undated" : "accept_bare_numbers" }
    });
  }

  // 3. Whether there is a clock at all, at the analysis's own threshold — three dated sequences
  //    for the regression (dating.py), five for surveillance (temporal.py:474).
  if (analysis !== "dates" && ingest.ok) {
    const clock = clockReadiness(ingest);
    const reasons = analysis === "temporal" ? clock.temporal_reasons : clock.reasons;
    if (reasons.length) {
      const code = analysis === "temporal" ? "TEMPORAL_TOO_FEW_DATED" : "DATING_TOO_FEW_DATED";
      warnings.push({
        code,
        severity: "refuse",
        message: "This date set carries no usable clock for hyphaeon_" + analysis + ": " + reasons.join("; ") + ".",
        hint: refusalHint(code),
        data: { analysis, dated: ingest.coverage.dated, reasons }
      });
    }
  }

  // 4. What was read, as the summary block, so `ok: true` is backed by numbers a reader can check.
  const summary = {
    source: ingest.source,
    source_name: options.dates_file_name || null,
    time_units: ingest.time_units,
    time_units_source: ingest.time_units_source,
    coverage: ingest.coverage,
    by_rule: ingest.by_rule,
    bare_number_dates: bareNumberDates(ingest),
    span: ingest.span,
    headline: ingest.ok ? dateHeadline(ingest) : null,
    min_dated_taxa: analysis === "temporal" ? TEMPORAL_MIN_DATED_TAXA : DATE_THRESHOLDS.minDatedTaxa,
    gate: { ok: gate.ok, blocking: gate.blocking.map((b) => b.code), overrides: gate.overrides, applied: gate.applied }
  };
  return { warnings, summary };
}

export function diagnose({ alignment, tree, analysis = "meme", use_tn93 = false, max_species, dates = null }) {
  const treeGiven = typeof tree === "string" && tree.trim().length > 0;
  const maxSpecies = Number.isInteger(max_species) && max_species >= 2 ? Math.min(max_species, TAXON_CAP) : TAXON_CAP;
  const lib = libraryDiagnose({
    alignmentText: typeof alignment === "string" ? alignment : "",
    treeText: treeGiven ? tree : null,
    maxSpecies,
    taxaLimit: MAX_TAXA,
    useTn93: !!use_tn93
  });

  const warnings = [...lib.warnings];
  const treeFree = warnings.find((w) => w.code === "TREE_FREE_TN93") || null;

  const summary = Object.assign(snakeSummary(lib.summary), {
    analysis,
    // `dates` never reaches src/engine.js at all, and `dating`'s default path loads no graph, so
    // the one word "in-process" is qualified rather than repeated: a caller sizing a run needs to
    // know whether a 7 MB graph is about to be read.
    engine: analysis === "dates" ? "in-process (no model)" : analysis === "dating" ? "in-process (no model unless use_model)" : "in-process",
    tree_source: treeSourceFrom({
      treeGiven,
      embedded: !treeGiven && hasEmbeddedTree(alignment),
      treeFree: treeFree !== null
    }),
    tree_free: treeFree ? treeFree.data.reason : null,
    distance_rescaled: lib.warnings.some((w) => w.code === "DISTANCE_RESCALED"),
    work: 0,
    mode: null,
    estimated_seconds: null
  });

  // Caps and the sync/job decision are sized on the FILE AS SUBMITTED (every sequence, the
  // longest one), as src/caps.js documents, not on the taxa the model would keep.
  const parsed = parseAlignment(alignment);
  if (parsed.sequences.length) {
    const probe = probeSequences(parsed.sequences);
    const taxa = parsed.sequences.length;
    summary.work = workFor(analysis, probe.codons, taxa);
    const cls = classifyRun(analysis, { codons: probe.codons, taxa });
    if (!cls.ok) {
      warnings.push({
        code: "CAPS_EXCEEDED",
        severity: "refuse",
        message: cls.reason + (cls.hint ? " " + cls.hint : ""),
        data: { work: cls.work, codons: probe.codons, taxa }
      });
    } else {
      summary.mode = cls.mode;
      const cost = lib.warnings.find((w) => w.code === "COST_ESTIMATE");
      const modelSeconds = cost && Number.isFinite(cost.data.predictedSeconds) ? cost.data.predictedSeconds : null;
      // THE LIBRARY'S COST ESTIMATE IS A MODEL-PASS ESTIMATE, so it may only be quoted for an
      // analysis that makes one. `dates` makes none at all and `dating`'s default path makes none
      // either (`use_model` is opt-in and hyphaeon_validate has no flag for it, so it sizes the
      // default), and quoting the meme figure for them promises a forward pass neither runs —
      // measured, the date layer is 3-24 ms and the model-free clock 85 ms on the bundled examples.
      const runsTheModel = analysis !== "dates" && analysis !== "dating";
      // `temporal` runs the model AND a permutation null whose cost the library's figure knows
      // nothing about, so it takes src/caps.js's own branch too: on H5N1_HA_geo the library's
      // one-pass estimate is 1.13 s against a measured 4.07 s for the whole pillar at the
      // reference's defaults, and caps.js's two-pass term gives 4.01 s.
      const useLibraryCost = runsTheModel && analysis !== "temporal" && modelSeconds !== null;
      const secs = useLibraryCost ? modelSeconds : estimateSeconds(analysis, probe.codons, taxa);
      summary.estimated_seconds = Math.round(secs * 100) / 100;
      // `temporal` is ALWAYS a job whatever the caps said (its record is megabytes; src/caps.js
      // TEMPORAL_ALWAYS_JOB), and `dates` runs no graph, so neither can be described by the two
      // sentences the other pillars share.
      const engineClause =
        analysis === "dates"
          ? "hyphaeon_dates runs the date layer in-process and loads NO model and no graph; it "
          : analysis === "dating"
            ? "hyphaeon_dating runs in-process and, by default, loads NO model (use_model adds one forward pass over every codon through <variant>_taxa.onnx); it "
            : "hyphaeon_" + analysis + " runs in-process (ONNX Runtime under Node) and ";
      const modeClause =
        analysis === "temporal"
          ? "ALWAYS returns a job id, waits for it inside the call, and answers with the run's summary — never the record, which is megabytes of trajectories read one section at a time"
          : cls.mode === "sync"
            ? analysis === "analyze"
              ? "answers inside the tool call when the report finishes within its wait budget, else returns the job id with the sections that are ready"
              : "answers inside the tool call"
            : "returns a job id (above the synchronous caps)";
      warnings.push({
        code: "RUN_MODE",
        severity: "info",
        message:
          engineClause + modeClause +
          "; roughly " + (secs < 1 ? "< 1" : Math.round(secs)) + " s of " + (runsTheModel ? "model" : "compute") + " time on a laptop CPU" +
          (analysis === "analyze" ? " before the DMS section, which is capped by its own work budget." : "."),
        data: {
          engine: summary.engine,
          mode: analysis === "temporal" ? "job" : cls.mode,
          work: cls.work,
          estimated_seconds: summary.estimated_seconds,
          runs_the_model: runsTheModel
        }
      });
      if (analysis === "temporal") summary.mode = "job";
    }
  }

  // THE DATE GATE, for the three analyses that have one. Last, so a client reads the alignment's
  // own problems first and the metadata's after — the order the run itself applies them in.
  if (DATE_ANALYSES.includes(analysis)) {
    const d = diagnoseDates(alignment, analysis, dates || {});
    warnings.push(...d.warnings);
    summary.dates = d.summary;
  }

  const ok = !warnings.some((w) => w.severity === "refuse");
  return { ok, warnings, summary };
}
