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
 */

import { memeCsv, bustedCsv, epistasisCsv, dmsCsv, graphml } from "@veg/hyphaeon-js";
import { shapeResult } from "@veg/hyphaeon-mcp/tools";
import { REPORT_SECTIONS } from "./runner.js";

export class FormatError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
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
    default:
      throw new FormatError(406, "No CSV form exists for `" + analysis + "`; request JSON.");
  }
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

  if (job.analysis !== "analyze") {
    const { provenance, analysis: _a, ...rest } = doc;
    if (format === "csv") return { type: "csv", body: toCsv(job.analysis, rest), filename: stem + ".csv" };
    if (format === "graphml") return { type: "graphml", body: toGraphml(rest), filename: stem + ".graphml" };
    return { type: "json", body: shapeResult(job.analysis, rest, provenance, { fields, top, summary_only: summaryOnly }) };
  }

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
    return { type: "json", body: shapeResult(analysis, section, doc.provenance, { fields, top, summary_only: summaryOnly }) };
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
