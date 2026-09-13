/**
 * time.js — the server's seam onto the date layer and the two Phase-6 time pillars.
 *
 * WHY THIS FILE EXISTS
 *
 * Phase 6 adds three analyses to `POST /api/v1/jobs`: `dates` (the date review, no model),
 * `dating` (the molecular clock) and `temporal` (per-site selection through calendar time). The
 * first and the last need things no existing pillar needed, and each of them is a decision rather
 * than a wiring detail, so they live here instead of being smeared across runner.js, jobs.js and
 * formats.js:
 *
 *   1. A DATE LAYER THAT IS NOT AN ANALYSIS OF THE SEQUENCES. `dates` runs no forward pass and
 *      loads no graph; it reads sequence NAMES and a metadata document. It must therefore reach
 *      the pillar helpers without dragging a session in.
 *   2. A REFUSAL THAT IS RETURNED, NOT THROWN. `ingestDates` answers a bad metadata file with
 *      `{ok: false, warnings:[{severity:'refuse'}]}` and never throws, so a wrapper that does
 *      `result = ingest` completes the job and serves nulls where the numbers should be.
 *   3. A NULL THAT REFINES FOR MINUTES AND WHOSE INTERIM PAYLOAD IS THE WHOLE RECORD.
 *      `runTemporal`'s `onProgress` fires a complete TemporalRecord per stage and per null chunk.
 *      MEASURED upstream at the reference's own defaults: 17 interim payloads of ~6.7 MiB each.
 *      jobs.js hands a section payload straight to the SSE stream, so forwarding those unprojected
 *      is 114 MiB of progress indicator to deliver a few kilobytes of p-values, on a single-worker
 *      server whose HTTP loop the worker pool exists to protect. `temporalNullSection` below is
 *      the projection — the same one `web/src/lib/workers/temporal.worker.ts` invented for the
 *      browser, narrowed further because SSE has no structured clone to lean on.
 *
 * ── WHERE THE SHARED VOCABULARY COMES FROM, AND WHY IT IS RESOLVED RATHER THAN IMPORTED ──────
 *
 * The MCP already owns every judgement these pillars need a surface to make: the two confirmation
 * gates the browser puts to a human (`DATES_BARE_NUMBER_MAJORITY` with its 0.5 threshold,
 * `DATES_UNDATED_PRESENT`), the 23-code refusal -> hint table, the null's four states and the
 * clause each one licenses, the wave-variance conditioning sentence, and the `{command, reproduces,
 * caveats}` reproduction object. All of it is in `mcp/src/time.js`, and `@veg/hyphaeon-mcp`'s
 * exports map publishes `./engine`, `./tools` and `./caps` but not `./time`.
 *
 * So this file RESOLVES `time.js` beside the published `./engine` entry rather than copying any of
 * it. A second copy of `BARE_NUMBER_MAJORITY` here would be a second threshold, and two surfaces
 * disagreeing about when to refuse a bare-number axis is exactly the failure the gate exists to
 * prevent; a second `uncalledBecause` would be a second sentence, and the browser already shipped
 * the bug of telling a reader whose null was SKIPPED that it "has not finished". The resolution
 * follows the package wherever it is installed (hoisted, linked or unpacked from the tarball,
 * whose `files` list carries `src`), so it is not an assumption about this repository's layout.
 * When the package publishes a `./time` subpath this becomes a one-line import.
 *
 * WHAT IS NOT HERE. No date arithmetic, no second date parser, no gate threshold, no honesty
 * sentence, no eigensolver, no session. The runtime's `./dates`, `./dating` and `./temporal`
 * subpaths supply the numbers and the writers; none of the three loads onnxruntime at import
 * (MEASURED on this machine: `import('@veg/hyphaeon-runtime/temporal')` is 97 ms with zero
 * onnxruntime modules in `process.moduleLoadList`), which is what lets `formats.js` — a main-thread
 * module on the HTTP event loop — import this file to write a CSV without paying for a graph.
 */

