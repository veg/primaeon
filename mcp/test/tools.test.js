import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { connect, parseText, example, waitFor } from "./helpers.js";
import { TOOL_NAMES } from "../src/tools.js";
import { PROMPT_NAMES } from "../src/prompts.js";

describe("tool registry", () => {
  let ctx;
  beforeAll(async () => {
    ctx = await connect();
  });
  afterAll(async () => {
    await ctx.close();
  });

  it("tools/list has all eleven names", async () => {
    const { tools } = await ctx.client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([...TOOL_NAMES].sort());
    expect(names).toHaveLength(11);
    for (const t of tools) expect(t.description.length).toBeGreaterThan(20);
  });

  it("prompts/list has one interpretation guide per pillar plus choose-analysis", async () => {
    const { prompts } = await ctx.client.listPrompts();
    const names = prompts.map((p) => p.name).sort();
    expect(names).toEqual([...PROMPT_NAMES].sort());
    const meme = await ctx.client.getPrompt({ name: "interpret-meme" });
    expect(meme.messages[0].content.text).toMatch(/Rank is strong, scale is compressed/);
    const choose = await ctx.client.getPrompt({ name: "choose-analysis", arguments: { question: "which sites?" } });
    expect(choose.messages[0].content.text).toMatch(/hyphaeon_meme/);
  });

  it("job_status on an unknown id reports not_found", async () => {
    const res = await ctx.client.callTool({ name: "job_status", arguments: { job_id: "0".repeat(32) } });
    expect(parseText(res).status).toBe("not_found");
  });

  it("list_models tolerates a missing manifest", async () => {
    const res = await ctx.client.callTool({ name: "list_models", arguments: {} });
    const body = parseText(res);
    expect(body).toHaveProperty("available");
    expect(body).toHaveProperty("searched");
    expect(body.variants.map((v) => v.variant)).toContain("general");
    expect(body.bridge.surface).toBe("python-reference");
  });
});

describe("hyphaeon_validate", () => {
  let ctx;
  beforeAll(async () => {
    ctx = await connect();
  });
  afterAll(async () => {
    await ctx.close();
  });

  it("accepts Smc6.fasta with its tree", async () => {
    const alignment = await example("Smc6.fasta");
    const tree = await example("Smc6.nwk");
    const res = await ctx.client.callTool({ name: "hyphaeon_validate", arguments: { alignment, tree } });
    const body = parseText(res);
    expect(res.isError).toBeFalsy();
    expect(body.ok).toBe(true);
    expect(body.summary.format).toBe("fasta");
    expect(body.summary.sequence_count).toBe(20);
    expect(body.summary.codons).toBe(1097);
    expect(body.summary.tree_tips).toBe(20);
    const codes = body.warnings.map((w) => w.code);
    expect(codes).toContain("FORMAT_DETECTED");
    expect(codes).toContain("COST_ESTIMATE");
    expect(body.warnings.every((w) => ["info", "warn", "refuse"].includes(w.severity))).toBe(true);
    expect(body.warnings.some((w) => w.severity === "refuse")).toBe(false);
  });

  it("refuses when no tree is given and use_tn93 is off, accepts with use_tn93", async () => {
    const alignment = await example("bat_oas1.fasta");
    const r1 = parseText(await ctx.client.callTool({ name: "hyphaeon_validate", arguments: { alignment } }));
    expect(r1.ok).toBe(false);
    expect(r1.warnings.find((w) => w.code === "TREE_MISSING").severity).toBe("refuse");
    const r2 = parseText(await ctx.client.callTool({ name: "hyphaeon_validate", arguments: { alignment, use_tn93: true } }));
    expect(r2.ok).toBe(true);
    expect(r2.summary.tree_source).toBe("tn93");
  });

  it("refuses alignment taxa that have no tree tip and reports unmatched tips", async () => {
    const alignment = ">a\nATGAAATTT\n>b\nATGAAATTC\n>c\nATGAAGTTT\n>d\nATGCAATTT\n";
    const tree = "((a:0.1,b:0.1):0.05,(c:0.1,zzz:0.1):0.05);";
    const body = parseText(await ctx.client.callTool({ name: "hyphaeon_validate", arguments: { alignment, tree } }));
    expect(body.ok).toBe(false);
    const missing = body.warnings.find((w) => w.code === "ALIGNMENT_TAXA_MISSING_FROM_TREE");
    expect(missing.severity).toBe("refuse");
    expect(missing.sequences).toEqual(["d"]);
    const unmatched = body.warnings.find((w) => w.code === "TREE_TIPS_UNMATCHED");
    expect(unmatched.tips).toEqual(["zzz"]);
  });

  it("refuses fewer than three taxa and flags frame and stop problems", async () => {
    const alignment = ">a\nATGTAAAAATTTA\n>b\nATGTAGAAATTTA\n";
    const tree = "(a:0.1,b:0.1);";
    const body = parseText(await ctx.client.callTool({ name: "hyphaeon_validate", arguments: { alignment, tree } }));
    const codes = body.warnings.map((w) => w.code);
    expect(body.ok).toBe(false);
    expect(codes).toContain("TOO_FEW_TAXA");
    expect(codes).toContain("LENGTH_NOT_MULTIPLE_OF_3");
    expect(codes).toContain("IN_FRAME_STOPS");
  });

  it("recognises NEXUS with an embedded tree (RHO.fasta)", async () => {
    const alignment = await example("RHO.fasta");
    const body = parseText(await ctx.client.callTool({ name: "hyphaeon_validate", arguments: { alignment, analysis: "phenotype" } }));
    expect(body.summary.format).toBe("nexus");
    expect(body.summary.sequence_count).toBe(710);
    expect(body.summary.tree_source).toBe("embedded");
    expect(body.warnings.map((w) => w.code)).toContain("TAXA_ABOVE_CAP");
  });
});

