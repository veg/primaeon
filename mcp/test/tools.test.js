import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { connect, parseText, example, waitFor } from "./helpers.js";
import { TOOL_NAMES, NATIVE_ANALYSES, BRIDGED_ANALYSES } from "../src/tools.js";
import { PROMPT_NAMES } from "../src/prompts.js";

describe("tool registry", () => {
  let ctx;
  beforeAll(async () => {
    ctx = await connect();
  });
  afterAll(async () => {
    await ctx.close();
  });

  it("tools/list has all eleven names and says which run in-process", async () => {
    const { tools } = await ctx.client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([...TOOL_NAMES].sort());
    expect(names).toHaveLength(11);
    for (const t of tools) expect(t.description.length).toBeGreaterThan(20);
    expect(tools.find((t) => t.name === "hyphaeon_meme").description).toMatch(/IN THIS PROCESS/);
    expect(tools.find((t) => t.name === "hyphaeon_epistasis").description).toMatch(/Python reference bridge/);
    expect([...NATIVE_ANALYSES]).toEqual(["meme", "busted", "evaluate"]);
    expect([...BRIDGED_ANALYSES]).toEqual(["epistasis", "dms", "phenotype"]);
  });

  it("prompts/list has one interpretation guide per pillar plus choose-analysis", async () => {
    const { prompts } = await ctx.client.listPrompts();
    const names = prompts.map((p) => p.name).sort();
    expect(names).toEqual([...PROMPT_NAMES].sort());
    const meme = await ctx.client.getPrompt({ name: "interpret-meme" });
    expect(meme.messages[0].content.text).toMatch(/Rank is strong, scale is compressed/);
    expect(meme.messages[0].content.text).toMatch(/mcp-stdio/);
    const choose = await ctx.client.getPrompt({ name: "choose-analysis", arguments: { question: "which sites?" } });
    expect(choose.messages[0].content.text).toMatch(/hyphaeon_meme/);
  });

  it("job_status on an unknown id reports not_found", async () => {
    const res = await ctx.client.callTool({ name: "job_status", arguments: { job_id: "0".repeat(32) } });
    expect(parseText(res).status).toBe("not_found");
  });

  it("list_models reads the manifest through the runtime and reports both engines", async () => {
    const res = await ctx.client.callTool({ name: "list_models", arguments: {} });
    const body = parseText(res);
    expect(body.available).toBe(true);
    expect(body.manifest.model_version).toBe("v1");
    expect(body.variants.map((v) => v.variant)).toEqual(["general", "viral"]);
    expect(body.variants[0].onnx_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(body.variants[0].onnx_path).toMatch(/general\.onnx$/);
    expect(body.variants[0].busted_head_path).toMatch(/busted_head\.onnx$/);
    expect(body.variants[1].busted_head_path).toBeNull();
    expect(body.native.surface).toBe("mcp-stdio");
    expect(body.native.analyses).toEqual(["meme", "busted", "evaluate"]);
    expect(body.native.engine).toBe("onnxruntime-node");
    expect(body.native.available).toBe(true);
    expect(body.native.onnxruntime_node).toBe("1.23.2");
    expect(body.native.models_dir).toMatch(/models$/);
    expect(body.bridge.surface).toBe("python-reference");
    expect(body.bridge.analyses).toEqual(["epistasis", "dms", "phenotype"]);
  });
});

describe("hyphaeon_validate through the tool", () => {
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
    expect(body.summary.taxa_used).toBe(20);
    expect(body.summary.engine).toBe("in-process");
    expect(body.summary.mode).toBe("sync");
    const codes = body.warnings.map((w) => w.code);
    expect(codes).toContain("COST_ESTIMATE");
    expect(codes).toContain("RUN_MODE");
    expect(body.warnings.every((w) => ["info", "warn", "refuse"].includes(w.severity))).toBe(true);
  });

  it("camelid: BRANCH_LENGTHS_MISSING with this server's estimator recorded", async () => {
    const alignment = await example("camelid.fasta");
    const tree = await example("camelid.nwk");
    const body = parseText(await ctx.client.callTool({ name: "hyphaeon_validate", arguments: { alignment, tree } }));
    const w = body.warnings.find((x) => x.code === "BRANCH_LENGTHS_MISSING");
    expect(w).toBeDefined();
    expect(w.severity).toBe("warn");
    expect(w.data.recoverable).toBe(true);
    expect(["hyphy-hky85", null]).toContain(w.data.estimator);
    expect(body.summary.branch_lengths_missing).toBe(true);
  });

  it("bat_oas1: DISTANCE_RESCALED", async () => {
    const alignment = await example("bat_oas1.fasta");
    const tree = await example("bat_oas1.nwk");
    const body = parseText(await ctx.client.callTool({ name: "hyphaeon_validate", arguments: { alignment, tree } }));
    const w = body.warnings.find((x) => x.code === "DISTANCE_RESCALED");
    expect(w).toBeDefined();
    expect(w.data.dividedBy).toBe(351);
    expect(body.summary.distance_rescaled).toBe(true);
  });

  it("refuses when no tree is given; TN93 mode is refused for a native pillar and passed through for a bridged one", async () => {
    const alignment = await example("bat_oas1.fasta");
    const r1 = parseText(await ctx.client.callTool({ name: "hyphaeon_validate", arguments: { alignment } }));
    expect(r1.ok).toBe(false);
    expect(r1.warnings.find((w) => w.code === "TREE_MISSING").severity).toBe("refuse");
    const r2 = parseText(await ctx.client.callTool({ name: "hyphaeon_validate", arguments: { alignment, use_tn93: true } }));
    expect(r2.summary.tree_source).toBe("tn93");
    expect(r2.ok).toBe(false);
    expect(r2.warnings.find((w) => w.code === "TN93_UNAVAILABLE").severity).toBe("refuse");
    const r3 = parseText(await ctx.client.callTool({ name: "hyphaeon_validate", arguments: { alignment, use_tn93: true, analysis: "epistasis" } }));
    expect(r3.ok).toBe(true);
    expect(r3.summary.engine).toBe("python-reference");
  });

  it("refuses alignment taxa that have no tree tip", async () => {
    const alignment = ">a\nATGAAATTT\n>b\nATGAAATTC\n>c\nATGAAGTTT\n>d\nATGCAATTT\n";
    const tree = "((a:0.1,b:0.1):0.05,(c:0.1,zzz:0.1):0.05);";
    const body = parseText(await ctx.client.callTool({ name: "hyphaeon_validate", arguments: { alignment, tree } }));
    expect(body.ok).toBe(false);
    expect(body.warnings.find((w) => w.code === "TAXA_NOT_IN_TREE").severity).toBe("refuse");
  });

  it("recognises NEXUS with an embedded tree (RHO.fasta)", async () => {
    const alignment = await example("RHO.fasta");
    const body = parseText(await ctx.client.callTool({ name: "hyphaeon_validate", arguments: { alignment, analysis: "phenotype" } }));
    expect(body.summary.format).toBe("nexus");
    expect(body.summary.sequence_count).toBe(710);
    expect(body.summary.tree_source).toBe("embedded");
    expect(body.warnings.map((w) => w.code)).toContain("TAXA_OVER_CAP");
  });
});

