/**
 * formats.js — `GET /api/v1/jobs/:id/result` shaping: JSON with provenance, `?format=csv|graphml`,
 * `?fields=`, `?top=`, `?section=`.
 *
 * WHY THIS FILE EXISTS
 *
 * PLAN.md 3.5 gives the result route three knobs and two alternative formats. The JSON knobs
 * (`fields`, `top`) are the MCP's `get_results` knobs, so they are the MCP's implementation:
 * `shapeResult` from @veg/hyphaeon-mcp/tools ranks and truncates the same collections by the
 * same keys (sites by hyphaeon_lrt, edges by cesi, sectors by spectral_coherence, plasticity by
 * intrinsic_plasticity) and records `truncated`. The CSV and GraphML bodies are the library's
 * Python-byte-equal writers (@veg/hyphaeon-js writers.js): `memeCsv` is `hyphaeon meme --csv`,
 * `bustedCsv` is `hyphaeon busted --csv`, `epistasisCsv` / `dmsCsv` are cli.py's DataFrame dumps,
 * `graphml` is `nx.write_graphml` of the co-selection edges. The server adds no format of its own.
 *
 * For an `analyze` report the knobs apply per section: `?section=sites&format=csv` is the meme
 * CSV of the report's site table, `?format=graphml` with no section is the epistasis network
 * (the only GraphML a report has), `?top=20` truncates every ranked collection in every section.
 * A section that is `null` in the report (not computed, e.g. DMS above the work budget) gives
 * 404 with the reason from the provenance warnings rather than an empty file.
 *
 * ── PHASE 6: TWO PILLARS THAT WRITE MORE THAN ONE FILE ───────────────────────────────────────
 *
 * Every analysis before these had at most one CSV and one GraphML, which is what `toCsv` assumed.
 * `hyphaeon temporal` writes FOUR files (`_sites_summary.csv`, `_curves.csv`, `_waves.csv`,
 * `_summary.json`) and `hyphaeon dating` writes two (a JSON and a per-taxon CSV), so `?file=` names
 * one of them and its absence leaves every route that existed before behaving as it did. The
 * writers are the runtime's, byte-equal to the reference's own output (src/time.js
 * REFERENCE_FILES), and BYTE-EQUAL FORMAT IS NOT REPRODUCIBLE CONTENT: the temporal numbers differ
 * from a CLI run's because a different generator draws the null. That is why every JSON answer for
 * these two carries `honesty`, with its `{command, reproduces, caveats}` reproduction object and
 * the runtime's mandatory download notes, and why `?file=` sets `Content-Disposition` rather than
 * pretending the bytes are an API response.
 *
 * `?section=` also works on a temporal result, over the MCP's own ten-name vocabulary and through
 * the MCP's own `temporalSection`, so `get_results section=curves` and
 * `GET /result?section=curves` are one implementation and cannot drift.
 *
 * ── WHY THIS ROUTE SERVES A WHOLE TEMPORAL RECORD AND `hyphaeon_temporal` NEVER WILL ─────────
 *
 * The MCP publishes `caps.temporal.record_never_inline` (mcp/src/resources.js) and means it: a tool
 * result is spent in a model's CONTEXT WINDOW, where 2.1 MB is 8.2x the 256 KiB inline limit and
 * 7.18 MB on the engine's acceptance run is 27x, so the tool answers with the summary and a job id
 * and `get_results section=` pages the rest. An HTTP client has no context window. It asked for a
 * file, and `GET /jobs/:id/result` has answered `analyze` jobs with megabyte reports since Phase 2.
 * Making the two surfaces agree by refusing here would make this one useless, so they differ — and
 * each can say why.
 *
 * What the two DO agree on is that a record above a measured size is not handed over in one piece.
 * The constraint on this side is not the reader, it is this process: the document is read, parsed
 * and re-serialised on the HTTP event loop the worker pool exists to keep free, and its size is the
 * caller's choice (about 8 KB per `time_points` grid point — 2,162,993 bytes at the reference's
 * default grid on the bundled example, 16,272,879 at `time_points: 2000`). So `GET /result` with no
 * `?section=` / `?file=` is guarded at TEMPORAL_RECORD_BYTES_MAX (src/time.js) and answers 406
 * `TEMPORAL_RECORD_TOO_LARGE` above it, naming the same two doors `record_never_inline` names.
 * `?file=` is unguarded on purpose: those bodies are the runtime's writers streamed as text, with
 * no parse and no re-serialisation.
 *
 * Every `?section=` answer, on a finished job and a running one alike, goes through
 * `sectionEnvelope` below: one shape, with `honesty` at the top level in both states.
 */

