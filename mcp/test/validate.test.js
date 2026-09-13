/**
 * validate.test.js — hyphaeon_validate's decision layer over the library's diagnose().
 *
 * WHY THIS FILE EXISTS. The parse and the caps are this server's; the codes are the library's,
 * and PLAN.md 4.3 makes them the contract every surface shares. Phase 3 rewrites two rows of that
 * contract (D22): `TREE_MISSING` (refuse) and `BRANCH_LENGTHS_MISSING` (warn) are GONE, replaced
 * by `TREE_FREE_TN93` at INFO level with the reason, so an alignment with no tree is a run this
 * server accepts rather than one it refuses. `TN93_UNAVAILABLE` is gone with them: the library
 * computes the distances, so there is nothing to be unavailable. Each of those is pinned here by
 * absence as well as by presence, because a regression would silently make a whole class of
 * upload fail again.
 */

import { describe, it, expect } from "vitest";
import { DIAGNOSTIC_CODES } from "@veg/hyphaeon-js";
import { DATE_DIAGNOSTIC_CODES } from "@veg/hyphaeon-runtime/dates";
import { parseAlignment, hasEmbeddedTree, diagnose, treeSourceFrom, CODES, NATIVE_ANALYSES } from "../src/validate.js";
import { classifyRun, workFor, MAX_SYNC_WORK } from "../src/caps.js";
import { example } from "./helpers.js";

describe("parseAlignment is the library's dataset.py mirror", () => {
  it("reads FASTA, takes the first header token, strips quotes, maps U to T, stops at an embedded tree", () => {
    // dataset.py:106 takes the first whitespace token of the header and strips quotes, so
    // `>'seq one'` is the name `seq`; the library replicates it and this pins it on this surface.
    const text = ">'seq one' extra\nauggca\nAUG\n>seq_two\nATGGCAATG\n((seq one,seq_two));\n";
    const p = parseAlignment(text);
    expect(p.format).toBe("fasta");
    expect(p.sequences).toEqual([
      { name: "seq", seq: "ATGGCAATG" },
      { name: "seq_two", seq: "ATGGCAATG" }
    ]);
    expect(hasEmbeddedTree(text)).toBe(true);
    expect(hasEmbeddedTree(">a\nATG\n")).toBe(false);
  });

  it("reads PHYLIP sequential (rows need more than 10 sequence characters, dataset.py:80)", () => {
    const text = "3 12\nA ATGGCAATGAAA\nB ATGGCAATCAAA\nC ATGGCTATGAAA\n";
    const p = parseAlignment(text);
    expect(p.format).toBe("phylip");
    expect(p.sequences.map((s) => s.name)).toEqual(["A", "B", "C"]);
    expect(p.sequences[0].seq).toBe("ATGGCAATGAAA");
    expect(parseAlignment("3 9\nA ATGGCAATG\nB ATGGCAATC\nC ATGGCTATG\n").format).not.toBe("phylip");
  });

  it("reads NEXUS with quoted names and interleaved rows", () => {
    const text = "#NEXUS\nBEGIN DATA;\nDIMENSIONS NTAX=2 NCHAR=6;\nFORMAT DATATYPE=DNA;\nMATRIX\n'a_b' ATG\n'c'   ATG\n'a_b' GCA\n'c'   GCC\n;\nEND;\n";
    const p = parseAlignment(text);
    expect(p.format).toBe("nexus");
    expect(p.sequences).toEqual([
      { name: "a_b", seq: "ATGGCA" },
      { name: "c", seq: "ATGGCC" }
    ]);
  });

  it("returns unknown for garbage and never throws", () => {
    expect(parseAlignment("hello world").format).toBe("unknown");
    expect(parseAlignment("").sequences).toEqual([]);
    expect(parseAlignment(">\nATG\n").sequences).toEqual([]); // dataset.py:107 raises; here: no sequences
  });
});

