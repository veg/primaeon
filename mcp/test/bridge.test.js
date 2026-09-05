/**
 * bridge.test.js — the Python bridge, now serving hyphaeon_phenotype only.
 *
 * WHY THIS FILE EXISTS
 *
 * Phase 2 moved epistasis and dms in-process (src/engine.js over the library's phase-2a port),
 * so the bridge's argv tables for them are GONE and asking the bridge for them is an error —
 * that deletion is a contract (PLAN.md D16, "the bridge is deleted for that pillar") and is
 * pinned here. The phenotype table gains --seed and --mds-sign (phase-2a). The end-to-end run
 * exercises `hyphaeon phenotype` through the tool on bat_oas1 with an inline foreground (the
 * rhinolophid / hipposiderid laryngeal echolocators of that alignment), python-reference
 * provenance and a redacted command line; the input-class error path is a tree with no matching
 * taxa. Both need HYPHAEON_PY_BIN (or `hyphaeon` on PATH) and are skipped with
 * HYPHAEON_MCP_SKIP_BRIDGE=1.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { connect, parseText, example } from "./helpers.js";
import { buildArgv, classifyFailure, BRIDGED_ANALYSES as BRIDGE_ARGV_TABLES } from "../src/bridge.js";
import { BRIDGED_ANALYSES } from "../src/validate.js";

describe("bridge argv mapping (no Python)", () => {
  it("carries a flag table for exactly the bridged pillar (phenotype); epistasis and dms are gone", () => {
    expect([...BRIDGE_ARGV_TABLES]).toEqual(["phenotype"]);
    expect([...BRIDGE_ARGV_TABLES].sort()).toEqual([...BRIDGED_ANALYSES].sort());
    for (const gone of ["meme", "busted", "evaluate", "epistasis", "dms", "analyze"]) {
      expect(() => buildArgv(gone, {}, { alignment: "a", output: "o" }), gone).toThrow(/Unknown analysis/);
    }
  });

  it("maps phenotype options one-to-one onto CLI flags, --seed and --mds-sign included", () => {
    expect(
      buildArgv("phenotype", { preset: "marine", permulations: 100, alpha: 0.1, min_taxa: 6, continuous: true, seed: 7, mds_sign: "canonical" }, { alignment: "a", tree: "t", phenotype_file: "p", output: "o" })
    ).toEqual(["phenotype", "-a", "a", "-t", "t", "--phenotype-file", "p", "--preset", "marine", "--continuous", "--permulations", "100", "--min-taxa", "6", "--alpha", "0.1", "--seed", "7", "--mds-sign", "canonical", "-o", "o"]);
    expect(buildArgv("phenotype", { foreground: "R_ferr,R_sin", use_tn93: true, cpu: true }, { alignment: "/t/alignment.fasta", output: "/t/result.json" })).toEqual([
      "phenotype", "-a", "/t/alignment.fasta", "--use-tn93", "--foreground", "R_ferr,R_sin", "--cpu", "-o", "/t/result.json"
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

describe.skipIf(skipBridge)("hyphaeon_phenotype through the Python reference", () => {
  let ctx;
  beforeAll(async () => {
    ctx = await connect();
  });
  afterAll(async () => {
    await ctx.close();
  });

  it("runs bat_oas1 (18 x 351, inline foreground, 100 permutations, seed 42) with python-reference provenance", async () => {
    const alignment = await example("bat_oas1.fasta");
    const tree = await example("bat_oas1.nwk");
    const t0 = Date.now();
    const res = await ctx.client.callTool({
      name: "hyphaeon_phenotype",
      arguments: { alignment, tree, foreground: "R_ferr,R_sin,R_aeg,H_arm", n_permutations: 100, seed: 42, cpu: true, top: 5 }
    });
    if (res.isError) throw new Error("bridge failed: " + res.content[0].text);
    const body = parseText(res);
    console.log("[bridge] hyphaeon_phenotype bat_oas1 through Python: " + (Date.now() - t0) + " ms");
    expect(body.analysis).toBe("phenotype");
    expect(body.taxa_count).toBe(18);
    expect(body.codon_count).toBe(351);
    expect(body.phenotype_meta.foreground_count).toBe(4);
    expect(Array.isArray(body.sites)).toBe(true);
    expect(body.sites.length).toBeLessThanOrEqual(5);
    expect(body.truncated.sites.ranked_by).toBe("score");
    expect(body.provenance.surface).toBe("python-reference");
    expect(body.provenance.bridge).toBe("python-cli");
    expect(body.provenance.reference_version).toMatch(/^\d+\.\d+/);
    expect(body.provenance.elapsed_sec).toBeGreaterThan(0);
    expect(body.provenance.command[0]).toMatch(/hyphaeon/);
    expect(body.provenance.command).toContain("--foreground");
    expect(body.provenance.command).toContain("--n-permutations");
    expect(body.provenance.command).toContain("--seed");
    // temp paths are redacted to <tmp>/<name>; only the executable itself may be absolute
    expect(body.provenance.command.slice(1).some((a) => a.startsWith("/"))).toBe(false);
    expect(body.alignment === undefined || body.alignment === "alignment.fasta").toBe(true);
  });

  it("reports an input-class error from the CLI when the tree is unusable", async () => {
    const alignment = await example("bat_oas1.fasta");
    const res = await ctx.client.callTool({ name: "hyphaeon_phenotype", arguments: { alignment, tree: "((x:0.1,y:0.1):0.1,z:0.1);", preset: "marine", cpu: true } });
    expect(res.isError).toBe(true);
    const body = parseText(res);
    expect(body.kind).toBe("input");
    expect(body.error).toMatch(/No matching taxa/);
  });
});
