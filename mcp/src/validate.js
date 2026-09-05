/**
 * validate.js — hyphaeon_validate: the library's "Before you run" diagnostics plus this
 * server's caps.
 *
 * WHY THIS FILE EXISTS
 *
 * PLAN.md 4.3 and 2 (hard truth 4) want ONE implementation of the pre-flight checks, run before
 * the model on every surface, producing the same `warnings[]` codes. Phase 1a put that
 * implementation in the library: `diagnose()` in veg/HyphAeon js/src/diagnostics.js (tag
 * phase-1a) — 23 codes, thresholds with their sources in that file's header, built on the
 * dataset.py mirror so the numbers it reports are the numbers the model is then given (taxa
 * after matching and haplotype collapse, the rescaled patristic distances, the unknown-codon
 * fraction of the tokens). Phase 0's hand-written parsers and tree statistics that lived here
 * are gone; what remains is what only this server knows:
 *
 *   - the size caps and the sync/job decision (src/caps.js): CAPS_EXCEEDED (refuse) and RUN_MODE
 *     (info) are APP codes, not library ones, and say so in CODES;
 *   - what this process can do about a recoverable tree problem: whether HyPhy is on PATH to
 *     estimate branch lengths (the reference's own behaviour, dataset.py:601-611) — appended to
 *     the library's BRANCH_LENGTHS_MISSING as `data.estimator`; and that TN93 tree-free mode
 *     (dataset.py:544-580) is not available in-process (TN93_UNAVAILABLE, refuse) unless the
 *     runtime provides it;
 *   - which engine the analysis would run on (in-process ONNX or the Python reference bridge),
 *     so the cost line is honest about what it estimates.
 *
 * The library's `summary` is camelCase and model-level; the tool's `summary` is snake_case and
 * adds the app fields (work, mode, estimated_seconds, engine). Both `warnings[]` keep the
 * library's `{code, severity, message, data}` shape. Severity is info | warn | refuse; `ok` is
 * false when anything refuses.
 *
 * This module has no I/O and no SDK import. It calls pure library functions on strings.
 */

import {
  diagnose as libraryDiagnose,
  DIAGNOSTIC_CODES,
  DIAGNOSTIC_THRESHOLDS,
  sniffAlignmentFormat,
  parseAlignmentSequences,
  extractTree
} from "@veg/hyphaeon-js";
import {
  MAX_TAXA,
  TAXON_CAP,
  NATIVE_ANALYSES,
  BRIDGED_ANALYSES,
  classifyRun,
  estimateSeconds,
  probeSequences,
  workFor
} from "./caps.js";

/**
 * Which analyses run in-process (runtime/ over onnxruntime-node: meme, busted, epistasis, dms,
 * evaluate, and the whole-report `analyze`) and which still go through the Python bridge
 * (phenotype only). One list, in src/caps.js, shared with src/engine.js and src/tools.js.
 */
export { NATIVE_ANALYSES, BRIDGED_ANALYSES };

/**
 * Every code hyphaeon_validate can emit: the library's DIAGNOSTIC_CODES (descriptions here are
 * summaries; the thresholds and sources are in js/src/diagnostics.js) plus the three app codes.
 * Kept as an object so the hyphaeon://methods/requirements resource can publish the list.
 */
const LIBRARY_DESCRIPTIONS = {
  FORMAT_UNKNOWN: "No sequences could be parsed; FASTA, PHYLIP and NEXUS are read",
  ALPHABET_U_TO_T: "U characters read as T (RNA alphabet)",
  NON_ACGT_FRACTION: "Fraction of characters that are not A/C/G/T; refuse when it does not look like nucleotides",
  LENGTH_NOT_MULTIPLE_OF_3: "A sequence length is not divisible by 3; trailing bases are trimmed",
  IN_FRAME_STOPS: "Internal stop codons; refuse above 1% of internal codons",
  FRAMESHIFT_SUSPECTED: "Frame-0 internal stops exceed the other frames in some sequences",
  UNKNOWN_CODON_FRACTION: "More than 5% of codons are gaps, ambiguous or unrecognised (dataset.py:706-709)",
  UNEQUAL_LENGTHS: "Sequences differ in length; the site count comes from the first matched taxon",
  DUPLICATE_SEQUENCES: "Identical sequences collapsed to one haplotype each",
  TOO_FEW_TAXA: "Fewer than 3 usable taxa (issue #7)",
  TAXA_OVER_CAP: "More unique taxa than the model cap; Faith's-PD subsampling applies",
  TAXA_OVER_LIMIT: "More than 1,000 taxa; refused",
  TREE_MISSING: "No tree supplied and none embedded (recoverable: HyPhy HKY85, TN93, NJ)",
  TREE_UNPARSEABLE: "The tree text could not be parsed as Newick or a NEXUS TREE block",
  TAXA_NOT_IN_TREE: "Alignment sequences with no tree tip, or matched only by case/quote folding (issue #9)",
  TIPS_NOT_IN_ALIGNMENT: "Tree tips with no sequence of that name",
  BRANCH_LENGTHS_MISSING: "The tree has no usable branch lengths (recoverable: HyPhy HKY85 when available)",
  NEGATIVE_BRANCH_LENGTHS: "Negative branch lengths raised to 1e-4 (dataset.py:289-300)",
  DISTANCE_RESCALED: "Maximum patristic distance above 10; distances divided by the codon count (dataset.py:678-681)",
  SHALLOW_TREE: "Median patristic distance below 0.05: the viral variant's regime",
  DEEP_LARGE_TREE: "Deep tree with 100 or more taxa: elevated false-positive regime",
  STAR_LIKE: "Fewer than 5 haplotypes or mean pairwise divergence below 0.005 (issue #33)",
  COST_ESTIMATE: "Codons x taxa_used^2 work and the reference-path seconds it implies"
};

