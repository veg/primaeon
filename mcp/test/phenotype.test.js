/**
 * phenotype.test.js — `hyphaeon_phenotype` in-process on RHO against `hyphaeon phenotype`'s own
 * output (fixtures/e2e/phenotype_RHO_marine_n_permutations_0.json).
 *
 * WHY THIS FILE EXISTS
 *
 * Phenotype association was the last pillar the app could not compute: until Phase 3 this tool
 * shelled out to the Python CLI and `sections.phenotype` was null on every surface (PHASE2.md gap
 * 1). The port landed in the library (`js/src/phenotype.js`, `permulations.js`, HyphAeon/PHASE3A.md)
 * and the runtime wraps it as `runPhenotype`; this file is the evidence that the JavaScript on this
 * surface reproduces the reference's file, so that deleting the bridge cost nothing.
 *
 * The fixture is the README's Example 3: `hyphaeon phenotype -a RHO.fasta -fg turTru,balMus,...
 * --n-permutations 0 --cpu --seed 42 --mds-sign canonical`. RHO carries its tree inside the NEXUS
 * file, so no `-t` is given on either side, and `--permulations` defaults to 0 — hence "the
 * non-permutation fields": with no permulation draws and `--n-permutations 0`, `p_assoc_perm` is
 * null on every row, `gene_p_value_perm` is null, and the trait-sector null block is degenerate,
 * so EVERY number in the file is deterministic and comparable. Nothing here is statistical.
 *
 * THE CLASSES, EACH MEASURED RATHER THAN GUESSED (the run's own worst values are printed):
 *
 *   exact      the 21 top-level keys IN ORDER (phenotype.py:624-646), `taxa_count` / `codon_count`,
 *              the whole `phenotype_meta` including its description string, the four counts,
 *              `compact_pars_signature`, the site table's length / order / key order, every
 *              `site` / `ref_aa` / `derived_aa`, both frequency columns (pure counting over the
 *              two groups: measured 0.0), `p_assoc_perm` null on every row, the trait sector's
 *              membership, signatures, shared counts and its whole degenerate null block
 *              (`p_perm`, a pure count with a degenerate null: measured 0.0), and each
 *              co-selection pair's sites, residues and `shared_branches`.
 *   graph      1e-5 x max(1, |x|) — PLAN.md 5.4's class for anything downstream of an ORT forward
 *              pass. `hyphaeon_lrt` (measured 1.9e-6) and everything computed from it or from the
 *              attention: `attribution_norm`, the two attention means, `association_rho`, `score`,
 *              the gene tracks, `mean_lrt`, `similarity`, `cesi`, and the sector's
 *              `spectral_coherence` / `null_coherence_*`, which are eigenvalues of an
 *              attention-derived matrix and match on darwin/x64 but differ by 9.4e-8 relative on
 *              linux/x64 (worst of all of them: 4.7e-6, on
 *              `p_evd_length_adjusted`, which takes `max_assoc` through an exponential).
 *   probability 1e-6 ABSOLUTE for `p_lrt`, `p_value`, `p_assoc`, `p_assoc_parametric`, `q_value`
 *              and the pairs' `p_value` / `q_value`. A p-value is an exponential function of a
 *              statistic, so a 1.9e-6 RELATIVE difference in an LRT becomes ~1.8e-5 relative in
 *              its p while staying at 3.3e-7 absolute — the relative class is the wrong ruler for
 *              a number whose scale is 1e-10, and the absolute one is the honest bound.
 *
 * Those three are the whole file: no field is skipped, and none is compared at a class looser than
 * the one its arithmetic earns.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { connect, parseText, example, examplesDir, TEST_THREADS } from "./helpers.js";

const ENGINE_ROOT = path.resolve(examplesDir(), "..");
const FIXTURE = JSON.parse(readFileSync(path.join(ENGINE_ROOT, "fixtures", "e2e", "phenotype_RHO_marine_n_permutations_0.json"), "utf8"))[0];
const ref = FIXTURE.outputs;
/** The exact foreground the fixture's argv carries, so neither side can drift from the other. */
const FOREGROUND = FIXTURE.inputs.argv[FIXTURE.inputs.argv.indexOf("-fg") + 1];

