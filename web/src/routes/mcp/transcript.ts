/**
 * transcript.ts — a recorded exchange with the stdio MCP server, for the /mcp page.
 *
 * WHY THIS FILE EXISTS. PLAN.md §4.1 asks /mcp for "an example transcript". This one was recorded
 * on 2026-09-05 against @veg/hyphaeon-mcp 0.2.0 (`node mcp/bin/hyphaeon-mcp.js`, JSON-RPC over
 * stdio, HYPHAEON_MCP_THREADS=4) on the bundled Smc6 example (20 primates × 1,097 codons), with
 * `summary_only: true` so the tool results fit on a page. Tool results are abridged: the
 * `top_sites` list is cut to five, warnings to their codes, and the provenance to the fields a
 * reader needs; every number shown is the number the server returned (runtime_sec 0.089,
 * elapsed_sec 0.302 and 0.115 on an x64 Node under Rosetta). The closing turn is what a good
 * answer looks like given the interpretation prompts the server ships: it carries the surrogate
 * caveat, the regime note, the head's non-reproducibility, and the confirmation path.
 *
 * Kept as data so the page stays readable and so a re-recording replaces one file.
 */

export type Turn =
	| { role: 'user'; text: string }
	| { role: 'assistant'; text: string }
	| { role: 'tool'; tool: string; args: Record<string, unknown>; result: string; elapsedMs: number };

export const RECORDED = {
	date: '2026-09-05',
	server: '@veg/hyphaeon-mcp 0.2.0',
	transport: 'stdio',
	dataset: 'Smc6 (20 primates × 1,097 codons, bundled example)'
};

const EX = 'file:///path/to/examples';

