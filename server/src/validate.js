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
 * The response shape follows the MCP tool's: `{ok, warnings:[{code, severity, message, data}],
 * summary}` with the summary keys in snake_case as the CLI prints them.
 */

import { diagnose as libraryDiagnose, parseAlignmentSequences, sniffAlignmentFormat, extractTree } from "@veg/hyphaeon-js";
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
 * distances, O(N x L) and measured at 85-122 ms on korber's 143 x 981, while `use_model: true`
 * adds one forward pass over every codon and is the ordinary L x N^2 — and brings the pillar's own
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
 * @param {string} analysis   "dating" | "temporal"
 * @param {string} alignment
 * @param {string} [datesFile] the metadata document's TEXT
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
 * @param {{alignment: string, tree?: string, analysis?: string, use_tn93?: boolean,
 *   max_species?: number, dates_file?: string, options?: object}} input
 */
export function validate({ alignment, tree, analysis = "analyze", use_tn93 = false, max_species, dates_file, options = {} }) {
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
    surface: "node-server",
    engine: "in-process",
    tree_source: treeSourceFor({ treeGiven, embedded: !treeGiven && hasEmbeddedTree(alignment), treeFree: treeFree !== null }),
    tree_free: treeFree ? treeFree.data.reason : null,
    distance_rescaled: lib.warnings.some((w) => w.code === "DISTANCE_RESCALED"),
    work: 0,
    mode: null,
    estimated_seconds: null
  });

  const capsAnalysis = capsAnalysisFor(analysis);
  const capsOptions = capsOptionsFor(analysis, options);
  const parsed = parseAlignment(alignment);
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