/** phenotype.py:624-646 writes these, in this order. */
const RECORD_KEYS = [
  "alignment", "tree", "taxa_count", "codon_count", "phenotype_meta", "spectral_energy",
  "norm_spectral_ratio", "max_assoc", "p_evd_length_adjusted", "score_track_a", "score_track_b",
  "dual_track_composite", "compact_pars_signature", "permulations_count", "gene_p_value_perm",
  "significant_sites_count", "coselection_pairs_count", "trait_sectors_count",
  "coselection_pairs", "trait_sectors", "sites"
];

/** Downstream of the graph: PLAN.md 5.4's 1e-5 x max(1, |x|). */
const GRAPH_SITE_KEYS = ["hyphaeon_lrt", "attribution_norm", "fg_mean_attn", "bg_mean_attn", "association_rho", "score"];
/** Exponential in a graph output: compared absolutely (see the header). */
const PROBABILITY_SITE_KEYS = ["p_lrt", "p_value", "p_assoc", "p_assoc_parametric", "q_value"];
/** Pure counting over the two groups; nothing float about them. */
const EXACT_SITE_KEYS = ["site", "ref_aa", "derived_aa", "foreground_freq_pct", "background_freq_pct"];

const GRAPH_TOL = 1e-5;
const PROBABILITY_TOL = 1e-6;

const graphClass = (got, want) => Math.abs(got - want) / Math.max(1, Math.abs(want));

/** Worst relative (graph class) and absolute difference of one field over a collection. */
function worstOf(rows, refRows, key) {
  let rel = 0;
  let abs = 0;
  let at = null;
  for (let i = 0; i < refRows.length; i++) {
    const g = rows[i][key];
    const w = refRows[i][key];
    if (typeof w !== "number" || typeof g !== "number") continue;
    const r = graphClass(g, w);
    if (r > rel) {
      rel = r;
      at = refRows[i].site ?? refRows[i].site_u + "-" + refRows[i].site_v;
    }
    abs = Math.max(abs, Math.abs(g - w));
  }
  return { rel, abs, at };
}