import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import {
  candidateSiteIndices,
  siteRow,
  temporalCurvesCsvText,
  temporalDownloadNotes,
  temporalPPermNote,
  temporalReferenceCommand,
  temporalSitesCsvText,
  temporalSummaryJsonText,
  temporalWavesCsvText,
  TEMPORAL_FILE_SUFFIXES,
  TEMPORAL_THRESHOLDS
} from "@veg/hyphaeon-runtime/temporal";
import { datingCsvText, datingJsonText } from "@veg/hyphaeon-runtime/dating";

/**
 * See the header: `./time` is not in the package's exports map, so it is resolved beside `./engine`.
 * `createRequire().resolve` rather than `import.meta.resolve` because vitest's SSR transform does
 * not provide the latter (it rewrites `import.meta` and the property is simply absent), and a
 * resolution that works under `node` and not under the test runner is not a resolution.
 */
const MCP_TIME_URL = new URL("./time.js", pathToFileURL(createRequire(import.meta.url).resolve("@veg/hyphaeon-mcp/engine"))).href;

export const {
  DATE_MATCH_TIERS,
  DATES_BARE_NUMBER_MAJORITY,
  DATES_UNDATED_PRESENT,
  TEMPORAL_SECTIONS,
  TIME_REFUSAL_CODES,
  clockReadiness,
  dateGate,
  dateHeadline,
  dateReview,
  datingSummary,
  ingestFor,
  nullStateOf,
  refusalHint,
  refusalOf,
  temporalHonesty,
  temporalSection,
  temporalSummary,
  uncalledBecause
} = await import(MCP_TIME_URL);

/** The three analyses Phase 6 adds, in the order the API lists them. */
export const TIME_ANALYSES = Object.freeze(["dates", "dating", "temporal"]);

/**
 * The runtime bag `temporalSection` and `temporalHonesty` take. Built once: every entry is a pure
 * function over a JSON-safe record, so one object serves the worker and the HTTP thread.
 */
export const TEMPORAL_RT = Object.freeze({ siteRow, candidateSiteIndices, temporalReferenceCommand, temporalDownloadNotes, temporalPPermNote });

/**
 * The sections a RUNNING temporal job streams, as SSE `section` events and as `sections` in the
 * job view. Both names are also sections of the finished record (`TEMPORAL_SECTIONS`), deliberately:
 * a client that read `permutations` at draw 313 and the same client reading it after the job
 * finished are reading the same thing, refined, and never two vocabularies for one quantity.
 */
export const TEMPORAL_LIVE_SECTIONS = Object.freeze(["summary", "permutations"]);

/**
 * How many candidate codons one `permutations` payload carries its p-values for.
 *
 * MEASURED on H5N1_HA_geo (98 taxa x 566 codons) through this server: 168 stage-one candidates,
 * each `{site, p_perm, q_perm}` entry 44-48 bytes of JSON, so the whole list is about 8 KB and the
 * payload with its permutation block about 9 KB. The engine's H1N1 acceptance run has 247
 * candidates at 4,384 codons, so this cap is not reached by either bundled example; it exists
 * because the candidate count is a property of the caller's data and nothing else bounds it. At
 * 500 the payload is about 24 KB, and a null that emits one per chunk (12 chunks at B = 1,000 on
 * the acceptance shape) puts under 300 KB on the wire for a whole run — against 114 MiB if the
 * runtime's own interim record were forwarded as it arrives.
 */
export const TEMPORAL_PERM_ROWS_MAX = 500;

// ── the temporal grid: the one caller number nothing was sizing ──────────────

