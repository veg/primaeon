/**
 * validate.js — `POST /api/v1/validate` and the sizing check every job request passes through.
 *
 * WHY THIS FILE EXISTS
 *
 * PLAN.md 3.5: "Sync diagnostics from the package (identical codes to the browser)". The
 * diagnostics are the library's `diagnose()` (@veg/hyphaeon-js diagnostics.js, PLAN.md 4.3), the
 * same function the web app's prep worker and the MCP's hyphaeon_validate call, so a warning code
 * seen in the browser is the code the server prints. What this module adds is the server's own
 * decision layer, taken from the MCP's caps (mcp/src/caps.js, imported, not copied): the alignment
 * is parsed once, sized "as submitted" (every sequence, the longest one — the axomeme_scan rule
 * caps.js documents), classified against the codon / taxa / work caps, and either refused with a
 * CAPS_EXCEEDED warning or accepted. The server has no synchronous mode (every accepted run is a
 * job), so `classifyRun`'s sync/job split collapses to ok/refuse here and the response says so.
 *
 * `analyze` is sized as `meme` for the codon and work caps (the forward pass is the same), and
 * its DMS stage is what the report caps by work budget at run time (PLAN.md 4.0 row 7), not what
 * refuses the upload; a dataset above the DMS cap still gets a report without a DMS section.
 *
 * A TREE IS OPTIONAL (PLAN.md D22). A missing tree, or a tree with no usable branch lengths, is
 * `TREE_FREE_TN93` at INFO level, not a refusal: the run takes pairwise TN93 distances instead.
 * Nothing here asks whether the server can estimate branch lengths, because nothing can and
 * nothing needs to.
 *
 * The response shape follows the MCP tool's: `{ok, warnings:[{code, severity, message, data}],
 * summary}` with the summary keys in snake_case as the CLI prints them.
 */

import { diagnose as libraryDiagnose, parseAlignmentSequences, sniffAlignmentFormat, extractTree } from "@veg/hyphaeon-js";
import { MAX_ALIGNMENT_CHARS, MAX_TAXA, TAXON_CAP, classifyRun, probeSequences, workFor } from "@veg/hyphaeon-mcp/caps";
import { ANALYSES } from "./runner.js";

export { ANALYSES, MAX_ALIGNMENT_CHARS };

/** Which caps table an analysis is sized with (`analyze` runs the meme forward pass). */
export function capsAnalysisFor(analysis) {
  if (analysis === "analyze") return "meme";
  if (analysis === "evaluate") return null;
  return analysis;
}

/**
 * Parse with the library's dataset.py mirror; never throws.
 * @returns {{format: string, sequences: Array<{name: string, seq: string}>}}
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

export function hasEmbeddedTree(text) {
  if (typeof text !== "string" || !text.trim()) return false;
  try {
    return extractTree(text) !== null;
  } catch {
    return false;
  }
}

/** 'user' | 'embedded' | 'tn93': what the run will record as `preprocessing.tree_source`. */
export function treeSourceFor({ treeGiven, embedded, treeFree }) {
  if (treeFree) return "tn93";
  if (treeGiven) return "user";
  return embedded ? "embedded" : "tn93";
}

function snakeSummary(s) {
  const out = {};
  for (const [k, v] of Object.entries(s || {})) out[k.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase())] = v;
  if (s && s.taxaInAlignment !== undefined) out.sequence_count = s.taxaInAlignment;
  return out;
}

/**
 * Size an alignment as submitted and classify it against the caps.
 *
 * @param {string} analysis  one of ANALYSES
 * @param {string} alignment
 * @returns {{ok: boolean, size: {format: string, sequences: number, codons: number, work: number}|null, reason?: string, hint?: string}}
 */
