/**
 * validate.js — JS-side "Before you run" checks for the HyphAeon MCP.
 *
 * WHY THIS FILE EXISTS
 *
 * hyphaeon_validate has to answer without starting Python, so it needs its own parse of the
 * alignment and the tree. Everything here mirrors the sniffing order and the name-handling rules
 * of the Python reference so the two surfaces agree on what a file contains:
 *
 *   hyphaeon/dataset.py:59-159   parse_alignment_sequences  (veg/HyphAeon@3cb9cc6)
 *     1. PHYLIP if the first non-empty line is two integers;
 *     2. FASTA if the text starts with '>' — a header's name is the first whitespace token with
 *        surrounding quotes stripped, and reading STOPS at the first line that starts with '(',
 *        'tree ' or 'begin ' (that is how a tree embedded after the sequences is skipped);
 *     3. otherwise NEXUS: bracket comments removed, TAXLABELS honoured for NOLABELS matrices,
 *        MATRIX rows split on the first run of whitespace, interleaved rows concatenated.
 *     In every branch the sequence is upper-cased and U is rewritten to T.
 *   hyphaeon/dataset.py:161-206  extract_tree_from_string_or_file
 *     1. a NEXUS/HyPhy `TREE name = (...)` command; 2. any line starting with '(' that has at
 *     least two '('; 3. the whole text. HyPhy `{...}` annotations and `[...]` comments are
 *     stripped before parsing.
 *   hyphaeon/dataset.py:615-633  taxon matching: exact, then quote-stripped, then case-insensitive.
 *     hyphaeon_validate reports the EXACT tier (PLAN.md 4.3 "Tree <-> alignment names exact"), so
 *     a file the CLI would silently rescue with a case-insensitive match shows up here as a
 *     warning instead of a silent rescue.
 *   hyphaeon/dataset.py:208-215  has_nonzero_branch_lengths: positive lengths on >= 50% of the
 *     non-root clades.
 *   hyphaeon/dataset.py:686-688  max patristic > 10 => the matrix is divided by L (issue #8).
 *   hyphaeon/dataset.py:718-727  "unknown codon" diagnostic fires above 5% of the matrix.
 *
 * The warning codes are this file's contract with the web app's diagnostics panel and the Node
 * server's /validate (PLAN.md 4.3): the same string for the same condition on every surface.
 * PLAN.md names only DEEP_LARGE_TREE; the rest are defined here (see CODES) and listed in the
 * hyphaeon://methods/requirements resource. Severity is one of info | warn | refuse; `ok` is
 * false when any warning is a refusal.
 *
 * Thresholds that are heuristics rather than ported rules are marked as such next to the number.
 * The XGBoost hit-likelihood prescreen from DM3 is NOT here yet (TODO Phase 1: port
 * datamonkey3/src/lib/services/prescreen/ into the library and call it from here).
 *
 * This module is a LEAF: no I/O, no subprocess, no SDK import. It parses strings.
 */

import {
  MIN_TAXA,
  MAX_TAXA,
  TAXON_CAP,
  classifyRun,
  estimateSeconds,
  probeSequences,
  workFor
} from "./caps.js";

