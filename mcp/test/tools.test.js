/**
 * tools.test.js — the tool registry, hyphaeon_validate through the protocol, and every analysis
 * tool's routing and paging over a STUBBED engine.
 *
 * WHY THIS FILE EXISTS
 *
 * The parity files (engine, tn93, epistasis, dms, analyze, phenotype) load models and score whole
 * alignments; this one pins what the TOOL LAYER itself decides without loading anything: that
 * every pillar now goes to the in-process engine (Phase 3 moved the last one, phenotype, and
 * deleted the Python path with it), the refusals that still happen before any engine is touched
 * (two taxa, a missing trait) and the one that no longer does (a missing tree — D22 makes that a
 * TN93 run, not an error), the job path (run_async, job_status progress, get_results shaping,
 * cancel), and hyphaeon_analyze's contract — always a job, inline when small, sections readable
 * through get_results while the stubbed report is still streaming, paged by section afterwards,
 * listed as hyphaeon://report/{id}, and a phenotype section that appears if and only if the call
 * carried a trait block.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { connect, parseText, example, waitFor } from "./helpers.js";
import { TOOL_NAMES, NATIVE_ANALYSES } from "../src/tools.js";
import { PROMPT_NAMES } from "../src/prompts.js";

describe("tool registry", () => {
  let ctx;
  beforeAll(async () => {
    ctx = await connect();
  });
  afterAll(async () => {
    await ctx.close();
  });

  it("tools/list has all twelve names and says which run in-process", async () => {
    const { tools } = await ctx.client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([...TOOL_NAMES].sort());
    expect(names).toHaveLength(12);
    for (const t of tools) expect(t.description.length).toBeGreaterThan(20);
    expect(tools.find((t) => t.name === "hyphaeon_analyze").description).toMatch(/ONE ACTION/);
    expect(tools.find((t) => t.name === "hyphaeon_analyze").description).toMatch(/IN THIS PROCESS/);
    expect(tools.find((t) => t.name === "hyphaeon_meme").description).toMatch(/IN THIS PROCESS/);
    expect(tools.find((t) => t.name === "hyphaeon_epistasis").description).toMatch(/IN THIS PROCESS/);
    expect(tools.find((t) => t.name === "hyphaeon_dms").description).toMatch(/IN THIS PROCESS/);
    expect(tools.find((t) => t.name === "hyphaeon_phenotype").description).toMatch(/IN THIS PROCESS/);
    expect(tools.find((t) => t.name === "hyphaeon_phenotype").description).toMatch(/no Python anywhere/);
    expect([...NATIVE_ANALYSES]).toEqual(["meme", "busted", "epistasis", "dms", "phenotype", "evaluate", "analyze"]);
    // D22: every tool says a tree is optional, and none of them offers to estimate branch lengths.
    for (const name of ["hyphaeon_meme", "hyphaeon_busted", "hyphaeon_epistasis", "hyphaeon_dms", "hyphaeon_phenotype", "hyphaeon_analyze"]) {
      const tool = tools.find((x) => x.name === name);
      expect(tool.inputSchema.properties.tree.description, name).toMatch(/OPTIONAL/);
      expect(tool.inputSchema.properties.tree.description, name).toMatch(/TN93/);
      expect(JSON.stringify(tool), name).not.toMatch(/HKY85/);
    }
    const analyze = tools.find((t) => t.name === "hyphaeon_analyze");
    expect(Object.keys(analyze.inputSchema.properties)).toEqual(expect.arrayContaining(["alignment", "tree", "variant", "seed", "permutations", "dms", "dms_work_budget", "phenotype", "phenotype_file", "use_tn93", "wait_seconds", "section", "fields", "top", "summary_only", "run_async"]));
    const pheno = tools.find((t) => t.name === "hyphaeon_phenotype");
    expect(Object.keys(pheno.inputSchema.properties)).toEqual(
      expect.arrayContaining(["alignment", "tree", "use_tn93", "preset", "foreground", "background", "phenotype_file", "trait_col", "species_col", "continuous", "permulations", "n_permutations", "alpha", "min_taxa", "seed"])
    );
    const getResults = tools.find((t) => t.name === "get_results");
    expect(Object.keys(getResults.inputSchema.properties)).toEqual(expect.arrayContaining(["job_id", "section", "fields", "top", "summary_only"]));
  });

  it("prompts/list has one interpretation guide per pillar, one for the report, and choose-analysis", async () => {
    const { prompts } = await ctx.client.listPrompts();
    const names = prompts.map((p) => p.name).sort();
    expect(names).toEqual([...PROMPT_NAMES].sort());
    expect(names).toContain("interpret-report");
    const meme = await ctx.client.getPrompt({ name: "interpret-meme" });
    expect(meme.messages[0].content.text).toMatch(/Rank is strong, scale is compressed/);
    expect(meme.messages[0].content.text).toMatch(/mcp-stdio/);
    // The surrogate preamble now explains tree_source, and no guide claims a Python surface.
    expect(meme.messages[0].content.text).toMatch(/tree_source/);
    for (const n of names) {
      const args = n === "choose-analysis" ? { question: "which sites?" } : {};
      const text = (await ctx.client.getPrompt({ name: n, arguments: args })).messages[0].content.text;
      expect(text, n).not.toMatch(/python-reference/);
    }
    const phenotype = await ctx.client.getPrompt({ name: "interpret-phenotype" });
    expect(phenotype.messages[0].content.text).toMatch(/Permulations need a phylogeny/);
    const report = await ctx.client.getPrompt({ name: "interpret-report" });
    const text = report.messages[0].content.text;
    for (const h of ["diagnostics", "sections.sites", "sections.gene", "sections.epistasis", "sections.attribution", "sections.filter", "sections.dms", "sections.phenotype"]) {
      expect(text).toContain(h);
    }
    expect(text.indexOf("sections.sites")).toBeLessThan(text.indexOf("sections.gene"));
    expect(text.indexOf("sections.gene")).toBeLessThan(text.indexOf("sections.epistasis"));
    expect(text.indexOf("sections.filter")).toBeLessThan(text.indexOf("sections.dms"));
    expect(text).toMatch(/p_perm.*Monte Carlo/);
    expect(text).toMatch(/sqrt\(p\(1-p\)\/B\)/);
    expect(text).toMatch(/Cannot support/);
    const epi = await ctx.client.getPrompt({ name: "interpret-epistasis" });
    expect(epi.messages[0].content.text).toMatch(/1,000 a sector reported at p_perm = 0\.09/);
    const choose = await ctx.client.getPrompt({ name: "choose-analysis", arguments: { question: "which sites?" } });
    expect(choose.messages[0].content.text).toMatch(/hyphaeon_analyze/);
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
    expect(body.native.analyses).toEqual(["meme", "busted", "epistasis", "dms", "phenotype", "evaluate", "analyze"]);
    expect(body.native.engine).toBe("onnxruntime-node");
    expect(body.native.available).toBe(true);
    expect(body.native.onnxruntime_node).toBe("1.23.2");
    expect(body.native.models_dir).toMatch(/models$/);
    expect(body.native.mds_sign).toBe("canonical");
    expect(body.native.runtime_provides).toEqual({ runEpistasis: true, runDms: true, runEverything: true, runPhenotype: true });
    // D22 / Phase 3: no estimator, no second engine.
    expect(body.native.branch_length_estimator).toBeNull();
    expect(body.native.tree_free).toMatch(/tn93/);
    expect(body.bridge).toBeUndefined();
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

  it("sizes the whole report (analysis: analyze) in-process and names the wait budget", async () => {
    const alignment = await example("Smc6.fasta");
    const tree = await example("Smc6.nwk");
    const body = parseText(await ctx.client.callTool({ name: "hyphaeon_validate", arguments: { alignment, tree, analysis: "analyze" } }));
    expect(body.ok).toBe(true);
    expect(body.summary.engine).toBe("in-process");
    expect(body.summary.analysis).toBe("analyze");
    expect(body.warnings.find((w) => w.code === "RUN_MODE").message).toMatch(/wait budget/);
  });

  it("camelid: a topology-only tree is TREE_FREE_TN93 at info, not a branch-length problem", async () => {
    const alignment = await example("camelid.fasta");
    const tree = await example("camelid.nwk");
    const body = parseText(await ctx.client.callTool({ name: "hyphaeon_validate", arguments: { alignment, tree } }));
    const w = body.warnings.find((x) => x.code === "TREE_FREE_TN93");
    expect(w).toBeDefined();
    expect(w.severity).toBe("info");
    expect(w.data.reason).toBe("no_branch_lengths");
    expect(body.ok).toBe(true);
    expect(body.summary.tree_source).toBe("tn93");
    expect(body.warnings.map((x) => x.code)).not.toContain("BRANCH_LENGTHS_MISSING");
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

  it("accepts an alignment with no tree, and use_tn93 on one that has a usable tree", async () => {
    const alignment = await example("bat_oas1.fasta");
    const r1 = parseText(await ctx.client.callTool({ name: "hyphaeon_validate", arguments: { alignment } }));
    expect(r1.ok).toBe(true);
    expect(r1.summary.tree_source).toBe("tn93");
    expect(r1.warnings.find((w) => w.code === "TREE_FREE_TN93").data.reason).toBe("no_tree");
    const r2 = parseText(await ctx.client.callTool({ name: "hyphaeon_validate", arguments: { alignment, use_tn93: true, analysis: "epistasis" } }));
    expect(r2.ok).toBe(true);
    expect(r2.summary.engine).toBe("in-process");
    expect(r2.summary.tree_source).toBe("tn93");
    const r3 = parseText(await ctx.client.callTool({ name: "hyphaeon_validate", arguments: { alignment, analysis: "phenotype" } }));
    expect(r3.ok).toBe(true);
    expect(r3.summary.engine).toBe("in-process");
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
    expect(body.summary.engine).toBe("in-process");
    expect(body.warnings.map((w) => w.code)).toContain("TAXA_OVER_CAP");
  });
});

describe("analysis tools over a stubbed engine", () => {
  let ctx;
  const engineCalls = [];
  const analyzeCalls = [];
  const fakeSites = (n) =>
    Array.from({ length: n }, (_, i) => ({
      site: i + 1,
      hyphaeon_lrt: (i * 7) % 12,
      p_value: 1 - i / 12,
      q_value: 1 - i / 24,
      is_invariable: i % 4 === 0,
      call: i % 5 === 0 ? "Strong" : "Neutral"
    }));
  const waitOrAbort = (signal, ms) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      if (signal) {
        signal.addEventListener("abort", () => {
          clearTimeout(t);
          reject(Object.assign(new Error("aborted"), { kind: "input" }));
        });
      }
    });
  const fakeEngine = {
    status: async () => ({ engine: "stub", available: true }),
    run: async (req) => {
      engineCalls.push(req);
      if (req.progress) req.progress("infer", 1, 2, "half");
      await waitOrAbort(req.signal, 30);
      const results = {
        meme: { alignment: "alignment.fasta", tree: "tree.nwk", taxa_count: 18, codon_count: 12, runtime_sec: 0.01, filter_enabled: false, artifacts_masked: [], attribution_enabled: false, attributions: {}, sites: fakeSites(12) },
        busted: { gene: "x", taxa: 18, sites: 12, p_value_acat: 0.5, sites_detail: fakeSites(12) },
        epistasis: { taxa_count: 18, codon_count: 12, edges: [{ site_u: 1, site_v: 2, cesi: 0.9 }, { site_u: 3, site_v: 4, cesi: 2.5 }], sectors: [], plasticity: [] },
        dms: { taxa_count: 18, codon_count: 12, focal_taxon: "a", total_mutations: 228, plasticity: [{ site: 1, intrinsic_plasticity: 0.3 }] },
        phenotype: {
          taxa_count: 18,
          codon_count: 12,
          phenotype_meta: { mode: "discrete", foreground_count: 2, background_count: 16, description: "stub" },
          sites: [{ site: 1, score: 0.9 }],
          trait_sectors: [],
          coselection_pairs: [],
          permulations: { requested: 0, ran: 0, reason: "not-requested", detail: "stub" }
        }
      };
      const treeFree = !req.tree || req.options.use_tn93 || req.options.no_tree;
      return {
        result: results[req.analysis],
        provenance: {
          surface: req.surface,
          engine: "in-process",
          elapsed_sec: 0.01,
          warnings: [],
          preprocessing: { tree_source: treeFree ? "tn93" : "user", tree_free: treeFree ? { reason: req.tree ? "requested" : "no_tree" } : null }
        }
      };
    },
    analyze: async (req) => {
      analyzeCalls.push(req);
      const trait = req.options && req.options.phenotype;
      const sections = {
        sites: { taxa_count: 18, codon_count: 12, sites: fakeSites(12), summary: {} },
        gene: { record: { p_value_acat: 0.4, positive_selection_detected: false }, statistics: {} },
        epistasis: { edges: [{ site_u: 1, site_v: 2, cesi: 1 }], sectors: [] },
        attribution: { attributions: { 1: {}, 6: {} }, attribution_enabled: true },
        filter: { artifacts_masked: [], filter_enabled: true, cleaned: null },
        dms: { plasticity: [{ site: 1, intrinsic_plasticity: 0.3 }, { site: 2, intrinsic_plasticity: 0.8 }], focal_taxon: "a", total_mutations: 228, progress: { done: 2, total: 12 }, cancelled: true },
        // PLAN.md 4.0 row 8: filled if and only if the call carried a trait.
        phenotype: trait
          ? { taxa_count: 18, codon_count: 12, phenotype_meta: { mode: "discrete", foreground_count: 2, background_count: 16, description: "stub" }, sites: [{ site: 2, score: 0.8 }], trait_sectors: [], coselection_pairs: [] }
          : null
      };
      for (const name of ["sites", "gene", "epistasis", "attribution", "filter"]) {
        if (req.progress) req.progress(name === "sites" ? "infer" : name, 1, 1, name);
        req.onSection(name, sections[name], { final: true });
        await waitOrAbort(req.signal, 15);
      }
      req.onSection("dms", { ...sections.dms, plasticity: sections.dms.plasticity.slice(0, 1), progress: { done: 1, total: 12 } }, { final: false });
      await waitOrAbort(req.signal, 15);
      req.onSection("dms", sections.dms, { final: true });
      if (sections.phenotype) req.onSection("phenotype", sections.phenotype, { final: true });
      return {
        schema_version: 2,
        kind: "report",
        id: req.id,
        createdAt: new Date().toISOString(),
        inputs: { alignmentName: req.names.alignment || null },
        options: req.options,
        diagnostics: { taxa_used: 18, codon_count: 12, warnings: [{ code: "DISTANCE_RESCALED", severity: "warn" }], refused: false },
        sections,
        provenance: {
          surface: req.surface,
          engine: "in-process",
          model_variant: "general",
          preprocessing: { taxa_used: 18, taxa_in_alignment: 18, tree_source: req.tree ? "user" : "tn93" },
          warnings: [],
          ...(sections.phenotype ? { phenotype_source: "report-pass" } : {})
        },
        timings: { infer: 0.01, dms: 0.02, total: 0.05 }
      };
    }
  };
  beforeAll(async () => {
    ctx = await connect({ engine: fakeEngine });
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
    expect(body.provenance.preprocessing.tree_source).toBe("user");
  });

  it("epistasis, dms AND phenotype all go to the one in-process engine", async () => {
    const alignment = await example("bat_oas1.fasta");
    const tree = await example("bat_oas1.nwk");
    const epi = parseText(await ctx.client.callTool({ name: "hyphaeon_epistasis", arguments: { alignment, tree, no_dms: true, n_permutations: 10, seed: 7, top: 1 } }));
    expect(epi.provenance.surface).toBe("mcp-stdio");
    expect(epi.edges).toEqual([{ site_u: 3, site_v: 4, cesi: 2.5 }]);
    expect(engineCalls[engineCalls.length - 1].analysis).toBe("epistasis");
    expect(engineCalls[engineCalls.length - 1].options).toEqual({ no_dms: true, n_permutations: 10, seed: 7 });
    const dms = parseText(await ctx.client.callTool({ name: "hyphaeon_dms", arguments: { alignment, tree, sites: [1, 2], focal_taxon: "R_ferr" } }));
    expect(dms.provenance.surface).toBe("mcp-stdio");
    expect(engineCalls[engineCalls.length - 1].analysis).toBe("dms");
    expect(engineCalls[engineCalls.length - 1].options).toEqual({ sites: [1, 2], focal_taxon: "R_ferr" });

    const pheno = parseText(await ctx.client.callTool({ name: "hyphaeon_phenotype", arguments: { alignment, tree, foreground: "R_ferr,R_sin", n_permutations: 10, seed: 3 } }));
    expect(pheno.provenance.surface).toBe("mcp-stdio");
    expect(pheno.provenance.engine).toBe("in-process");
    expect(pheno.phenotype_meta.foreground_count).toBe(2);
    const last = engineCalls[engineCalls.length - 1];
    expect(last.analysis).toBe("phenotype");
    expect(last.options).toEqual({ foreground: "R_ferr,R_sin", n_permutations: 10, seed: 3 });
    // The phenotype table is an INPUT, not an option: no CSV ends up in the recorded options.
    const withCsv = parseText(
      await ctx.client.callTool({ name: "hyphaeon_phenotype", arguments: { alignment, tree, phenotype_file: "species,trait\nR_ferr,1\nR_sin,1\nM_lyra,0\n" } })
    );
    expect(withCsv.provenance.surface).toBe("mcp-stdio");
    const csvCall = engineCalls[engineCalls.length - 1];
    expect(csvCall.options.phenotype_file).toBeUndefined();
    expect(csvCall.phenotype_file).toMatch(/^species,trait/);
  });

  it("ACCEPTS a run with no tree and records tree_source tn93 (D22): no tool refuses for want of one", async () => {
    const alignment = await example("bat_oas1.fasta");
    for (const name of ["hyphaeon_meme", "hyphaeon_busted", "hyphaeon_epistasis", "hyphaeon_dms"]) {
      const res = await ctx.client.callTool({ name, arguments: { alignment } });
      expect(res.isError, name).toBeFalsy();
      const body = parseText(res);
      expect(body.provenance.preprocessing.tree_source, name).toBe("tn93");
      expect(engineCalls[engineCalls.length - 1].tree, name).toBeUndefined();
    }
    const pheno = await ctx.client.callTool({ name: "hyphaeon_phenotype", arguments: { alignment, preset: "marine" } });
    expect(pheno.isError).toBeFalsy();
    expect(parseText(pheno).provenance.preprocessing.tree_source).toBe("tn93");
  });

  it("use_tn93 is forwarded to the engine instead of refused", async () => {
    const alignment = await example("bat_oas1.fasta");
    const tree = await example("bat_oas1.nwk");
    for (const name of ["hyphaeon_meme", "hyphaeon_busted", "hyphaeon_epistasis", "hyphaeon_dms"]) {
      const res = await ctx.client.callTool({ name, arguments: { alignment, tree, use_tn93: true } });
      expect(res.isError, name).toBeFalsy();
      expect(engineCalls[engineCalls.length - 1].options.use_tn93, name).toBe(true);
      expect(parseText(res).provenance.preprocessing.tree_source, name).toBe("tn93");
    }
    const ok = await ctx.client.callTool({ name: "hyphaeon_phenotype", arguments: { alignment, use_tn93: true, preset: "marine" } });
    expect(ok.isError).toBeFalsy();
    expect(engineCalls[engineCalls.length - 1].options).toEqual({ use_tn93: true, preset: "marine" });
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

    const withSection = parseText(await ctx.client.callTool({ name: "get_results", arguments: { job_id: queued.job_id, section: "sites", summary_only: true } }));
    expect(withSection.note).toMatch(/reports only/);

    const cancel = parseText(await ctx.client.callTool({ name: "cancel_job", arguments: { job_id: queued.job_id } }));
    expect(cancel.message).toMatch(/already completed/);
  });

  it("a phenotype job keeps in-process provenance through get_results", async () => {
    const alignment = await example("bat_oas1.fasta");
    const tree = await example("bat_oas1.nwk");
    const queued = parseText(await ctx.client.callTool({ name: "hyphaeon_phenotype", arguments: { alignment, tree, preset: "marine", run_async: true } }));
    expect(queued.engine).toBe("in-process");
    expect(queued.tree_source).toBe("user");
    await waitFor(async () => {
      const s = parseText(await ctx.client.callTool({ name: "job_status", arguments: { job_id: queued.job_id } }));
      return s.status === "completed" ? s : null;
    });
    const full = parseText(await ctx.client.callTool({ name: "get_results", arguments: { job_id: queued.job_id, summary_only: true } }));
    expect(full.provenance.surface).toBe("mcp-stdio");
    expect(full.collections).toEqual({ sites: 1, trait_sectors: 0, coselection_pairs: 0 });
    expect(full.summary.phenotype_meta.foreground_count).toBe(2);
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

  it("hyphaeon_analyze: always a job, inline when small, sections readable while running, paged by section afterwards", async () => {
    const alignment = await example("bat_oas1.fasta");
    const tree = await example("bat_oas1.nwk");

    // Inline: the stub's report is small, so the whole record comes back with its id.
    const inline = parseText(await ctx.client.callTool({ name: "hyphaeon_analyze", arguments: { alignment, tree, seed: 5, permutations: 50 } }));
    expect(inline.analysis).toBe("analyze");
    expect(inline.status).toBe("completed");
    expect(inline.kind).toBe("report");
    expect(inline.job_id).toMatch(/^[0-9a-f]{32}$/);
    expect(inline.report_id).toBe(inline.job_id);
    expect(inline.id).toBe(inline.job_id);
    expect(inline.report_uri).toBe("hyphaeon://report/" + inline.job_id);
    expect(Object.keys(inline.sections)).toEqual(["sites", "gene", "epistasis", "attribution", "filter", "dms", "phenotype"]);
    expect(inline.sections.phenotype).toBeNull();
    expect(inline.provenance.surface).toBe("mcp-stdio");
    const call = analyzeCalls[analyzeCalls.length - 1];
    expect(call.options).toEqual({ seed: 5, permutations: 50 });
    expect(call.id).toBe(inline.job_id);
    expect(call.surface).toBe("mcp-stdio");

    // Paging by section on the finished job, and the resource.
    const dms = parseText(await ctx.client.callTool({ name: "get_results", arguments: { job_id: inline.job_id, section: "dms", top: 1 } }));
    expect(dms.section).toBe("dms");
    expect(dms.plasticity).toEqual([{ site: 2, intrinsic_plasticity: 0.8 }]);
    expect(dms.truncated.plasticity).toEqual({ returned: 1, total: 2, ranked_by: "intrinsic_plasticity" });
    expect(dms.cancelled).toBe(true);
    const sum = parseText(await ctx.client.callTool({ name: "get_results", arguments: { job_id: inline.job_id, summary_only: true } }));
    expect(sum.summary.sections_present).toEqual(["sites", "gene", "epistasis", "attribution", "filter", "dms"]);
    expect(sum.summary.sites.called_sites).toBe(3);
    expect(sum.summary.dms.progress).toEqual({ done: 2, total: 12 });
    expect(sum.collections.phenotype).toBeNull();
    const pheno = parseText(await ctx.client.callTool({ name: "get_results", arguments: { job_id: inline.job_id, section: "phenotype" } }));
    expect(pheno.available).toBe(false);
    const rsrc = await ctx.client.readResource({ uri: "hyphaeon://report/" + inline.job_id });
    expect(rsrc.contents[0].mimeType).toBe("application/json");
    expect(JSON.parse(rsrc.contents[0].text).id).toBe(inline.job_id);
    const { resources } = await ctx.client.listResources();
    expect(resources.map((r) => r.uri)).toContain("hyphaeon://report/" + inline.job_id);

    // Streaming: wait_seconds 0, then the sites section is served while the stub is still on DMS.
    const queued = parseText(await ctx.client.callTool({ name: "hyphaeon_analyze", arguments: { alignment, tree, wait_seconds: 0 } }));
    expect(["queued", "running"]).toContain(queued.status);
    expect(queued.report_uri).toBe("hyphaeon://report/" + queued.job_id);
    const notYet = await ctx.client.callTool({ name: "get_results", arguments: { job_id: queued.job_id, section: "dms" } });
    if (notYet.isError) {
      expect(parseText(notYet).sections_ready).toBeDefined();
    }
    const partial = await waitFor(async () => {
      const s = parseText(await ctx.client.callTool({ name: "job_status", arguments: { job_id: queued.job_id } }));
      if (s.status === "completed") return { completed: true };
      if (s.status === "running" && (s.sections_ready || []).includes("sites")) {
        const p = parseText(await ctx.client.callTool({ name: "get_results", arguments: { job_id: queued.job_id, section: "sites", top: 2 } }));
        return p.status === "running" ? p : null;
      }
      return null;
    });
    if (!partial.completed) {
      expect(partial.partial).toBe(true);
      expect(partial.sites).toHaveLength(2);
      expect(partial.sections_ready).toContain("sites");
      const early = await ctx.client.readResource({ uri: "hyphaeon://report/" + queued.job_id });
      expect(early.contents[0].text).toMatch(/is running \(sections ready: /);
    }
    const done = await waitFor(async () => {
      const s = parseText(await ctx.client.callTool({ name: "job_status", arguments: { job_id: queued.job_id } }));
      return s.status === "completed" ? s : null;
    });
    expect(done.report_uri).toBe("hyphaeon://report/" + queued.job_id);
    expect(done.sections_ready).toBeUndefined();

    // A short wait hands back the id with what is ready.
    const short = parseText(await ctx.client.callTool({ name: "hyphaeon_analyze", arguments: { alignment, tree, wait_seconds: 0.02 } }));
    if (short.status !== "completed") {
      expect(short.job_id).toMatch(/^[0-9a-f]{32}$/);
      expect(short.reason).toMatch(/did not finish within wait_seconds/);
      expect(short.next).toMatch(/get_results/);
    }
  });

  it("hyphaeon_analyze fills sections.phenotype if and only if a trait block was given", async () => {
    const alignment = await example("bat_oas1.fasta");
    const tree = await example("bat_oas1.nwk");

    const without = parseText(await ctx.client.callTool({ name: "hyphaeon_analyze", arguments: { alignment, tree, summary_only: true } }));
    expect(without.summary.sections_absent).toEqual(["phenotype"]);
    expect(without.summary.phenotype).toMatch(/on demand/);
    expect(analyzeCalls[analyzeCalls.length - 1].options.phenotype).toBeUndefined();

    const withTrait = parseText(
      await ctx.client.callTool({ name: "hyphaeon_analyze", arguments: { alignment, tree, phenotype: { preset: "marine", permulations: 100 }, summary_only: true } })
    );
    expect(withTrait.summary.sections_present).toContain("phenotype");
    expect(withTrait.summary.sections_absent).toEqual([]);
    expect(withTrait.summary.phenotype.phenotype_meta.foreground_count).toBe(2);
    expect(withTrait.provenance.phenotype_source).toBe("report-pass");
    const call = analyzeCalls[analyzeCalls.length - 1];
    expect(call.options.phenotype).toEqual({ preset: "marine", permulations: 100 });

    // The section pages like every other one.
    const section = parseText(await ctx.client.callTool({ name: "get_results", arguments: { job_id: withTrait.job_id, section: "phenotype", top: 1 } }));
    expect(section.section).toBe("phenotype");
    expect(section.sites).toHaveLength(1);
  });

  it("hyphaeon_analyze carries a phenotype_file input to the engine without putting the CSV in the options", async () => {
    const alignment = await example("bat_oas1.fasta");
    const tree = await example("bat_oas1.nwk");
    const csv = "species,trait\nR_ferr,1\nR_sin,1\nM_lyra,0\n";
    const body = parseText(await ctx.client.callTool({ name: "hyphaeon_analyze", arguments: { alignment, tree, phenotype_file: csv, summary_only: true } }));
    expect(body.status).toBe("completed");
    const call = analyzeCalls[analyzeCalls.length - 1];
    expect(call.phenotype_file).toBe(csv);
    expect(call.options.phenotype_file).toBeUndefined();
  });
});
