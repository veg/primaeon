/**
 * epistasis.test.js — hyphaeon_epistasis in-process on Smc6 against `hyphaeon epistasis`'s own
 * output (fixtures/e2e/epistasis_Smc6_n_permutations_1000.json, regenerated under the canonical
 * MDS sign convention at veg/HyphAeon phase-2a).
 *
 * WHY THIS FILE EXISTS
 *
 * PLAN.md 5.4 gives the epistasis pillar three parity classes at once, and the tool has to be
 * checked at each: the EDGES and the SECTOR MEMBERSHIP are "exact" (graph edges and sectors,
 * equality after canonicalisation — here the floats on an edge are checked at 1e-6, the class
 * for float32 arithmetic on the model's outputs, since the attributions themselves went through
 * ORT), `spectral_coherence` / `mean_lrt` at 1e-6, the sector-site DMS (`plasticity`) at the
 * 1e-5 graph class, and `p_perm` with the null moments STATISTICAL: the reference draws its
 * K-subsets with PCG64 and the library with xoshiro256**, so the two agree only within
 * 3*sqrt(p(1-p)/B) (PHASE2A.md measured 0.093 vs 0.080 on sector 2 at B = 1,000, both inside
 * the bound), and at B = 1,000 the null std carries ~5% of Monte Carlo error on EACH side, which
 * is why the moments are held to a wider band here than PLAN.md's "2%" that was written for
 * B = 10,000. The run uses the fixture's own argv: --n-permutations 1000 --seed 42 --cpu, DMS on.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { connect, parseText, example, examplesDir, compareDmsRecords, TEST_THREADS } from "./helpers.js";
import { mapOptions, referenceCommand } from "../src/engine.js";

const ENGINE_ROOT = path.resolve(examplesDir(), "..");
const fixture = JSON.parse(readFileSync(path.join(ENGINE_ROOT, "fixtures", "e2e", "epistasis_Smc6_n_permutations_1000.json"), "utf8"))[0];
const ref = fixture.outputs;
const B = 1000;

const INT_OR_STRING_EDGE_KEYS = ["site_u", "site_v", "ref_u", "ref_v", "shared_taxa", "shared_branches"];
/**
 * Two float classes on an edge (PLAN.md 5.4). `lrt_u` / `lrt_v` are the model's LRTs through
 * ORT and `cesi` is a function of them: the graph class, 1e-5 x max(1, |x|) (measured on Smc6:
 * 2.9e-6 absolute on lrt_v, i.e. 7e-7 relative). The cosine, its Student-t p and the BH q are
 * float32 arithmetic on the attributions: 1e-6 absolute.
 */
const GRAPH_CLASS_EDGE_KEYS = ["lrt_u", "lrt_v", "cesi"];
const FLOAT32_EDGE_KEYS = ["similarity", "p_val", "hyper_p", "fdr_q"];
const graphClass = (got, want) => Math.abs(got - want) / Math.max(1, Math.abs(want));

describe("epistasis option mapping (no model)", () => {
  it("maps the CLI's names onto runEpistasis's and defaults to no taxon cap, DMS on", () => {
    const m = mapOptions("epistasis", { n_permutations: 1000, seed: 7, min_sim: 0.4, no_dms: true, focal_taxon: "hg38", max_perm_p: 0.05 });
    expect(m.runtime).toMatchObject({ maxSpecies: Infinity, nPermutations: 1000, seed: 7, minSim: 0.4, dms: false, focalTaxon: "hg38", maxPermP: 0.05, graph: true });
    expect(mapOptions("epistasis", {}).runtime.dms).toBe(true);
    expect(mapOptions("dms", { focal_taxon: "x", sites: [1, 5, 9] }).runtime).toMatchObject({ maxSpecies: Infinity, focalTaxon: "x", siteSubset: [0, 4, 8] });
  });

  it("writes the reproduce-with-the-CLI line with --seed and --mds-sign", () => {
    expect(referenceCommand("epistasis", { n_permutations: 1000, seed: 42 }, { alignment: "Smc6.fasta", tree: "Smc6.nwk" })).toEqual([
      "hyphaeon", "epistasis", "-a", "Smc6.fasta", "-t", "Smc6.nwk", "--cpu", "--n-permutations", "1000", "--seed", "42", "--mds-sign", "canonical", "-o", "<out.json>"
    ]);
    expect(referenceCommand("dms", { focal_taxon: "r_ferr" }, { alignment: "a.fasta" })).toEqual([
      "hyphaeon", "dms", "-a", "a.fasta", "--cpu", "--focal-taxon", "r_ferr", "--mds-sign", "canonical", "-o", "<out.json>"
    ]);
  });
});