describe("CODES", () => {
  it("publishes every library code plus the two app codes, and none of the three D22 retired", () => {
    for (const c of DIAGNOSTIC_CODES) expect(CODES).toHaveProperty(c);
    // The library's codes, the app codes, and — since Phase 6 — the date layer's own thirty-one
    // plus this surface's three (two date gates and the dating distance-mode pair). Since the
    // phase 6 review hyphaeon_validate EMITS the date codes as well, for analysis dates / dating /
    // temporal; the rest are published so a client that sees one from hyphaeon_dates can look it up.
    const extra = Object.keys(CODES).filter((c) => !DIAGNOSTIC_CODES.includes(c)).sort();
    expect(extra).toContain("CAPS_EXCEEDED");
    expect(extra).toContain("RUN_MODE");
    expect(extra).toContain("DATING_LATENT_NEEDS_MODEL");
    expect(extra.filter((c) => !/^(DATES?|DATE|DATING)_/.test(c))).toEqual(["CAPS_EXCEEDED", "RUN_MODE"]);
    for (const code of DATE_DIAGNOSTIC_CODES) expect(CODES, code).toHaveProperty(code);
    for (const code of ["DATES_BARE_NUMBER_MAJORITY", "DATES_UNDATED_PRESENT"]) expect(CODES, code).toHaveProperty(code);
    expect(CODES).toHaveProperty("TREE_FREE_TN93");
    expect(CODES).toHaveProperty("TN93_SATURATED_PAIRS");
    for (const gone of ["TREE_MISSING", "BRANCH_LENGTHS_MISSING", "TN93_UNAVAILABLE"]) expect(CODES).not.toHaveProperty(gone);
  });

  it("every pillar is native: there is no bridged list left", () => {
    expect([...NATIVE_ANALYSES].sort()).toEqual(["analyze", "busted", "dates", "dating", "dms", "epistasis", "evaluate", "meme", "phenotype", "temporal"]);
  });

  it("sizes the three time analyses honestly: no model where none runs, and temporal always a job", async () => {
    const alignment = await example("H5N1_HA_geo.fasta");

    // `dates` reads sequence NAMES: no codon is parsed, no matrix is built, no graph is loaded.
    // Quoting the library's model-pass cost here would promise a forward pass it never makes.
    const dates = diagnose({ alignment, analysis: "dates" });
    expect(dates.summary.work).toBe(0);
    expect(dates.summary.engine).toBe("in-process (no model)");
    expect(dates.summary.estimated_seconds).toBeLessThan(0.5);
    const datesMode = dates.warnings.find((w) => w.code === "RUN_MODE");
    expect(datesMode.message).toMatch(/loads NO model and no graph/);
    expect(datesMode.message).not.toMatch(/ONNX Runtime/);
    expect(datesMode.data.runs_the_model).toBe(false);

    // `dating`'s default path is O(taxa x codons) and model-free; `use_model` is opt-in and this
    // tool has no flag for it, so it sizes the default and says which default it sized.
    const dating = diagnose({ alignment, analysis: "dating" });
    expect(dating.summary.engine).toBe("in-process (no model unless use_model)");
    expect(dating.summary.work).toBe(workFor("dating", dating.summary.codons, dating.summary.sequence_count));
    expect(dating.summary.work).toBeLessThan(workFor("meme", dating.summary.codons, dating.summary.sequence_count));
    expect(dating.warnings.find((w) => w.code === "RUN_MODE").message).toMatch(/by default, loads NO model/);

    // `temporal` is ALWAYS a job however small the input, because its record is megabytes.
    const temporal = diagnose({ alignment, analysis: "temporal" });
    expect(temporal.summary.mode).toBe("job");
    const tMode = temporal.warnings.find((w) => w.code === "RUN_MODE");
    expect(tMode.data.mode).toBe("job");
    expect(tMode.message).toMatch(/ALWAYS returns a job id/);
    expect(tMode.message).toMatch(/never the record/);
    // And its estimate carries the null, which the library's one-pass figure does not know about.
    expect(temporal.summary.estimated_seconds).toBeGreaterThan(diagnose({ alignment, analysis: "meme" }).summary.estimated_seconds);
  });

  it("treeSourceFrom names what the run will record", () => {
    expect(treeSourceFrom({ treeGiven: true })).toBe("user");
    expect(treeSourceFrom({ treeGiven: false, embedded: true })).toBe("embedded");
    expect(treeSourceFrom({ treeGiven: false, embedded: false })).toBe("tn93");
    expect(treeSourceFrom({ treeGiven: true, treeFree: true })).toBe("tn93");
  });
});