export const CODES = Object.freeze(
  Object.assign(
    Object.fromEntries(DIAGNOSTIC_CODES.map((c) => [c, LIBRARY_DESCRIPTIONS[c] || "See js/src/diagnostics.js"])),
    {
      CAPS_EXCEEDED: "[app] The run is above this server's hard caps (src/caps.js); refused",
      RUN_MODE: "[app] Whether the run answers inside the tool call or as a job, and on which engine",
      TN93_UNAVAILABLE: "[app] use_tn93 / no_tree was requested but TN93 tree-free mode is not available in-process"
    }
  )
);

export { DIAGNOSTIC_THRESHOLDS };

/**
 * Parse an alignment with the library's dataset.py mirror, for the sizing probe: the format the
 * reference would sniff and `{name, seq}` pairs in file order. Never throws; an unparseable text
 * yields no sequences (dataset.py raises on the same input, and hyphaeon_validate reports it as
 * FORMAT_UNKNOWN).
 *
 * @param {string} text
 * @returns {{format: "phylip"|"fasta"|"nexus"|"unknown", sequences: Array<{name: string, seq: string}>}}
 */
export function parseAlignment(text) {
  if (typeof text !== "string" || !text.trim()) return { format: "unknown", sequences: [] };
  let seqDict;
  try {
    seqDict = parseAlignmentSequences(text);
  } catch {
    return { format: "unknown", sequences: [] };
  }
  const sequences = [];
  for (const [name, seq] of seqDict) sequences.push({ name, seq });
  return { format: sequences.length ? sniffAlignmentFormat(text) : "unknown", sequences };
}

/**
 * Does the text carry a tree the reference would find (dataset.py:161-212)?
 * @param {string} text
 */
export function hasEmbeddedTree(text) {
  if (typeof text !== "string" || !text.trim()) return false;
  try {
    return extractTree(text) !== null;
  } catch {
    return false;
  }
}

function snakeSummary(s) {
  return {
    format: s.format,
    sequence_count: s.taxaInAlignment,
    taxa_matched: s.taxaMatched,
    unique_haplotypes: s.uniqueHaplotypes,
    taxa_used: s.taxaUsed,
    codons: s.codons,
    tree_source: s.treeSource,
    match_tier: s.matchTier,
    median_patristic: s.medianPatristic,
    mean_pairwise_divergence: s.meanPairwiseDivergence,
    branch_lengths: s.branchLengths || null
  };
}

/**
 * Run the "Before you run" checks on inline text.
 *
 * @param {{alignment: string, tree?: string, analysis?: string, use_tn93?: boolean,
 *   max_species?: number, capabilities?: {hyphy?: boolean, tn93?: boolean}}} input
 *   `capabilities` says what this process can do about recoverable tree problems (src/engine.js
 *   reports them); absent means neither.
 * @returns {{ok: boolean, warnings: Array<{code: string, severity: string, message: string, data: object}>, summary: object}}
 */
