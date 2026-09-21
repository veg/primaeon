/**
 * validate.js — `POST /api/v1/validate` and the sizing check every job request passes through.
 *
 * WHY THIS FILE EXISTS
 *
 * PLAN.md 3.5: "Sync diagnostics from the package (identical codes to the browser)". The
 * diagnostics are the library's `diagnose()` (@veg/hyphaeon-js diagnostics.js, PLAN.md 4.3), the
 * same function the web app's prep worker and the MCP's hyphaeon_validate call, so a warning code
 * seen in the browser is the code the server prints. What this module adds is the server's own
 * decision layer, taken from the MCP's caps (mcp/src/caps.js, imported, not copied): the alignment
 * is parsed once, sized "as submitted" (every sequence, the longest one — the axomeme_scan rule
 * caps.js documents), classified against the codon / taxa / work caps, and either refused with a
 * CAPS_EXCEEDED warning or accepted. The server has no synchronous mode (every accepted run is a
 * job), so `classifyRun`'s sync/job split collapses to ok/refuse here and the response says so.
 *
 * `analyze` is sized as `meme` for the codon and work caps (the forward pass is the same), and
 * its DMS stage is what the report caps by work budget at run time (PLAN.md 4.0 row 7), not what
 * refuses the upload; a dataset above the DMS cap still gets a report without a DMS section.
 *
 * A TREE IS OPTIONAL (PLAN.md D22). A missing tree, or a tree with no usable branch lengths, is
 * `TREE_FREE_TN93` at INFO level, not a refusal: the run takes pairwise TN93 distances instead.
 * Nothing here asks whether the server can estimate branch lengths, because nothing can and
 * nothing needs to.
 *
 * AN XML IS NOT AN ALIGNMENT (`ALIGNMENT_IS_XML`, below). This is the one refusal in this file that
 * is neither the library's nor the caps' — it exists because the library's parser does not reject
 * XML, it MISREADS it, and Phase 6b (`dates_file` reads a BEAST XML) made that a likely mistake
 * rather than a curious one. The measurement is on the constant.
 *
 * The response shape follows the MCP tool's: `{ok, warnings:[{code, severity, message, data}],
 * summary}` with the summary keys in snake_case as the CLI prints them.
 */

import { parseAlignmentSequences, sniffAlignmentFormat, extractTree } from "@veg/hyphaeon-js";
// `diagnoseUpload` is `diagnose()` with the distance engine this product actually runs handed in
// (runtime/src/pipeline.js). A STATIC import, unlike the MCP's, because the runtime's main entry is
// already in this process's module graph by the time validate.js is linked — MEASURED at 0.7 ms
// incremental against 331.8 ms for validate.js's own graph, so there is nothing to defer.
import { diagnoseUpload } from "@veg/hyphaeon-runtime";
import { DATING_MODEL_MAX_TAXA, MAX_ALIGNMENT_CHARS, MAX_TAXA, TAXON_CAP, classifyRun, probeSequences, workFor } from "@veg/hyphaeon-mcp/caps";
import { ANALYSES } from "./runner.js";
import { clockReadiness, dateGate, dateHeadline, dateReview, ingestFor, refusalHint, temporalGridCheck } from "./time.js";

export { ANALYSES, MAX_ALIGNMENT_CHARS, DATING_MODEL_MAX_TAXA };

/** Which caps table an analysis is sized with (`analyze` runs the meme forward pass). */
export function capsAnalysisFor(analysis) {
  if (analysis === "analyze") return "meme";
  if (analysis === "evaluate") return null;
  return analysis;
}

/**
 * The caps options an analysis's own request implies. `dating`'s work term switches on `use_model`
 * (mcp/src/caps.js `workFor`): the default path is a root-to-tip regression over pairwise TN93
 * distances, O(N x L) and measured at 43 ms on korber's 143 x 981 (median of 9, date ingest plus
 * `runDating`, with veg/tn93's compiled build; 36 ms with the JavaScript port that has since been
 * deleted), while
 * `use_model: true` adds one forward pass over every codon and is the ordinary L x N^2 — and
 * brings the pillar's own
 * DATING_MODEL_MAX_TAXA ceiling with it, which refuses rather than downsampling into it.
 */
export function capsOptionsFor(analysis, options = {}) {
  if (analysis === "dating") return { useModel: options.use_model === true };
  return {};
}

