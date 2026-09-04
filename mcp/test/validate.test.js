import { describe, it, expect } from "vitest";
import { parseAlignment, extractNewick, parseNewick, treeStats, diagnose } from "../src/validate.js";
import { classifyRun, workFor, MAX_SYNC_WORK } from "../src/caps.js";

describe("parseAlignment mirrors the reference sniff", () => {
  it("reads FASTA, takes the first header token, strips quotes, maps U to T, stops at an embedded tree", () => {
    // The reference takes the first whitespace token of the header and strips quotes
    // (dataset.py:106), so `>'seq one'` is the name `seq`. Replicated, and pinned here.
    const text = ">'seq one' extra\nauggca\nAUG\n>seq_two\nATGGCAATG\n((seq one,seq_two));\n";
    const p = parseAlignment(text);
    expect(p.format).toBe("fasta");
    expect(p.sequences).toEqual([
      { name: "seq", seq: "ATGGCAATG" },
      { name: "seq_two", seq: "ATGGCAATG" }
    ]);
    expect(p.u_count).toBe(2);
    // a 'u' in a taxon name is not RNA
    expect(parseAlignment(">musEve\nATGGCA\n>b\nATGGCC\n").u_count).toBe(0);
  });

  it("reads PHYLIP sequential (rows need more than 10 sequence characters, dataset.py:80)", () => {
    const text = "3 12\nA ATGGCAATGAAA\nB ATGGCAATCAAA\nC ATGGCTATGAAA\n";
    const p = parseAlignment(text);
    expect(p.format).toBe("phylip");
    expect(p.sequences.map((s) => s.name)).toEqual(["A", "B", "C"]);
    expect(p.sequences[0].seq).toBe("ATGGCAATGAAA");
    // 9-nt rows are not PHYLIP to the reference either
    expect(parseAlignment("3 9\nA ATGGCAATG\nB ATGGCAATC\nC ATGGCTATG\n").format).toBe("unknown");
  });

  it("reads NEXUS with quoted names and interleaved rows", () => {
    const text = "#NEXUS\nBEGIN DATA;\nDIMENSIONS NTAX=2 NCHAR=6;\nFORMAT DATATYPE=DNA;\nMATRIX\n'a_b' ATG\n'c'   ATG\n'a_b' GCA\n'c'   GCC\n;\nEND;\n";
    const p = parseAlignment(text);
    expect(p.format).toBe("nexus");
    expect(p.sequences).toEqual([
      { name: "a_b", seq: "ATGGCA" },
      { name: "c", seq: "ATGGCC" }
    ]);
    // A quoted name WITH a space is cut at the space by the reference (dataset.py:143); pinned.
    const cut = parseAlignment("#NEXUS\nBEGIN DATA;\nMATRIX\n'a b' ATG\n;\nEND;\n");
    expect(cut.sequences[0].name).toBe("a");
  });

  it("returns unknown for garbage", () => {
    expect(parseAlignment("hello world").format).toBe("unknown");
    expect(parseAlignment("").sequences).toEqual([]);
  });
});

describe("tree parsing", () => {
  it("extracts a NEXUS TREE command and strips HyPhy annotations", () => {
    const nwk = extractNewick("BEGIN TREES;\n\tTREE tree = ((a{FG}:0.1,b:0.2)Node1{FG}:0.05,c:0.3);\nEND;");
    expect(nwk).toBe("((a:0.1,b:0.2)Node1:0.05,c:0.3);");
    const st = treeStats(parseNewick(nwk));
    expect(st.tips).toEqual(["a", "b", "c"]);
    expect(st.internalNodes).toBe(2);
    expect(st.diameter).toBeCloseTo(0.55, 10);
    expect(st.maxRootToTip).toBeCloseTo(0.3, 10);
  });

  it("handles quoted tip labels and missing lengths", () => {
    const st = treeStats(parseNewick("(('x y':0.1,z):0.1,w);"));
    expect(st.tips).toEqual(["x y", "z", "w"]);
    expect(st.missingBranches).toBe(2);
    expect(st.positiveBranches).toBe(2);
  });

  it("throws a TREE_UNPARSEABLE error on broken input", () => {
    expect(() => parseNewick("((a,b);")).toThrow(/Newick parse error/);
  });
});

describe("diagnose regimes", () => {
  const seqs = (n, L) => Array.from({ length: n }, (_, i) => ">t" + i + "\n" + "ATG".repeat(L - 1) + (i % 2 ? "GCA" : "GCC") + "\n").join("");
  const star = (n, bl) => "(" + Array.from({ length: n }, (_, i) => "t" + i + ":" + bl).join(",") + ");";

  it("flags a near-star tree and a shallow regime", () => {
    // One trivially short internal branch keeps two '(' in the string (the reference's
    // recognition rule) while 99.8% of the length stays on the terminals.
    const tree = "((t0:0.01,t1:0.01):0.0001,t2:0.01,t3:0.01,t4:0.01,t5:0.01);";
    const out = diagnose({ alignment: seqs(6, 10), tree });
    const codes = out.warnings.map((w) => w.code);
    expect(codes).toContain("STAR_LIKE_TREE");
    expect(codes).toContain("SHALLOW_TREE");
    expect(codes).toContain("IDENTICAL_SEQUENCES");
    expect(out.ok).toBe(true);
  });

  it("refuses a pure star tree as unparseable, the way the reference does, not as missing", () => {
    const out = diagnose({ alignment: seqs(6, 10), tree: star(6, 0.01) });
    const codes = out.warnings.map((w) => w.code);
    expect(codes).toContain("TREE_UNPARSEABLE");
    expect(codes).not.toContain("TREE_MISSING");
    expect(out.ok).toBe(false);
  });

  it("flags deep large trees and rescaled patristic distances", () => {
    const n = 120;
    let tree = "t0:0.6";
    for (let i = 1; i < n; i++) tree = "(" + tree + ",t" + i + ":0.6):0.01";
    const out = diagnose({ alignment: seqs(n, 10), tree: tree + ";" });
    const codes = out.warnings.map((w) => w.code);
    expect(codes).toContain("DEEP_LARGE_TREE");
    expect(out.summary.tree_tips).toBe(n);
    const big = diagnose({ alignment: seqs(4, 10), tree: "((t0:6,t1:6):1,(t2:6,t3:6):1);" });
    expect(big.warnings.map((w) => w.code)).toContain("MAX_PATRISTIC_ABOVE_10");
    expect(big.warnings.map((w) => w.code)).toContain("SATURATED_BRANCH_LENGTH");
  });

  it("flags branch lengths absent and negative", () => {
    const out = diagnose({ alignment: seqs(4, 10), tree: "((t0,t1),(t2,t3));" });
    expect(out.warnings.map((w) => w.code)).toContain("BRANCH_LENGTHS_ABSENT");
    const neg = diagnose({ alignment: seqs(4, 10), tree: "((t0:0.1,t1:-0.1):0.1,(t2:0.1,t3:0.1):0.1);" });
    expect(neg.warnings.map((w) => w.code)).toContain("NEGATIVE_BRANCH_LENGTHS");
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