/** Warning codes emitted by diagnose(). Kept as an object so the resource can publish the list. */
export const CODES = Object.freeze({
  FORMAT_UNRECOGNISED: "No sequences could be read; expected FASTA, NEXUS or PHYLIP",
  FORMAT_DETECTED: "Format and sequence count",
  EMBEDDED_TREE: "The alignment text carries a tree",
  RNA_U_TO_T: "U characters present; rewritten to T (the reference does the same)",
  NON_ACGT_FRACTION: "Fraction of non-ACGT, non-gap characters",
  LENGTH_NOT_MULTIPLE_OF_3: "A sequence length is not divisible by 3; trailing bases are trimmed",
  IN_FRAME_STOPS: "Internal stop codons (TAA/TAG/TGA) present",
  FRAMESHIFT_SUSPECTED: "A sequence carries several internal stops, as a frameshift would",
  UNKNOWN_CODON_FRACTION: "More than 5% of codons are gaps or ambiguous",
  UNEQUAL_LENGTHS: "Sequences differ in length; shorter ones are padded with gaps",
  IDENTICAL_SEQUENCES: "Identical sequences that the reference collapses to one haplotype",
  TOO_FEW_TAXA: "Fewer than 3 sequences",
  TOO_MANY_TAXA: "More than 1,000 sequences",
  TAXA_ABOVE_CAP: "More sequences than the model cap; Faith's-PD subsampling applies",
  TREE_MISSING: "No tree supplied, none embedded, and use_tn93 not set",
  TREE_UNPARSEABLE: "The tree text could not be parsed as Newick",
  TREE_TIPS_UNMATCHED: "Tree tips with no sequence of the same name",
  ALIGNMENT_TAXA_MISSING_FROM_TREE: "Sequences with no tree tip of the same name (issue #9)",
  BRANCH_LENGTHS_ABSENT: "The tree has no usable branch lengths",
  NEGATIVE_BRANCH_LENGTHS: "Negative branch lengths present",
  SATURATED_BRANCH_LENGTH: "A branch longer than 3 substitutions/site",
  MAX_PATRISTIC_ABOVE_10: "Maximum patristic distance above 10; the reference rescales (issue #8)",
  DEEP_LARGE_TREE: "Deep tree with >= 100 taxa: elevated false-positive rate regime",
  SHALLOW_TREE: "Shallow tree: consider the viral variant",
  STAR_LIKE_TREE: "Nearly all tree length is on terminal branches (issue #33)",
  COST_ESTIMATE: "Estimated wallclock and whether the run answers in the call or as a job"
});

const CODON_ALPHABET = /^[ACGT]{3}$/;
const STOP_CODONS = new Set(["TAA", "TAG", "TGA"]);

// ── alignment parsing ───────────────────────────────────────────────────────

function isPhylipHeader(line) {
  const t = line.trim().split(/\s+/);
  return t.length === 2 && /^\d+$/.test(t[0]) && /^\d+$/.test(t[1]);
}

/**
 * Upper-case, drop whitespace, U -> T (dataset.py does exactly this in every branch). `stats.u`
 * counts the U characters seen in SEQUENCE data, so the RNA warning cannot be triggered by a
 * 'u' in a taxon name.
 */
function normaliseSeq(s, stats) {
  const compact = s.replace(/\s+/g, "");
  if (stats) {
    const m = compact.match(/[Uu]/g);
    if (m) stats.u += m.length;
  }
  return compact.toUpperCase().replace(/U/g, "T");
}

/**
 * dataset.py:68-95 — sequential/interleaved PHYLIP. Returns null when the header count is not
 * met. Replicated as is: a row "NAME SEQ" is only recognised when SEQ is longer than 10
 * characters (dataset.py:80), so a toy PHYLIP with 9-nt sequences is not PHYLIP to the reference.
 */
function parsePhylip(text, stats) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const header = lines[0].split(/\s+/);
  const expected = parseInt(header[0], 10);
  const seqs = new Map();
  let currName = null;
  let curr = [];
  const flush = () => {
    if (currName !== null) seqs.set(currName, normaliseSeq(curr.join(""), stats));
  };
  for (const line of lines.slice(1)) {
    const parts = line.split(/\s+/);
    const rest = line.replace(/^\S+\s*/, "");
    const looksLikeBareName =
      line.length <= 35 && !/[- ]/.test(line) && (/^[A-Za-z0-9]+$/.test(line) || line.includes("_"));
    if (looksLikeBareName) {
      flush();
      currName = line;
      curr = [];
    } else if (
      parts.length >= 2 &&
      (/^[A-Za-z0-9]+$/.test(parts[0]) || parts[0].includes("_")) &&
      parts[0].length <= 35 &&
      rest.length > 10
    ) {
      flush();
      currName = parts[0];
      curr = [rest];
    } else {
      curr.push(line);
    }
  }
  flush();
  if (seqs.size > 0 && seqs.size >= expected) return seqs;
  return null;
}