/**
 * Parse with the library's dataset.py mirror; never throws.
 * @returns {{format: string, sequences: Array<{name: string, seq: string}>}}
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
 * Does this text open as an XML document? A leading BOM and leading whitespace are skipped because
 * a caller who exported an XML from a Windows tool has both.
 *
 * No alignment format this server accepts begins with `<`: FASTA opens with `>`, NEXUS with
 * `#NEXUS`, PHYLIP with a taxon count. So an opening `<` is not an ambiguous signal, and this is
 * not a second classifier competing with the date layer's `detectDateSourceKind` — it answers one
 * narrower question, about one field, whose answer is never "which kind of date document is this".
 */
function looksLikeXml(text) {
  if (typeof text !== "string") return false;
  const head = text.replace(/^﻿/, "").trimStart().slice(0, 64).toLowerCase();
  return head.startsWith("<?xml") || head.startsWith("<!doctype") || /^<[a-z_]/.test(head);
}

/**
 * The code and the two sentences for an XML handed to `alignment`.
 *
 * WHY THIS IS A REFUSAL AND NOT A DIAGNOSTIC. MEASURED on a BEAST 1 XML built around
 * H5N1_HA_geo's own alignment (98 taxa, 566 codons): the library's `parseAlignmentSequences` does
 * not reject XML — it reads it as FOUR sequences named `<?xml`, `<taxon`, `<alignment` and
 * `<sequence><taxon` with 581 "codons" between them, `format: "unknown"`, and `classifyRun` then
 * passes it. So `POST /jobs {analysis:"dating", alignment:<a BEAST XML>}` answered 202 today,
 * spent a worker, and failed inside the pillar on nonsense — the door's whole job undone by a
 * field that had never been handed a document with angle brackets in it. Phase 6b makes that a
 * likely mistake rather than a curious one, because a caller now HAS a BEAST XML in hand and three
 * fields to try it in. `format: "unknown"` on a document that opens with `<` is the tell, and this
 * is that tell turned into a refusal a caller can read.
 */
const ALIGNMENT_IS_XML = Object.freeze({
  code: "ALIGNMENT_IS_XML",
  reason: "The `alignment` field was given an XML document, and it takes sequences.",
  hint:
    "FASTA (headers starting with '>'), NEXUS (a MATRIX block) or PHYLIP (a 'ntaxa nsites' header) are accepted. " +
    "A BEAST XML belongs in `dates_file`, which reads it for its sampling dates (BEAST 1 <taxon><date>, BEAST 2 " +
    '<trait traitname="date">); export the sequences it carries as FASTA for `alignment`.'
});

export function hasEmbeddedTree(text) {
  if (typeof text !== "string" || !text.trim()) return false;
  try {
    return extractTree(text) !== null;
  } catch {
    return false;
  }
}

/** 'user' | 'embedded' | 'tn93': what the run will record as `preprocessing.tree_source`. */
export function treeSourceFor({ treeGiven, embedded, treeFree }) {
  if (treeFree) return "tn93";
  if (treeGiven) return "user";
  return embedded ? "embedded" : "tn93";
}

function snakeSummary(s) {
  const out = {};
  for (const [k, v] of Object.entries(s || {})) out[k.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase())] = v;
  if (s && s.taxaInAlignment !== undefined) out.sequence_count = s.taxaInAlignment;
  return out;
}

/**
 * Size an alignment as submitted and classify it against the caps.
 *
 * @param {string} analysis  one of ANALYSES
 * @param {string} alignment
 * @param {object} [options] the job's options, for the caps that switch on one (`dating`'s use_model)
 * @returns {{ok: boolean, size: {format: string, sequences: number, codons: number, work: number}|null, reason?: string, hint?: string}}
 */
