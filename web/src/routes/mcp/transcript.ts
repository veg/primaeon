/**
 * transcript.ts — a recorded exchange with the stdio MCP server, for the /mcp page.
 *
 * WHY THIS FILE EXISTS. PLAN.md §4.1 asks /mcp for "an example transcript". This one was recorded
 * on 2026-09-05 against @veg/hyphaeon-mcp 0.4.0 (`node mcp/bin/hyphaeon-mcp.js`, JSON-RPC over
 * stdio, HYPHAEON_MCP_THREADS=4) on the bundled Smc6 example (20 primates × 1,097 codons), with
 * `summary_only: true` so the tool results fit on a page. Tool results are abridged: the
 * `top_sites` list is cut to five, warnings to their codes, and the provenance to the fields a
 * reader needs; every number shown is the number the server returned (elapsed_sec 0.351, 0.224
 * and 1.011 on an x64 Node under Rosetta). The closing turn is what a good answer looks like given
 * the interpretation prompts the server ships: it carries the surrogate caveat, the regime note,
 * the head's non-reproducibility, and the confirmation path.
 *
 * RE-RECORDED FOR PHASE 3. The 0.2.0 recording was three turns and ended at `hyphaeon_busted`,
 * because `hyphaeon_phenotype` was the one tool that shelled out to the Python CLI. The bridge is
 * deleted (PLAN.md D16, §8 phase 3), so the fourth turn is the phenotype pillar running in the
 * same process on the same alignment, with the Brownian-motion permulations Smc6's tree makes
 * possible — the thing the page most needs to show. `preprocessing` also gained D22's tree fields
 * (`tree_provided`, `tree_free`, `display_tree_source`), and they are kept in the abridged
 * provenance because a reader has to be able to see which of the two tree paths a run took.
 *
 * Kept as data so the page stays readable and so a re-recording replaces one file.
 */

export type Turn =
	| { role: 'user'; text: string }
	| { role: 'assistant'; text: string }
	| { role: 'tool'; tool: string; args: Record<string, unknown>; result: string; elapsedMs: number };