/**
 * dataset.py:97-115 — FASTA; stops at an embedded tree line. The name is the first whitespace
 * token of the header with quotes stripped (dataset.py:106), so a quoted name with a space,
 * `>'seq one'`, becomes `seq` in the reference and therefore here.
 */
function parseFasta(text, stats) {
  const seqs = new Map();
  let currId = null;
  let chunks = [];
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.trim();
    if (!l) continue;
    if (l.startsWith(">")) {
      if (currId !== null) seqs.set(currId, normaliseSeq(chunks.join(""), stats));
      const tok = l.slice(1).trim().split(/\s+/)[0] || "";
      currId = tok.replace(/^['"]+|['"]+$/g, "");
      chunks = [];
    } else if (l.startsWith("(") || /^tree /i.test(l) || /^begin /i.test(l)) {
      break;
    } else {
      chunks.push(l);
    }
  }
  if (currId !== null) seqs.set(currId, normaliseSeq(chunks.join(""), stats));
  return seqs;
}

/**
 * dataset.py:117-159 — NEXUS matrix, with the plain-matrix fallback. MATRIX rows are split on
 * the first run of whitespace (dataset.py:143), so a quoted name containing a space is cut at
 * the space and its tail becomes sequence data; replicated, not repaired.
 */
function parseNexus(text, stats) {
  const clean = text.replace(/\[[^\]]*\]/g, "");
  const taxlabels = [];
  const taxMatch = /taxlabels\s+([\s\S]*?)\s*;/i.exec(clean);
  if (taxMatch) {
    const re = /'([^']+)'|"([^"]+)"|(\S+)/g;
    let m;
    while ((m = re.exec(taxMatch[1])) !== null) {
      const name = (m[1] || m[2] || m[3] || "").trim();
      if (name) taxlabels.push(name);
    }
  }
  const formatMatch = /format\s+([\s\S]*?)\s*;/i.exec(clean);
  const noLabels = !!(formatMatch && /nolabels/i.test(formatMatch[1]));
  const matrixMatch = /matrix\s+([\s\S]*?)\s*;/i.exec(clean);
  const seqs = new Map();
  if (matrixMatch) {
    const rows = matrixMatch[1].split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (noLabels && taxlabels.length) {
      rows.forEach((row, idx) => {
        if (idx < taxlabels.length) seqs.set(taxlabels[idx], normaliseSeq(row, stats));
      });
    } else {
      for (const row of rows) {
        const m = /^(\S+)\s+([\s\S]+)$/.exec(row);
        if (!m) continue;
        const name = m[1].replace(/['"]/g, "").trim();
        const seq = normaliseSeq(m[2], stats);
        seqs.set(name, (seqs.get(name) || "") + seq);
      }
    }
  } else {
    for (const raw of clean.split(/\r?\n/)) {
      const m = /^(\S+)\s+([\s\S]+)$/.exec(raw.trim());
      if (m && m[2].replace(/\s/g, "").length > 20) {
        seqs.set(m[1].replace(/['"]/g, "").trim(), normaliseSeq(m[2], stats));
      }
    }
  }
  return seqs;
}

/**
 * Parse an alignment the way the reference does, plus the format it sniffed and the number of
 * U characters seen in sequence data (before the U -> T rewrite).
 *
 * @param {string} text
 * @returns {{format: "phylip"|"fasta"|"nexus"|"unknown", sequences: Array<{name: string, seq: string}>, u_count: number}}
 */
export function parseAlignment(text) {
  if (typeof text !== "string" || !text.trim()) return { format: "unknown", sequences: [], u_count: 0 };
  const firstLine = text.split(/\r?\n/).map((l) => l.trim()).find(Boolean) || "";
  const stats = { u: 0 };
  let format = "unknown";
  let seqs = null;
  if (isPhylipHeader(firstLine)) {
    seqs = parsePhylip(text, stats);
    if (seqs) format = "phylip";
    else stats.u = 0;
  }
  if (!seqs && text.trim().startsWith(">")) {
    seqs = parseFasta(text, stats);
    format = "fasta";
  }
  if (!seqs) {
    seqs = parseNexus(text, stats);
    if (seqs.size > 0) format = "nexus";
  }
  const sequences = [];
  for (const [name, seq] of seqs) sequences.push({ name, seq });
  return { format: sequences.length ? format : "unknown", sequences, u_count: stats.u };
}

// ── tree parsing ─────────────────────────────────────────────────────────────

function stripTreeAnnotations(s) {
  return s.replace(/\{[^}]*\}/g, "").replace(/\[[^\]]*\]/g, "");
}

/**
 * Find the Newick string inside a tree file or an alignment file, in the reference's order
 * (dataset.py:161-206). Returns null when there is none.
 *
 * @param {string} text
 * @returns {string|null}
 */
export function extractNewick(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  const cmd = /tree\s+[^=]+=\s*(\([^;]+;)/i.exec(text);
  if (cmd) return stripTreeAnnotations(cmd[1]);
  for (const raw of text.split(/\r?\n/)) {
    let l = raw.trim();
    if (l.startsWith("(") && (l.match(/\(/g) || []).length >= 2) {
      if (!l.endsWith(";")) l += ";";
      return stripTreeAnnotations(l);
    }
  }
  let all = text.trim();
  if (all.startsWith("(") && (all.match(/\(/g) || []).length >= 2) {
    if (!all.endsWith(";")) all += ";";
    return stripTreeAnnotations(all);
  }
  return null;
}

/**
 * Minimal Newick parser: enough to list tips, count internal nodes and read branch lengths.
 * Quoted labels keep their contents; quotes are stripped the way the reference strips them.
 *
 * @param {string} newick
 * @returns {{name: string|null, length: number|null, children: Array}} root node
 */
export function parseNewick(newick) {
  const s = newick.trim();
  let i = 0;
  const peek = () => s[i];
  const err = (msg) => {
    const e = new Error("Newick parse error at position " + i + ": " + msg);
    e.code = "TREE_UNPARSEABLE";
    throw e;
  };
  function readLabel() {
    if (peek() === "'" || peek() === '"') {
      const q = peek();
      i++;
      let out = "";
      while (i < s.length) {
        if (s[i] === q) {
          if (s[i + 1] === q) {
            out += q;
            i += 2;
            continue;
          }
          i++;
          return out;
        }
        out += s[i++];
      }
      err("unterminated quoted label");
    }
    let out = "";
    while (i < s.length && !/[,:;()]/.test(s[i])) out += s[i++];
    return out.trim();
  }
  function readLength() {
    if (peek() !== ":") return null;
    i++;
    let out = "";
    while (i < s.length && /[0-9eE.+\-]/.test(s[i])) out += s[i++];
    const v = Number(out);
    if (out === "" || Number.isNaN(v)) err("bad branch length '" + out + "'");
    return v;
  }
  function readNode() {
    const node = { name: null, length: null, children: [] };
    if (peek() === "(") {
      i++;
      node.children.push(readNode());
      while (peek() === ",") {
        i++;
        node.children.push(readNode());
      }
      if (peek() !== ")") err("expected ')'");
      i++;
    }
    const label = readLabel();
    node.name = label === "" ? null : label;
    node.length = readLength();
    return node;
  }
  const root = readNode();
  while (i < s.length && /\s/.test(s[i])) i++;
  if (peek() !== ";" && i < s.length) err("trailing characters");
  return root;
}

/**
 * Structural statistics used by the tree checks.
 *
 * @param {object} root  from parseNewick
 */
export function treeStats(root) {
  const tips = [];
  let internal = 0;
  let branches = 0;
  let positive = 0;
  let negative = 0;
  let missing = 0;
  let maxBranch = 0;
  let totalLength = 0;
  let internalLength = 0;
  let maxDepth = 0;
  // Diameter of a weighted tree by the standard two-value recursion: for each node the two
  // deepest child paths give the best path through it. Equals the maximum patristic distance.
  let diameter = 0;
  function walk(node, depth, isRoot) {
    const bl = node.length;
    if (!isRoot) {
      branches++;
      if (bl === null) missing++;
      else {
        if (bl > 0) positive++;
        if (bl < 0) negative++;
        if (bl > maxBranch) maxBranch = bl;
        totalLength += bl;
        if (node.children.length) internalLength += bl;
      }
    }
    const here = depth + (bl || 0);
    if (node.children.length === 0) {
      tips.push(node.name === null ? "" : node.name);
      if (here > maxDepth) maxDepth = here;
      return 0;
    }
    internal++;
    let best1 = 0;
    let best2 = 0;
    for (const c of node.children) {
      const d = walk(c, here, false) + (c.length || 0);
      if (d > best1) {
        best2 = best1;
        best1 = d;
      } else if (d > best2) best2 = d;
    }
    if (best1 + best2 > diameter) diameter = best1 + best2;
    return best1;
  }
  walk(root, 0, true);
  return {
    tips,
    internalNodes: internal,
    branches,
    positiveBranches: positive,
    negativeBranches: negative,
    missingBranches: missing,
    maxBranch,
    totalLength,
    internalLength,
    maxRootToTip: maxDepth,
    diameter
  };
}

// ── diagnostics ──────────────────────────────────────────────────────────────

function warning(code, severity, message, extra) {
  return Object.assign({ code, severity, message }, extra || {});
}

/**
 * Run the "Before you run" checks of PLAN.md 4.3 on inline text.
 *
 * @param {{alignment: string, tree?: string, analysis?: string, use_tn93?: boolean}} input
 * @returns {{ok: boolean, warnings: Array<{code: string, severity: string, message: string}>, summary: object}}
 */
export function diagnose({ alignment, tree, analysis = "meme", use_tn93 = false }) {
  const warnings = [];
  const push = (code, severity, message, extra) => warnings.push(warning(code, severity, message, extra));

  const parsed = parseAlignment(alignment || "");
  const sequences = parsed.sequences;
  const summary = {
    format: parsed.format,
    sequence_count: sequences.length,
    codons: 0,
    work: 0,
    tree_source: null,
    analysis
  };

  if (sequences.length === 0) {
    push(
      "FORMAT_UNRECOGNISED",
      "refuse",
      "No sequences could be read. hyphaeon accepts FASTA (headers starting with '>'), NEXUS " +
        "(a MATRIX block) or PHYLIP (a 'ntaxa nsites' header)."
    );
    return { ok: false, warnings, summary };
  }

  const probe = probeSequences(sequences);
  summary.codons = probe.codons;
  push(
    "FORMAT_DETECTED",
    "info",
    parsed.format.toUpperCase() + " alignment with " + sequences.length + " sequence(s); longest " +
      "sequence " + probe.longestSequenceChars + " nt = " + probe.codons + " codon site(s)."
  );

  // U -> T, non-ACGT fraction, unknown codons, stops, frame, unequal lengths
  if (parsed.u_count > 0) {
    push("RNA_U_TO_T", "info", parsed.u_count + " U character(s) in the sequences; they are read as T, as the reference does.");
  }

  let totalChars = 0;
  let nonAcgt = 0;
  let totalCodons = 0;
  let unknownCodons = 0;
  let internalStops = 0;
  let stopsPerSequence = [];
  let notMultipleOf3 = [];
  const lengths = new Set();
  const seen = new Map();
  let duplicates = 0;
  for (const s of sequences) {
    lengths.add(s.seq.length);
    if (s.seq.length % 3 !== 0) notMultipleOf3.push(s.name);
    if (seen.has(s.seq)) duplicates++;
    else seen.set(s.seq, s.name);
    let stops = 0;
    const L = Math.floor(s.seq.length / 3);
    for (let k = 0; k < s.seq.length; k++) {
      const ch = s.seq[k];
      totalChars++;
      if (ch !== "A" && ch !== "C" && ch !== "G" && ch !== "T" && ch !== "-" && ch !== ".") nonAcgt++;
    }
    for (let site = 0; site < L; site++) {
      const codon = s.seq.substr(site * 3, 3);
      totalCodons++;
      if (!CODON_ALPHABET.test(codon)) unknownCodons++;
      else if (STOP_CODONS.has(codon) && site < L - 1) stops++;
    }
    internalStops += stops;
    stopsPerSequence.push({ name: s.name, stops });
  }

  const nonAcgtFraction = totalChars ? nonAcgt / totalChars : 0;
  if (nonAcgtFraction > 0.01) {
    // 1% is a heuristic: ambiguity codes in a real alignment are rare; above this the file is
    // more likely protein, RNA with modified bases, or mis-sniffed.
    push(
      "NON_ACGT_FRACTION",
      "warn",
      (nonAcgtFraction * 100).toFixed(1) + "% of characters are not A/C/G/T or gap; they become " +
        "unknown codons for the model."
    );
  }
  if (notMultipleOf3.length) {
    push(
      "LENGTH_NOT_MULTIPLE_OF_3",
      "warn",
      notMultipleOf3.length + " sequence(s) have a length not divisible by 3 (" +
        notMultipleOf3.slice(0, 5).join(", ") + (notMultipleOf3.length > 5 ? ", ..." : "") +
        "). The reference trims trailing bases; check the reading frame.",
      { sequences: notMultipleOf3 }
    );
  }
  if (internalStops > 0) {
    const stopFraction = totalCodons ? internalStops / totalCodons : 0;
    const frameshifted = stopsPerSequence.filter((s) => s.stops >= 3).map((s) => s.name);
    // "refuse if pervasive" (PLAN.md 4.3): 1% of all codons being internal stops is far beyond
    // sequencing noise (a frameshifted sequence carries ~3% stops), so it is the refusal line.
    push(
      "IN_FRAME_STOPS",
      stopFraction > 0.01 ? "refuse" : "warn",
      internalStops + " internal stop codon(s) across " + totalCodons + " codons (" +
        (stopFraction * 100).toFixed(2) + "%). Stops are tokenised as unknown, not as amino acids."
    );
    if (frameshifted.length) {
      push(
        "FRAMESHIFT_SUSPECTED",
        "warn",
        frameshifted.length + " sequence(s) carry 3 or more internal stops, as a frameshift would: " +
          frameshifted.slice(0, 5).join(", ") + (frameshifted.length > 5 ? ", ..." : "") + ".",
        { sequences: frameshifted }
      );
    }
  }
  const unknownFraction = totalCodons ? unknownCodons / totalCodons : 0;
  if (unknownFraction > 0.05) {
    push(
      "UNKNOWN_CODON_FRACTION",
      "warn",
      (unknownFraction * 100).toFixed(1) + "% of codons are gaps, ambiguous or unrecognised (the " +
        "reference warns above 5%)."
    );
  }
  if (lengths.size > 1) {
    push(
      "UNEQUAL_LENGTHS",
      "warn",
      "Sequences have " + lengths.size + " different lengths (" +
        [...lengths].sort((a, b) => a - b).slice(0, 4).join(", ") + (lengths.size > 4 ? ", ..." : "") +
        " nt). The reference pads shorter sequences with gaps; the site count is taken from the first " +
        "matched sequence."
    );
  }
  if (duplicates > 0) {
    push(
      "IDENTICAL_SEQUENCES",
      "info",
      duplicates + " identical sequence(s) will be collapsed to one haplotype each (" +
        sequences.length + " -> " + (sequences.length - duplicates) + ")."
    );
  }

  // taxa counts
  if (sequences.length < MIN_TAXA) {
    push(
      "TOO_FEW_TAXA",
      "refuse",
      "Only " + sequences.length + " sequence(s); HyphAeon needs at least " + MIN_TAXA +
        " (a two-taxon alignment is degenerate, veg/HyphAeon#7)."
    );
  } else if (sequences.length > MAX_TAXA) {
    push(
      "TOO_MANY_TAXA",
      "refuse",
      sequences.length + " sequences; the cap is " + MAX_TAXA + " as submitted."
    );
  } else if (sequences.length > TAXON_CAP) {
    push(
      "TAXA_ABOVE_CAP",
      "info",
      sequences.length + " sequences exceed the model cap of " + TAXON_CAP + "; Faith's-PD " +
        "subsampling will select " + TAXON_CAP + " (use max_species to lower it)."
    );
  }

  // tree
  let newick = null;
  const treeGiven = typeof tree === "string" && tree.trim().length > 0;
  if (treeGiven) {
    newick = extractNewick(tree);
    summary.tree_source = "user";
    if (!newick) {
      push(
        "TREE_UNPARSEABLE",
        "refuse",
        "The tree text does not contain a Newick string the reference recognises: it looks for a " +
          "NEXUS `TREE name = (...)` command or a line starting with '(' that contains at least two " +
          "'(' (dataset.py:185), so a pure star tree with a single pair of parentheses is rejected."
      );
    }
  } else {
    newick = extractNewick(alignment);
    if (newick) {
      summary.tree_source = "embedded";
      push("EMBEDDED_TREE", "info", "The alignment carries an embedded tree; it will be used.");
    }
  }
  if (use_tn93) {
    // --use-tn93 wins over any tree in the reference (dataset.py:537).
    summary.tree_source = "tn93";
  } else if (!newick && !treeGiven) {
    summary.tree_source = null;
    push(
      "TREE_MISSING",
      "refuse",
      "No tree was supplied and none is embedded in the alignment. Pass `tree`, or set " +
        "`use_tn93: true` to estimate pairwise distances from the sequences (the reference's " +
        "--use-tn93)."
    );
  }

  if (newick && !use_tn93) {
    let root = null;
    try {
      root = parseNewick(newick);
    } catch (e) {
      push("TREE_UNPARSEABLE", "refuse", e.message);
    }
    if (root) {
      const st = treeStats(root);
      summary.tree_tips = st.tips.length;
      const tipSet = new Set(st.tips);
      const nameSet = new Set(sequences.map((s) => s.name));
      const unmatchedTips = st.tips.filter((t) => !nameSet.has(t));
      const missingTaxa = sequences.map((s) => s.name).filter((n) => !tipSet.has(n));
      if (unmatchedTips.length) {
        push(
          "TREE_TIPS_UNMATCHED",
          "warn",
          unmatchedTips.length + " tree tip(s) have no sequence of exactly the same name and will " +
            "be ignored: " + unmatchedTips.slice(0, 5).join(", ") + (unmatchedTips.length > 5 ? ", ..." : "") + ".",
          { tips: unmatchedTips }
        );
      }
      if (missingTaxa.length) {
        push(
          "ALIGNMENT_TAXA_MISSING_FROM_TREE",
          missingTaxa.length === sequences.length ? "refuse" : "refuse",
          missingTaxa.length + " sequence(s) have no tree tip of exactly the same name: " +
            missingTaxa.slice(0, 5).join(", ") + (missingTaxa.length > 5 ? ", ..." : "") +
            ". The reference drops them silently (veg/HyphAeon#9); rename the tips or prune the " +
            "sequences so both sides match.",
          { sequences: missingTaxa }
        );
      }
      const hasLengths = st.branches > 0 && st.positiveBranches / st.branches >= 0.5;
      if (!hasLengths) {
        push(
          "BRANCH_LENGTHS_ABSENT",
          "warn",
          "The tree has no usable branch lengths (" + st.positiveBranches + " of " + st.branches +
            " branches positive). The reference estimates them with HyPhy HKY85 when hyphy is on " +
            "PATH, otherwise sets every branch to 1e-3, which makes every pair look equally related."
        );
      }
      if (st.negativeBranches > 0) {
        push(
          "NEGATIVE_BRANCH_LENGTHS",
          "warn",
          st.negativeBranches + " negative branch length(s); the reference raises them to 1e-4."
        );
      }
      if (st.maxBranch > 3) {
        // Heuristic: 3 substitutions/site is past saturation for any codon model.
        push(
          "SATURATED_BRANCH_LENGTH",
          "warn",
          "Longest branch is " + st.maxBranch.toPrecision(3) + " — saturated if the units are " +
            "substitutions/site; if they are years or mutation counts, see MAX_PATRISTIC_ABOVE_10."
        );
      }
      if (st.diameter > 10) {
        push(
          "MAX_PATRISTIC_ABOVE_10",
          "warn",
          "Maximum patristic distance is " + st.diameter.toPrecision(4) + " (> 10). The reference " +
            "divides the whole matrix by the codon count (veg/HyphAeon#8), treating the lengths as " +
            "mutation counts; if this is a chronogram, rescale it yourself first."
        );
      }
      if (hasLengths && st.tips.length >= 100 && st.maxRootToTip >= 0.5) {
        // model_eval calibration grid: large_deep = 100 taxa at depth 0.5 gave FPR ~36%.
        push(
          "DEEP_LARGE_TREE",
          "warn",
          st.tips.length + " taxa on a deep tree (root-to-tip up to " + st.maxRootToTip.toPrecision(3) +
            "). On neutral simulations this regime gave a false-positive rate near 36% at alpha 0.05 " +
            "(model_eval calibration, 100 taxa / depth 0.5). Rank sites; do not read p-values as calibrated."
        );
      }
      if (hasLengths && st.diameter < 0.2) {
        // model_eval "shallow" = depth 0.1; viral regime.
        push(
          "SHALLOW_TREE",
          "info",
          "Shallow tree (diameter " + st.diameter.toPrecision(3) + "). The viral variant was trained " +
            "on this regime (rho ~0.43 vs ~0.10 for the general variant on unseen viral families); " +
            "consider model_variant: \"viral\"."
        );
      }
      if (hasLengths && st.internalNodes <= 1 && st.tips.length >= 4) {
        push(
          "STAR_LIKE_TREE",
          "warn",
          "The tree has a single internal node: a star. Single-ancestor panels return nothing, " +
            "silently (veg/HyphAeon#33); this input is outside the model's regime."
        );
      } else if (hasLengths && st.totalLength > 0 && st.internalLength / st.totalLength < 0.05 && st.tips.length >= 4) {
        // Heuristic: < 5% of tree length on internal branches is star-like for scoring purposes.
        push(
          "STAR_LIKE_TREE",
          "warn",
          "Only " + ((st.internalLength / st.totalLength) * 100).toFixed(1) + "% of the tree length " +
            "is on internal branches; a near-star topology behaves like the shallow single-ancestor " +
            "panels of veg/HyphAeon#33 and may return nothing."
        );
      }
    }
  }

  // cost
  if (sequences.length >= MIN_TAXA && sequences.length <= MAX_TAXA) {
    const cls = classifyRun(analysis, { codons: probe.codons, taxa: sequences.length });
    summary.work = workFor(analysis, probe.codons, sequences.length);
    if (!cls.ok) {
      push("COST_ESTIMATE", "refuse", cls.reason + (cls.hint ? " " + cls.hint : ""));
    } else {
      const secs = estimateSeconds(analysis, probe.codons, sequences.length);
      summary.estimated_seconds = Math.round(secs);
      summary.mode = cls.mode;
      push(
        "COST_ESTIMATE",
        "info",
        "Roughly " + Math.round(secs) + " s on a laptop CPU through the Python reference (work " +
          summary.work.toExponential(2) + "); " +
          (cls.mode === "sync" ? "answers inside the tool call." : "above the synchronous caps, returns a job id.")
      );
    }
  }

  const ok = !warnings.some((w) => w.severity === "refuse");
  return { ok, warnings, summary };
}