/**
 * The largest `--time-points` grid this server will accept.
 *
 * WHY A CAP AT ALL, AND WHY IT IS NOT THE WORK CAP. `classifyRun` (mcp/src/caps.js) sizes a
 * temporal run at `codons x taxa^2` — the FORWARD PASS, which is the only cost the other pillars
 * have. The temporal pillar has a second one the caller controls independently: everything after
 * that pass is arithmetic over a [codons x T] trajectory store, where T is `options.time_points`,
 * and nothing in the caps vocabulary mentions T. So before this cap
 * `POST /jobs {analysis:"temporal", options:{time_points:999999}}` answered 202, and a request whose
 * every checked number was small wedged a default single-worker deployment.
 *
 * MEASURED on this machine through this server — H5N1_HA_geo (566 codons x 98 sequences, all dated,
 * the bundled temporal example), B = 100, one worker, two ORT threads, one job at a time. Wall
 * clock, the phases the progress record reports, and the stored `result.json`:
 *
 *   T      wall       temporal-infer   temporal-smooth + temporal-waves   result.json
 *   60     11.8 s      8.91 s          0.61 s                                631,844 B
 *   250     8.8 s      7.82 s          0.47 s                              2,162,993 B
 *   500     8.0 s      5.65 s          1.74 s                              4,182,333 B
 *   600    14.2 s      8.67 s          3.54 s                              4,987,844 B
 *   1000   18.0 s      5.77 s         10.46 s                              8,207,709 B
 *   2000   92.5 s      4.95 s         86.39 s                             16,272,879 B
 *   5000   DID NOT FINISH: killed at 1,004 s, against the shipped 600 s HYPHAEON_JOB_TIMEOUT_MS
 *
 * The forward pass is T-BLIND — 8.9 / 7.8 / 5.7 / 8.7 / 5.8 / 5.0 s is run-to-run noise on the same
 * 566 x 98 pass — and everything that grows is the part after it, which goes from 0.6 s to 86 s
 * between T = 60 and T = 2,000: FASTER THAN T, a factor of 8.3 for the last doubling. The stored
 * record grows linearly at about 8.1 KB per grid point on this alignment.
 *
 * 2,000 IS THE LARGEST GRID MEASURED TO COMPLETE, and it is also the ceiling `hyphaeon_temporal`'s
 * own tool schema already enforces (`time_points: z.number().int().min(2).max(2000)`,
 * mcp/src/tools.js), while the browser's grid control offers 60, 120 and 250 (`TemporalSection.svelte`).
 * The server was the only surface of the three with no number here, so this is agreement rather
 * than invention. At 2,000 a run is 92 s — inside the 600 s job timeout with room for a machine
 * several times slower; at 5,000 it is not a run, it is an outage.
 */
export const TEMPORAL_TIME_POINTS_MAX = 2000;

/**
 * The largest [codons x time_points] trajectory store this server will build.
 *
 * THE FIRST READING OF THE TABLE ABOVE WAS WRONG AND A CONTROL KILLED IT. `codons x T` is the cell
 * count of the store, so the obvious conclusion from "86 s at 566 x 2,000" is that cells price the
 * post-pass arithmetic. They do not. MEASURED, two shapes with nearly the same cell count:
 *
 *   H5N1_HA_geo   566 codons x T = 2,000 = 1,132,000 cells   smooth + waves 86.39 s   record 16,272,879 B
 *   H1N1_2009     4,384 codons x T =  250 = 1,096,000 cells   smooth + waves  1.51 s   record  7,202,693 B
 *
 * Fifty-seven times the arithmetic for the same number of cells. The post-pass cost is driven by T
 * and is only weakly a function of the codon count (0.47 s at 566 x 250 against 1.51 s at
 * 4,384 x 250 — 7.7x the codons for 3.2x the time), which is why the TIME bound above is a cap on
 * T alone and this one is not a time bound at all.
 *
 * WHAT THIS NUMBER IS. The store is also what the RESULT DOCUMENT carries, and there the cell count
 * is the right variable: 14.4 bytes a cell on H5N1 and 6.6 on H1N1 (the difference is invariable
 * codons, whose trajectories are all-zero rows). 1.2e6 cells therefore bounds the stored record at
 * about 17 MB — which is the largest record measured here, written once per job and read back by
 * `GET /result`. Without it the pillar's own codon cap of 30,000 at the reference's default grid is
 * 7.5e6 cells and a record of 50 to 108 MB, from a request whose forward-pass work term
 * (30,000 x N^2) can sit anywhere under the 2.5e9 cap.
 */