describe("analysis tools with a stubbed engine and a stubbed bridge", () => {
  let ctx;
  const engineCalls = [];
  const bridgeCalls = [];
  const fakeSites = (n) =>
    Array.from({ length: n }, (_, i) => ({
      site: i + 1,
      hyphaeon_lrt: (i * 7) % 12,
      p_value: 1 - i / 12,
      q_value: 1 - i / 24,
      is_invariable: i % 4 === 0
    }));
  const fakeEngine = {
    capabilities: async () => ({ hyphy: false, tn93: false }),
    status: async () => ({ engine: "stub", available: true }),
    run: async (req) => {
      engineCalls.push(req);
      if (req.progress) req.progress("infer", 1, 2, "half");
      if (req.signal) {
        await new Promise((resolve, reject) => {
          const t = setTimeout(resolve, 30);
          req.signal.addEventListener("abort", () => {
            clearTimeout(t);
            reject(Object.assign(new Error("aborted"), { kind: "input" }));
          });
        });
      }
      return {
        result: req.analysis === "meme"
          ? { alignment: "alignment.fasta", tree: "tree.nwk", taxa_count: 18, codon_count: 12, runtime_sec: 0.01, filter_enabled: false, artifacts_masked: [], attribution_enabled: false, attributions: {}, sites: fakeSites(12) }
          : { gene: "x", taxa: 18, sites: 12, p_value_acat: 0.5, sites_detail: fakeSites(12) },
        provenance: { surface: req.surface, engine: "in-process", elapsed_sec: 0.01, warnings: [] }
      };
    }
  };
  const fakeBridge = async (req) => {
    bridgeCalls.push(req);
    if (req.signal) {
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, 30);
        req.signal.addEventListener("abort", () => {
          clearTimeout(t);
          reject(Object.assign(new Error("aborted"), { kind: "input" }));
        });
      });
    }
    return {
      result: { taxa_count: 18, codon_count: 12, edges: [{ site_u: 1, site_v: 2, cesi: 0.9 }], sectors: [], plasticity: [] },
      provenance: { surface: "python-reference", reference_version: "1.0.0", elapsed_sec: 0.01, command: ["hyphaeon", "epistasis"] }
    };
  };
  beforeAll(async () => {
    ctx = await connect({ engine: fakeEngine, bridge: fakeBridge });
  });
  afterAll(async () => {
    await ctx.close();
  });

  it("hyphaeon_meme goes to the engine with the surface, names and CLI options, and returns shaped mcp-stdio results", async () => {
    const alignment = await example("bat_oas1.fasta");
    const tree = await example("bat_oas1.nwk");
    const res = await ctx.client.callTool({ name: "hyphaeon_meme", arguments: { alignment, tree, model_variant: "viral", top: 3 } });
    const body = parseText(res);
    expect(res.isError).toBeFalsy();
    expect(body.analysis).toBe("meme");
    expect(body.provenance.surface).toBe("mcp-stdio");
    expect(body.sites).toHaveLength(3);
    expect(body.sites.map((s) => s.hyphaeon_lrt)).toEqual([11, 10, 9]);
    expect(body.truncated.sites.total).toBe(12);
    const last = engineCalls[engineCalls.length - 1];
    expect(last.analysis).toBe("meme");
    expect(last.surface).toBe("mcp-stdio");
    expect(last.options).toEqual({ model_variant: "viral" });
    expect(last.tree).toBe(tree);
    expect(last.names).toEqual({});
    expect(bridgeCalls).toHaveLength(0);
  });

  it("hyphaeon_epistasis goes to the bridge and is labelled python-reference", async () => {
    const alignment = await example("bat_oas1.fasta");
    const tree = await example("bat_oas1.nwk");
    const before = engineCalls.length;
    const res = await ctx.client.callTool({ name: "hyphaeon_epistasis", arguments: { alignment, tree, no_dms: true, n_permutations: 10 } });
    const body = parseText(res);
    expect(res.isError).toBeFalsy();
    expect(body.provenance.surface).toBe("python-reference");
    expect(body.edges).toHaveLength(1);
    expect(bridgeCalls[bridgeCalls.length - 1].options).toEqual({ no_dms: true, n_permutations: 10 });
    expect(engineCalls.length).toBe(before);
  });

  it("refuses a run with no tree before touching either engine", async () => {
    const alignment = await example("bat_oas1.fasta");
    const before = engineCalls.length + bridgeCalls.length;
    const res = await ctx.client.callTool({ name: "hyphaeon_meme", arguments: { alignment } });
    expect(res.isError).toBe(true);
    expect(parseText(res).kind).toBe("input");
    expect(engineCalls.length + bridgeCalls.length).toBe(before);
  });

  it("refuses TN93 mode for a native pillar when the engine has no TN93, but lets a bridged pillar through", async () => {
    const alignment = await example("bat_oas1.fasta");
    const res = await ctx.client.callTool({ name: "hyphaeon_busted", arguments: { alignment, use_tn93: true } });
    expect(res.isError).toBe(true);
    expect(parseText(res).error).toMatch(/TN93/);
    const ok = await ctx.client.callTool({ name: "hyphaeon_dms", arguments: { alignment, use_tn93: true } });
    expect(ok.isError).toBeFalsy();
    expect(bridgeCalls[bridgeCalls.length - 1].options).toEqual({ use_tn93: true });
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

  it("run_async returns a job id, job_status carries progress, and get_results pages the result", async () => {
    const alignment = await example("bat_oas1.fasta");
    const tree = await example("bat_oas1.nwk");
    const queued = parseText(await ctx.client.callTool({ name: "hyphaeon_meme", arguments: { alignment, tree, run_async: true } }));
    expect(queued.job_id).toMatch(/^[0-9a-f]{32}$/);
    expect(queued.engine).toBe("in-process");
    expect(["queued", "running"]).toContain(queued.status);

    const done = await waitFor(async () => {
      const s = parseText(await ctx.client.callTool({ name: "job_status", arguments: { job_id: queued.job_id } }));
      return s.status === "completed" ? s : null;
    });
    expect(done.result_available).toBe(true);
    expect(done.elapsed_sec).toBeGreaterThanOrEqual(0);
    expect(done.progress).toMatchObject({ phase: "infer", done: 1, total: 2, message: "half" });

    const full = parseText(await ctx.client.callTool({ name: "get_results", arguments: { job_id: queued.job_id } }));
    expect(full.sites).toHaveLength(12);
    expect(full.provenance.surface).toBe("mcp-stdio");
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

  it("a bridged job keeps python-reference provenance through get_results", async () => {
    const alignment = await example("bat_oas1.fasta");
    const tree = await example("bat_oas1.nwk");
    const queued = parseText(await ctx.client.callTool({ name: "hyphaeon_epistasis", arguments: { alignment, tree, run_async: true } }));
    expect(queued.engine).toBe("python-reference");
    await waitFor(async () => {
      const s = parseText(await ctx.client.callTool({ name: "job_status", arguments: { job_id: queued.job_id } }));
      return s.status === "completed" ? s : null;
    });
    const full = parseText(await ctx.client.callTool({ name: "get_results", arguments: { job_id: queued.job_id, summary_only: true } }));
    expect(full.provenance.surface).toBe("python-reference");
    expect(full.collections).toEqual({ edges: 1, sectors: 0, plasticity: 0 });
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