export function sizeCheck(analysis, alignment) {
  const capsAnalysis = capsAnalysisFor(analysis);
  if (!capsAnalysis) return { ok: true, size: null };
  const parsed = parseAlignment(alignment);
  if (!parsed.sequences.length) {
    return {
      ok: false,
      size: null,
      reason: "Could not read the alignment: no sequences found.",
      hint: "FASTA (headers starting with '>'), NEXUS (a MATRIX block) or PHYLIP (a 'ntaxa nsites' header) are accepted."
    };
  }
  const probe = probeSequences(parsed.sequences);
  const cls = classifyRun(capsAnalysis, { codons: probe.codons, taxa: parsed.sequences.length });
  const size = { format: parsed.format, sequences: parsed.sequences.length, codons: probe.codons, work: cls.work };
  if (!cls.ok) return { ok: false, size, reason: cls.reason, hint: cls.hint };
  return { ok: true, size };
}

/**
 * The validate endpoint's body.
 *
 * @param {{alignment: string, tree?: string, analysis?: string, use_tn93?: boolean, max_species?: number}} input
 */
export function validate({ alignment, tree, analysis = "analyze", use_tn93 = false, max_species }) {
  const treeGiven = typeof tree === "string" && tree.trim().length > 0;
  const maxSpecies = Number.isInteger(max_species) && max_species >= 2 ? Math.min(max_species, TAXON_CAP) : TAXON_CAP;
  const lib = libraryDiagnose({
    alignmentText: typeof alignment === "string" ? alignment : "",
    treeText: treeGiven ? tree : null,
    maxSpecies,
    taxaLimit: MAX_TAXA,
    useTn93: !!use_tn93
  });

  const warnings = [...lib.warnings];
  const treeFree = warnings.find((w) => w.code === "TREE_FREE_TN93") || null;

  const summary = Object.assign(snakeSummary(lib.summary), {
    analysis,
    surface: "node-server",
    engine: "in-process",
    tree_source: treeSourceFor({ treeGiven, embedded: !treeGiven && hasEmbeddedTree(alignment), treeFree: treeFree !== null }),
    tree_free: treeFree ? treeFree.data.reason : null,
    distance_rescaled: lib.warnings.some((w) => w.code === "DISTANCE_RESCALED"),
    work: 0,
    mode: null,
    estimated_seconds: null
  });

  const capsAnalysis = capsAnalysisFor(analysis);
  const parsed = parseAlignment(alignment);
  if (capsAnalysis && parsed.sequences.length) {
    const probe = probeSequences(parsed.sequences);
    const taxa = parsed.sequences.length;
    summary.work = workFor(capsAnalysis, probe.codons, taxa);
    const cls = classifyRun(capsAnalysis, { codons: probe.codons, taxa });
    if (!cls.ok) {
      warnings.push({
        code: "CAPS_EXCEEDED",
        severity: "refuse",
        message: cls.reason + (cls.hint ? " " + cls.hint : ""),
        data: { work: cls.work, codons: probe.codons, taxa, analysis }
      });
    } else {
      summary.mode = "job";
      const cost = lib.warnings.find((w) => w.code === "COST_ESTIMATE");
      const secs = cost && Number.isFinite(cost.data.predictedSeconds) ? cost.data.predictedSeconds : null;
      summary.estimated_seconds = secs === null ? null : Math.round(secs * 10) / 10;
      warnings.push({
        code: "RUN_MODE",
        severity: "info",
        message:
          "The server runs " + (analysis === "analyze" ? "the whole report" : "hyphaeon " + analysis) +
          " in-process (ONNX Runtime under Node) as a job: POST /api/v1/jobs returns an id to poll or stream." +
          (secs === null ? "" : " Roughly " + (secs < 1 ? "< 1" : Math.round(secs)) + " s of model time."),
        data: { engine: "in-process", mode: "job", work: cls.work, estimated_seconds: summary.estimated_seconds }
      });
    }
  }

  const ok = !warnings.some((w) => w.severity === "refuse");
  return { ok, warnings, summary };
}