export const TEMPORAL_GRID_CELLS_MAX = 1.2e6;

/**
 * `temporal.py:405`'s `num_time_points`, read from the runtime's own thresholds table rather than
 * written down again here — a second copy of a reference default is a second default.
 */
export const TEMPORAL_TIME_POINTS_DEFAULT = TEMPORAL_THRESHOLDS.timePointsDefault;

/**
 * Size the temporal grid a request asks for, before a worker is spent on it.
 *
 * @param {number} codons   codon sites of the longest sequence (the caps' own `probeSequences`)
 * @param {object} options  the job's options (CLI spelling: `time_points`)
 * @returns {{ok: boolean, timePoints: number, cells: number, code?: string, reason?: string, hint?: string}}
 */
export function temporalGridCheck(codons, options = {}) {
  const raw = options.time_points;
  const T = raw === undefined || raw === null ? TEMPORAL_TIME_POINTS_DEFAULT : raw;
  const cells = Math.max(0, Math.floor(codons)) * (Number.isFinite(T) ? T : 0);
  if (!Number.isInteger(T) || T < 2) {
    return {
      ok: false,
      timePoints: T,
      cells,
      code: "TEMPORAL_TIME_POINTS_INVALID",
      reason: "`time_points` must be an integer of at least 2; the grid is a continuous time axis and two points is the fewest that is one.",
      hint: "Omit it for the reference's own default of " + TEMPORAL_TIME_POINTS_DEFAULT + ", or pass an integer between 2 and " + TEMPORAL_TIME_POINTS_MAX + "."
    };
  }
  if (T > TEMPORAL_TIME_POINTS_MAX) {
    return {
      ok: false,
      timePoints: T,
      cells,
      code: "TEMPORAL_TIME_POINTS_EXCEEDED",
      reason:
        "`time_points` is " + T + "; this server is capped at " + TEMPORAL_TIME_POINTS_MAX + ". Everything after the " +
        "model pass is arithmetic over a [codons x time_points] store, and it grows faster than the grid does: measured on " +
        "the 566-codon bundled example, smoothing and the wave decomposition together are 0.6 s at 60 points, 10.5 s at " +
        "1,000 and 86.4 s at 2,000, and a 5,000-point run was killed at 1,004 s having never finished.",
      hint:
        "Use at most " + TEMPORAL_TIME_POINTS_MAX + " (the reference's own default is " + TEMPORAL_TIME_POINTS_DEFAULT +
        ", and `hyphaeon_temporal` caps the same option at " + TEMPORAL_TIME_POINTS_MAX + "). A finer grid does not add " +
        "information the dates do not carry: the grid cannot resolve below the sampling interval."
    };
  }
  if (cells > TEMPORAL_GRID_CELLS_MAX) {
    return {
      ok: false,
      timePoints: T,
      cells,
      code: "TEMPORAL_GRID_TOO_LARGE",
      reason:
        "This run would build a " + codons + " codon x " + T + " point trajectory store — " + cells.toExponential(2) +
        " cells, above the cap of " + TEMPORAL_GRID_CELLS_MAX.toExponential(1) + ". That store is what the result document " +
        "carries, measured at 6.6 to 14.4 bytes a cell on the two bundled examples, so this cap is what keeps one job's " +
        "record near 17 MB rather than hundreds.",
      hint:
        "Lower `time_points` to at most " + Math.max(2, Math.floor(TEMPORAL_GRID_CELLS_MAX / Math.max(1, codons))) +
        " for this alignment, or submit fewer codon sites. The reference's own default is " + TEMPORAL_TIME_POINTS_DEFAULT +
        " points; `max_species` does not help, because the store has no taxon axis."
    };
  }
  return { ok: true, timePoints: T, cells };
}