describe("analysis tools without Python (stubbed bridge)", () => {
  let ctx;
  const calls = [];
  const fakeMeme = () => ({
    result: {
      alignment: "alignment.fasta",
      tree: "tree.nwk",
      taxa_count: 18,
      codon_count: 12,
      runtime_sec: 0.01,
      filter_enabled: false,
      artifacts_masked: [],
      attribution_enabled: false,
      attributions: {},
      sites: Array.from({ length: 12 }, (_, i) => ({
        site: i + 1,
        hyphaeon_lrt: (i * 7) % 12,
        p_value: 1 - i / 12,
        q_value: 1 - i / 24,
        is_invariable: i % 4 === 0
      }))
    },
    provenance: { surface: "python-reference", reference_version: "1.0.0", elapsed_sec: 0.01, command: ["hyphaeon", "meme"] }
  });
  beforeAll(async () => {
    ctx = await connect({
      bridge: async (req) => {
        calls.push(req);
        if (req.signal) {
          await new Promise((resolve, reject) => {
            const t = setTimeout(resolve, 30);
            req.signal.addEventListener("abort", () => {
              clearTimeout(t);
              reject(Object.assign(new Error("aborted"), { kind: "input" }));
            });
          });
        }
        return fakeMeme();
      }
    });
  });
  afterAll(async () => {
    await ctx.close();
  });

  it("hyphaeon_meme runs synchronously under the caps and carries provenance", async () => {
    const alignment = await example("bat_oas1.fasta");
    const tree = await example("bat_oas1.nwk");
    const res = await ctx.client.callTool({ name: "hyphaeon_meme", arguments: { alignment, tree, model_variant: "viral", top: 3 } });
    const body = parseText(res);
    expect(res.isError).toBeFalsy();
    expect(body.analysis).toBe("meme");
    expect(body.provenance.surface).toBe("python-reference");
    expect(body.sites).toHaveLength(3);
    expect(body.sites.map((s) => s.hyphaeon_lrt)).toEqual([11, 10, 9]);
    expect(body.truncated.sites.total).toBe(12);
    const last = calls[calls.length - 1];
    expect(last.analysis).toBe("meme");
    expect(last.options).toEqual({ model_variant: "viral" });
    expect(last.tree).toBe(tree);
  });

  it("refuses a run with no tree before touching the bridge", async () => {
    const alignment = await example("bat_oas1.fasta");
    const before = calls.length;
    const res = await ctx.client.callTool({ name: "hyphaeon_meme", arguments: { alignment } });
    expect(res.isError).toBe(true);
    expect(parseText(res).kind).toBe("input");
    expect(calls.length).toBe(before);
  });

  it("refuses a two-sequence alignment with an input-class error", async () => {
    const res = await ctx.client.callTool({
      name: "hyphaeon_busted",
      arguments: { alignment: ">a\nATGAAA\n>b\nATGAAC\n", tree: "(a:0.1,b:0.1);" }
    });
    expect(res.isError).toBe(true);
    const body = parseText(res);
    expect(body.kind).toBe("input");
    expect(body.error).toMatch(/at least 3/);
  });

  it("hyphaeon_phenotype requires a trait definition", async () => {
    const alignment = await example("bat_oas1.fasta");
    const tree = await example("bat_oas1.nwk");
    const res = await ctx.client.callTool({ name: "hyphaeon_phenotype", arguments: { alignment, tree } });
    expect(res.isError).toBe(true);
    expect(parseText(res).error).toMatch(/trait definition/);
  });

  it("run_async returns a job id and get_results pages the result", async () => {
    const alignment = await example("bat_oas1.fasta");
    const tree = await example("bat_oas1.nwk");
    const queued = parseText(await ctx.client.callTool({ name: "hyphaeon_meme", arguments: { alignment, tree, run_async: true } }));
    expect(queued.job_id).toMatch(/^[0-9a-f]{32}$/);
    expect(["queued", "running"]).toContain(queued.status);

    const done = await waitFor(async () => {
      const s = parseText(await ctx.client.callTool({ name: "job_status", arguments: { job_id: queued.job_id } }));
      return s.status === "completed" ? s : null;
    });
    expect(done.result_available).toBe(true);
    expect(done.elapsed_sec).toBeGreaterThanOrEqual(0);

    const full = parseText(await ctx.client.callTool({ name: "get_results", arguments: { job_id: queued.job_id } }));
    expect(full.sites).toHaveLength(12);
    expect(full.provenance.surface).toBe("python-reference");
    expect(full.provenance.job_id).toBe(queued.job_id);

    const top = parseText(await ctx.client.callTool({ name: "get_results", arguments: { job_id: queued.job_id, top: 5 } }));
    expect(top.sites).toHaveLength(5);
    // lrt = (i*7) % 12 for site i+1: 11 at site 6, 10 at site 11, 9 at site 4, 8 at site 9, 7 at site 2
    expect(top.sites.map((s) => s.site)).toEqual([6, 11, 4, 9, 2]);
    expect(top.truncated.sites).toEqual({ returned: 5, total: 12, ranked_by: "hyphaeon_lrt" });

    const fields = parseText(await ctx.client.callTool({ name: "get_results", arguments: { job_id: queued.job_id, fields: ["taxa_count", "codon_count", "nope"] } }));
    expect(Object.keys(fields).sort()).toEqual(["analysis", "codon_count", "provenance", "taxa_count", "unknown_fields"]);
    expect(fields.unknown_fields).toEqual(["nope"]);

    const summary = parseText(await ctx.client.callTool({ name: "get_results", arguments: { job_id: queued.job_id, summary_only: true } }));
    expect(summary.sites).toBeUndefined();
    expect(summary.collections).toEqual({ sites: 12 });
    expect(summary.summary.invariable_sites).toBe(3);
    expect(summary.summary.top_sites[0].hyphaeon_lrt).toBe(11);

    const cancel = parseText(await ctx.client.callTool({ name: "cancel_job", arguments: { job_id: queued.job_id } }));
    expect(cancel.message).toMatch(/already completed/);
  });

  it("cancel_job aborts a running job", async () => {
    const alignment = await example("bat_oas1.fasta");
    const tree = await example("bat_oas1.nwk");
    const queued = parseText(await ctx.client.callTool({ name: "hyphaeon_dms", arguments: { alignment, tree, run_async: true } }));
    const cancelled = parseText(await ctx.client.callTool({ name: "cancel_job", arguments: { job_id: queued.job_id } }));
    expect(cancelled.success).toBe(true);
    expect(cancelled.status).toBe("cancelled");
    const res = await ctx.client.callTool({ name: "get_results", arguments: { job_id: queued.job_id } });
    expect(res.isError).toBe(true);
    expect(parseText(res).status).toBe("cancelled");
  });

  it("get_results on an unknown id is an input error", async () => {
    const res = await ctx.client.callTool({ name: "get_results", arguments: { job_id: "f".repeat(32) } });
    expect(res.isError).toBe(true);
    expect(parseText(res).kind).toBe("input");
  });
});