import { memeCsv, bustedCsv, epistasisCsv, dmsCsv, graphml } from "@veg/hyphaeon-js";
import { shapeResult } from "@veg/hyphaeon-mcp/tools";
import { REPORT_SECTIONS } from "./runner.js";
import { REFERENCE_FILES, TEMPORAL_SECTIONS, referenceFileNames, temporalResultSection } from "./time.js";

export class FormatError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * ONE ENVELOPE FOR `GET /api/v1/jobs/:id/result?section=`, WHATEVER THE JOB'S STATE.
 *
 * Until this function existed the same URL answered in two shapes. A RUNNING job gave
 * `{analysis, section, final, status, payload: {..., honesty}}` — the live payload nested one level
 * down — and a FINISHED one gave the section body at the top level, `{analysis, section, stage,
 * honesty, summary, provenance}`. So a client that read `body.honesty` got `undefined` exactly
 * while the run was in flight, which is the state honesty is for: a temporal null mid-draw is the
 * one moment at which "nothing is called" must not be read as a finding.
 *
 * The settled shape is the FINISHED one, flat, with the two state fields the running case needs
 * added to it on every answer:
 *
 *   {analysis, section, status, final, ...the section's own body}
 *
 * `analysis` is the JOB's analysis on every answer. A report section is SHAPED as another pillar
 * (`sites` through `shapeResult('meme', ...)`), and that name used to leak out as `analysis` on a
 * finished section and not on a running one; it is preserved as `section_analysis` instead, so
 * nothing is lost and one key does not mean two things.
 *
 * THE SSE `section` EVENT IS NOT THIS AND IS NOT MEANT TO BE. Its `{name, final, payload}` is an
 * EVENT frame — the name is how a listener routes it and the payload is the thing routed — and it
 * sits inside `event: section` with an id, which is the envelope there. This function is about the
 * RESOURCE at `/jobs/:id/result?section=`, where the same URL used to answer in two shapes
 * depending on when you asked. One URL, one shape; one event, one frame.
 *
 * @param {{analysis: string, section: string, status: string, final: boolean, body: any}} args
 */
export function sectionEnvelope({ analysis, section, status, final, body }) {
  const head = { analysis, section, status, final: Boolean(final) };
  if (body === null || body === undefined || typeof body !== "object" || Array.isArray(body)) {
    // A section that is explicitly `null` (a report section that was not computed) keeps its
    // shape rather than being dressed as an object with no keys.
    return Object.assign(head, { payload: body === undefined ? null : body });
  }
  const rest = Object.assign({}, body);
  const bodyAnalysis = rest.analysis;
  delete rest.analysis;
  delete rest.section;
  if (bodyAnalysis && bodyAnalysis !== analysis) head.section_analysis = bodyAnalysis;
  return Object.assign(head, rest);
}

/** Which per-pillar analysis a report section is shaped as (for fields/top and the writers). */
const SECTION_ANALYSIS = Object.freeze({
  sites: "meme",
  gene: "busted",
  epistasis: "epistasis",
  attribution: "meme",
  filter: "meme",
  dms: "dms",
  phenotype: "phenotype"
});

function parseFields(q) {
  if (q === undefined || q === null || q === "") return undefined;
  const list = (Array.isArray(q) ? q : String(q).split(","))
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length ? list : undefined;
}

/** `?sites=12,44,90`: the 1-indexed codons a temporal `sites` or `curves` section is about. */
function parseSites(q) {
  if (q === undefined || q === null || q === "") return undefined;
  const list = (Array.isArray(q) ? q : String(q).split(","))
    .map((s) => String(s).trim())
    .filter(Boolean)
    .map((s) => Number.parseInt(s, 10));
  if (list.some((n) => !Number.isInteger(n))) throw new FormatError(400, "`sites` must be a comma-separated list of 1-indexed codon numbers.");
  return list.length ? list : undefined;
}

function parseTop(q) {
  if (q === undefined || q === null || q === "") return undefined;
  const n = parseInt(q, 10);
  if (!Number.isInteger(n) || n < 1) throw new FormatError(400, "`top` must be a positive integer.");
  return n;
}

/** Sites of a report's `sites` section, in Python-key records (the section holds runMeme's rows). */
function siteRecords(section) {
  const rows = Array.isArray(section && section.sites) ? section.sites : [];
  return rows;
}

/**
 * CSV text for a per-pillar result or a report section.
 * @param {string} analysis  meme | busted | epistasis | dms | evaluate
 * @param {object} doc
 */
export function toCsv(analysis, doc) {
  switch (analysis) {
    case "meme":
      return memeCsv(siteRecords(doc), { attribution: doc.attribution_enabled || undefined });
    case "busted":
      return bustedCsv([doc.record || doc]);
    case "epistasis":
      return epistasisCsv({ edges: doc.edges, sectors: doc.sectors, plasticity: doc.plasticity }, { command: "epistasis" });
    case "dms":
      return dmsCsv(Array.isArray(doc.plasticity) ? doc.plasticity : []);
    // The two time pillars' primary tables, through the runtime's byte-equal writers. `?file=`
    // reaches the other four; `?format=csv` alone keeps meaning "this analysis's main table".
    case "temporal":
      return REFERENCE_FILES.temporal.sites.write(doc, {});
    case "dating":
      return REFERENCE_FILES.dating.csv.write(doc, {});
    default:
      throw new FormatError(406, "No CSV form exists for `" + analysis + "`; request JSON.");
  }
}

/**
 * One of the reference's own output files, by the name `?file=` asks for it by.
 *
 * @param {string} analysis
 * @param {object} doc   the stored result document
 * @param {string} name  a key of REFERENCE_FILES[analysis]
 * @param {object} query req.query (`prediction_method=1` adds dating's own extra column)
 */
export function toReferenceFile(analysis, doc, name, query = {}) {
  const files = REFERENCE_FILES[analysis];
  if (!files) {
    throw new FormatError(406, "`file` is only meaningful for an analysis that writes the reference's own output files (" + Object.keys(REFERENCE_FILES).join(", ") + ").");
  }
  const spec = files[name];
  if (!spec) throw new FormatError(400, "`file` must be one of " + referenceFileNames(analysis).join(", ") + " for a " + analysis + " result.");
  // The reference does NOT emit `prediction_method`; it is this build's own column, and it says
  // which of three models produced each predicted date. Off by default so the file diffs against a
  // CLI run, on by request for a reader who wants to know.
  const predictionMethod = query.prediction_method === "1" || query.prediction_method === "true";
  return { type: spec.type, body: spec.write(doc, { predictionMethod }), suffix: spec.suffix };
}

/** GraphML of a co-selection network (edges with site_u/site_v/similarity/cesi/shared_branches/fdr_q). */
export function toGraphml(doc) {
  const edges = Array.isArray(doc && doc.edges) ? doc.edges : null;
  if (!edges) throw new FormatError(406, "GraphML is available only for an epistasis network (edges).");
  return graphml(edges);
}

function nullSectionReason(report, name) {
  const warnings = (report.provenance && report.provenance.warnings) || [];
  const w = warnings.find((x) => x && x.data && x.data.section === name);
  return w ? w.message : "The `" + name + "` section was not computed for this report.";
}

/**
 * Shape a stored result document for the response.
 *
 * @param {object} job     the job view (analysis, id)
 * @param {object} doc     the stored result (report or per-pillar document with provenance)
 * @param {object} query   req.query
 * @returns {{type: "json"|"csv"|"graphml", body: object|string, filename?: string}}
 */
export function shapeResponse(job, doc, query = {}) {
  const format = query.format ? String(query.format).toLowerCase() : "json";
  const fields = parseFields(query.fields);
  const top = parseTop(query.top);
  const summaryOnly = query.summary_only === "1" || query.summary_only === "true";
  const stem = job.analysis + "-" + job.id.slice(0, 8);

  if (!["json", "csv", "graphml"].includes(format)) {
    throw new FormatError(400, "`format` must be json, csv or graphml.");
  }

  const file = query.file ? String(query.file) : null;

  if (job.analysis !== "analyze") {
    const { provenance, analysis: _a, ...rest } = doc;
    if (file) {
      const out = toReferenceFile(job.analysis, rest, file, query);
      return { type: out.type === "json" ? "json-text" : out.type, body: out.body, filename: stem + out.suffix };
    }
    if (format === "csv") return { type: "csv", body: toCsv(job.analysis, rest), filename: stem + ".csv" };
    if (format === "graphml") return { type: "graphml", body: toGraphml(rest), filename: stem + ".graphml" };
    // A temporal result pages by section over the MCP's own vocabulary and its own implementation.
    if (job.analysis === "temporal" && query.section) {
      const name = String(query.section);
      if (!TEMPORAL_SECTIONS.includes(name)) {
        throw new FormatError(400, "`section` must be one of " + TEMPORAL_SECTIONS.join(", ") + " for a temporal result.");
      }
      try {
        const body = Object.assign(temporalResultSection(rest, name, { sites: parseSites(query.sites), top }), { provenance });
        return { type: "json", body: sectionEnvelope({ analysis: job.analysis, section: name, status: job.status, final: true, body }) };
      } catch (err) {
        // `sites` out of range is the caller's, not the server's (the MCP names the error the same
        // way); anything else is a real failure and must not be dressed as a bad request.
        if (err && err.name === "TemporalSiteRangeError") throw new FormatError(400, err.message);
        throw err;
      }
    }
    if (query.section) throw new FormatError(400, "`section` is not meaningful for a " + job.analysis + " result.");
    return { type: "json", body: shapeResult(job.analysis, rest, provenance, { fields, top, summary_only: summaryOnly }) };
  }
  if (file) throw new FormatError(400, "`file` is not meaningful for a report; use ?section= and ?format=.");

  // A report.
  const sectionName = query.section ? String(query.section) : null;
  if (sectionName && !REPORT_SECTIONS.includes(sectionName)) {
    throw new FormatError(400, "`section` must be one of " + REPORT_SECTIONS.join(", ") + ".");
  }
  const sections = doc.sections || {};

  if (format === "graphml") {
    const name = sectionName || "epistasis";
    if (name !== "epistasis") throw new FormatError(406, "GraphML is available only for the epistasis section.");
    if (!sections.epistasis) throw new FormatError(404, nullSectionReason(doc, "epistasis"));
    return { type: "graphml", body: toGraphml(sections.epistasis), filename: stem + "-epistasis.graphml" };
  }

  if (sectionName) {
    const section = sections[sectionName];
    if (section === null || section === undefined) throw new FormatError(404, nullSectionReason(doc, sectionName));
    const analysis = SECTION_ANALYSIS[sectionName];
    if (format === "csv") return { type: "csv", body: toCsv(analysis, section), filename: stem + "-" + sectionName + ".csv" };
    // The same envelope a RUNNING report section answers in; the per-pillar name this section is
    // shaped as travels as `section_analysis` rather than overwriting the job's own `analysis`.
    const body = shapeResult(analysis, section, doc.provenance, { fields, top, summary_only: summaryOnly });
    return { type: "json", body: sectionEnvelope({ analysis: job.analysis, section: sectionName, status: job.status, final: true, body }) };
  }

  if (format === "csv") {
    if (!sections.sites) throw new FormatError(404, nullSectionReason(doc, "sites"));
    return { type: "csv", body: toCsv("meme", sections.sites), filename: stem + "-sites.csv" };
  }

  // Whole report as JSON; `top` and `fields` apply inside every non-null section.
  let out = doc;
  if (top !== undefined || fields !== undefined) {
    const shaped = {};
    for (const name of REPORT_SECTIONS) {
      const section = sections[name];
      if (!section) {
        shaped[name] = section === undefined ? null : section;
        continue;
      }
      const s = shapeResult(SECTION_ANALYSIS[name], section, undefined, { fields, top });
      delete s.provenance;
      delete s.analysis;
      shaped[name] = s;
    }
    out = Object.assign({}, doc, { sections: shaped });
  }
  return { type: "json", body: out };
}