/**
 * The largest temporal `result.json` this route will serve WHOLE.
 *
 * WHY THE SERVER MAY DO WHAT THE MCP WILL NOT, AND WHERE IT STOPS. `caps.temporal.record_never_inline`
 * (mcp/src/resources.js) is a statement about a TOOL RESULT: a temporal record is 2.1 MB on the
 * bundled example and 7.18 MB on the engine's acceptance run, 8.2x and 27x the MCP's 256 KiB inline
 * limit, and a tool result is spent in a model's context window, so `hyphaeon_temporal` answers with
 * the summary and a job id and `get_results section=` pages the rest. An HTTP client has no context
 * window; it asked for a file, and `GET /jobs/:id/result` has answered `analyze` jobs with megabyte
 * reports since Phase 2. Refusing the whole record here would make the two surfaces agree by making
 * this one useless, so the route keeps serving it — up to a measured bound, which is the part that
 * was missing.
 *
 * The bound is not about the client, it is about THIS PROCESS. `jobs.result()` reads the stored
 * document with `readFileSync` + `JSON.parse` and `res.json()` re-serialises it, both synchronously
 * on the HTTP event loop the worker pool exists to keep free, and both allocating the whole
 * document again. MEASURED on this machine, `JSON.parse` then `JSON.stringify` of the stored
 * `result.json` of four real runs of the bundled example:
 *
 *   result.json     parse      stringify   blocked
 *   2,162,993 B     (T = 250, the reference's own grid)         — the default run, well inside
 *   4,182,333 B     18.4 ms    23.4 ms     41.8 ms
 *   4,987,844 B     24.3 ms    30.5 ms     54.8 ms
 *   7,202,693 B     61.4 ms    32.3 ms     93.7 ms
 *  16,272,879 B     64.1 ms    69.6 ms    133.7 ms
 *
 * about 8 ms of event loop per megabyte, PER REQUEST — a client that polls, or two clients at once,
 * multiplies it, and none of it is work the worker pool can take. 4 MiB is where that block crosses
 * 40 ms and is sixteen times the MCP's own inline limit; MEASURED, it admits the reference's default
 * grid on the bundled example (2.16 MB at T = 250, and 4.18 MB at T = 500) and refuses a doubled one
 * (4.99 MB at T = 600). It is deliberately the smallest round number above a default run rather than
 * the largest this process survives.
 *
 * Over it the route answers 406 with `TEMPORAL_RECORD_TOO_LARGE` and names the two ways to get the
 * numbers — `?section=` (the MCP's own ten sections, the same implementation) and `?file=` (the
 * reference's own four output files, streamed as text with no parse and no re-serialisation) —
 * which is exactly the door `record_never_inline` points a caller at. A record under the cap is
 * served whole, as before.
 */
export const TEMPORAL_RECORD_BYTES_MAX = 4 * 1024 * 1024;

// ── the date layer as an analysis ────────────────────────────────────────────

/**
 * The `dates` analysis result: byte for byte the body `hyphaeon_dates` returns, plus the job
 * API's `provenance`. The two surfaces answer the same question with the same object on purpose —
 * a client that read the MCP tool's contract can read this one.
 *
 * A REFUSAL IS RAISED, NOT RETURNED. `ingestDates` answers an unreadable metadata file with
 * `{ok: false}` and a `refuse`-severity warning; handed back as a result it would complete the job
 * and hand a client a body whose `coverage.dated` is 0 with no error anywhere. `datesBody` throws
 * instead, carrying the date layer's own code and the hint that names the METADATA fix, and the
 * runner turns it into a failed job with `kind: "input"`.
 *
 * @param {{alignment: string, dates_file?: string, names?: object, options?: object}} task
 * @returns {object}
 */