export function sizeCheck(analysis, alignment, options = {}) {
  const capsAnalysis = capsAnalysisFor(analysis);
  if (!capsAnalysis) return { ok: true, size: null };
  // Checked BEFORE the parse, because the parse is what gets this wrong (see ALIGNMENT_IS_XML).
  if (looksLikeXml(alignment)) return { ok: false, size: null, code: ALIGNMENT_IS_XML.code, reason: ALIGNMENT_IS_XML.reason, hint: ALIGNMENT_IS_XML.hint };
  const parsed = parseAlignment(alignment);
  if (!parsed.sequences.length) {
    return {
      ok: false,
      size: null,
      reason: "Could not read the alignment: no sequences found.",
      hint: "FASTA (headers starting with '>'), NEXUS (a MATRIX block) or PHYLIP (a 'ntaxa nsites' header) are accepted."
    };
  }
  const probe = probeSequences(parsed.sequences);
  const capsOptions = capsOptionsFor(analysis, options);
  const cls = classifyRun(capsAnalysis, { codons: probe.codons, taxa: parsed.sequences.length }, capsOptions);
  const size = { format: parsed.format, sequences: parsed.sequences.length, codons: probe.codons, work: cls.work };
  if (!cls.ok) return { ok: false, size, code: "CAPS_EXCEEDED", reason: cls.reason, hint: cls.hint };
  // THE SECOND COST THE CAPS VOCABULARY HAS NO WORD FOR. `classifyRun` sizes the forward pass —
  // codons x taxa^2 — and that term is BLIND to `time_points`, which the caller also chooses and
  // which sets the size of the [codons x T] trajectory store every stage after the pass walks.
  // Measured, the pass is the same 5-9 s at T = 60 and at T = 2,000 on the bundled example while
  // the stages after it go from 0.6 s to 67.8 s. `temporalGridCheck` (src/time.js) carries the
  // measurements and the two bounds; it lives there because the numbers are the temporal pillar's,
  // and it is applied here so `POST /validate` rehearses exactly what `POST /jobs` will answer.
  if (analysis === "temporal") {
    const grid = temporalGridCheck(probe.codons, options);
    size.time_points = grid.timePoints;
    size.grid_cells = grid.cells;
    if (!grid.ok) return { ok: false, size, code: grid.code, reason: grid.reason, hint: grid.hint };
  }
  return { ok: true, size };
}

/**
 * Run the date layer at the door, before a worker is spent on the job.
 *
 * WHY IT IS HERE AND NOT ONLY IN THE WORKER. Every refusal this can raise is a property of the
 * caller's METADATA: the file did not parse as the kind it was read as, no column held a date, no
 * name matched a sequence, fewer than three sequences carry a date, every date is the same day.
 * They cost 3-24 ms to find (measured on the four bundled examples; the date layer reads sequence
 * names and a document, loads no model and parses no codon), and finding them here makes them a
 * synchronous 422 with the structured code — the same shape the caps refusal already has — rather
 * than a 202 followed by a failed job. The engine ingests the dates again inside the run, so this
 * is a door and not the only lock.
 *
 * THE TWO GATES ARE APPLIED HERE TOO, and they are the reason this is not merely an optimisation.
 * `DATES_BARE_NUMBER_MAJORITY` and `DATES_UNDATED_PRESENT` are the questions the browser puts to a
 * human before it will run (web/src/lib/time/dateReview.ts `readyGate`), and an HTTP job has nobody
 * to ask: refusing with a named override is the only answer that neither silently ships the wrong
 * axis nor blocks a legitimate run. The thresholds and the hints are the MCP's — resolved, not
 * copied — so all three surfaces refuse the same input for the same reason.
 *
 * NOT APPLIED TO `analysis: "dates"`. Reporting which sequences carry a date and which do not is
 * that analysis's entire job; refusing it for the thing it was asked to measure would be absurd.
 * A dates job always runs and carries the gate as `gate.blocking[]`.
 *
 * ── PHASE 6b: A BEAST XML IS READ HERE, NOT REFUSED HERE ─────────────────────────────────────
 *
 * `DATES_BEAST_XML_UNSUPPORTED` is gone. `dates_file` reads a BEAST 1.x or 2.x XML through the
 * runtime's port of `parse_beast_xml` (runtime/src/dates/beast.js, dataset.py:84-233), so a file
 * this door used to refuse on its NAME now produces dates — and four narrower refusals take the
 * old one's place, each still `kind: "input"` with a hint that names the METADATA fix, because
 * every one of them is a property of the caller's document and none changes if the operator
 * restarts the server: `DATES_XML_UNPARSABLE` (not well-formed), `DATES_XML_UNSAFE` (an external
 * or oversized entity, refused before the document is read), `DATES_BEAST_NOT_BEAST` (well-formed
 * XML holding nothing a BEAST file holds — a namespaced document included, because
 * `parse_beast_xml` searches unqualified tags) and `DATES_BEAST_NO_DATES`. Their hints are the
 * MCP's `TIME_REFUSAL_HINTS`, resolved rather than copied (src/time.js), so this surface and the
 * tool surface refuse the same file with the same sentence.
 *
 * WHAT THAT COSTS ON THE HTTP THREAD, MEASURED, because the refusal used to be free: reading a
 * BEAST XML built around each bundled example is 9-21 ms (182 KB to 1.34 MB of XML) against 4-6 ms
 * for the equivalent CSV. At the 8 MiB body limit — the largest document that can arrive — it is
 * 70 ms for 740 long records and 504 ms for 36,000 short ones, the element-densest shape a caller
 * can build. That is NOT a new exposure: `POST /validate` on an 8 MiB FASTA of many short records
 * already costs 583 ms today, with no XML anywhere, so the body limit and the per-IP rate limits
 * (src/config.js) are what bound this, exactly as they bounded the alignment parse. No second byte
 * cap was added; see the `dates_file` field comment in src/app.js for why one would not help.
 *
 * @param {string} analysis   "dating" | "temporal"
 * @param {string} alignment
 * @param {string} [datesFile] the metadata document's TEXT (Auspice JSON, JSON map, CSV/TSV or BEAST XML)
 * @param {object} [options]   the job's options (CLI spelling: date_col, time_units, drop_undated, ...)
 * @param {object} [names]     {dates_file}
 * @returns {{ok: boolean, code?: string, message?: string, hint?: string, details?: object, review?: object}}
 */
