/**
 * jobs.test.js — the job lifecycle on bat_oas1 and the caps at the door.
 *
 * WHY THIS FILE EXISTS. PLAN.md 3.5's contract in one place: POST -> 202 {id} (128-bit hex), SSE
 * progress in the runtime's phases, a result with sections and a node-server provenance, the CSV
 * and GraphML formats, `fields`/`top`, DELETE -> 404; and the refusals that must happen before a
 * worker is touched: too many taxa, too many codons for dms, permutations above the cap, a body
 * above 8 MiB, an unknown analysis.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { example, listen, readSse, silentLogger, testConfig } from "./helpers.js";

let handle;
let config;
let srv;

beforeAll(async () => {
  config = testConfig({ mcpEnabled: false });
  handle = createApp(config, { logger: silentLogger });
  srv = await listen(handle.app);
});

afterAll(async () => {
  await srv.close();
  await handle.close();
  config.cleanup();
});

const ID_RE = /^[0-9a-f]{32}$/;

describe("job lifecycle (analyze, bat_oas1)", () => {
  let id;

  it("POST /api/v1/jobs answers 202 with a 128-bit id", async () => {
    const ex = example("bat_oas1");
    const res = await request(handle.app)
      .post("/api/v1/jobs")
      .send({ analysis: "analyze", alignment: ex.alignment, tree: ex.tree, names: ex.names, seed: 42 });
    expect(res.status).toBe(202);
    expect(res.body.id).toMatch(ID_RE);
    expect(res.headers.location).toBe("/api/v1/jobs/" + res.body.id);
    expect(["queued", "running"]).toContain(res.body.status);
    expect(res.body.analysis).toBe("analyze");
    expect(res.body.sections).toMatchObject({ sites: "pending", gene: "pending" });
    id = res.body.id;
  });

  it("GET /events streams status, progress phases, sections (DMS progressively), done", async () => {
    const events = await readSse(srv.baseUrl, "/api/v1/jobs/" + id + "/events");
    const kinds = events.map((e) => e.event);
    expect(kinds[0]).toBe("status");
    expect(kinds.at(-1)).toBe("done");
    const done = events.at(-1).data;
    expect(done.status).toBe("completed");
    const phases = new Set(events.filter((e) => e.event === "progress").map((e) => e.data.phase));
    // A late subscriber may have missed the early phases; a subscriber that saw any progress saw
    // the runtime's phase names and nothing else.
    for (const p of phases) expect(["parse", "prepare", "infer", "stats", "gene", "epistasis", "attribute", "filter", "dms", "postprocess"]).toContain(p);
    const sections = events.filter((e) => e.event === "section");
    const names = sections.map((e) => e.data.name);
    expect(names).toContain("sites");
    expect(names).toContain("gene");
    // PLAN.md 4.0 row 7: DMS runs last and fills in progressively — non-final updates, then one final.
    const dms = sections.filter((e) => e.data.name === "dms");
    if (dms.length) {
      expect(dms.filter((e) => e.data.final === false).length).toBeGreaterThan(0);
      expect(dms.at(-1).data.final).toBe(true);
      expect(names.indexOf("dms")).toBeGreaterThan(names.indexOf("sites"));
    }
  });

  it("GET /jobs/:id shows completed with section states and expiry", async () => {
    const res = await request(handle.app).get("/api/v1/jobs/" + id);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("completed");
    expect(res.body.result_available).toBe(true);
    expect(res.body.sections.sites).toBe("final");
    expect(res.body.sections.gene).toBe("final");
    expect(Date.parse(res.body.expires_at) - Date.parse(res.body.created_at)).toBeGreaterThan(6 * 24 * 3600 * 1000);
    expect(res.body.elapsed_sec).toBeGreaterThanOrEqual(0);
  });

  it("GET /result returns the report with sections and node-server provenance", async () => {
    const res = await request(handle.app).get("/api/v1/jobs/" + id + "/result");
    expect(res.status).toBe(200);
    const report = res.body;
    expect(report.schema_version).toBe(2);
    expect(report.kind).toBe("report");
    expect(Object.keys(report.sections)).toEqual(expect.arrayContaining(["sites", "gene", "epistasis", "attribution", "filter", "dms", "phenotype"]));
    expect(report.sections.sites.sites).toHaveLength(351);
    expect(report.sections.gene.record.p_value_acat).toBeGreaterThan(0);
    expect(report.provenance.surface).toBe("node-server");
    expect(report.provenance.seed ?? report.options.seed).toBe(42);
    expect(report.inputs.alignmentName).toBe("bat_oas1.fasta");
    expect(report.timings).toBeTypeOf("object");
    const top = [...report.sections.sites.sites].sort((a, b) => b.hyphaeon_lrt - a.hyphaeon_lrt).slice(0, 3).map((s) => s.site);
    expect(top.sort()).toEqual([273, 329, 332]); // PHASE1.md's bat_oas1 top sites
  });

  it("?format=csv is `hyphaeon meme --csv` of the site table", async () => {
    const res = await request(handle.app).get("/api/v1/jobs/" + id + "/result?format=csv");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(res.headers["content-disposition"]).toMatch(/attachment; filename="analyze-.*-sites\.csv"/);
    const lines = res.text.trim().split("\n");
    expect(lines[0]).toBe("site,hyphaeon_lrt,p_value,q_value,is_invariable");
    expect(lines).toHaveLength(352);
  });

  it("?top= truncates ranked collections and records it; ?section= picks one", async () => {
    const res = await request(handle.app).get("/api/v1/jobs/" + id + "/result?top=5");
    expect(res.status).toBe(200);
    expect(res.body.sections.sites.sites).toHaveLength(5);
    expect(res.body.sections.sites.truncated.sites).toMatchObject({ returned: 5, total: 351, ranked_by: "hyphaeon_lrt" });
    const gene = await request(handle.app).get("/api/v1/jobs/" + id + "/result?section=gene&fields=record");
    expect(gene.status).toBe(200);
    expect(gene.body.record).toBeDefined();
    expect(gene.body.statistics).toBeUndefined();
    expect(gene.body.provenance.surface).toBe("node-server");
    const bad = await request(handle.app).get("/api/v1/jobs/" + id + "/result?top=zero");
    expect(bad.status).toBe(400);
  });

  it("GraphML is 404 while the epistasis section is null, with the provenance's reason", async () => {
    const res = await request(handle.app).get("/api/v1/jobs/" + id + "/result?format=graphml");
    if (res.status === 200) {
      expect(res.text).toMatch(/^<\?xml version='1.0' encoding='utf-8'\?>/);
    } else {
      expect(res.status).toBe(404);
      expect(res.body.error.message).toMatch(/epistasis/);
    }
  });

  it("options.dms.enabled=false skips the DMS section and says so in the section states", async () => {
    const ex = example("bat_oas1");
    const post = await request(handle.app).post("/api/v1/jobs").send({ analysis: "analyze", alignment: ex.alignment, tree: ex.tree, options: { dms: { enabled: false }, epistasis: false, attribute: false, filter: false } });
    expect(post.status).toBe(202);
    const events = await readSse(srv.baseUrl, "/api/v1/jobs/" + post.body.id + "/events");
    expect(events.at(-1).data.status).toBe("completed");
    expect(events.filter((e) => e.event === "section" && e.data.name === "dms" && e.data.final === false)).toHaveLength(0);
    const view = await request(handle.app).get("/api/v1/jobs/" + post.body.id);
    expect(view.body.sections.sites).toBe("final");
    expect(view.body.sections.dms).toBe("null");
    const res = await request(handle.app).get("/api/v1/jobs/" + post.body.id + "/result?section=dms");
    expect(res.status).toBe(404);
    expect(res.body.error.message).toMatch(/dms/);
  });

  it("DELETE removes the job; a second GET is 404", async () => {
    const del = await request(handle.app).delete("/api/v1/jobs/" + id);
    expect(del.status).toBe(204);
    const gone = await request(handle.app).get("/api/v1/jobs/" + id);
    expect(gone.status).toBe(404);
    const again = await request(handle.app).delete("/api/v1/jobs/" + id);
    expect(again.status).toBe(404);
  });
});

describe("per-pillar jobs", () => {
  it("meme: result is the `hyphaeon meme -o` document plus provenance; CSV matches", async () => {
    const ex = example("bat_oas1");
    const post = await request(handle.app).post("/api/v1/jobs").send({ analysis: "meme", alignment: ex.alignment, tree: ex.tree, names: ex.names });
    expect(post.status).toBe(202);
    const id = post.body.id;
    await readSse(srv.baseUrl, "/api/v1/jobs/" + id + "/events");
    const res = await request(handle.app).get("/api/v1/jobs/" + id + "/result");
    expect(res.status).toBe(200);
    expect(res.body.analysis).toBe("meme");
    expect(res.body.sites).toHaveLength(351);
    expect(res.body.taxa_count).toBe(18);
    expect(res.body.provenance.surface).toBe("node-server");
    expect(res.body.provenance.reference_command.slice(0, 2)).toEqual(["hyphaeon", "meme"]);
    const csv = await request(handle.app).get("/api/v1/jobs/" + id + "/result?format=csv");
    expect(csv.text.split("\n")[0]).toBe("site,hyphaeon_lrt,p_value,q_value,is_invariable");
    const summary = await request(handle.app).get("/api/v1/jobs/" + id + "/result?summary_only=1");
    expect(summary.body.summary.sites).toBe(351);
    expect(summary.body.collections.sites).toBe(351);
  });

  it("busted: the record carries the omnibus statistics", async () => {
    const ex = example("bat_oas1");
    const post = await request(handle.app).post("/api/v1/jobs").send({ analysis: "busted", alignment: ex.alignment, tree: ex.tree, names: ex.names });
    expect(post.status).toBe(202);
    await readSse(srv.baseUrl, "/api/v1/jobs/" + post.body.id + "/events");
    const res = await request(handle.app).get("/api/v1/jobs/" + post.body.id + "/result");
    expect(res.status).toBe(200);
    expect(res.body.p_value_acat).toBeGreaterThan(0);
    expect(res.body.omnibus_lrt).toBeTypeOf("number");
    const csv = await request(handle.app).get("/api/v1/jobs/" + post.body.id + "/result?format=csv");
    expect(csv.status).toBe(200);
    expect(csv.text.split("\n")[0]).toMatch(/^Gene,Taxa,Sites,p_ACAT,p_Simes/);
  });

  it("a failed input (no tree) is a failed job with kind input, 410 on result", async () => {
    const ex = example("bat_oas1");
    const post = await request(handle.app).post("/api/v1/jobs").send({ analysis: "meme", alignment: ex.alignment });
    expect(post.status).toBe(202);
    const events = await readSse(srv.baseUrl, "/api/v1/jobs/" + post.body.id + "/events");
    const done = events.at(-1).data;
    expect(done.status).toBe("failed");
    expect(done.error.kind).toBe("input");
    const res = await request(handle.app).get("/api/v1/jobs/" + post.body.id + "/result");
    expect(res.status).toBe(410);
    expect(res.body.error.code).toBe("NOT_READY");
  });
});

describe("caps at the door", () => {
  const seq = "ATGAAACCC";

  it("refuses more than 1,000 sequences with 422 CAPS_EXCEEDED before any worker runs", async () => {
    const alignment = Array.from({ length: 1001 }, (_, i) => ">s" + i + "\n" + seq).join("\n") + "\n";
    const res = await request(handle.app).post("/api/v1/jobs").send({ analysis: "meme", alignment, tree: "(s0:0.1,s1:0.1);" });
    expect(res.status).toBe(422);
    expect(res.body.error.kind).toBe("input");
    expect(res.body.error.code).toBe("CAPS_EXCEEDED");
    expect(res.body.error.message).toMatch(/cap is 1000/);
    expect(res.body.error.details.sequences).toBe(1001);
  });

  it("refuses dms above 3,000 codons and analyze above 30,000", async () => {
    const dms = [">a", "ATG".repeat(3001), ">b", "ATG".repeat(3001), ">c", "ATG".repeat(3001)].join("\n");
    const r1 = await request(handle.app).post("/api/v1/jobs").send({ analysis: "dms", alignment: dms, tree: "(a:1,b:1,c:1);" });
    expect(r1.status).toBe(422);
    expect(r1.body.error.message).toMatch(/capped at 3000/);
    const big = [">a", "ATG".repeat(30001), ">b", "ATG".repeat(30001), ">c", "ATG".repeat(30001)].join("\n");
    const r2 = await request(handle.app).post("/api/v1/jobs").send({ analysis: "analyze", alignment: big, tree: "(a:1,b:1,c:1);" });
    expect(r2.status).toBe(422);
    expect(r2.body.error.message).toMatch(/capped at 30000/);
  });

  it("refuses permutations above 10,000", async () => {
    const ex = example("bat_oas1");
    const res = await request(handle.app).post("/api/v1/jobs").send({ analysis: "analyze", alignment: ex.alignment, tree: ex.tree, options: { permutations: 20000 } });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("CAPS_EXCEEDED");
  });

  it("refuses a body above 8 MiB with 413", async () => {
    const alignment = ">a\n" + "A".repeat(8 * 1024 * 1024 + 10) + "\n";
    const res = await request(handle.app).post("/api/v1/jobs").send({ analysis: "meme", alignment });
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("rejects an unknown analysis and a missing alignment", async () => {
    const r1 = await request(handle.app).post("/api/v1/jobs").send({ analysis: "relax", alignment: ">a\nATG\n" });
    expect(r1.status).toBe(400);
    const r2 = await request(handle.app).post("/api/v1/jobs").send({ analysis: "meme" });
    expect(r2.status).toBe(422);
    expect(r2.body.error.code).toBe("MISSING_INPUT");
    const r3 = await request(handle.app).post("/api/v1/jobs").send({ analysis: "evaluate", alignment: ">a\nATG\n" });
    expect(r3.status).toBe(422);
  });

  it("404s an unknown or malformed job id", async () => {
    expect((await request(handle.app).get("/api/v1/jobs/deadbeef")).status).toBe(404);
    expect((await request(handle.app).get("/api/v1/jobs/" + "0".repeat(32))).status).toBe(404);
    expect((await request(handle.app).get("/api/v1/jobs/" + "0".repeat(32) + "/events")).status).toBe(404);
  });
});