describe("diagnose on the bundled examples", () => {
  it("camelid: a topology-only tree goes tree-free (no_branch_lengths), at INFO, for every pillar", async () => {
    const alignment = await example("camelid.fasta");
    const tree = await example("camelid.nwk");
    const out = diagnose({ alignment, tree });
    const w = out.warnings.find((x) => x.code === "TREE_FREE_TN93");
    expect(w).toBeDefined();
    expect(w.severity).toBe("info");
    expect(w.data.reason).toBe("no_branch_lengths");
    expect(w.data.treeKeptForDisplay).toBe(true);
    expect(out.ok).toBe(true);
    expect(out.summary.tree_source).toBe("tn93");
    expect(out.summary.tree_free).toBe("no_branch_lengths");
    expect(out.summary.sequence_count).toBe(212);
    expect(out.summary.codons).toBe(96);
    expect(out.summary.engine).toBe("in-process");
    // The D22 vocabulary: nothing warns about missing branch lengths and nothing offers HyPhy.
    expect(out.warnings.map((x) => x.code)).not.toContain("BRANCH_LENGTHS_MISSING");
    expect(JSON.stringify(out)).not.toMatch(/hyphy/i);

    // Every pillar, phenotype included, is in-process and sees the same decision.
    for (const analysis of ["meme", "busted", "epistasis", "dms", "phenotype", "analyze"]) {
      const each = diagnose({ alignment, tree, analysis });
      expect(each.summary.engine, analysis).toBe("in-process");
      expect(each.summary.tree_source, analysis).toBe("tn93");
      expect(each.ok, analysis).toBe(true);
    }

    // camelid's distances are real now, so the depth regime is measured rather than skipped.
    expect(out.summary.median_patristic).toBeGreaterThan(0);
    expect(out.warnings.map((x) => x.code)).toContain("DEEP_LARGE_TREE");
  });

  it("bat_oas1: a chronogram in Mya gets DISTANCE_RESCALED (dataset.py:678-681)", async () => {
    const alignment = await example("bat_oas1.fasta");
    const tree = await example("bat_oas1.nwk");
    const out = diagnose({ alignment, tree });
    const w = out.warnings.find((x) => x.code === "DISTANCE_RESCALED");
    expect(w).toBeDefined();
    expect(w.severity).toBe("warn");
    expect(w.data.rawMax).toBeGreaterThan(100);
    expect(w.data.dividedBy).toBe(351);
    expect(out.ok).toBe(true);
    expect(out.summary.distance_rescaled).toBe(true);
    expect(out.summary.taxa_used).toBe(18);
    expect(out.summary.median_patristic).toBeGreaterThan(0.2);
    expect(out.summary.mode).toBe("sync");
    expect(out.summary.work).toBe(351 * 18 * 18);
    const run = out.warnings.find((x) => x.code === "RUN_MODE");
    expect(run.data).toMatchObject({ engine: "in-process", mode: "sync" });
    expect(out.summary.estimated_seconds).toBeGreaterThanOrEqual(0);
  });

  it("Smc6 is clean apart from the shallow-tree regime note", async () => {
    const out = diagnose({ alignment: await example("Smc6.fasta"), tree: await example("Smc6.nwk") });
    expect(out.ok).toBe(true);
    expect(out.summary.format).toBe("fasta");
    expect(out.summary.sequence_count).toBe(20);
    expect(out.summary.codons).toBe(1097);
    expect(out.summary.tree_source).toBe("user");
    expect(out.summary.match_tier).toBe("exact");
    const codes = out.warnings.map((w) => w.code);
    expect(codes).toContain("SHALLOW_TREE");
    expect(codes).toContain("COST_ESTIMATE");
    expect(out.warnings.every((w) => ["info", "warn", "refuse"].includes(w.severity))).toBe(true);
  });

  it("RHO: NEXUS with an embedded tree, 710 sequences, over the taxon cap", async () => {
    const out = diagnose({ alignment: await example("RHO.fasta"), analysis: "phenotype" });
    expect(out.summary.format).toBe("nexus");
    expect(out.summary.sequence_count).toBe(710);
    expect(out.summary.tree_source).toBe("embedded");
    expect(out.warnings.map((w) => w.code)).toContain("TAXA_OVER_CAP");
    expect(out.summary.engine).toBe("in-process");
  });
});