export function dateCheck(analysis, alignment, datesFile, options = {}, names = {}) {
  let ingest;
  try {
    ingest = ingestFor({
      alignment,
      dates_file: datesFile,
      dates_file_name: names.dates_file || options.dates_file_name || null,
      options
    });
  } catch (err) {
    // A caller's own regular expression is the one thing here that can throw rather than refuse.
    return { ok: false, code: "DATE_REGEX_INVALID", message: (err && err.message) || String(err), hint: refusalHint("DATE_REGEX_INVALID") };
  }
  if (!ingest.ok) {
    const refuse = (ingest.warnings || []).find((w) => w && w.severity === "refuse");
    const code = (refuse && refuse.code) || "DATES_NONE";
    return {
      ok: false,
      code,
      message: (refuse && refuse.message) || "No sequence in this alignment could be dated.",
      hint: refusalHint(code),
      details: { date_review: dateReview(ingest, { rows: false }) }
    };
  }
  const clock = clockReadiness(ingest);
  const possible = analysis === "temporal" ? clock.temporal_possible : clock.dating_possible;
  if (!possible) {
    const code = analysis === "temporal" ? "TEMPORAL_TOO_FEW_DATED" : "DATING_TOO_FEW_DATED";
    const reasons = analysis === "temporal" ? clock.temporal_reasons : clock.reasons;
    return {
      ok: false,
      code,
      message: "This date set cannot carry a clock: " + reasons.join("; ") + ".",
      hint: refusalHint(code),
      details: { date_review: dateReview(ingest, { rows: false }), headline: dateHeadline(ingest) }
    };
  }
  const gate = dateGate(ingest, options);
  if (!gate.ok) {
    const first = gate.blocking[0];
    return {
      ok: false,
      code: first.code,
      message: first.message,
      hint: first.hint,
      details: { gate, date_review: dateReview(ingest, { rows: false }) }
    };
  }
  return { ok: true, review: dateReview(ingest, { rows: false }), gate, clock, headline: dateHeadline(ingest) };
}

