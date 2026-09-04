import { describe, it, expect } from "vitest";
import { DIAGNOSTIC_CODES } from "@veg/hyphaeon-js";
import { parseAlignment, hasEmbeddedTree, diagnose, CODES, NATIVE_ANALYSES, BRIDGED_ANALYSES } from "../src/validate.js";
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
  it("publishes every library code plus the three app codes", () => {
    for (const c of DIAGNOSTIC_CODES) expect(CODES).toHaveProperty(c);
    expect(Object.keys(CODES).filter((c) => !DIAGNOSTIC_CODES.includes(c)).sort()).toEqual(["CAPS_EXCEEDED", "RUN_MODE", "TN93_UNAVAILABLE"]);
    expect([...NATIVE_ANALYSES, ...BRIDGED_ANALYSES].sort()).toEqual(["busted", "dms", "epistasis", "evaluate", "meme", "phenotype"]);
  });
});

describe("diagnose on the bundled examples", () => {
  it("camelid: a topology-only tree gets BRANCH_LENGTHS_MISSING, and the estimator follows this server's capabilities", async () => {
    const alignment = await example("camelid.fasta");
    const tree = await example("camelid.nwk");
    const withHyphy = diagnose({ alignment, tree, capabilities: { hyphy: true } });
    const w = withHyphy.warnings.find((x) => x.code === "BRANCH_LENGTHS_MISSING");
    expect(w).toBeDefined();
    expect(w.severity).toBe("warn");
    expect(w.data.recoverable).toBe(true);
    expect(w.data.estimator).toBe("hyphy-hky85");
    expect(w.message).toMatch(/hyphy-hky85/);
    expect(withHyphy.ok).toBe(true);
    expect(withHyphy.summary.branch_lengths_missing).toBe(true);
    expect(withHyphy.summary.sequence_count).toBe(212);
    expect(withHyphy.summary.codons).toBe(96);
    expect(withHyphy.summary.engine).toBe("in-process");

    const without = diagnose({ alignment, tree, capabilities: {} });
    expect(without.warnings.find((x) => x.code === "BRANCH_LENGTHS_MISSING").data.estimator).toBeNull();

    const bridged = diagnose({ alignment, tree, analysis: "epistasis" });
    expect(bridged.warnings.find((x) => x.code === "BRANCH_LENGTHS_MISSING").data.estimator).toBe("python-reference");
    expect(bridged.summary.engine).toBe("python-reference");
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
    expect(out.summary.engine).toBe("python-reference");
  });
});

describe("diagnose refusals and modes", () => {
  const seqs = (n, L) => Array.from({ length: n }, (_, i) => ">t" + i + "\n" + "ATG".repeat(L - 1) + (i % 3 === 0 ? "GCA" : i % 3 === 1 ? "GCC" : "GAA") + "\n").join("");

  it("refuses when no tree is given and none is embedded; TN93 mode refuses in-process and passes through to the bridge", async () => {
    const alignment = await example("bat_oas1.fasta");
    const r1 = diagnose({ alignment });
    expect(r1.ok).toBe(false);
    expect(r1.warnings.find((w) => w.code === "TREE_MISSING").severity).toBe("refuse");

    const r2 = diagnose({ alignment, use_tn93: true });
    expect(r2.ok).toBe(false);
    expect(r2.warnings.map((w) => w.code)).not.toContain("TREE_MISSING");
    expect(r2.warnings.find((w) => w.code === "TN93_UNAVAILABLE").severity).toBe("refuse");
    expect(r2.summary.tree_source).toBe("tn93");

    const r3 = diagnose({ alignment, use_tn93: true, capabilities: { tn93: true } });
    expect(r3.ok).toBe(true);

    const r4 = diagnose({ alignment, use_tn93: true, analysis: "epistasis" });
    expect(r4.ok).toBe(true);
    expect(r4.warnings.map((w) => w.code)).not.toContain("TN93_UNAVAILABLE");
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

  it("flags branch lengths absent and negative on synthetic trees", () => {
    const out = diagnose({ alignment: seqs(4, 10), tree: "((t0,t1),(t2,t3));" });
    expect(out.warnings.map((w) => w.code)).toContain("BRANCH_LENGTHS_MISSING");
    const neg = diagnose({ alignment: seqs(4, 10), tree: "((t0:0.1,t1:-0.1):0.1,(t2:0.1,t3:0.1):0.1);" });
    expect(neg.warnings.map((w) => w.code)).toContain("NEGATIVE_BRANCH_LENGTHS");
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
  });
});
