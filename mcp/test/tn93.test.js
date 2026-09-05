/**
 * tn93.test.js — the tree-free path end to end: `hyphaeon_meme` on camelid with NO TREE against
 * `hyphaeon meme --use-tn93`'s own output (fixtures/e2e/meme_camelid_tn93.json).
 *
 * WHY THIS FILE EXISTS
 *
 * D22 is the decision this file exists to hold. Before Phase 3, camelid could not be scored at
 * parity by any surface in this repository: its tree has a topology and no branch lengths, so the
 * app fitted HKY85 with HyPhy 2.5.98 compiled to WebAssembly while the fixtures came from native
 * HyPhy 2.5.65, and the residual (max |delta patristic| 3.7e-4, up to 2e-2 relative on an LRT) was
 * a tolerance nobody could close — PHASE2.md gap 3. D22 removes the fitting entirely: when there
 * is no usable tree BOTH sides compute the same pairwise TN93 distance matrix (measured
 * bit-identical in HyphAeon/PHASE3A.md's probe, because the tn93 package rounds to six significant
 * digits) and feed it to the MDS. The parity gap is gone by construction rather than by tolerance,
 * and this test is what says so on this surface.
 *
 * WHAT IS COMPARED, AND AT WHICH CLASS (PLAN.md 5.4):
 *   - exact: the document's key order, `taxa_count` (212 — every sequence is kept, in ALIGNMENT
 *     order, because tree-free mode does no taxon matching), `codon_count`, the site numbers and
 *     the `is_invariable` mask;
 *   - the graph class, 1e-5 x max(1, |lrt|), with NO sign allowance and no exemption:
 *     `hyphaeon_lrt`. This is the clause PHASE2.md could not assert for camelid;
 *   - float32-exact: `p_value` / `q_value`, as the reference functions on THIS surface's LRTs
 *     (cmd_meme writes both as float32) — the same rule engine.test.js applies to bat_oas1.
 *
 * The fixture ran `--use-tn93` explicitly ('requested'); this call passes no tree at all
 * ('no_tree'). The two reasons take the same branch of `loadAlignmentAndTree` and therefore the
 * same numbers, which is the point: a user who simply has no tree gets what the reference's flag
 * gives, without knowing the flag exists. The `use_tn93: true` spelling is checked to agree.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { memeSitePq } from "@veg/hyphaeon-js";
import { connect, parseText, example, examplesDir, TEST_THREADS } from "./helpers.js";

const ENGINE_ROOT = path.resolve(examplesDir(), "..");
const fixture = (name) => JSON.parse(readFileSync(path.join(ENGINE_ROOT, "fixtures", "e2e", name), "utf8"))[0];
const ref = fixture("meme_camelid_tn93.json").outputs;

/** PLAN.md 5.4's graph class for a model output. */
const graphClass = (got, want) => Math.abs(got - want) / Math.max(1, Math.abs(want));