export const RECORDED = {
	date: '2026-09-05',
	server: '@veg/hyphaeon-mcp 0.4.0',
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
		elapsedMs: 98,
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
               "codons": 1097, "tree_source": "user", "match_tier": "exact", "tree_free": null,
               "branch_lengths": { "branches": 37, "missing": 0, "zeros": 2 }, "mode": "sync" }
}`
	},
	{
		role: 'tool',
		tool: 'hyphaeon_meme',
		args: { alignment: `${EX}/Smc6.fasta`, tree: `${EX}/Smc6.nwk`, summary_only: true },
		elapsedMs: 344,
		result: `{
  "analysis": "meme",
  "summary": {
    "taxa_count": 20, "codon_count": 1097, "runtime_sec": 0.153,
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
    "is_surrogate": true, "surrogate_for": "MEME", "seed": 42, "elapsed_sec": 0.351,
    "preprocessing": { "taxa_used": 20, "duplicates_collapsed": 0, "pd_subsampled": false,
                       "tree_source": "user", "tree_provided": "user", "tree_free": null,
                       "display_tree_source": "user", "distance_rescaled": false },
    "reference_command": ["hyphaeon", "meme", "-a", "Smc6.fasta", "-t", "Smc6.nwk", "--cpu", "-o", "<out.json>"]
  }
}`
	},
	{
		role: 'tool',
		tool: 'hyphaeon_busted',
		args: { alignment: `${EX}/Smc6.fasta`, tree: `${EX}/Smc6.nwk`, summary_only: true },
		elapsedMs: 247,
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
    "surface": "mcp-stdio", "surrogate_for": "BUSTED", "seed": 42, "elapsed_sec": 0.224,
    "busted_head_sha256": "2ad554e02b5580b813a915d8fbd8a4fa925c7679977adb596388fdc8d4c1c116", "busted_head_verified": true,
    "neural_head": { "deterministic_upstream": false }
  }
}`
	},
	{
		role: 'user',
		text: 'Do the top sites track the great apes specifically, rather than the primates in general?'
	},
	{
		role: 'tool',
		tool: 'hyphaeon_phenotype',
		args: {
			alignment: `${EX}/Smc6.fasta`,
			tree: `${EX}/Smc6.nwk`,
			foreground: 'hg18,homSap_293T,panTro4,panPan,ponAbe2,nomLeu3',
			permulations: 100,
			seed: 42,
			summary_only: true
		},
		elapsedMs: 1037,
		result: `{
  "analysis": "phenotype",
  "summary": {
    "phenotype_meta": { "mode": "discrete", "foreground_count": 6, "background_count": 14,
      "description": "User-specified foreground patterns: ['hg18', 'homSap_293T', 'panTro4', 'panPan', 'ponAbe2', 'nomLeu3']" },
    "taxa_count": 20, "codon_count": 1097, "sites": 97,
    "spectral_energy": 0.5557, "norm_spectral_ratio": 0.3251,
    "max_assoc": 0.99999824, "p_evd_length_adjusted": 0.00846,
    "compact_pars_signature": "[ R704H - Q567P - D930E - K763E - A697A - N913S - M685T - ... ]",
    "permulations_count": 100, "gene_p_value_perm": 0.485,
    "significant_sites_count": 0, "trait_sectors": 0, "coselection_pairs": 0,
    "top_sites": [
      { "site": 704, "ref_aa": "R", "derived_aa": "H", "hyphaeon_lrt": 1.861, "association_rho": 1.000, "score": 1.364, "foreground_freq_pct": 100, "background_freq_pct": 0 },
      { "site": 567, "ref_aa": "Q", "derived_aa": "P", "hyphaeon_lrt": 1.536, "association_rho": 1.000, "score": 1.240, "foreground_freq_pct": 100, "background_freq_pct": 0 },
      { "site": 930, "ref_aa": "D", "derived_aa": "E", "hyphaeon_lrt": 4.068, "association_rho": 0.596, "score": 1.202, "foreground_freq_pct": 100, "background_freq_pct": 0 },
      { "site": 763, "ref_aa": "K", "derived_aa": "E", "hyphaeon_lrt": 2.091, "association_rho": 0.816, "score": 1.181, "foreground_freq_pct": 66.7, "background_freq_pct": 0 },
      { "site": 697, "ref_aa": "A", "derived_aa": "A", "hyphaeon_lrt": 6.913, "association_rho": 0.434, "score": 1.141, "foreground_freq_pct": 66.7, "background_freq_pct": 35.7 }
    ]
  },
  "provenance": {
    "surface": "mcp-stdio", "engine": "in-process",
    "is_surrogate": true, "surrogate_for": "no HyPhy counterpart (attention-based trait association)",
    "seed": 42, "elapsed_sec": 1.011,
    "options": { "foreground": "hg18,homSap_293T,panTro4,panPan,ponAbe2,nomLeu3", "permulations": 100, "seed": 42 },
    "preprocessing": { "taxa_used": 20, "tree_source": "user", "tree_free": null },
    "reference_command": ["hyphaeon", "phenotype", "-a", "Smc6.fasta", "-t", "Smc6.nwk",
                          "-fg", "hg18,homSap_293T,panTro4,panPan,ponAbe2,nomLeu3",
                          "--permulations", "100", "--seed", "42", "--cpu", "-o", "<out.json>"]
  }
}`
	},
	{
		role: 'assistant',
		text:
			'Smc6 has 1,097 codons, 97 of them variable across the 20 primates. One site reaches nominal p ≤ 0.05, codon 697 (LRT 6.9, p 0.014), with codons 930, 628, 365 and 279 next in rank; no site survives false-discovery control (every q is 0.67), so at the gene level the combination tests are neutral (p_ACAT 0.118, p_Simes 1.0, omnibus LRT 3.3). The "positive selection detected" flag is true only because the neural head\'s selection probability is 0.53, and that field is not reproducible upstream, so I would not lean on it. On the great-ape question: several sites do separate the six great apes cleanly (704 R→H and 567 Q→P are present in all six and absent from the other fourteen, ρ ≈ 1.0), but with a Brownian-motion permulation null over the tree the gene-level p is 0.49 — that pattern is what phylogenetic autocorrelation alone produces for a clade-shaped trait on this tree, and no site survives with a permulation p. Two things to keep in mind throughout: these are surrogate scores for MEME (rank is reliable, the LRT scale is compressed), and the tree is shallow (median patristic distance 0.024), the regime the viral variant was trained on, so a re-run with model_variant "viral" is worth comparing. If codon 697 matters to you, confirm it with MEME on Datamonkey.'
	}
];