describe("hyphaeon_phenotype in-process on RHO vs fixtures/e2e/phenotype_RHO_marine_n_permutations_0.json", () => {
  let ctx;
  let body;

  beforeAll(async () => {
    ctx = await connect({ threads: TEST_THREADS });
    const alignment = await example("RHO.fasta");
    const t0 = Date.now();
    // The fixture's own argv: no `-t` (RHO's tree is inside the NEXUS), --n-permutations 0, seed 42.
    const res = await ctx.client.callTool({
      name: "hyphaeon_phenotype",
      arguments: { alignment, foreground: FOREGROUND, n_permutations: 0, seed: 42, cpu: true }
    });
    if (res.isError) throw new Error("hyphaeon_phenotype failed: " + res.content[0].text);
    body = parseText(res);
    console.log(
      "[phenotype] RHO marine in-process: " + (Date.now() - t0) + " ms, " + body.taxa_count + " taxa x " +
        body.codon_count + " codons, " + body.sites.length + " site rows, " + body.coselection_pairs.length +
        " pairs, " + body.trait_sectors.length + " sector(s)"
    );
  }, 900000);
  afterAll(async () => {
    await ctx.close();
  });

  it("runs in this process with mcp-stdio provenance and the CLI line that reproduces it", () => {
    expect(body.analysis).toBe("phenotype");
    expect(body.provenance.surface).toBe("mcp-stdio");
    expect(body.provenance.engine).toBe("in-process");
    expect(body.provenance.mds_sign).toBe("canonical");
    expect(body.provenance.seed).toBe(42);
    expect(body.provenance.reference_command.slice(0, 2)).toEqual(["hyphaeon", "phenotype"]);
    expect(body.provenance.reference_command).toContain("--foreground");
    expect(body.provenance.reference_command).toContain("--mds-sign");
    // RHO's tree is embedded and has branch lengths, so this run is NOT tree-free.
    expect(body.provenance.preprocessing.tree_source).toBe("embedded");
    expect(body.provenance.preprocessing.tree_free).toBeNull();
    // The whole CSV/`phenotype_file` machinery aside, no Python was involved anywhere.
    expect(JSON.stringify(body.provenance)).not.toMatch(/python-reference/);
  });

  it("exact: the reference's 21 keys in order, the counts, the meta and the gene-level strings", () => {
    expect(Object.keys(body).filter((k) => RECORD_KEYS.includes(k))).toEqual(RECORD_KEYS);
    expect(body.taxa_count).toBe(ref.taxa_count);
    expect(body.codon_count).toBe(ref.codon_count);
    // The description is the reference's own Python repr of the pattern list, character for character.
    expect(body.phenotype_meta).toEqual(ref.phenotype_meta);
    expect(body.compact_pars_signature).toBe(ref.compact_pars_signature);
    expect(body.significant_sites_count).toBe(ref.significant_sites_count);
    expect(body.coselection_pairs_count).toBe(ref.coselection_pairs_count);
    expect(body.trait_sectors_count).toBe(ref.trait_sectors_count);
    // --permulations 0: no Brownian draws, so nothing here is statistical.
    expect(body.permulations_count).toBe(ref.permulations_count);
    expect(body.gene_p_value_perm).toBe(ref.gene_p_value_perm);
    expect(body.permulations.requested).toBe(0);
    expect(body.permulations.ran).toBe(0);
    expect(body.permulations.reason).toBe("not-requested");
  });

  it("graph class: every gene-level track within 1e-5 x max(1, |x|)", () => {
    const worst = {};
    for (const k of ["spectral_energy", "norm_spectral_ratio", "max_assoc", "p_evd_length_adjusted", "score_track_a", "score_track_b", "dual_track_composite"]) {
      worst[k] = graphClass(body[k], ref[k]);
    }
    console.log(
      "[phenotype] gene-level worst relative: " +
        Object.entries(worst).map(([k, v]) => k + " " + v.toExponential(2)).join("; ")
    );
    for (const [k, v] of Object.entries(worst)) expect(v, k).toBeLessThanOrEqual(GRAPH_TOL);
  });

  it("the site table: length, order, key order and the counted columns are EXACT", () => {
    expect(body.sites).toHaveLength(ref.sites.length);
    // The reference sorts by score, descending, with a stable tie-break; the order is part of the file.
    expect(body.sites.map((s) => s.site)).toEqual(ref.sites.map((s) => s.site));
    expect(Object.keys(body.sites[0])).toEqual(Object.keys(ref.sites[0]));
    for (const k of EXACT_SITE_KEYS) {
      expect(body.sites.map((s) => s[k]), k).toEqual(ref.sites.map((s) => s[k]));
    }
    // --n-permutations 0 and --permulations 0: the permutation column is null on both sides.
    expect(body.sites.every((s) => s.p_assoc_perm === null)).toBe(true);
    expect(ref.sites.every((s) => s.p_assoc_perm === null)).toBe(true);
  });

  it("the site table: model-derived columns at the graph class, p-values at 1e-6 absolute", () => {
    const lines = [];
    for (const k of GRAPH_SITE_KEYS) {
      const w = worstOf(body.sites, ref.sites, k);
      lines.push(k + " rel " + w.rel.toExponential(2) + " (site " + w.at + ")");
      expect(w.rel, k).toBeLessThanOrEqual(GRAPH_TOL);
    }
    for (const k of PROBABILITY_SITE_KEYS) {
      const w = worstOf(body.sites, ref.sites, k);
      lines.push(k + " abs " + w.abs.toExponential(2) + " (rel " + w.rel.toExponential(2) + ", site " + w.at + ")");
      expect(w.abs, k).toBeLessThanOrEqual(PROBABILITY_TOL);
    }
    console.log("[phenotype] sites: " + lines.join("; "));
  });

  it("the trait sector is exact in membership, signatures and its whole (degenerate) null block", () => {
    expect(body.trait_sectors).toHaveLength(ref.trait_sectors.length);
    for (let i = 0; i < ref.trait_sectors.length; i++) {
      const got = body.trait_sectors[i];
      const want = ref.trait_sectors[i];
      expect(Object.keys(got), "sector " + i + " keys").toEqual(Object.keys(want));
      for (const k of ["sector_id", "size", "sites", "pars_signature", "consensus_signature", "shared_taxa", "shared_branches", "isotropic_baseline"]) {
        expect(got[k], "sector." + k).toEqual(want[k]);
      }
      // n_permutations 0 makes the null a single copy of the observed value on both sides, so
      // p_perm is a pure count (1.0) and stays exact. The coherence itself is NOT: it is the
      // leading eigenvalue of a similarity matrix built from the model's attention, so it carries
      // the forward pass's rounding and belongs in the graph class like every other model-derived
      // float here. It was exact on darwin/x64 when this suite was written, which is why it sat in
      // the exact list; on CI's linux/x64 the same run gives 0.6355730295181274 against the
      // fixture's 0.6355729699134827, a relative 9.4e-8 — three orders inside the class, and
      // invariant to the thread count (1, 2 and 8 all reproduce the darwin value here).
      expect(got.p_perm, "sector.p_perm").toBe(want.p_perm);
      for (const k of ["spectral_coherence", "null_coherence_mean", "null_coherence_std", "null_coherence_95"]) {
        const relCoherence = graphClass(got[k], want[k]);
        expect(relCoherence, "sector." + k + " (graph class)").toBeLessThanOrEqual(GRAPH_TOL);
      }
      // mean_lrt is a mean of the model's LRTs.
      const rel = graphClass(got.mean_lrt, want.mean_lrt);
      console.log("[phenotype] sector " + want.sector_id + " sites [" + want.sites.join(",") + "]: mean_lrt rel " + rel.toExponential(2));
      expect(rel).toBeLessThanOrEqual(GRAPH_TOL);
    }
  });

  it("the co-selection pairs: set, order and integers exact; floats at their classes", () => {
    expect(body.coselection_pairs).toHaveLength(ref.coselection_pairs.length);
    expect(body.coselection_pairs.map((p) => [p.site_u, p.site_v])).toEqual(ref.coselection_pairs.map((p) => [p.site_u, p.site_v]));
    expect(Object.keys(body.coselection_pairs[0])).toEqual(Object.keys(ref.coselection_pairs[0]));
    for (const k of ["ref_u", "ref_v", "shared_branches"]) {
      expect(body.coselection_pairs.map((p) => p[k]), k).toEqual(ref.coselection_pairs.map((p) => p[k]));
    }
    const lines = [];
    for (const k of ["lrt_u", "lrt_v", "similarity", "cesi"]) {
      const w = worstOf(body.coselection_pairs, ref.coselection_pairs, k);
      lines.push(k + " rel " + w.rel.toExponential(2));
      expect(w.rel, k).toBeLessThanOrEqual(GRAPH_TOL);
    }
    for (const k of ["p_value", "q_value"]) {
      const w = worstOf(body.coselection_pairs, ref.coselection_pairs, k);
      lines.push(k + " abs " + w.abs.toExponential(2) + " (rel " + w.rel.toExponential(2) + ")");
      expect(w.abs, k).toBeLessThanOrEqual(PROBABILITY_TOL);
    }
    console.log("[phenotype] pairs: " + lines.join("; "));
  });

});

