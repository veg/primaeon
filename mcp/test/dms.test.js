/**
 * dms.test.js — hyphaeon_dms in-process against the reference's DMS fixtures.
 *
 * WHY THIS FILE EXISTS
 *
 * fixtures/dms/run_insilico_selection_dms.json (veg/HyphAeon phase-2a) records
 * `run_insilico_selection_dms` on bat_oas1 for two cases — the default focal taxon over the five
 * sites with LRT >= 3.84, and `focal_taxon="r_ferr"` over two of them — at the 1e-5 class
 * ("numeric 1e-5, keys/strings exact"). The standalone `hyphaeon dms` sweeps every site, which
 * the fixture does not cover, so the tool's app-side `sites` option is what lets this test ask
 * for exactly the fixture's `target_sites` (0-indexed there, 1-indexed here). The e2e epistasis
 * fixture for Smc6 carries the CLI's own sector-site DMS (six sites, default focal taxon), and
 * the same tool reproduces that table too — the second, Smc6, check below. Both hold every
 * record to the 1e-5 graph class of PLAN.md 5.4 as compareDmsRecords applies it — a mutant
 * delta is the DIFFERENCE of two ORT LRTs, so its scale is the sum of theirs (measured: the
 * fixture's own 1e-5 "relative to the value" reads 1.4e-5 on one r_ferr delta of 1.2 whose two
 * LRTs are 5.0 and 6.3) — with the key ORDER of each record and of `mutant_deltas` exact, the
 * way the Python wrote them.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { connect, parseText, example, examplesDir, compareDmsRecords, TEST_THREADS } from "./helpers.js";

const ENGINE_ROOT = path.resolve(examplesDir(), "..");
const cases = JSON.parse(readFileSync(path.join(ENGINE_ROOT, "fixtures", "dms", "run_insilico_selection_dms.json"), "utf8"));
const smc6 = JSON.parse(readFileSync(path.join(ENGINE_ROOT, "fixtures", "e2e", "epistasis_Smc6_n_permutations_1000.json"), "utf8"))[0].outputs;

describe("hyphaeon_dms in-process vs fixtures/dms/run_insilico_selection_dms.json (bat_oas1)", () => {
  let ctx;
  let alignment;
  let tree;

  beforeAll(async () => {
    ctx = await connect({ threads: TEST_THREADS });
    alignment = await example("bat_oas1.fasta");
    tree = await example("bat_oas1.nwk");
  });
  afterAll(async () => {
    await ctx.close();
  });

  for (const c of cases) {
    it("reproduces " + c.name + " at 1e-5 with keys, residues and the focal taxon exact", async () => {
      const sites = c.inputs.target_sites.map((s) => s + 1);
      const args = { alignment, tree, sites, cpu: true };
      if (c.inputs.focal_taxon) args.focal_taxon = c.inputs.focal_taxon;
      const t0 = Date.now();
      const res = await ctx.client.callTool({ name: "hyphaeon_dms", arguments: args });
      if (res.isError) throw new Error("hyphaeon_dms failed: " + res.content[0].text);
      const body = parseText(res);
      console.log("[dms] " + c.name + ": " + (Date.now() - t0) + " ms, " + body.plasticity.length + " sites swept");

      expect(body.analysis).toBe("dms");
      expect(body.provenance.surface).toBe("mcp-stdio");
      expect(body.provenance.engine).toBe("in-process");
      expect(body.provenance.mds_sign).toBe("canonical");
      expect(body.provenance.focal_index).toBe(c.outputs.focal_index);
      expect(body.provenance.focal_name).toBe(c.outputs.focal_name);
      expect(body.provenance.reference_command.slice(0, 2)).toEqual(["hyphaeon", "dms"]);
      // epistasis.py:759-768 key for key first.
      expect(Object.keys(body).slice(0, 9)).toEqual(["analysis", "alignment", "tree", "taxa_count", "codon_count", "focal_taxon", "total_mutations", "plasticity", "selection_dms_plasticity"]);
      expect(body.taxa_count).toBe(18);
      expect(body.codon_count).toBe(351);
      // run_digital_dms_analysis: the CALLER's string, else the first taxon in tree order (the
      // fixture's focal_name for index 0); 19 x L whatever was swept.
      expect(body.focal_taxon).toBe(c.inputs.focal_taxon || c.outputs.focal_name);
      expect(body.total_mutations).toBe(19 * 351);
      expect(body.progress).toEqual({ done: sites.length, total: sites.length });
      expect(body.selection_dms_plasticity).toEqual(body.plasticity);

      expect(body.plasticity.map((p) => p.site)).toEqual(c.outputs.plasticity.map((p) => p.site));
      const worst = compareDmsRecords(body.plasticity, c.outputs.plasticity, 1e-5, c.name + ".plasticity");
      console.log("[dms] " + c.name + ": worst |delta| / LRT scale " + worst.diff.toExponential(2) + " at " + worst.where + " (scale " + (worst.scale || 0).toFixed(2) + ")");
      expect(worst.diff).toBeLessThanOrEqual(1e-5);
    });
  }

  it("refuses sites outside 1..codon_count and --mds-sign lapack with input-class errors", async () => {
    const bad = await ctx.client.callTool({ name: "hyphaeon_dms", arguments: { alignment, tree, sites: [1, 352] } });
    expect(bad.isError).toBe(true);
    expect(parseText(bad).kind).toBe("input");
    expect(parseText(bad).error).toMatch(/out of range/);
    const lapack = await ctx.client.callTool({ name: "hyphaeon_dms", arguments: { alignment, tree, sites: [1], mds_sign: "lapack" } });
    expect(lapack.isError).toBe(true);
    expect(parseText(lapack).error).toMatch(/canonical/);
  });

  it("shapes: summary_only reports the most plastic and most rigid sites; top ranks by intrinsic plasticity", async () => {
    const sites = cases[0].inputs.target_sites.map((s) => s + 1);
    const s = parseText(await ctx.client.callTool({ name: "hyphaeon_dms", arguments: { alignment, tree, sites, summary_only: true } }));
    expect(s.collections).toEqual({ plasticity: sites.length });
    expect(s.summary.most_plastic[0].intrinsic_plasticity).toBeGreaterThanOrEqual(s.summary.most_rigid[0].intrinsic_plasticity);
    const t = parseText(await ctx.client.callTool({ name: "hyphaeon_dms", arguments: { alignment, tree, sites, top: 2 } }));
    expect(t.plasticity).toHaveLength(2);
    expect(t.truncated.plasticity).toEqual({ returned: 2, total: sites.length, ranked_by: "intrinsic_plasticity" });
  });
});

describe("hyphaeon_dms in-process on Smc6 sector sites vs the CLI's own sector DMS (fixtures/e2e/epistasis_Smc6)", () => {
  let ctx;
  beforeAll(async () => {
    ctx = await connect({ threads: TEST_THREADS });
  });
  afterAll(async () => {
    await ctx.close();
  });

  it("matches the six plasticity records of `hyphaeon epistasis` at 1e-5", async () => {
    const alignment = await example("Smc6.fasta");
    const tree = await example("Smc6.nwk");
    const sites = smc6.plasticity.map((p) => p.site);
    const t0 = Date.now();
    const res = await ctx.client.callTool({ name: "hyphaeon_dms", arguments: { alignment, tree, sites, cpu: true } });
    if (res.isError) throw new Error("hyphaeon_dms failed: " + res.content[0].text);
    const body = parseText(res);
    console.log("[dms] Smc6 sector sites: " + (Date.now() - t0) + " ms");
    expect(body.taxa_count).toBe(smc6.taxa_count);
    expect(body.codon_count).toBe(smc6.codon_count);
    expect(body.total_mutations).toBe(19 * smc6.codon_count);
    const worst = compareDmsRecords(body.plasticity, smc6.plasticity, 1e-5, "Smc6.plasticity");
    console.log("[dms] Smc6: worst |delta| / LRT scale " + worst.diff.toExponential(2) + " at " + worst.where);
    expect(worst.diff).toBeLessThanOrEqual(1e-5);
  });
});