/**
 * The validate endpoint's body.
 *
 * ASYNC BECAUSE THE DIAGNOSIS RUNS THE SAME TN93 THE JOB WILL. A tree-free diagnosis does a full
 * model-level load of its own, so it computes the whole N x N distance matrix before any job is
 * accepted — and it computed it with the library's JavaScript port while every accepted job used
 * veg/tn93's compiled build. `diagnoseUpload` resolves the engine (loading a WebAssembly module,
 * hence the promise) and hands it to the same load. MEASURED per process, median of 7, this
 * machine, alignment only and no tree: korber 143 taxa 200 ms compiled against 373 in the port,
 * HIV1_RT 475 taxa 981 ms against 2,776 — and the diagnosis was IDENTICAL either way (same warning
 * codes and severities, byte-identical summary, checked on all five bundled examples), which is
 * why swapping it was allowed to be invisible. That port is now deleted, so the compiled engine's
 * fixed load is paid on a small upload too (bat_oas1, 18 taxa: 44 ms against 14) and
 * `summary.tn93_engine` reports which engine ran.
 *
 * AND IT CAN NOW SAY "NO ENGINE". `diagnoseUpload` never throws: a deployment whose vendored build
 * is missing or does not verify gets a `refuse`-level TN93_ENGINE_UNAVAILABLE row here, so
 * `/validate` tells an operator what is wrong with the INSTALLATION before a job is submitted and
 * fails in a worker.
 *
 * @param {{alignment: string, tree?: string, analysis?: string, use_tn93?: boolean,
 *   max_species?: number, dates_file?: string, options?: object}} input
 */