describe("hyphaeon_phenotype: the trait, and what a tree-free run can and cannot do", () => {
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

  it("takes a trait from a CSV's TEXT as well as from a foreground list, and never reads a path", async () => {
    const csv = "species,marine\nR_ferr,1\nR_sin,1\nR_aeg,1\nH_arm,1\nM_lyra,0\nP_disc,0\n";
    const fromCsv = parseText(
      await ctx.client.callTool({ name: "hyphaeon_phenotype", arguments: { alignment, tree, phenotype_file: csv, n_permutations: 0, top: 3 } })
    );
    expect(fromCsv.phenotype_meta.mode).toBe("discrete");
    expect(fromCsv.phenotype_meta.foreground_count).toBe(4);
    expect(fromCsv.phenotype_meta.description).toMatch(/phenotype\.csv/);
    expect(fromCsv.provenance.reference_command).toContain("--phenotype-file");
    // The CSV is an input, not an option: no copy of it is kept in the provenance.
    expect(JSON.stringify(fromCsv.provenance.options)).not.toMatch(/R_ferr/);

    const fromList = parseText(
      await ctx.client.callTool({ name: "hyphaeon_phenotype", arguments: { alignment, tree, foreground: "R_ferr,R_sin,R_aeg,H_arm", n_permutations: 0, top: 3 } })
    );
    // The same four taxa, resolved two ways, give the same association.
    expect(fromList.phenotype_meta.foreground_count).toBe(4);
    expect(fromList.sites.map((s) => s.site)).toEqual(fromCsv.sites.map((s) => s.site));
    expect(fromList.sites.map((s) => s.association_rho)).toEqual(fromCsv.sites.map((s) => s.association_rho));
  }, 900000);

  it("shapes: summary_only counts the collections, top ranks the sites by score", async () => {
    const args = { alignment, tree, foreground: "R_ferr,R_sin,R_aeg,H_arm", n_permutations: 0 };
    const full = parseText(await ctx.client.callTool({ name: "hyphaeon_phenotype", arguments: args }));
    const s = parseText(await ctx.client.callTool({ name: "hyphaeon_phenotype", arguments: { ...args, summary_only: true } }));
    expect(s.collections).toEqual({ sites: full.sites.length, trait_sectors: full.trait_sectors.length, coselection_pairs: full.coselection_pairs.length });
    expect(s.summary.significant_sites_count).toBe(full.significant_sites_count);
    expect(s.summary.top_sites[0].score).toBeGreaterThanOrEqual(s.summary.top_sites[1].score);
    const t = parseText(await ctx.client.callTool({ name: "hyphaeon_phenotype", arguments: { ...args, top: 3 } }));
    expect(t.sites).toHaveLength(3);
    expect(t.truncated.sites).toEqual({ returned: 3, total: full.sites.length, ranked_by: "score" });
  }, 900000);

  it("with a tree, permulations run; without one they are skipped with a reason, not silently", async () => {
    const trait = "R_ferr,R_sin,R_aeg,H_arm";
    const withTree = parseText(
      await ctx.client.callTool({ name: "hyphaeon_phenotype", arguments: { alignment, tree, foreground: trait, permulations: 50, n_permutations: 0, seed: 42, top: 1 } })
    );
    expect(withTree.permulations.requested).toBe(50);
    expect(withTree.permulations.reason).toBeNull();
    expect(withTree.permulations.ran).toBe(50);
    expect(typeof withTree.gene_p_value_perm).toBe("number");
    expect(withTree.sites.every((s) => typeof s.p_assoc_perm === "number")).toBe(true);

    const treeFree = parseText(
      await ctx.client.callTool({ name: "hyphaeon_phenotype", arguments: { alignment, foreground: trait, permulations: 50, n_permutations: 0, seed: 42, top: 1 } })
    );
    expect(treeFree.provenance.preprocessing.tree_source).toBe("tn93");
    expect(treeFree.permulations.requested).toBe(50);
    expect(treeFree.permulations.ran).toBe(0);
    expect(treeFree.permulations.reason).toBe("tree-free");
    expect(treeFree.permulations.detail).toMatch(/Brownian/);
    expect(treeFree.gene_p_value_perm).toBeNull();
    expect(treeFree.sites.every((s) => s.p_assoc_perm === null)).toBe(true);
    // A tree-free run only reproduces with the reference's flag.
    expect(treeFree.provenance.reference_command).toContain("--use-tn93");
  }, 900000);

  it("refuses a call with no trait at all, before any model is loaded", async () => {
    const res = await ctx.client.callTool({ name: "hyphaeon_phenotype", arguments: { alignment, tree } });
    expect(res.isError).toBe(true);
    const err = parseText(res);
    expect(err.kind).toBe("input");
    expect(err.error).toMatch(/trait definition/);
  });
});
