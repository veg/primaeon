/**
 * analyze.test.js — hyphaeon_analyze: one alignment in, the whole report out, and the paging
 * around it.
 *
 * WHY THIS FILE EXISTS
 *
 * PLAN.md 4.0 / 4.1 (D21): the MCP "mirrors the product with a hyphaeon_analyze tool that runs
 * everything and returns the report". What has to be pinned here is the product's shape on this
 * surface, not the arithmetic (runtime/test/analyze.test.js owns that): every non-phenotype
 * section present and phenotype null, the sites section equal to `hyphaeon meme` on bat_oas1
 * (the report's default taxon cap of 256 does not bite at 18 taxa), the report always a job with
 * an id, `get_results section=` paging with top / fields / summary_only, `job_status` naming the
 * sections that are ready, the finished record as `hyphaeon://report/{id}`, and the tree-less
 * path (an NJ tree from HyPhy, PLAN.md 4.0 row 1) that no per-pillar tool offers.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { connect, parseText, example, examplesDir, waitFor, withinRel, TEST_THREADS } from "./helpers.js";
import { REPORT_SECTIONS } from "../src/resources.js";
import { summariseReport, shapeReport } from "../src/tools.js";
import { variantFromDiagnostics, referenceCommandsForReport } from "../src/engine.js";

const ENGINE_ROOT = path.resolve(examplesDir(), "..");
const memeRef = JSON.parse(readFileSync(path.join(ENGINE_ROOT, "fixtures", "e2e", "meme_bat_oas1.json"), "utf8"))[0].outputs;
const ANALYSIS_SECTIONS = ["sites", "gene", "epistasis", "attribution", "filter", "dms"];

describe("report shaping (no model)", () => {
  const report = {
    schema_version: 2,
    kind: "report",
    id: "r1",
    createdAt: "2026-09-05T00:00:00Z",
    inputs: { alignmentName: "a.fasta" },
    options: {},
    diagnostics: { warnings: [{ code: "SHALLOW_TREE", severity: "info" }], refused: false },
    sections: {
      sites: { taxa_count: 4, codon_count: 3, sites: [{ site: 1, hyphaeon_lrt: 1, p_value: 0.5, q_value: 0.5, is_invariable: false, call: "Neutral" }, { site: 2, hyphaeon_lrt: 5, p_value: 0.01, q_value: 0.02, is_invariable: false, call: "Strong" }, { site: 3, hyphaeon_lrt: 0, p_value: 1, q_value: 1, is_invariable: true, call: "Neutral" }] },
      gene: { record: { p_value_acat: 0.2, positive_selection_detected: false }, statistics: {} },
      epistasis: { edges: [{ site_u: 1, site_v: 2, cesi: 2 }, { site_u: 2, site_v: 3, cesi: 3 }], sectors: [] },
      attribution: { attributions: { 2: {} }, attribution_enabled: true },
      filter: { artifacts_masked: [], filter_enabled: true },
      dms: { plasticity: [{ site: 1, intrinsic_plasticity: 0.1 }, { site: 2, intrinsic_plasticity: 0.9 }], focal_taxon: "a", total_mutations: 57, progress: { done: 2, total: 3 } },
      phenotype: null
    },
    provenance: { surface: "mcp-stdio", model_variant: "viral", preprocessing: { taxa_used: 4, taxa_in_alignment: 5, tree_source: "user" } },
    timings: { infer: 0.1 }
  };

  it("summarises the overview strip and one line per section", () => {
    const s = summariseReport(report);
    expect(s.sections_present).toEqual(ANALYSIS_SECTIONS);
    expect(s.taxa_used).toBe(4);
    expect(s.model_variant).toBe("viral");
    expect(s.diagnostics.codes).toEqual(["SHALLOW_TREE"]);
    expect(s.sites.called_sites).toBe(1);
    expect(s.sites.invariable_sites).toBe(1);
    expect(s.gene.p_value_acat).toBe(0.2);
    expect(s.epistasis.edges).toBe(2);
    expect(s.attribution.attributed_sites).toBe(1);
    expect(s.dms.progress).toEqual({ done: 2, total: 3 });
    expect(s.phenotype).toMatch(/on demand/);
  });

  it("pages by section with top, fields and summary_only, and says when a section is absent", () => {
    const top = shapeReport(report, { section: "epistasis", top: 1 }, { job_id: "j" });
    expect(top.analysis).toBe("analyze");
    expect(top.section).toBe("epistasis");
    expect(top.edges).toEqual([{ site_u: 2, site_v: 3, cesi: 3 }]);
    expect(top.truncated.edges).toEqual({ returned: 1, total: 2, ranked_by: "cesi" });
    expect(top.provenance.surface).toBe("mcp-stdio");
    const fields = shapeReport(report, { section: "sites", fields: ["taxa_count", "nope"] });
    expect(fields.taxa_count).toBe(4);
    expect(fields.sites).toBeUndefined();
    expect(fields.unknown_fields).toEqual(["nope"]);
    const sum = shapeReport(report, { section: "dms", summary_only: true });
    expect(sum.summary.most_plastic[0].site).toBe(2);
    const pheno = shapeReport(report, { section: "phenotype" });
    expect(pheno.available).toBe(false);
    expect(pheno.note).toMatch(/hyphaeon_phenotype/);
    const whole = shapeReport(report, { summary_only: true });
    expect(whole.collections.sites).toEqual({ sites: 3 });
    expect(whole.collections.phenotype).toBeNull();
    const two = shapeReport(report, { fields: ["sites", "gene", "timings"] });
    expect(Object.keys(two.sections)).toEqual(["sites", "gene"]);
    expect(two.timings).toEqual({ infer: 0.1 });
    expect(two.diagnostics).toBeUndefined();
    const whole2 = shapeReport(report, { top: 1 });
    expect(whole2.sections.sites.sites).toHaveLength(1);
    expect(whole2.sections.dms.plasticity[0].site).toBe(2);
    expect(whole2.truncated.sites.sites.total).toBe(3);
  });

  it("chooses the variant from the tree regime and writes one CLI line per section", () => {
    expect(variantFromDiagnostics([{ code: "SHALLOW_TREE" }])).toBe("viral");
    expect(variantFromDiagnostics([{ code: "DEEP_LARGE_TREE" }])).toBe("general");
    const cmds = referenceCommandsForReport({ variant: "general", permutations: 1000, seed: 42, maxSpecies: 256 }, { alignment: "a.fasta", tree: "t.nwk" });
    expect(Object.keys(cmds)).toEqual(["sites", "gene", "epistasis", "dms"]);
    expect(cmds.sites).toContain("--attribute");
    expect(cmds.sites).toContain("--filter");
    expect(cmds.gene.slice(0, 2)).toEqual(["hyphaeon", "busted"]);
    expect(cmds.epistasis).toContain("--n-permutations");
    expect(cmds.epistasis).toContain("--no-dms");
    expect(cmds.dms.slice(0, 2)).toEqual(["hyphaeon", "dms"]);
    expect(REPORT_SECTIONS).toContain("diagnostics");
  });
});

describe("hyphaeon_analyze on bat_oas1 in-process", () => {
  let ctx;
  let alignment;
  let tree;
  let first;
  let jobId;

  beforeAll(async () => {
    ctx = await connect({ threads: TEST_THREADS });
    alignment = await example("bat_oas1.fasta");
    tree = await example("bat_oas1.nwk");
    const t0 = Date.now();
    const res = await ctx.client.callTool({ name: "hyphaeon_analyze", arguments: { alignment, tree, seed: 42, permutations: 200, wait_seconds: 600 } });
    if (res.isError) throw new Error("hyphaeon_analyze failed: " + res.content[0].text);
    first = parseText(res);
    jobId = first.job_id;
    console.log("[analyze] bat_oas1 report: " + (Date.now() - t0) + " ms; status " + first.status + "; inline keys " + Object.keys(first).slice(0, 8).join(","));
  }, 900000);
  afterAll(async () => {
    await ctx.close();
  });

  it("returns every non-phenotype section (inline or as a summary with the job id) with mcp-stdio provenance", async () => {
    expect(first.analysis).toBe("analyze");
    expect(first.status).toBe("completed");
    expect(jobId).toMatch(/^[0-9a-f]{32}$/);
    expect(first.report_uri).toBe("hyphaeon://report/" + jobId);
    expect(first.provenance.surface).toBe("mcp-stdio");
    expect(first.provenance.engine).toBe("in-process");
    expect(first.provenance.mds_sign).toBe("canonical");
    expect(first.provenance.model_variant).toBe("general");
    expect(first.provenance.variant_source).toBe("diagnostics");
    expect(first.provenance.seed).toBe(42);
    expect(Object.keys(first.provenance.reference_commands)).toEqual(["sites", "gene", "epistasis", "dms"]);
    // Either the whole record was small enough to inline, or its summary came back: both name the sections.
    const present = first.summary ? first.summary.sections_present : ANALYSIS_SECTIONS.filter((n) => first.sections[n] != null);
    expect(present).toEqual(ANALYSIS_SECTIONS);
    if (first.summary) {
      expect(first.note).toMatch(/inline limit/);
      expect(first.summary.phenotype).toMatch(/on demand/);
      expect(first.summary.taxa_used).toBe(18);
      expect(first.summary.codon_count).toBe(351);
    } else {
      expect(first.sections.phenotype).toBeNull();
      expect(first.kind).toBe("report");
      expect(first.schema_version).toBe(2);
    }
  });

  it("job_status shows the completed report and its uri; the sections page through get_results", async () => {
    const status = parseText(await ctx.client.callTool({ name: "job_status", arguments: { job_id: jobId } }));
    expect(status.status).toBe("completed");
    expect(status.analysis).toBe("analyze");
    expect(status.report_uri).toBe("hyphaeon://report/" + jobId);
    expect(status.result_available).toBe(true);

    const sites = parseText(await ctx.client.callTool({ name: "get_results", arguments: { job_id: jobId, section: "sites", top: 5 } }));
    expect(sites.section).toBe("sites");
    expect(sites.report_id).toBe(jobId);
    expect(sites.sites).toHaveLength(5);
    expect(sites.truncated.sites).toEqual({ returned: 5, total: 351, ranked_by: "hyphaeon_lrt" });
    expect(sites.sites[0].hyphaeon_lrt).toBeGreaterThanOrEqual(sites.sites[1].hyphaeon_lrt);
    expect(sites.taxa_count).toBe(18);
    expect(sites.provenance.surface).toBe("mcp-stdio");

    const gene = parseText(await ctx.client.callTool({ name: "get_results", arguments: { job_id: jobId, section: "gene" } }));
    expect(gene.record).toBeDefined();
    for (const k of ["p_value_acat", "p_value_simes", "omnibus_lrt", "total_selection_energy", "sig_sites_p05", "sig_sites_p10", "positive_selection_detected"]) {
      expect(gene.record).toHaveProperty(k);
    }
    expect(gene.statistics).toBeDefined();
    expect(gene.neural_head.deterministic_upstream).toBe(false);

    const epi = parseText(await ctx.client.callTool({ name: "get_results", arguments: { job_id: jobId, section: "epistasis", summary_only: true } }));
    expect(epi.summary).toHaveProperty("edges");
    expect(epi.summary).toHaveProperty("sectors");
    expect(epi.summary.permutations.n).toBe(200);
    expect(epi.summary.permutations.seed).toBe(42);

    const attr = parseText(await ctx.client.callTool({ name: "get_results", arguments: { job_id: jobId, section: "attribution", fields: ["attribution_enabled", "attributed_sites", "gate"] } }));
    expect(attr.attribution_enabled).toBe(true);
    expect(attr.gate.kind).toBe("called");
    expect(attr.attributions).toBeUndefined();

    const filter = parseText(await ctx.client.callTool({ name: "get_results", arguments: { job_id: jobId, section: "filter", summary_only: true } }));
    expect(filter.summary.filter_enabled).toBe(true);
    expect(typeof filter.summary.artifacts_masked).toBe("number");

    const dms = parseText(await ctx.client.callTool({ name: "get_results", arguments: { job_id: jobId, section: "dms", top: 3 } }));
    expect(dms.plasticity).toHaveLength(3);
    expect(dms.truncated.plasticity.ranked_by).toBe("intrinsic_plasticity");
    expect(dms.total_mutations).toBe(19 * 351);
    expect(dms.progress.total).toBe(351);
    expect(dms.progress.done).toBe(351);
    expect(dms.focal_index).toBe(0);
    expect(dms.focal_name).toBe("M_lyra"); // taxon 0 in tree order (fixtures/dms focal_name for the default)

    const diag = parseText(await ctx.client.callTool({ name: "get_results", arguments: { job_id: jobId, section: "diagnostics" } }));
    expect(diag.taxa_used).toBe(18);
    expect(diag.warnings.map((w) => w.code)).toContain("DISTANCE_RESCALED");
    expect(diag.preprocessing.tree_source).toBe("user");

    const pheno = parseText(await ctx.client.callTool({ name: "get_results", arguments: { job_id: jobId, section: "phenotype" } }));
    expect(pheno.available).toBe(false);
    expect(pheno.note).toMatch(/hyphaeon_phenotype/);

    const timings = parseText(await ctx.client.callTool({ name: "get_results", arguments: { job_id: jobId, section: "timings" } }));
    for (const k of ["prepare", "infer", "gene", "epistasis", "attribute", "filter", "dms", "total"]) expect(timings).toHaveProperty(k);

    const whole = parseText(await ctx.client.callTool({ name: "get_results", arguments: { job_id: jobId, summary_only: true } }));
    expect(whole.summary.sections_present).toEqual(ANALYSIS_SECTIONS);
    expect(whole.collections.dms).toEqual({ plasticity: 351 });
  });

  it("the sites section IS `hyphaeon meme` on bat_oas1: site order and is_invariable exact, LRT within 1e-5", async () => {
    const sites = parseText(await ctx.client.callTool({ name: "get_results", arguments: { job_id: jobId, section: "sites" } }));
    expect(sites.sites.map((s) => s.site)).toEqual(memeRef.sites.map((s) => s.site));
    expect(sites.sites.map((s) => s.is_invariable)).toEqual(memeRef.sites.map((s) => s.is_invariable));
    let worst = 0;
    for (let i = 0; i < memeRef.sites.length; i++) {
      const got = sites.sites[i].hyphaeon_lrt;
      const want = memeRef.sites[i].hyphaeon_lrt;
      worst = Math.max(worst, Math.abs(got - want) / Math.max(1, Math.abs(want)));
      expect(withinRel(got, want, 1e-5), "site " + (i + 1) + ": " + got + " vs " + want).toBe(true);
    }
    console.log("[analyze] sites vs hyphaeon meme: max relative |dLRT| " + worst.toExponential(2));
    expect(sites.sites.every((s) => typeof s.call === "string")).toBe(true);
  });

  it("hyphaeon://report/{id} serves the finished record, lists it, and explains an unknown id", async () => {
    const res = await ctx.client.readResource({ uri: "hyphaeon://report/" + jobId });
    expect(res.contents[0].mimeType).toBe("application/json");
    const report = JSON.parse(res.contents[0].text);
    expect(report.kind).toBe("report");
    expect(report.schema_version).toBe(2);
    expect(report.id).toBe(jobId);
    expect(ANALYSIS_SECTIONS.every((n) => report.sections[n] != null)).toBe(true);
    expect(report.sections.phenotype).toBeNull();
    expect(report.sections.sites.attention).toBeUndefined();
    expect(report.sections.sites.arrays).toBeUndefined();
    expect(report.provenance.report.sections_run).toEqual(ANALYSIS_SECTIONS);
    const { resources } = await ctx.client.listResources();
    expect(resources.map((r) => r.uri)).toContain("hyphaeon://report/" + jobId);
    const missing = await ctx.client.readResource({ uri: "hyphaeon://report/" + "0".repeat(32) });
    expect(missing.contents[0].text).toMatch(/^Error: no job/);
    const bad = await ctx.client.readResource({ uri: "hyphaeon://report/nope" });
    expect(bad.contents[0].text).toMatch(/^Error/);
  });

  it("wait_seconds 0 returns the job at once; sections become readable while it runs; the report completes", async () => {
    const queued = parseText(await ctx.client.callTool({ name: "hyphaeon_analyze", arguments: { alignment, tree, permutations: 100, dms: false, wait_seconds: 0 } }));
    expect(queued.job_id).toMatch(/^[0-9a-f]{32}$/);
    expect(["queued", "running"]).toContain(queued.status);
    expect(queued.report_uri).toBe("hyphaeon://report/" + queued.job_id);
    expect(queued.reason).toMatch(/wait_seconds is 0/);
    const early = await ctx.client.readResource({ uri: "hyphaeon://report/" + queued.job_id });
    if (early.contents[0].text.startsWith("Error")) expect(early.contents[0].text).toMatch(/is (queued|running)/);

    // Sections land in order; whichever is ready first is readable before the job completes.
    let sawPartial = false;
    const done = await waitFor(
      async () => {
        const s = parseText(await ctx.client.callTool({ name: "job_status", arguments: { job_id: queued.job_id } }));
        if (s.status === "running" && Array.isArray(s.sections_ready) && s.sections_ready.includes("sites") && !sawPartial) {
          const part = parseText(await ctx.client.callTool({ name: "get_results", arguments: { job_id: queued.job_id, section: "sites", top: 1 } }));
          if (part.status === "running") {
            sawPartial = true;
            expect(part.partial).toBe(true);
            expect(part.sites).toHaveLength(1);
          }
        }
        return s.status === "completed" || s.status === "failed" ? s : null;
      },
      { timeoutMs: 600000, stepMs: 25 }
    );
    expect(done.status).toBe("completed");
    console.log("[analyze] streaming run: partial sites section observed while running = " + sawPartial);
    const rec = parseText(await ctx.client.callTool({ name: "get_results", arguments: { job_id: queued.job_id, summary_only: true } }));
    expect(rec.summary.sections_present).toEqual(["sites", "gene", "epistasis", "attribution", "filter"]);
    expect(rec.collections.dms).toBeNull();
  }, 900000);

  it("with no tree at all the report builds an NJ tree first (tree_source nj) — the one tree-less path", async () => {
    const status = parseText(await ctx.client.callTool({ name: "list_models", arguments: {} }));
    const res = await ctx.client.callTool({ name: "hyphaeon_analyze", arguments: { alignment, permutations: 50, dms: false, wait_seconds: 600, section: "diagnostics" } });
    if (!status.native.branch_length_estimator) {
      expect(res.isError).toBe(true);
      expect(parseText(res).error).toMatch(/needs a phylogenetic tree/);
      return;
    }
    if (res.isError) throw new Error(res.content[0].text);
    const diag = parseText(res);
    expect(diag.status).toBe("completed");
    expect(diag.preprocessing.tree_source).toBe("nj");
    expect(diag.taxa_used).toBe(18);
    expect(diag.provenance.inputs.tree).toBe("nj.nwk");
  }, 900000);

  it("refuses --mds-sign lapack and an unreadable alignment before starting a job", async () => {
    const r1 = await ctx.client.callTool({ name: "hyphaeon_analyze", arguments: { alignment, tree, mds_sign: "lapack" } });
    expect(r1.isError).toBe(true);
    expect(parseText(r1).kind).toBe("input");
    const r2 = await ctx.client.callTool({ name: "hyphaeon_analyze", arguments: { alignment: "hello world" } });
    expect(r2.isError).toBe(true);
    expect(parseText(r2).error).toMatch(/no sequences/);
  });
});