export const TRANSCRIPT: readonly Turn[] = [
	{
		role: 'user',
		text: 'Is there episodic selection in Smc6? The alignment is examples/Smc6.fasta and the tree examples/Smc6.nwk.'
	},
	{
		role: 'tool',
		tool: 'hyphaeon_validate',
		args: { alignment: `${EX}/Smc6.fasta`, tree: `${EX}/Smc6.nwk` },
		elapsedMs: 73,
		result: `{
  "ok": true,
  "warnings": [
    { "code": "NON_ACGT_FRACTION", "severity": "info",
      "message": "0.4% of characters are not A/C/G/T (249 gaps, 2 ambiguity or other codes)." },
    { "code": "SHALLOW_TREE", "severity": "info",
      "message": "Median patristic distance 0.0238 substitutions/site is shallow (< 0.05); the viral variant was trained on this regime.",
      "data": { "suggestVariant": "viral" } },
    { "code": "COST_ESTIMATE", "severity": "info",
      "message": "1097 codons x 20 taxa: about < 1 s of model time on a laptop CPU (reference path)." },
    { "code": "RUN_MODE", "severity": "info",
      "message": "hyphaeon_meme runs in-process (ONNX Runtime under Node) and answers inside the tool call." }
  ],
  "summary": { "format": "fasta", "sequence_count": 20, "taxa_matched": 20, "unique_haplotypes": 20,
               "codons": 1097, "tree_source": "user", "match_tier": "exact",
               "branch_lengths": { "branches": 37, "missing": 0, "zeros": 2 }, "mode": "sync" }
}`
	},
	{
		role: 'tool',
		tool: 'hyphaeon_meme',
		args: { alignment: `${EX}/Smc6.fasta`, tree: `${EX}/Smc6.nwk`, summary_only: true },
		elapsedMs: 310,
		result: `{
  "analysis": "meme",
  "summary": {
    "taxa_count": 20, "codon_count": 1097, "runtime_sec": 0.089,
    "invariable_sites": 1000, "variable_sites": 97,
    "significant_p05": 1, "significant_p10": 5, "significant_q05": 0, "significant_q10": 0,
    "top_sites": [
      { "site": 697, "hyphaeon_lrt": 6.913, "p_value": 0.0141, "q_value": 0.667, "call": "Top 2%", "percentile": 100 },
      { "site": 930, "hyphaeon_lrt": 4.068, "p_value": 0.0611, "q_value": 0.667, "call": "Top 2%", "percentile": 99.0 },
      { "site": 628, "hyphaeon_lrt": 3.735, "p_value": 0.0726, "q_value": 0.667, "call": "Top 5%", "percentile": 97.9 },
      { "site": 365, "hyphaeon_lrt": 3.405, "p_value": 0.0863, "q_value": 0.667, "call": "Top 5%", "percentile": 96.9 },
      { "site": 279, "hyphaeon_lrt": 3.292, "p_value": 0.0916, "q_value": 0.667, "call": "Top 5%", "percentile": 95.9 }
    ]
  },
  "collections": { "sites": 1097 },
  "provenance": {
    "surface": "mcp-stdio", "engine": "in-process", "model_version": "v1", "model_variant": "general",
    "artifact_sha256": "aa10e8e0f059436bd8a6f59e1fb3f0137e845533b9c65009230c7de6b91ef22c", "artifact_verified": true,
    "is_surrogate": true, "surrogate_for": "MEME", "seed": 42, "elapsed_sec": 0.302,
    "preprocessing": { "taxa_used": 20, "duplicates_collapsed": 0, "pd_subsampled": false,
                       "tree_source": "user", "branch_lengths_estimated": false, "distance_rescaled": false },
    "reference_command": ["hyphaeon", "meme", "-a", "Smc6.fasta", "-t", "Smc6.nwk", "--cpu", "-o", "<out.json>"]
  }
}`
	},
	{
		role: 'tool',
		tool: 'hyphaeon_busted',
		args: { alignment: `${EX}/Smc6.fasta`, tree: `${EX}/Smc6.nwk`, summary_only: true },
		elapsedMs: 125,
		result: `{
  "analysis": "busted",
  "summary": {
    "gene": "Smc6", "taxa": 20, "sites": 1097,
    "p_value_acat": 0.1180, "p_value_simes": 1.0, "omnibus_lrt": 3.299, "total_selection_energy": 84.82,
    "sig_sites_p05": 5, "sig_sites_p10": 14,
    "selection_probability": 0.533, "predicted_gene_lrt": 0.330, "synonymous_rate_variation": 0.607,
    "rate_distributions": { "omega_1": 0.1, "proportion_1": 0.101, "omega_2": 1, "proportion_2": 0.738,
                            "omega_3": 1.164, "proportion_3": 0.161 },
    "positive_selection_detected": true
  },
  "provenance": {
    "surface": "mcp-stdio", "surrogate_for": "BUSTED", "seed": 42, "elapsed_sec": 0.115,
    "busted_head_sha256": "2ad554e02b5580b813a915d8fbd8a4fa925c7679977adb596388fdc8d4c1c116", "busted_head_verified": true,
    "neural_head": { "deterministic_upstream": false }
  }
}`
	},
	{
		role: 'assistant',
		text:
			'Smc6 has 1,097 codons, 97 of them variable across the 20 primates. One site reaches nominal p ≤ 0.05, codon 697 (LRT 6.9, p 0.014), with codons 930, 628, 365 and 279 next in rank; no site survives false-discovery control (every q is 0.67), so at the gene level the combination tests are neutral (p_ACAT 0.118, p_Simes 1.0, omnibus LRT 3.3). The "positive selection detected" flag is true only because the neural head\'s selection probability is 0.53, and that field is not reproducible upstream, so I would not lean on it. Two things to keep in mind: these are surrogate scores for MEME (rank is reliable, the LRT scale is compressed), and the tree is shallow (median patristic distance 0.024), the regime the viral variant was trained on, so a re-run with model_variant "viral" is worth comparing. If codon 697 matters to you, confirm it with MEME on Datamonkey.'
	}
];