export async function validate({ alignment, tree, analysis = "analyze", use_tn93 = false, max_species, dates_file, options = {} }) {
  const treeGiven = typeof tree === "string" && tree.trim().length > 0;
  const maxSpecies = Number.isInteger(max_species) && max_species >= 2 ? Math.min(max_species, TAXON_CAP) : TAXON_CAP;
  // AN XML IS NOT DIAGNOSED AS AN ALIGNMENT, it is refused as the wrong field (ALIGNMENT_IS_XML).
  // Diagnosing it would not merely be useless, it would be misleading: MEASURED on a BEAST XML
  // built around H5N1_HA_geo's own alignment, `diagnose()` answers `NON_ACGT_FRACTION` over four
  // "sequences" named `<?xml`, `<taxon`, `<alignment` and `<sequence><taxon` — a refusal about a
  // nucleotide composition the document does not have, and a `sequence_count` a caller could act
  // on. Diagnosing the empty string instead gives the one honest answer (`FORMAT_UNKNOWN`, and a
  // summary of nulls) and leaves the sentence that says what to do to the refusal below it.
  const alignmentIsXml = looksLikeXml(alignment);
  // `diagnoseUpload` (not the library's `diagnose` directly) so the compiled TN93 engine is threaded
  // through the tree-free path here exactly as a job would run it, and so a missing/unverified
  // vendored build is caught at the door (TN93_ENGINE_UNAVAILABLE) rather than in a worker.
  const lib = await diagnoseUpload({
    alignmentText: alignmentIsXml ? "" : typeof alignment === "string" ? alignment : "",
    treeText: treeGiven ? tree : null,
    maxSpecies,
    taxaLimit: MAX_TAXA,
    useTn93: !!use_tn93
  });

  const warnings = [...lib.warnings];
  if (alignmentIsXml) {
    warnings.unshift({
      code: ALIGNMENT_IS_XML.code,
      severity: "refuse",
      message: ALIGNMENT_IS_XML.reason + " " + ALIGNMENT_IS_XML.hint,
      data: { analysis }
    });
  }
  const treeFree = warnings.find((w) => w.code === "TREE_FREE_TN93") || null;

  const summary = Object.assign(snakeSummary(lib.summary), {
    analysis,
    surface: "node-server",
    engine: "in-process",
    // `hasEmbeddedTree` is not asked of an XML: `extractTree` would find a BEAST starting tree in
    // one and report `tree_source: "embedded"` for a body this call is refusing, which is a claim
    // about a run that will not happen.
    tree_source: treeSourceFor({ treeGiven, embedded: !treeGiven && !alignmentIsXml && hasEmbeddedTree(alignment), treeFree: treeFree !== null }),
    tree_free: treeFree ? treeFree.data.reason : null,
    // Which TN93 computed the matrix this diagnosis was made from: 'wasm' (the vendored compiled
    // build) or 'custom' on a tree-free check, null when a tree supplied the distances, when the
    // upload was too large to load, or when no engine could be reached — in which case the
    // TN93_ENGINE_UNAVAILABLE refusal is in `warnings`.
    tn93_engine: lib.tn93_engine,
    distance_rescaled: lib.warnings.some((w) => w.code === "DISTANCE_RESCALED"),
    work: 0,
    mode: null,
    estimated_seconds: null
  });

  const capsAnalysis = capsAnalysisFor(analysis);
  const capsOptions = capsOptionsFor(analysis, options);
  // A REHEARSAL MUST REHEARSE THE REFUSAL, TOO: `sizeCheck` turns this body down, so validating it
  // must not say "fine" — that is the one way a rehearsal is worse than no rehearsal. The caps
  // block is skipped for the same reason it is skipped on any unreadable file: there is no size to
  // report on a document that is not sequences.
  const parsed = alignmentIsXml ? { format: "unknown", sequences: [] } : parseAlignment(alignment);
  if (capsAnalysis && parsed.sequences.length) {
    const probe = probeSequences(parsed.sequences);
    const taxa = parsed.sequences.length;
    summary.work = workFor(capsAnalysis, probe.codons, taxa, capsOptions);
    const cls = classifyRun(capsAnalysis, { codons: probe.codons, taxa }, capsOptions);
    // The temporal grid is sized here too, so a rehearsal answers the refusal the job would.
    const grid = analysis === "temporal" ? temporalGridCheck(probe.codons, options) : { ok: true };
    if (analysis === "temporal") {
      summary.time_points = grid.timePoints;
      summary.grid_cells = grid.cells;
    }
    if (!cls.ok) {
      warnings.push({
        code: "CAPS_EXCEEDED",
        severity: "refuse",
        message: cls.reason + (cls.hint ? " " + cls.hint : ""),
        data: { work: cls.work, codons: probe.codons, taxa, analysis }
      });
    } else if (!grid.ok) {
      warnings.push({
        code: grid.code,
        severity: "refuse",
        message: grid.reason + " " + grid.hint,
        data: { time_points: grid.timePoints, grid_cells: grid.cells, codons: probe.codons, analysis }
      });
    } else {
      summary.mode = "job";
      const cost = lib.warnings.find((w) => w.code === "COST_ESTIMATE");
      const secs = cost && Number.isFinite(cost.data.predictedSeconds) ? cost.data.predictedSeconds : null;
      summary.estimated_seconds = secs === null ? null : Math.round(secs * 10) / 10;
      warnings.push({
        code: "RUN_MODE",
        severity: "info",
        message:
          "The server runs " + (analysis === "analyze" ? "the whole report" : "hyphaeon " + analysis) +
          " in-process (ONNX Runtime under Node) as a job: POST /api/v1/jobs returns an id to poll or stream." +
          (secs === null ? "" : " Roughly " + (secs < 1 ? "< 1" : Math.round(secs)) + " s of model time."),
        data: { engine: "in-process", mode: "job", work: cls.work, estimated_seconds: summary.estimated_seconds }
      });
    }
  }

  // THE DATE LAYER, WHEN THE ANALYSIS HAS ONE. `POST /validate {analysis:"temporal", dates_file}`
  // answers the question a caller has before submitting: which sequences carry a date, by what
  // rule, over what span, and will either confirmation gate refuse the job. It costs no model byte
  // (measured at 3-24 ms on the bundled examples) and its refusals are the same codes, with the
  // same hints, that POST /jobs answers 422 with, so validating is a rehearsal and not a guess.
  let dates = null;
  if (analysis === "dates" || analysis === "dating" || analysis === "temporal") {
    const check = dateCheck(analysis === "dates" ? "dating" : analysis, alignment, dates_file, options);
    if (check.ok) {
      dates = { ok: true, headline: check.headline, clock: check.clock, gate: check.gate, date_review: check.review };
    } else {
      dates = { ok: false, code: check.code, message: check.message, hint: check.hint, date_review: (check.details && check.details.date_review) || null };
      // `dates` itself never refuses for a gate — reporting the gate is its job — but a metadata
      // file that did not parse is a refusal on every one of the three.
      const gateCode = check.code === "DATES_BARE_NUMBER_MAJORITY" || check.code === "DATES_UNDATED_PRESENT";
      if (analysis !== "dates" || !gateCode) {
        warnings.push({ code: check.code, severity: "refuse", message: check.message + " " + check.hint, data: { analysis } });
      } else {
        warnings.push({ code: check.code, severity: "warn", message: check.message + " " + check.hint, data: { analysis, gates_the: ["dating", "temporal"] } });
      }
    }
  }

  const ok = !warnings.some((w) => w.severity === "refuse");
  const out = { ok, warnings, summary };
  if (dates) out.dates = dates;
  return out;
}