describe("diagnose refusals and modes", () => {
  const seqs = (n, L) => Array.from({ length: n }, (_, i) => ">t" + i + "\n" + "ATG".repeat(L - 1) + (i % 3 === 0 ? "GCA" : i % 3 === 1 ? "GCC" : "GAA") + "\n").join("");

  it("ACCEPTS an alignment with no tree (D22): TREE_FREE_TN93 at info, never a refusal", async () => {
    const alignment = await example("bat_oas1.fasta");
    const r1 = diagnose({ alignment });
    expect(r1.ok).toBe(true);
    const w = r1.warnings.find((x) => x.code === "TREE_FREE_TN93");
    expect(w.severity).toBe("info");
    expect(w.data.reason).toBe("no_tree");
    expect(r1.summary.tree_source).toBe("tn93");
    expect(r1.warnings.map((x) => x.code)).not.toContain("TREE_MISSING");

    // use_tn93 forces the same path on an alignment whose tree IS usable.
    const withTree = diagnose({ alignment, tree: await example("bat_oas1.nwk") });
    expect(withTree.summary.tree_source).toBe("user");
    expect(withTree.warnings.map((x) => x.code)).not.toContain("TREE_FREE_TN93");
    const forced = diagnose({ alignment, tree: await example("bat_oas1.nwk"), use_tn93: true });
    expect(forced.ok).toBe(true);
    expect(forced.summary.tree_source).toBe("tn93");
    expect(forced.warnings.find((x) => x.code === "TREE_FREE_TN93").data.reason).toBe("requested");

    // Every pillar behaves the same; none of them can refuse for want of a tree any more.
    for (const analysis of ["meme", "busted", "epistasis", "dms", "phenotype", "analyze"]) {
      const each = diagnose({ alignment, analysis });
      expect(each.ok, analysis).toBe(true);
      expect(each.summary.tree_source, analysis).toBe("tn93");
      expect(each.warnings.map((x) => x.code), analysis).not.toContain("TN93_UNAVAILABLE");
    }
  });

  it("a tree TEXT that will not parse is still an error: a bad tree is not a missing one", async () => {
    const alignment = await example("bat_oas1.fasta");
    const out = diagnose({ alignment, tree: "this is not newick" });
    expect(out.warnings.map((w) => w.code)).toContain("TREE_UNPARSEABLE");
  });

  it("sizes the report (analyze) like meme and says how the call answers", async () => {
    const alignment = await example("bat_oas1.fasta");
    const tree = await example("bat_oas1.nwk");
    const out = diagnose({ alignment, tree, analysis: "analyze" });
    expect(out.ok).toBe(true);
    expect(out.summary.engine).toBe("in-process");
    expect(out.summary.work).toBe(351 * 18 * 18);
    expect(out.summary.mode).toBe("sync");
    expect(out.warnings.find((w) => w.code === "RUN_MODE").message).toMatch(/wait budget/);
    expect(out.warnings.find((w) => w.code === "RUN_MODE").message).toMatch(/DMS section/);
  });

  it("refuses alignment taxa that have no tree tip", () => {
    const alignment = ">a\nATGAAATTT\n>b\nATGAAATTC\n>c\nATGAAGTTT\n>d\nATGCAATTT\n";
    const tree = "((a:0.1,b:0.1):0.05,(c:0.1,zzz:0.1):0.05);";
    const body = diagnose({ alignment, tree });
    expect(body.ok).toBe(false);
    expect(body.warnings.find((w) => w.code === "TAXA_NOT_IN_TREE").severity).toBe("refuse");
    expect(body.warnings.find((w) => w.code === "TIPS_NOT_IN_ALIGNMENT")).toBeDefined();
  });

  it("refuses fewer than three taxa and flags frame and stop problems", () => {
    const alignment = ">a\nATGTAAAAATTTA\n>b\nATGTAGAAATTTA\n";
    const tree = "(a:0.1,b:0.1);";
    const body = diagnose({ alignment, tree });
    const codes = body.warnings.map((w) => w.code);
    expect(body.ok).toBe(false);
    expect(codes).toContain("TOO_FEW_TAXA");
    expect(codes).toContain("LENGTH_NOT_MULTIPLE_OF_3");
    expect(codes).toContain("IN_FRAME_STOPS");
  });

  it("a topology-only synthetic tree goes tree-free; negative lengths are still flagged", () => {
    const out = diagnose({ alignment: seqs(4, 10), tree: "((t0,t1),(t2,t3));" });
    const w = out.warnings.find((x) => x.code === "TREE_FREE_TN93");
    expect(w).toBeDefined();
    expect(w.data.reason).toBe("no_branch_lengths");
    expect(out.summary.tree_source).toBe("tn93");
    const neg = diagnose({ alignment: seqs(4, 10), tree: "((t0:0.1,t1:-0.1):0.1,(t2:0.1,t3:0.1):0.1);" });
    expect(neg.warnings.map((w) => w.code)).toContain("NEGATIVE_BRANCH_LENGTHS");
    expect(neg.summary.tree_source).toBe("user");
  });

  it("takes the job path above the synchronous codon cap and refuses above the hard caps", () => {
    const n = 4;
    const tree = "((t0:0.1,t1:0.1):0.1,(t2:0.1,t3:0.1):0.1);";
    const job = diagnose({ alignment: seqs(n, 13000), tree });
    expect(job.ok).toBe(true);
    expect(job.summary.mode).toBe("job");
    expect(job.warnings.find((w) => w.code === "RUN_MODE").data.mode).toBe("job");
    const dms = diagnose({ alignment: seqs(n, 3001), tree, analysis: "dms" });
    expect(dms.ok).toBe(false);
    expect(dms.warnings.find((w) => w.code === "CAPS_EXCEEDED").severity).toBe("refuse");
  });
});