export function datesBody(task) {
  const options = task.options || {};
  const names = task.names || {};
  const ingest = ingestFor({
    alignment: task.alignment,
    dates_file: task.dates_file,
    dates_file_name: names.dates_file || options.dates_file_name || null,
    options
  });
  if (!ingest.ok) {
    const refuse = (ingest.warnings || []).find((w) => w && w.severity === "refuse");
    const err = new Error((refuse && refuse.message) || "No sequence in this alignment could be dated.");
    err.kind = "input";
    err.code = (refuse && refuse.code) || "DATES_NONE";
    err.hint = refusalHint(err.code);
    // The review is what a caller needs to fix it — which column was looked for, which names did
    // not match, what the first rows looked like — so it travels on the ERROR rather than being
    // thrown away with it. `rows: false` keeps a failed job's error bounded.
    err.details = { date_review: dateReview(ingest, { rows: false }) };
    throw err;
  }
  const gate = dateGate(ingest, options);
  return {
    analysis: "dates",
    ok: true,
    headline: dateHeadline(ingest),
    clock: clockReadiness(ingest),
    gate,
    date_review: dateReview(ingest, { rows: options.rows !== false, rowsMax: options.row_limit }),
    match_tiers_available: DATE_MATCH_TIERS,
    next: gate.ok
      ? 'POST /api/v1/jobs {"analysis":"dating"} (the molecular clock; model-free by default) and, with 5+ dated sequences, {"analysis":"temporal"}. Pass the same date fields you passed here.'
      : "Read `gate.blocking`: a dating or temporal job is refused (422) with the named code until you pass the override beside it, or supply better metadata.",
    engine: "in-process (no model, no graph)"
  };
}

// ── the temporal null, as something an SSE stream can carry ──────────────────

/**
 * An interim record with the one field the finished record has and it does not.
 *
 * `runTemporal`'s interim carries the partial null block straight from `runTemporalNull`, and that
 * block has NO `tested` flag: `runtime/src/temporal/record.js` adds it when it assembles the
 * finished record, as `completed > 0`. Every honesty judgement downstream reads it —
 * `nullInFlight` is `permutations.tested && stage is not complete`, so without it `nullStateOf`
 * answers `not-started` for a null that is demonstrably running, and `temporalHonesty` says "the
 * date-shuffling null has not been drawn" over a progress record reading 400 of 9,000. That was
 * REPRODUCED on this server: `GET /jobs/:id/result?section=summary` at phase `temporal-null`,
 * done > 400, carried `{null_state: 'not-started', calls_are_final: false}`.
 *
 * The fix is to apply the FINISHED record's own definition to the interim rather than to invent a
 * second one: `tested` means "at least one draw completed" in `record.js` and it means exactly that
 * here. Nothing else is changed, and a record that already has the flag is returned untouched, so
 * this is a no-op on a finished record.
 *
 * @param {object} record a TemporalRecord (interim from `onProgress`, or finished)
 */
export function liveTemporalRecord(record) {
  const perm = record && record.permutations;
  if (!perm || perm.tested !== undefined) return record;
  return Object.assign({}, record, { permutations: Object.assign({}, perm, { tested: perm.completed > 0 }) });
}

/**
 * The `permutations` section payload: what a client watching a refining null needs, and nothing
 * that would make it megabytes.
 *
 * WHAT IS DELIBERATELY IN IT. `permutations.completed` is the achieved draw count and it MEANS the
 * number it says: draw `b` is seeded from `splitmix64(seed0, b)`, so a run stopped at 313 is
 * bit-identical to one configured at 313 and a partially completed draw is never counted
 * (runtime/src/temporal/null.js). `null_state` and `uncalled_because` come from the MCP's own
 * four-state discriminator, because `permutations.tested` flips true after the FIRST chunk while
 * the call columns are still the scored payload's zeros — a client that read `tested` alone would
 * print "nothing is under selection" one second into every run, every time.
 *
 * WHAT IS DELIBERATELY NOT IN IT. The call columns, the sweep counts and the wave modes: they are
 * computed once, at the end, and an interim carries zeros that are indistinguishable from measured
 * zeros. `calls_are_final` says so on every payload, final or not.
 *
 * `p_perm` is reported ONLY at the stage-one candidates. At every other codon it is the reference's
 * assumed 1.0 (temporal.py:620-621) — a p-value printed for a test that was not run — and a
 * candidate whose null has not reached it carries NaN, never 1.0, which is the one distinction
 * that keeps "not tested" and "not a sweep" apart. JSON has no NaN, so it is written `null` here
 * and `tested` on each row says which.
 *
 * @param {object} record a TemporalRecord (an interim from `onProgress`, or the finished one)
 * @returns {object}
 */