describe("hyphaeon_meme with no tree on camelid vs fixtures/e2e/meme_camelid_tn93.json", () => {
  let ctx;
  let body;
  let alignment;

  beforeAll(async () => {
    ctx = await connect({ threads: TEST_THREADS });
    alignment = await example("camelid.fasta");
    const t0 = Date.now();
    // No `tree` argument at all: the whole point of D22 is that this is a normal run.
    const res = await ctx.client.callTool({ name: "hyphaeon_meme", arguments: { alignment, cpu: true } });
    if (res.isError) throw new Error("hyphaeon_meme failed: " + res.content[0].text);
    body = parseText(res);
    console.log("[tn93] camelid meme with no tree: " + (Date.now() - t0) + " ms, " + body.sites.length + " sites, " + body.taxa_count + " taxa");
  }, 900000);
  afterAll(async () => {
    await ctx.close();
  });

  it("runs tree-free without being asked to, and says so in the provenance", () => {
    expect(body.analysis).toBe("meme");
    expect(body.provenance.surface).toBe("mcp-stdio");
    expect(body.provenance.engine).toBe("in-process");
    expect(body.provenance.mds_sign).toBe("canonical");
    const pre = body.provenance.preprocessing;
    expect(pre.tree_source).toBe("tn93");
    expect(pre.tree_free.reason).toBe("no_tree");
    expect(pre.branch_lengths_estimated).toBe(false);
    // Tree-free mode keeps every sequence, in alignment order: no matching, no dropped taxa.
    expect(pre.taxa_in_alignment).toBe(212);
    expect(pre.taxa_used).toBe(212);
    expect(pre.dropped_taxa).toEqual([]);
    expect(pre.match_tier).toBeNull();
    // The reference REFUSES a missing tree, so only `--use-tn93` reproduces this run.
    expect(body.provenance.reference_command).toContain("--use-tn93");
    expect(body.provenance.warnings.map((w) => w.code)).toContain("TREE_FREE_TN93");
    expect(body.provenance.warnings.map((w) => w.code)).not.toContain("BRANCH_LENGTHS_MISSING");
  });

  it("exact: the document shape, taxa/codon counts, site order and the invariable mask", () => {
    expect(Object.keys(body).slice(0, 11)).toEqual([
      "analysis", "alignment", "tree", "taxa_count", "codon_count", "runtime_sec",
      "filter_enabled", "artifacts_masked", "attribution_enabled", "attributions", "sites"
    ]);
    expect(body.taxa_count).toBe(ref.taxa_count);
    expect(body.codon_count).toBe(ref.codon_count);
    expect(body.sites).toHaveLength(ref.sites.length);
    expect(body.sites.map((s) => s.site)).toEqual(ref.sites.map((s) => s.site));
    expect(body.sites.map((s) => s.is_invariable)).toEqual(ref.sites.map((s) => s.is_invariable));
    for (const s of body.sites) if (s.is_invariable) expect(s.hyphaeon_lrt).toBe(0);
  });

  it("graph class: hyphaeon_lrt within 1e-5 x max(1, |lrt|) of `hyphaeon meme --use-tn93`", () => {
    let maxRel = 0;
    let maxAbs = 0;
    let worst = null;
    for (let i = 0; i < ref.sites.length; i++) {
      const got = body.sites[i].hyphaeon_lrt;
      const want = ref.sites[i].hyphaeon_lrt;
      const rel = graphClass(got, want);
      maxAbs = Math.max(maxAbs, Math.abs(got - want));
      if (rel > maxRel) {
        maxRel = rel;
        worst = { site: i + 1, got, want };
      }
    }
    console.log(
      "[tn93] camelid LRT vs the reference: max relative " + maxRel.toExponential(2) +
        " (abs " + maxAbs.toExponential(2) + ", site " + (worst && worst.site) + ")"
    );
    expect(maxRel).toBeLessThanOrEqual(1e-5);
  });

  it("p and q are cmd_meme's float32 casts of the library's stats on this surface's LRTs", () => {
    const lrt = Float32Array.from(body.sites, (s) => s.hyphaeon_lrt);
    const { pvals, qvals } = memeSitePq(lrt);
    for (let i = 0; i < lrt.length; i++) {
      expect(body.sites[i].p_value).toBe(Math.fround(pvals[i]));
      expect(body.sites[i].q_value).toBe(Math.fround(qvals[i]));
    }
    // An invariable site never goes through the graph, so its p IS the fixture's, exactly.
    const inv = body.sites.findIndex((s) => s.is_invariable);
    expect(inv).toBeGreaterThanOrEqual(0);
    expect(body.sites[inv].p_value).toBe(ref.sites[inv].p_value);
    expect(body.sites[inv].q_value).toBe(ref.sites[inv].q_value);
  });

  it("`use_tn93: true` with the topology-only tree supplied gives the SAME numbers", async () => {
    const tree = await example("camelid.nwk");
    const res = await ctx.client.callTool({ name: "hyphaeon_meme", arguments: { alignment, tree, use_tn93: true, cpu: true } });
    if (res.isError) throw new Error(res.content[0].text);
    const forced = parseText(res);
    expect(forced.provenance.preprocessing.tree_source).toBe("tn93");
    expect(forced.provenance.preprocessing.tree_free.reason).toBe("requested");
    // Same distances, same MDS, same tokens: the LRTs are equal bit for bit, not merely close.
    expect(forced.sites.map((s) => s.hyphaeon_lrt)).toEqual(body.sites.map((s) => s.hyphaeon_lrt));

    // And the topology-only tree WITHOUT the flag takes the same branch, for the other reason.
    const implied = parseText(await ctx.client.callTool({ name: "hyphaeon_meme", arguments: { alignment, tree, cpu: true } }));
    expect(implied.provenance.preprocessing.tree_free.reason).toBe("no_branch_lengths");
    expect(implied.sites.map((s) => s.hyphaeon_lrt)).toEqual(body.sites.map((s) => s.hyphaeon_lrt));
  }, 900000);
});
