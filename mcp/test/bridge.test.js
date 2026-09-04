import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { connect, parseText, example } from "./helpers.js";
import { buildArgv, classifyFailure } from "../src/bridge.js";

describe("bridge argv mapping (no Python)", () => {
  it("maps meme options one-to-one onto CLI flags", () => {
    const argv = buildArgv(
      "meme",
      { filter: true, attribute: true, model_variant: "viral", max_species: 128, use_tn93: false, cpu: true },
      { alignment: "/t/alignment.fasta", tree: "/t/tree.nwk", output: "/t/result.json" }
    );
    expect(argv).toEqual([
      "meme", "-a", "/t/alignment.fasta", "-t", "/t/tree.nwk",
      "--model-variant", "viral", "--max-species", "128", "--cpu", "--filter", "--attribute",
      "-o", "/t/result.json"
    ]);
  });

  it("maps epistasis, phenotype and evaluate options", () => {
    expect(
      buildArgv("epistasis", { n_permutations: 1000, max_perm_p: 0.05, min_coherence: 0.6, min_clique_size: 4, max_overlap: 0.3, no_dms: true, no_tree: true }, { alignment: "a", output: "o" })
    ).toEqual(["epistasis", "-a", "a", "--no-tree", "--min-clique-size", "4", "--max-overlap", "0.3", "--min-coherence", "0.6", "--n-permutations", "1000", "--max-perm-p", "0.05", "--no-dms", "-o", "o"]);
    expect(
      buildArgv("phenotype", { preset: "marine", permulations: 100, alpha: 0.1, min_taxa: 6, continuous: true }, { alignment: "a", tree: "t", phenotype_file: "p", output: "o" })
    ).toEqual(["phenotype", "-a", "a", "-t", "t", "--phenotype-file", "p", "--preset", "marine", "--continuous", "--permulations", "100", "--min-taxa", "6", "--alpha", "0.1", "-o", "o"]);
    expect(buildArgv("evaluate", { variable_only: true }, { prediction: "g.csv", meme_result: "g.MEME.json", output: "o" })).toEqual([
      "evaluate", "--prediction", "g.csv", "--meme-result", "g.MEME.json", "--variable-only", "-o", "o", "--format", "json"
    ]);
  });

  it("classifies CLI failures into the two classes", () => {
    expect(classifyFailure("[*] Parsing\n[!] Error loading alignment and tree: No tree specified (--tree)\n", "", 1)).toEqual({
      kind: "input",
      cause: "No tree specified (--tree)"
    });
    expect(classifyFailure("[!] Error loading alignment and tree: ImportError: The 'tn93' tool or python package is required\n", "", 1).kind).toBe("server");
    expect(classifyFailure("", "Traceback (most recent call last):\n  ...\nModuleNotFoundError: No module named 'torch'\n", 1).kind).toBe("server");
    expect(classifyFailure("", "usage: hyphaeon evaluate ...\nhyphaeon evaluate: error: prediction gene 'Gene1' does not match MEME result gene 'Gene2'\n", 2)).toEqual({
      kind: "input",
      cause: "prediction gene 'Gene1' does not match MEME result gene 'Gene2'"
    });
    expect(classifyFailure("[!] Phenotype Association Error: Unknown preset 'x'\nTraceback (most recent call last):\n ...\n", "", 1)).toEqual({
      kind: "input",
      cause: "Unknown preset 'x'"
    });
  });
});

const skipBridge = process.env.HYPHAEON_MCP_SKIP_BRIDGE === "1";

describe.skipIf(skipBridge)("hyphaeon_meme through the Python bridge", () => {
  let ctx;
  beforeAll(async () => {
    ctx = await connect();
  });
  afterAll(async () => {
    await ctx.close();
  });

  it("scores bat_oas1 (18 x 351) inside the call with python-reference provenance", async () => {
    const alignment = await example("bat_oas1.fasta");
    const tree = await example("bat_oas1.nwk");
    const res = await ctx.client.callTool({ name: "hyphaeon_meme", arguments: { alignment, tree, cpu: true } });
    if (res.isError) throw new Error("bridge failed: " + res.content[0].text);
    const body = parseText(res);
    expect(body.analysis).toBe("meme");
    expect(body.taxa_count).toBe(18);
    expect(body.codon_count).toBe(351);
    expect(body.sites).toHaveLength(351);
    expect(body.sites[0]).toMatchObject({ site: 1, is_invariable: true, hyphaeon_lrt: 0 });
    expect(body.sites.every((s) => typeof s.p_value === "number" && typeof s.q_value === "number")).toBe(true);
    expect(body.provenance.surface).toBe("python-reference");
    expect(body.provenance.is_surrogate).toBe(true);
    expect(body.provenance.surrogate_for).toBe("MEME");
    expect(body.provenance.reference_version).toMatch(/^\d+\.\d+/);
    expect(body.provenance.elapsed_sec).toBeGreaterThan(0);
    expect(body.provenance.command[0]).toMatch(/hyphaeon/);
    expect(body.provenance.command).not.toContain(body.alignment);
    expect(body.alignment).toBe("alignment.fasta");
  });

  it("reports an input-class error from the CLI when the tree is unusable", async () => {
    const alignment = await example("bat_oas1.fasta");
    const res = await ctx.client.callTool({ name: "hyphaeon_meme", arguments: { alignment, tree: "((x:0.1,y:0.1):0.1,z:0.1);", cpu: true } });
    expect(res.isError).toBe(true);
    const body = parseText(res);
    expect(body.kind).toBe("input");
    expect(body.error).toMatch(/No matching taxa/);
  });

  it("evaluate runs the CLI on a synthetic gene", async () => {
    const prediction = "site,hyphaeon_lrt,p_value,q_value,is_invariable\n1,4.0,0.01,0.01,False\n2,3.0,0.10,0.10,False\n3,2.0,0.04,0.04,False\n4,1.0,0.80,0.80,True\n";
    const row = (l, p) => [0, 0, 1, 0, 1, l, p];
    const meme_result = JSON.stringify({
      input: { "number of sites": 4 },
      MLE: { headers: [["alpha", ""], ["beta1", ""], ["p1", ""], ["beta+", ""], ["p+", ""], ["LRT", ""], ["p-value", ""]], content: { 0: [row(5, 0.02), row(1, 0.5), row(3, 0.04), row(0, 1)] } },
      "data partitions": { 0: { coverage: [[0, 1, 2, 3]] } }
    });
    const res = await ctx.client.callTool({ name: "hyphaeon_evaluate", arguments: { prediction, meme_result, gene: "Gene1" } });
    if (res.isError) throw new Error("bridge failed: " + res.content[0].text);
    const body = parseText(res);
    expect(body.matched_genes).toBe(1);
    expect(body.total_sites).toBe(4);
    expect(body.thresholds["0.05"]).toHaveProperty("roc_auc");
    expect(body.provenance.is_surrogate).toBe(false);
  });
});
