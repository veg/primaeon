/**
 * formats.test.js — result shaping without a model: CSV, GraphML, fields, top, sections.
 *
 * WHY THIS FILE EXISTS. The result route's formats are the library's Python-byte-equal writers
 * and the MCP's shaping; this pins the plumbing between them on a synthetic report so a
 * regression shows up in milliseconds rather than after a model run.
 */

import { describe, expect, it } from "vitest";
import { shapeResponse, FormatError } from "../src/formats.js";

const edges = [
  { site_u: 3, site_v: 9, ref_u: "A", ref_v: "K", lrt_u: 5.5, lrt_v: 4.4, similarity: 0.8, shared_branches: 3, cesi: 6.1, fdr_q: 0.01 },
  { site_u: 3, site_v: 12, ref_u: "A", ref_v: "R", lrt_u: 5.5, lrt_v: 3.3, similarity: 0.6, shared_branches: 2, cesi: 2.5, fdr_q: 0.04 }
];

const sites = Array.from({ length: 6 }, (_, i) => ({ site: i + 1, hyphaeon_lrt: (i * 1.7) % 5, p_value: 0.5, q_value: 0.7, is_invariable: i === 0 }));

const report = {
  schema_version: 2,
  kind: "report",
  sections: {
    sites: { sites, summary: {} },
    gene: { record: { gene: "g", taxa: 3, sites: 6, p_value_acat: 0.2 }, statistics: {} },
    epistasis: { edges, sectors: [] },
    attribution: null,
    filter: null,
    dms: null,
    phenotype: null
  },
  provenance: { surface: "node-server", warnings: [{ code: "SECTION_UNAVAILABLE", severity: "info", message: "DMS skipped: above the work budget", data: { section: "dms" } }] }
};
const job = { id: "0123456789abcdef0123456789abcdef", analysis: "analyze" };

describe("shapeResponse on a report", () => {
  it("returns the report untouched by default", () => {
    const r = shapeResponse(job, report, {});
    expect(r.type).toBe("json");
    expect(r.body).toBe(report);
  });

  it("CSV is the meme site table", () => {
    const r = shapeResponse(job, report, { format: "csv" });
    expect(r.type).toBe("csv");
    expect(r.filename).toBe("analyze-01234567-sites.csv");
    const lines = r.body.trim().split("\n");
    expect(lines[0]).toBe("site,hyphaeon_lrt,p_value,q_value,is_invariable");
    expect(lines).toHaveLength(7);
    expect(lines[1]).toBe("1,0.0,0.5,0.7,True");
  });

  it("GraphML is the epistasis network", () => {
    const r = shapeResponse(job, report, { format: "graphml" });
    expect(r.type).toBe("graphml");
    expect(r.body).toMatch(/^<\?xml version='1.0' encoding='utf-8'\?>/);
    expect(r.body).toMatch(/<edge source="3" target="9">/);
    expect(r.body).toMatch(/attr.name="cesi" attr.type="double"/);
  });

  it("top truncates every ranked collection and records it", () => {
    const r = shapeResponse(job, report, { top: "2" });
    expect(r.body.sections.sites.sites.map((s) => s.site)).toEqual([6, 3]); // highest hyphaeon_lrt first
    expect(r.body.sections.sites.truncated.sites).toEqual({ returned: 2, total: 6, ranked_by: "hyphaeon_lrt" });
    expect(r.body.sections.epistasis.edges).toHaveLength(2);
    expect(r.body.sections.epistasis.truncated).toBeUndefined();
    expect(r.body.sections.dms).toBeNull();
  });

  it("section picks one and applies fields", () => {
    const r = shapeResponse(job, report, { section: "epistasis", fields: "edges", top: "1" });
    expect(r.body.edges).toHaveLength(1);
    expect(r.body.edges[0].cesi).toBe(6.1);
    expect(r.body.sectors).toBeUndefined();
    expect(r.body.provenance.surface).toBe("node-server");
    const csv = shapeResponse(job, report, { section: "epistasis", format: "csv" });
    expect(csv.body.split("\n")[0]).toBe("site_u,site_v,ref_u,ref_v,lrt_u,lrt_v,similarity,shared_branches,cesi,fdr_q");
  });

  it("a null section is 404 with the provenance reason; bad knobs are 400/406", () => {
    expect(() => shapeResponse(job, report, { section: "dms" })).toThrow(FormatError);
    try {
      shapeResponse(job, report, { section: "dms" });
    } catch (e) {
      expect(e.status).toBe(404);
      expect(e.message).toMatch(/above the work budget/);
    }
    expect(() => shapeResponse(job, report, { section: "nope" })).toThrow(/section/);
    expect(() => shapeResponse(job, report, { format: "xlsx" })).toThrow(/format/);
    expect(() => shapeResponse(job, report, { top: "-1" })).toThrow(/top/);
    try {
      shapeResponse(job, report, { section: "gene", format: "graphml" });
    } catch (e) {
      expect(e.status).toBe(406);
    }
  });
});

describe("shapeResponse on a per-pillar document", () => {
  it("meme: fields/top/summary_only through the MCP's shaping", () => {
    const doc = { analysis: "meme", sites, taxa_count: 3, codon_count: 6, provenance: { surface: "node-server" } };
    const j = { id: job.id, analysis: "meme" };
    const top = shapeResponse(j, doc, { top: "3", fields: "sites,taxa_count" });
    expect(top.body.sites).toHaveLength(3);
    expect(top.body.taxa_count).toBe(3);
    expect(top.body.codon_count).toBeUndefined();
    expect(top.body.provenance.surface).toBe("node-server");
    const summary = shapeResponse(j, doc, { summary_only: "1" });
    expect(summary.body.summary.sites).toBe(6);
    expect(summary.body.summary.invariable_sites).toBe(1);
    const csv = shapeResponse(j, doc, { format: "csv" });
    expect(csv.body.split("\n")).toHaveLength(8);
  });

  it("evaluate has no CSV", () => {
    expect(() => shapeResponse({ id: job.id, analysis: "evaluate" }, { matched_genes: 1, provenance: {} }, { format: "csv" })).toThrow(/No CSV/);
  });
});