export function temporalNullSection(record) {
  const sites = record.sites || {};
  const stage1 = sites.stage1 || null;
  const L = record.codons_total || 0;

  // AN INTERIM PAYLOAD AND A FINISHED RECORD ARE DIFFERENT SHAPES, and reading the wrong one is
  // the single most dangerous mistake available here. `runTemporal`'s interim is the scored record
  // with `stage: 'null'` and the live `p_perm` / `q_perm` spread onto the TOP LEVEL beside the
  // partial null block (temporal/run.js); `record.sites.p_perm` on that same object is still the
  // SCORED fill — 1.0 at every codon — so a projection that read it would publish the reference's
  // assumed 1.0 as a measured p-value at every candidate, per chunk, for the whole run. The
  // finished record carries the measured values in `sites` and nothing at the top level.
  const pPerm = record.p_perm || sites.p_perm || null;
  const qPerm = record.q_perm || sites.q_perm || null;

  // `liveTemporalRecord` supplies the `tested` flag the interim null block does not carry, which is
  // what lets the MCP's own four-state discriminator say `running` on an interim instead of
  // `not-started`; inventing a different rule would be a second opinion about the one thing no
  // surface may have two of.
  const live = liveTemporalRecord(record);
  const perm = live.permutations || null;
  const rows = [];
  let tested = 0;
  for (let s = 0; s < L && rows.length < TEMPORAL_PERM_ROWS_MAX; s++) {
    if (stage1 && !stage1[s]) continue;
    const p = pPerm ? pPerm[s] : null;
    const q = qPerm ? qPerm[s] : null;
    const measured = Number.isFinite(p);
    if (measured) tested++;
    rows.push({ site: s + 1, p_perm: measured ? p : null, q_perm: Number.isFinite(q) ? q : null, tested: measured });
  }
  let candidates = 0;
  if (stage1) for (let s = 0; s < L; s++) if (stage1[s]) candidates++;
  return {
    analysis: "temporal",
    section: "permutations",
    stage: record.stage,
    // `honesty` AT THE TOP LEVEL, on every section of every state. The MCP's own finished sections
    // are `{analysis, section, stage, honesty, ...}` (mcp/src/time.js `temporalSection`), and until
    // this line a live `permutations` payload carried the three flat fields below and no `honesty`
    // at all — so a client reading `body.honesty` got `undefined` exactly while the run was in
    // flight, which is when it matters. The three flat fields stay because the MCP's finished
    // `permutations` section carries `null_state` flat beside `honesty` too; they are the same
    // values from the same discriminator, not a second opinion.
    honesty: temporalHonesty(live, TEMPORAL_RT),
    null_state: nullStateOf(live),
    uncalled_because: uncalledBecause(live),
    calls_are_final: Boolean(perm && perm.tested) && record.stage === "complete",
    permutations: perm,
    stage1_candidates: record.stage1_candidates ?? candidates,
    candidates_reported: rows.length,
    candidates_measured: tested,
    p_perm_at_candidates: rows,
    note:
      "`permutations.completed` is the number of shuffles actually drawn and it means that number: draw b is seeded " +
      "from splitmix64(seed, b), so a run stopped here is bit-identical to one configured at " +
      ((perm && perm.completed) || 0) + " draws. The call columns, the sweep counts and the four wave modes are " +
      "computed once at the end; until `calls_are_final` is true they are interim zeros, not measured zeros. " +
      "`p_perm` outside the stage-one candidates is the reference's assumed 1.0 and is not reported here."
  };
}