describe("caps", () => {
  it("sizes by the longest sequence and takes the job path above the sync codon cap", () => {
    expect(workFor("meme", 351, 18)).toBe(351 * 18 * 18);
    expect(workFor("dms", 351, 18)).toBe(351 * 18 * 18 * 19);
    expect(classifyRun("meme", { codons: 351, taxa: 18 })).toMatchObject({ ok: true, mode: "sync" });
    expect(classifyRun("meme", { codons: 20000, taxa: 18 })).toMatchObject({ ok: true, mode: "job" });
    expect(classifyRun("meme", { codons: 40000, taxa: 18 }).ok).toBe(false);
    expect(classifyRun("dms", { codons: 3001, taxa: 18 }).ok).toBe(false);
    expect(classifyRun("meme", { codons: 12000, taxa: 1000 })).toMatchObject({ ok: false });
    expect(classifyRun("meme", { codons: 12000, taxa: 2 }).reason).toMatch(/at least 3/);
    expect(classifyRun("meme", { codons: 1000, taxa: 1500 }).ok).toBe(false);
    expect(workFor("meme", 12000, 456)).toBeLessThan(MAX_SYNC_WORK);
    // The report is sized like meme: its DMS section caps itself by its own work budget.
    expect(workFor("analyze", 351, 18)).toBe(351 * 18 * 18);
    expect(classifyRun("analyze", { codons: 351, taxa: 18 })).toMatchObject({ ok: true, mode: "sync" });
    expect(classifyRun("analyze", { codons: 40000, taxa: 18 }).ok).toBe(false);
  });
});