describe("hyphaeon_epistasis in-process on Smc6 vs fixtures/e2e/epistasis_Smc6_n_permutations_1000.json", () => {
  let ctx;
  let body;
  let alignment;
  let tree;

  beforeAll(async () => {
    ctx = await connect({ threads: TEST_THREADS });
    alignment = await example("Smc6.fasta");
    tree = await example("Smc6.nwk");
    const t0 = Date.now();
    const res = await ctx.client.callTool({ name: "hyphaeon_epistasis", arguments: { alignment, tree, n_permutations: B, seed: 42, cpu: true } });
    if (res.isError) throw new Error("hyphaeon_epistasis failed: " + res.content[0].text);
    body = parseText(res);
    console.log("[epistasis] Smc6 in-process: " + (Date.now() - t0) + " ms, " + body.edges.length + " edges, " + body.sectors.length + " sectors, " + body.plasticity.length + " plasticity records");
  });
  afterAll(async () => {
    await ctx.close();
  });

  it("answers in the call with mcp-stdio provenance, the CLI's document keys and the app's extras", () => {
    expect(body.analysis).toBe("epistasis");
    expect(body.provenance.surface).toBe("mcp-stdio");
    expect(body.provenance.engine).toBe("in-process");
    expect(body.provenance.mds_sign).toBe("canonical");
    expect(body.provenance.seed).toBe(42);
    expect(body.provenance.permutations).toMatchObject({ n: B, seed: 42 });
    expect(body.provenance.reference_command).toEqual(["hyphaeon", "epistasis", "-a", "alignment.fasta", "-t", "tree.nwk", "--cpu", "--n-permutations", "1000", "--seed", "42", "--mds-sign", "canonical", "-o", "<out.json>"]);
    expect(body.provenance.preprocessing).toMatchObject({ taxa_in_alignment: 20, taxa_used: 20, tree_source: "user" });
    expect(body.provenance.is_surrogate).toBe(true);
    // epistasis.py:717-731, key for key, then the app's additions.
    expect(Object.keys(body).slice(0, 14)).toEqual([
      "analysis", "alignment", "tree", "taxa_count", "codon_count", "evaluated_taxa", "coselection_edges_count", "discovered_sectors_count",
      "edges", "sectors", "plasticity", "coselection_edges", "epistatic_sectors", "selection_dms_plasticity"
    ]);
    expect(body.taxa_count).toBe(ref.taxa_count);
    expect(body.codon_count).toBe(ref.codon_count);
    expect(body.evaluated_taxa).toBe(ref.evaluated_taxa);
    expect(body.coselection_edges_count).toBe(ref.coselection_edges_count);
    expect(body.discovered_sectors_count).toBe(ref.discovered_sectors_count);
    expect(body.coselection_edges).toEqual(body.edges);
    expect(body.epistatic_sectors).toEqual(body.sectors);
    expect(body.graph.nodes.length).toBe(ref.codon_count);
    expect(body.dms_enabled).toBe(true);
    expect(body.dms_sites).toEqual(ref.plasticity.map((p) => p.site));
    expect(body.attention_source).toBe("all-sites");
  });

  it("edges: set, order, ints and strings exact; cosine/p/q within 1e-6; LRTs and CESI at the 1e-5 graph class", () => {
    expect(body.edges).toHaveLength(ref.edges.length);
    const worst = {};
    for (let i = 0; i < ref.edges.length; i++) {
      const got = body.edges[i];
      const want = ref.edges[i];
      expect(Object.keys(got), "edge " + i + " keys").toEqual(Object.keys(want));
      for (const k of INT_OR_STRING_EDGE_KEYS) expect(got[k], "edge " + i + "." + k).toBe(want[k]);
      for (const k of [...FLOAT32_EDGE_KEYS, ...GRAPH_CLASS_EDGE_KEYS]) {
        const d = FLOAT32_EDGE_KEYS.includes(k) ? Math.abs(got[k] - want[k]) : graphClass(got[k], want[k]);
        if (!worst[k] || d > worst[k].diff) worst[k] = { diff: d, edge: want.site_u + "-" + want.site_v, got: got[k], want: want[k] };
      }
    }
    console.log(
      "[epistasis] worst per edge field: " +
        Object.entries(worst)
          .map(([k, w]) => k + " " + w.diff.toExponential(2) + (GRAPH_CLASS_EDGE_KEYS.includes(k) ? " rel" : " abs") + " (edge " + w.edge + ")")
          .join("; ")
    );
    for (const k of FLOAT32_EDGE_KEYS) expect(worst[k].diff, k).toBeLessThanOrEqual(1e-6);
    for (const k of GRAPH_CLASS_EDGE_KEYS) expect(worst[k].diff, k).toBeLessThanOrEqual(1e-5);
  });

  it("sectors: membership, ids, sizes and signatures exact; coherence within 1e-6, mean LRT at the graph class; p_perm statistical", () => {
    expect(body.sectors).toHaveLength(ref.sectors.length);
    for (let i = 0; i < ref.sectors.length; i++) {
      const got = body.sectors[i];
      const want = ref.sectors[i];
      expect(Object.keys(got), "sector " + i + " keys").toEqual(Object.keys(want));
      expect(got.sector_id).toBe(want.sector_id);
      expect(got.size).toBe(want.size);
      expect(got.sites).toEqual(want.sites);
      expect(got.pars_signature).toBe(want.pars_signature);
      expect(got.consensus_signature).toBe(want.consensus_signature);
      expect(got.shared_taxa).toBe(want.shared_taxa);
      expect(got.shared_branches).toBe(want.shared_branches);
      expect(got.isotropic_baseline).toBe(want.isotropic_baseline);
      expect(Math.abs(got.spectral_coherence - want.spectral_coherence), "sector " + want.sector_id + " coherence").toBeLessThanOrEqual(1e-6);
      // mean_lrt is a mean of the model's LRTs: the graph class (measured 1.2e-6 abs on sector 2).
      expect(graphClass(got.mean_lrt, want.mean_lrt), "sector " + want.sector_id + " mean_lrt").toBeLessThanOrEqual(1e-5);
      // Statistical class: |p_js - p_py| <= 3 sqrt(p(1-p)/B), p floored at 1/B (the estimator's floor).
      const p = Math.max(want.p_perm, 1 / B);
      const bound = 3 * Math.sqrt((p * (1 - p)) / B);
      const dp = Math.abs(got.p_perm - want.p_perm);
      const rel = (k) => Math.abs(got[k] - want[k]) / Math.max(1e-12, Math.abs(want[k]));
      console.log(
        "[epistasis] sector " + want.sector_id + " sites [" + want.sites.join(",") + "]: p_perm " + got.p_perm + " vs " + want.p_perm +
          " (|dp| " + dp.toFixed(4) + " <= " + bound.toFixed(4) + "); null mean rel " + (100 * rel("null_coherence_mean")).toFixed(2) +
          "%, std rel " + (100 * rel("null_coherence_std")).toFixed(2) + "%, p95 rel " + (100 * rel("null_coherence_95")).toFixed(2) + "%"
      );
      expect(dp, "sector " + want.sector_id + " p_perm").toBeLessThanOrEqual(bound);
      // The null moments at B = 1,000: PHASE2A.md measured std excursions of ~5% (two standard
      // errors of a std estimate at this B) on the same sectors; the 2% class is for B = 10,000.
      expect(rel("null_coherence_mean"), "sector " + want.sector_id + " null mean").toBeLessThanOrEqual(0.05);
      expect(rel("null_coherence_95"), "sector " + want.sector_id + " null p95").toBeLessThanOrEqual(0.05);
      expect(rel("null_coherence_std"), "sector " + want.sector_id + " null std").toBeLessThanOrEqual(0.2);
    }
  });

  it("plasticity: the sector-site DMS matches at the 1e-5 graph class, keys and residues exact", () => {
    expect(body.plasticity).toHaveLength(ref.plasticity.length);
    expect(body.plasticity.map((p) => p.site)).toEqual(ref.plasticity.map((p) => p.site));
    const worst = compareDmsRecords(body.plasticity, ref.plasticity, 1e-5, "plasticity");
    console.log("[epistasis] plasticity worst |delta| / LRT scale " + worst.diff.toExponential(2) + " at " + worst.where);
    expect(worst.diff).toBeLessThanOrEqual(1e-5);
  });

  it("shapes: summary_only counts the collections and top ranks edges by CESI", async () => {
    const s = parseText(await ctx.client.callTool({ name: "hyphaeon_epistasis", arguments: { alignment, tree, n_permutations: 10, no_dms: true, summary_only: true } }));
    expect(s.collections).toEqual({ edges: ref.edges.length, sectors: ref.sectors.length, plasticity: 0 });
    expect(s.summary.sector_summary.map((x) => x.sites)).toEqual(ref.sectors.map((x) => x.sites));
    expect(s.summary.top_edges[0].cesi).toBeGreaterThanOrEqual(s.summary.top_edges[1].cesi);
    const t = parseText(await ctx.client.callTool({ name: "hyphaeon_epistasis", arguments: { alignment, tree, n_permutations: 10, no_dms: true, top: 2 } }));
    expect(t.edges).toHaveLength(2);
    expect(t.truncated.edges).toEqual({ returned: 2, total: ref.edges.length, ranked_by: "cesi" });
    expect(t.plasticity).toEqual([]);
    expect(t.dms_enabled).toBe(false);
  });

  it("refuses --mds-sign lapack, and runs tree-free instead of refusing it (D22)", async () => {
    const r1 = await ctx.client.callTool({ name: "hyphaeon_epistasis", arguments: { alignment, tree, mds_sign: "lapack" } });
    expect(r1.isError).toBe(true);
    expect(parseText(r1).kind).toBe("input");
    expect(parseText(r1).error).toMatch(/canonical/);
    // Before Phase 3 this was an input-class refusal; the library computes the distances now.
    const r2 = await ctx.client.callTool({ name: "hyphaeon_epistasis", arguments: { alignment, use_tn93: true, n_permutations: 10, no_dms: true, summary_only: true } });
    if (r2.isError) throw new Error(r2.content[0].text);
    const treeFree = parseText(r2);
    expect(treeFree.provenance.preprocessing.tree_source).toBe("tn93");
    expect(treeFree.provenance.preprocessing.tree_free.reason).toBe("requested");
    expect(treeFree.provenance.reference_command).toContain("--use-tn93");
    expect(typeof treeFree.summary.edges).toBe("number");
  }, 900000);
});
