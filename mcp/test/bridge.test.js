import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { connect, parseText, example } from "./helpers.js";
import { buildArgv, classifyFailure, BRIDGED_ANALYSES as BRIDGE_ARGV_TABLES } from "../src/bridge.js";
import { BRIDGED_ANALYSES } from "../src/validate.js";

describe("bridge argv mapping (no Python)", () => {
  it("carries a flag table for exactly the bridged pillars; the native ones are gone", () => {
    expect([...BRIDGE_ARGV_TABLES].sort()).toEqual([...BRIDGED_ANALYSES].sort());
    expect(() => buildArgv("meme", {}, { alignment: "a", output: "o" })).toThrow(/Unknown analysis/);
    expect(() => buildArgv("evaluate", {}, { output: "o" })).toThrow(/Unknown analysis/);
  });

  it("maps dms options one-to-one onto CLI flags", () => {
    expect(buildArgv("dms", { focal_taxon: "hg38", use_tn93: true, cpu: true }, { alignment: "/t/alignment.fasta", output: "/t/result.json" })).toEqual([
      "dms", "-a", "/t/alignment.fasta", "--use-tn93", "--focal-taxon", "hg38", "--cpu", "-o", "/t/result.json"
    ]);
  });

  it("maps epistasis and phenotype options", () => {
    expect(
      buildArgv("epistasis", { n_permutations: 1000, max_perm_p: 0.05, min_coherence: 0.6, min_clique_size: 4, max_overlap: 0.3, no_dms: true, no_tree: true }, { alignment: "a", output: "o" })
    ).toEqual(["epistasis", "-a", "a", "--no-tree", "--min-clique-size", "4", "--max-overlap", "0.3", "--min-coherence", "0.6", "--n-permutations", "1000", "--max-perm-p", "0.05", "--no-dms", "-o", "o"]);
    expect(
      buildArgv("phenotype", { preset: "marine", permulations: 100, alpha: 0.1, min_taxa: 6, continuous: true }, { alignment: "a", tree: "t", phenotype_file: "p", output: "o" })
    ).toEqual(["phenotype", "-a", "a", "-t", "t", "--phenotype-file", "p", "--preset", "marine", "--continuous", "--permulations", "100", "--min-taxa", "6", "--alpha", "0.1", "-o", "o"]);
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

describe.skipIf(skipBridge)("bridged pillars through the Python reference", () => {
  let ctx;
  beforeAll(async () => {
    ctx = await connect();
  });
  afterAll(async () => {
    await ctx.close();
  });

  it("hyphaeon_epistasis runs bat_oas1 (18 x 351, no DMS, 100 permutations) with python-reference provenance", async () => {
    const alignment = await example("bat_oas1.fasta");
    const tree = await example("bat_oas1.nwk");
    const res = await ctx.client.callTool({
      name: "hyphaeon_epistasis",
      arguments: { alignment, tree, no_dms: true, n_permutations: 100, cpu: true, top: 5 }
    });
    if (res.isError) throw new Error("bridge failed: " + res.content[0].text);
    const body = parseText(res);
    expect(body.analysis).toBe("epistasis");
    expect(body.taxa_count).toBe(18);
    expect(body.codon_count).toBe(351);
    expect(Array.isArray(body.edges)).toBe(true);
    expect(Array.isArray(body.sectors)).toBe(true);
    expect(body.provenance.surface).toBe("python-reference");
    expect(body.provenance.bridge).toBe("python-cli");
    expect(body.provenance.reference_version).toMatch(/^\d+\.\d+/);
    expect(body.provenance.elapsed_sec).toBeGreaterThan(0);
    expect(body.provenance.command[0]).toMatch(/hyphaeon/);
    expect(body.provenance.command).toContain("--no-dms");
    expect(body.provenance.command).toContain("--n-permutations");
    // temp paths are redacted to <tmp>/<name>; only the executable itself may be absolute
    expect(body.provenance.command.slice(1).some((a) => a.startsWith("/"))).toBe(false);
    expect(body.alignment === undefined || body.alignment === "alignment.fasta").toBe(true);
  });

  it("reports an input-class error from the CLI when the tree is unusable (hyphaeon_dms)", async () => {
    const alignment = await example("bat_oas1.fasta");
    const res = await ctx.client.callTool({ name: "hyphaeon_dms", arguments: { alignment, tree: "((x:0.1,y:0.1):0.1,z:0.1);", cpu: true } });
    expect(res.isError).toBe(true);
    const body = parseText(res);
    expect(body.kind).toBe("input");
    expect(body.error).toMatch(/No matching taxa/);
  });
});
