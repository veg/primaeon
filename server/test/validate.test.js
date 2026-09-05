/**
 * validate.test.js — POST /api/v1/validate: library codes, caps refusal, request validation.
 *
 * WHY THIS FILE EXISTS. PLAN.md 3.5 promises "identical codes to the browser": the route must
 * surface the library's diagnostic codes unchanged (bat_oas1 is the example whose tree is
 * DISTANCE_RESCALED on every surface, PHASE1.md), refuse what the caps refuse with the
 * CAPS_EXCEEDED code the MCP uses, and reject a malformed body before touching the library.
 *
 * D22 adds one contract to hold here: a MISSING TREE IS NOT A REFUSAL. camelid has no tree of its
 * own, and the route must answer ok with `TREE_FREE_TN93` at info level and
 * `summary.tree_source: "tn93"`; `use_tn93` must do the same on an alignment that DOES have a
 * usable tree. Nothing may report a branch-length estimator, because the server has none.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { example, silentLogger, testConfig } from "./helpers.js";

let handle;
let config;

beforeAll(() => {
  config = testConfig({ mcpEnabled: false });
  handle = createApp(config, { logger: silentLogger });
});

afterAll(async () => {
  await handle.close();
  config.cleanup();
});

describe("POST /api/v1/validate", () => {
  it("reports the library's codes for bat_oas1 and accepts it as a job", async () => {
    const ex = example("bat_oas1");
    const res = await request(handle.app).post("/api/v1/validate").send({ alignment: ex.alignment, tree: ex.tree });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const codes = res.body.warnings.map((w) => w.code);
    expect(codes).toContain("DISTANCE_RESCALED");
    expect(codes).toContain("RUN_MODE");
    expect(res.body.summary.sequence_count).toBe(18);
    expect(res.body.summary.codons).toBe(351);
    expect(res.body.summary.mode).toBe("job");
    expect(res.body.summary.surface).toBe("node-server");
    expect(res.body.summary.work).toBe(351 * 18 * 18);
  });

  it("accepts an alignment with no tree: TREE_FREE_TN93 at info, tree_source tn93, no estimator", async () => {
    const ex = example("bat_oas1");
    const res = await request(handle.app).post("/api/v1/validate").send({ alignment: ex.alignment });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const w = res.body.warnings.find((x) => x.code === "TREE_FREE_TN93");
    expect(w).toBeDefined();
    expect(w.severity).toBe("info");
    expect(w.data.reason).toBe("no_tree");
    expect(res.body.summary.tree_source).toBe("tn93");
    expect(res.body.summary.tree_free).toBe("no_tree");
    // The codes D22 retired must not come back, and nothing may claim an estimator.
    const codes = res.body.warnings.map((x) => x.code);
    expect(codes).not.toContain("TREE_MISSING");
    expect(codes).not.toContain("BRANCH_LENGTHS_MISSING");
    expect(codes).not.toContain("TN93_UNAVAILABLE");
    expect(JSON.stringify(res.body)).not.toMatch(/hyphy/i);
  });

  it("use_tn93 forces the tree-free path even when the tree is usable", async () => {
    const ex = example("bat_oas1");
    const withTree = await request(handle.app).post("/api/v1/validate").send({ alignment: ex.alignment, tree: ex.tree });
    expect(withTree.body.summary.tree_source).toBe("user");
    expect(withTree.body.warnings.map((w) => w.code)).not.toContain("TREE_FREE_TN93");
    const forced = await request(handle.app).post("/api/v1/validate").send({ alignment: ex.alignment, tree: ex.tree, use_tn93: true });
    expect(forced.status).toBe(200);
    expect(forced.body.ok).toBe(true);
    expect(forced.body.summary.tree_source).toBe("tn93");
    expect(forced.body.warnings.find((w) => w.code === "TREE_FREE_TN93").data.reason).toBe("requested");
  });

  it("refuses two sequences with a refuse-level warning", async () => {
    const res = await request(handle.app)
      .post("/api/v1/validate")
      .send({ alignment: ">a\nATGAAA\n>b\nATGAAG\n", tree: "(a:0.1,b:0.1);" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.warnings.some((w) => w.severity === "refuse")).toBe(true);
    expect(res.body.warnings.map((w) => w.code)).toContain("CAPS_EXCEEDED");
  });

  it("refuses a dms request above 3,000 codons through the MCP's caps table", async () => {
    const seq = "ATG".repeat(3001);
    const alignment = [">a", seq, ">b", seq, ">c", seq].join("\n") + "\n";
    const res = await request(handle.app).post("/api/v1/validate").send({ alignment, analysis: "dms" });
    expect(res.status).toBe(200);
    const caps = res.body.warnings.find((w) => w.code === "CAPS_EXCEEDED");
    expect(caps).toBeDefined();
    expect(caps.message).toMatch(/capped at 3000 sites/);
    expect(res.body.ok).toBe(false);
  });

  it("rejects a malformed body with 400 and the input kind", async () => {
    const res = await request(handle.app).post("/api/v1/validate").send({ alignmentText: "x" });
    expect(res.status).toBe(400);
    expect(res.body.error.kind).toBe("input");
    expect(res.body.error.code).toBe("BAD_REQUEST");
  });

  it("rejects a foreign Origin (same-origin API)", async () => {
    const res = await request(handle.app).post("/api/v1/validate").set("Origin", "https://evil.example").send({ alignment: ">a\nATG\n" });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("ORIGIN_FORBIDDEN");
  });

  it("answers health and version", async () => {
    const health = await request(handle.app).get("/api/v1/health");
    expect(health.status).toBe(200);
    expect(health.body.ok).toBe(true);
    expect(health.body.jobs.pool.size).toBe(1);
    const version = await request(handle.app).get("/api/v1/version");
    expect(version.status).toBe(200);
    expect(version.body.onnxruntime_node).toBe("1.23.2");
    expect(version.body.surface).toBe("node-server");
    expect(version.body.hyphaeon_js).toBeTruthy();
  });

  it("serves the models manifest", async () => {
    const res = await request(handle.app).get("/api/v1/models");
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(true);
    expect(res.body.variants.map((v) => v.name)).toEqual(expect.arrayContaining(["general", "viral"]));
    expect(res.body.engine.available).toBe(true);
    expect(res.body.engine.onnxruntime_node).toBe("1.23.2");
  });
});