/**
 * The `summary` section payload for a temporal job, live or finished.
 *
 * `liveTemporalRecord` is the whole reason this reads the true state mid-run: the honesty block is
 * computed from the same discriminator the finished record uses, over an interim that now carries
 * the `tested` flag the runtime only adds at the end. Without it this section reported a null that
 * had not started while the null was demonstrably running.
 */
export function temporalSummarySection(record) {
  const live = liveTemporalRecord(record);
  return {
    analysis: "temporal",
    section: "summary",
    stage: record.stage,
    summary: temporalSummary(live),
    honesty: temporalHonesty(live, TEMPORAL_RT)
  };
}

/**
 * One section of a FINISHED temporal result document, for `GET /jobs/:id/result?section=`.
 * The MCP's own `temporalSection` does the work, so the ten sections a `get_results section=` call
 * serves and the ten this route serves are the same ten with the same bodies.
 *
 * @param {object} doc   the stored result ({analysis, record, honesty, date_review, provenance})
 * @param {string} name  one of TEMPORAL_SECTIONS
 * @param {{sites?: number[], top?: number}} args
 */
export function temporalResultSection(doc, name, args = {}) {
  return temporalSection(doc.record, name, args, TEMPORAL_RT);
}

// ── the reference's own output files ─────────────────────────────────────────

/**
 * The files `hyphaeon dating` and `hyphaeon temporal` write, by the name `?file=` asks for them by.
 *
 * These are the runtime's byte-equal writers, not a format this server invented: temporal's four
 * were verified against the reference's own three CSVs by re-parsing and rewriting them (780,749 /
 * 1,186,202 / 6,083 bytes reproduced exactly) and dating's JSON has the same 1,821 lines in the
 * same key order as a CLI run. BYTE-EQUAL FORMAT IS NOT REPRODUCIBLE CONTENT and the two must not
 * be confused: the temporal numbers differ from a CLI run's because a different generator draws the
 * null downstream of a ~1e-6 ONNX-against-torch difference upstream of it, which is why
 * `temporalDownloadNotes` is the runtime's own list of mandatory sentences (six at this writing;
 * it is the runtime's to grow, and nothing here pins a count) and rides on `honesty.download_notes` in
 * every JSON answer this route gives.
 *
 * One CSV per analysis was the old assumption (formats.js `toCsv`); temporal writes four files and
 * dating two, so `?file=` names one and the absence of `?file=` keeps every route that existed
 * before behaving as it did.
 */
export const REFERENCE_FILES = Object.freeze({
  temporal: Object.freeze({
    sites: { suffix: TEMPORAL_FILE_SUFFIXES.sites, type: "csv", write: (doc) => temporalSitesCsvText(doc.record) },
    curves: { suffix: TEMPORAL_FILE_SUFFIXES.curves, type: "csv", write: (doc) => temporalCurvesCsvText(doc.record) },
    waves: { suffix: TEMPORAL_FILE_SUFFIXES.waves, type: "csv", write: (doc) => temporalWavesCsvText(doc.record) },
    summary: { suffix: TEMPORAL_FILE_SUFFIXES.summary, type: "json", write: (doc) => temporalSummaryJsonText(doc.record) }
  }),
  dating: Object.freeze({
    // `hyphaeon dating -o out.json`: the record with `primaeon` dropped and our own
    // `prediction_method` column dropped, which together give a file whose shape is exactly the
    // CLI's. `prediction_method: true` adds the column back for a reader who wants to know which
    // of three models produced each predicted date — a column the reference does not emit at all.
    json: { suffix: ".json", type: "json", write: (doc, opts) => datingJsonText(doc.record, { includeProvenance: false, predictionMethod: opts.predictionMethod }) },
    csv: { suffix: ".csv", type: "csv", write: (doc, opts) => datingCsvText(doc.taxa_summary || [], { predictionMethod: opts.predictionMethod }) }
  })
});

/** The `?file=` names an analysis offers, or null when it writes no reference file. */
export function referenceFileNames(analysis) {
  const files = REFERENCE_FILES[analysis];
  return files ? Object.keys(files) : null;
}