describe("the date gate: validate answers the question the time tools will be asked", () => {
  // PHASE 6 REVIEW, M3. hyphaeon_validate answered `ok: true` for analysis `temporal` and `dating`
  // on Smc6.fasta — a file with no date anywhere — complete with summary.mode "job" and
  // estimated_seconds 2.12, and both tools then refused the same bytes. Validate is the call a
  // client makes precisely to avoid that, so the three checks the analysis dispatcher runs are run
  // here too, from the same functions.
  it("refuses an undated alignment for `dating` and `temporal`, and says which code and what to do", async () => {
    const alignment = await example("Smc6.fasta");
    for (const analysis of ["dating", "temporal"]) {
      const out = diagnose({ alignment, analysis });
      expect(out.ok, analysis).toBe(false);
      const refusals = out.warnings.filter((w) => w.severity === "refuse");
      expect(refusals.length, analysis).toBeGreaterThan(0);
      expect(refusals.map((w) => w.code), analysis).toContain("DATES_NONE");
      // The hint names the METADATA fix, never the alignment one.
      expect(refusals.find((w) => w.code === "DATES_NONE").hint).toMatch(/dates_file|date_pattern/);
      expect(out.summary.dates.coverage.dated).toBe(0);
    }
    // The same file for a pillar with no date layer is unaffected: this gate is not a new refusal
    // for everyone, it is the date tools' own.
    expect(diagnose({ alignment, analysis: "meme" }).ok).toBe(true);
  });

  it("`dates` reports the same gates at INFO, because reporting them is that tool's job", async () => {
    const h1n1 = await example("H1N1_2009_pandemic.fasta");
    const review = diagnose({ alignment: h1n1, analysis: "dates" });
    const undated = review.warnings.find((w) => w.code === "DATES_UNDATED_PRESENT");
    expect(undated).toBeDefined();
    expect(undated.severity).toBe("info");
    expect(review.ok).toBe(true);
    // The two analyses refuse the identical fact, with the override named.
    const run = diagnose({ alignment: h1n1, analysis: "temporal" });
    const blocked = run.warnings.find((w) => w.code === "DATES_UNDATED_PRESENT");
    expect(blocked.severity).toBe("refuse");
    expect(blocked.data.override).toBe("drop_undated");
    expect(run.ok).toBe(false);
    // ... and accept it when the caller says so, which is what the run will do with the same flag.
    const overridden = diagnose({ alignment: h1n1, analysis: "temporal", dates: { drop_undated: true } });
    expect(overridden.warnings.some((w) => w.code === "DATES_UNDATED_PRESENT" && w.severity === "refuse")).toBe(false);
    expect(overridden.ok).toBe(true);
    expect(overridden.summary.dates.coverage.dated).toBe(95);
    expect(overridden.summary.dates.gate.applied).toContain("DATES_UNDATED_PRESENT");
  });

  it("refuses a dated set with too few sequences at EACH pillar's own threshold", () => {
    // Four dated sequences: enough to regress (three), not enough to survey (five,
    // temporal.py:474). One alignment, two answers, and each one says which number it used.
    const four =
      ">a_2001\nATGAAACCCGGGTTTAAACCCGGGTTTAAACCC\n" +
      ">b_2002\nATGAAACCCGGGTTTAAACCCGGGTTTAAACCG\n" +
      ">c_2003\nATGAAACCCGGGTTTAAACCCGGGTTTAAACCA\n" +
      ">d_2004\nATGAAACCCGGGTTTAAACCCGGGTTTAAACCT\n";
    const dating = diagnose({ alignment: four, analysis: "dating" });
    expect(dating.warnings.some((w) => w.code === "DATING_TOO_FEW_DATED")).toBe(false);
    expect(dating.summary.dates.coverage.dated).toBe(4);

    const temporal = diagnose({ alignment: four, analysis: "temporal" });
    const refusal = temporal.warnings.find((w) => w.code === "TEMPORAL_TOO_FEW_DATED");
    expect(temporal.ok).toBe(false);
    expect(refusal.severity).toBe("refuse");
    expect(refusal.message).toMatch(/at least 5/);
    expect(refusal.hint).toMatch(/at least 5/);
    expect(refusal.hint).not.toMatch(/At least 3 sequences/);
    expect(temporal.summary.dates.min_dated_taxa).toBe(5);
  });

  it("validating with the run's own date arguments is validating the run: the pattern is applied", () => {
    const named = ">iso|2001.5|x\nATGAAACCCGGGTTTAAACCCGGGTTTAAACCC\n>iso|2002.5|x\nATGAAACCCGGGTTTAAACCCGGGTTTAAACCG\n>iso|2003.5|x\nATGAAACCCGGGTTTAAACCCGGGTTTAAACCA\n>iso|2004.5|x\nATGAAACCCGGGTTTAAACCCGGGTTTAAACCT\n>iso|2005.5|x\nATGAAACCCGGGTTTAAACCCGGGTTTAAACCG\n";
    const withPattern = diagnose({ alignment: named, analysis: "temporal", dates: { date_pattern: "\\|(\\d{4}\\.\\d)\\|" } });
    expect(withPattern.ok).toBe(true);
    expect(withPattern.summary.dates.coverage.dated).toBe(5);
    // A pattern that cannot compile is refused here as the run would refuse it, with its own code.
    const bad = diagnose({ alignment: named, analysis: "temporal", dates: { date_pattern: "(" } });
    expect(bad.ok).toBe(false);
    expect(bad.warnings.map((w) => w.code)).toContain("DATE_REGEX_INVALID");
  });
});