export function diagnose({ alignment, tree, analysis = "meme", use_tn93 = false, max_species, capabilities = {} }) {
  const treeGiven = typeof tree === "string" && tree.trim().length > 0;
  const maxSpecies = Number.isInteger(max_species) && max_species >= 2 ? Math.min(max_species, TAXON_CAP) : TAXON_CAP;
  const lib = libraryDiagnose({
    alignmentText: typeof alignment === "string" ? alignment : "",
    treeText: treeGiven ? tree : null,
    maxSpecies,
    taxaLimit: MAX_TAXA
  });

  const native = NATIVE_ANALYSES.includes(analysis);
  const warnings = [];
  for (const w of lib.warnings) {
    if (use_tn93 && w.code === "TREE_MISSING") continue; // a tree is not needed in TN93 mode
    if (w.code === "BRANCH_LENGTHS_MISSING") {
      const estimator = capabilities.hyphy ? "hyphy-hky85" : null;
      warnings.push({
        code: w.code,
        severity: w.severity,
        message:
          w.message +
          (native
            ? estimator
              ? " This server has HyPhy on PATH and will estimate HKY85 branch lengths before scoring (tree_source \"hyphy-hky85\")."
              : " HyPhy is not on PATH here: the 1e-3 defaults will be used and every pair of sequences will look equally related; supply a tree with branch lengths."
            : " The Python reference decides the same way on its own PATH."),
        data: Object.assign({}, w.data, { estimator: native ? estimator : "python-reference" })
      });
      continue;
    }
    warnings.push(w);
  }

  const summary = Object.assign(snakeSummary(lib.summary), {
    analysis,
    engine: native ? "in-process" : "python-reference",
    branch_lengths_missing: lib.warnings.some((w) => w.code === "BRANCH_LENGTHS_MISSING"),
    distance_rescaled: lib.warnings.some((w) => w.code === "DISTANCE_RESCALED"),
    work: 0,
    mode: null,
    estimated_seconds: null
  });

  if (use_tn93) {
    summary.tree_source = "tn93";
    if (native && !capabilities.tn93) {
      warnings.push({
        code: "TN93_UNAVAILABLE",
        severity: "refuse",
        message:
          "use_tn93 / no_tree asks for TN93 pairwise distances instead of a tree (dataset.py:544-580); " +
          "hyphaeon_" + analysis + " runs in-process here and has no TN93 implementation. Supply a tree " +
          "(Newick with branch lengths, or a topology for HyPhy to fit).",
        data: { analysis, recoverable: true, via: ["tree"] }
      });
    } else if (!native) {
      warnings.push({
        code: "RUN_MODE",
        severity: "info",
        message: "TN93 mode is passed to the Python reference (--use-tn93), which needs the tn93 package installed there.",
        data: { engine: "python-reference", tn93: true }
      });
    }
  }

  // Caps and the sync/job decision are sized on the FILE AS SUBMITTED (every sequence, the
  // longest one), as src/caps.js documents, not on the taxa the model would keep.
  const parsed = parseAlignment(alignment);
  if (parsed.sequences.length) {
    const probe = probeSequences(parsed.sequences);
    const taxa = parsed.sequences.length;
    summary.work = workFor(analysis, probe.codons, taxa);
    const cls = classifyRun(analysis, { codons: probe.codons, taxa });
    if (!cls.ok) {
      warnings.push({
        code: "CAPS_EXCEEDED",
        severity: "refuse",
        message: cls.reason + (cls.hint ? " " + cls.hint : ""),
        data: { work: cls.work, codons: probe.codons, taxa }
      });
    } else {
      summary.mode = cls.mode;
      const cost = lib.warnings.find((w) => w.code === "COST_ESTIMATE");
      const modelSeconds = cost && Number.isFinite(cost.data.predictedSeconds) ? cost.data.predictedSeconds : null;
      const secs = native && modelSeconds !== null ? modelSeconds : estimateSeconds(analysis, probe.codons, taxa);
      summary.estimated_seconds = Math.round(secs * 10) / 10;
      warnings.push({
        code: "RUN_MODE",
        severity: "info",
        message:
          "hyphaeon_" + analysis + " runs " +
          (native ? "in-process (ONNX Runtime under Node)" : "through the Python reference bridge") +
          " and " +
          (cls.mode === "sync"
            ? analysis === "analyze"
              ? "answers inside the tool call when the report finishes within its wait budget, else returns the job id with the sections that are ready"
              : "answers inside the tool call"
            : "returns a job id (above the synchronous caps)") +
          "; roughly " + (secs < 1 ? "< 1" : Math.round(secs)) + " s of model time on a laptop CPU" +
          (analysis === "analyze" ? " before the DMS section, which is capped by its own work budget." : "."),
        data: { engine: summary.engine, mode: cls.mode, work: cls.work, estimated_seconds: summary.estimated_seconds }
      });
    }
  }

  const ok = !warnings.some((w) => w.severity === "refuse");
  return { ok, warnings, summary };
}
