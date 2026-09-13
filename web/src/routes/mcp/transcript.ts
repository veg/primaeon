/**
 * transcript.ts — a recorded exchange with the stdio MCP server, for the /mcp page.
 *
 * WHY THIS FILE EXISTS. PLAN.md §4.1 asks /mcp for "an example transcript". This one was recorded
 * on 2026-09-12 against @veg/hyphaeon-mcp 0.5.0 (`node mcp/bin/hyphaeon-mcp.js`, JSON-RPC over
 * stdio, HYPHAEON_MCP_THREADS=4) on two bundled examples: Smc6 (20 primates × 1,097 codons) for
 * the selection pillars and H5N1_HA_geo (98 avian influenza HA sequences × 566 codons, with its
 * tree and its metadata CSV) for the time pillars, with `summary_only: true` where a result would
 * otherwise not fit on a page. Tool results are abridged: the `top_sites` list is cut to five,
 * warnings to their codes, and the provenance to the fields a reader needs; every number shown is
 * the number the server returned on an x64 Node under Rosetta. The closing turns are what a good
 * answer looks like given the interpretation prompts the server ships: they carry the surrogate
 * caveat, the regime note, the head's non-reproducibility, and the confirmation path.
 *
 * RE-RECORDED FOR PHASE 6 (0.5.0). The Smc6 turns were re-run against the 0.5.0 server and their
 * numbers are unchanged (p_ACAT 0.1180, omnibus LRT 3.299, selection probability 0.533, spectral
 * energy 0.5557, permulation p 0.485); the elapsed times and the phenotype turn's
 * `reference_command` are NOT — the command's flag order had moved since 0.4.0 and the stored copy
 * was stale, which is exactly what re-recording on a version bump is for. Four new turns follow
 * them, one per new tool plus the section fetch that is the only way to read a temporal record:
 * `hyphaeon_dates` (no model, 25 ms), `hyphaeon_dating`, `hyphaeon_temporal` and `get_results
 * section=sites`. They show the two things the time pillars must never omit — the date review that
 * says which sequences were analysed, and the honesty block that says whether the null's answer is
 * final — and the `{command, reproduces, caveats}` object these two pillars carry in place of the
 * other six's argv array.
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
	date: '2026-09-12',
	server: '@veg/hyphaeon-mcp 0.5.0',
	transport: 'stdio',
	dataset: 'Smc6 (20 primates × 1,097 codons) and H5N1_HA_geo (98 sequences × 566 codons, with its tree and metadata CSV), both bundled examples'
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
		elapsedMs: 243,
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
    "is_surrogate": true, "surrogate_for": "MEME", "seed": 42, "elapsed_sec": 0.235,
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
		elapsedMs: 117,
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
    "surface": "mcp-stdio", "surrogate_for": "BUSTED", "seed": 42, "elapsed_sec": 0.113,
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
		elapsedMs: 832,
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
    "seed": 42, "elapsed_sec": 0.830,
    "options": { "foreground": "hg18,homSap_293T,panTro4,panPan,ponAbe2,nomLeu3", "permulations": 100, "seed": 42 },
    "preprocessing": { "taxa_used": 20, "tree_source": "user", "tree_free": null },
    "reference_command": ["hyphaeon", "phenotype", "-a", "Smc6.fasta", "-t", "Smc6.nwk", "--cpu",
                          "--foreground", "hg18,homSap_293T,panTro4,panPan,ponAbe2,nomLeu3",
                          "--permulations", "100", "--seed", "42",
                          "--mds-sign", "canonical", "-o", "<out.json>"]
  }
}`
	},
	{
		role: 'assistant',
		text:
			'Smc6 has 1,097 codons, 97 of them variable across the 20 primates. One site reaches nominal p ≤ 0.05, codon 697 (LRT 6.9, p 0.014), with codons 930, 628, 365 and 279 next in rank; no site survives false-discovery control (every q is 0.67), so at the gene level the combination tests are neutral (p_ACAT 0.118, p_Simes 1.0, omnibus LRT 3.3). The "positive selection detected" flag is true only because the neural head\'s selection probability is 0.53, and that field is not reproducible upstream, so I would not lean on it. On the great-ape question: several sites do separate the six great apes cleanly (704 R→H and 567 Q→P are present in all six and absent from the other fourteen, ρ ≈ 1.0), but with a Brownian-motion permulation null over the tree the gene-level p is 0.49 — that pattern is what phylogenetic autocorrelation alone produces for a clade-shaped trait on this tree, and no site survives with a permulation p. Two things to keep in mind throughout: these are surrogate scores for MEME (rank is reliable, the LRT scale is compressed), and the tree is shallow (median patristic distance 0.024), the regime the viral variant was trained on, so a re-run with model_variant "viral" is worth comparing. If codon 697 matters to you, confirm it with MEME on Datamonkey.'
	},
	{
		role: 'user',
		text: 'Different dataset: I have 98 avian influenza HA sequences sampled over about a decade (examples/H5N1_HA_geo.fasta, tree H5N1_HA.nwk, dates in H5N1_HA_metadata.csv). Did anything sweep, and when?'
	},
	{
		role: 'tool',
		tool: 'hyphaeon_dates',
		args: { alignment: `${EX}/H5N1_HA_geo.fasta`, dates_file: `${EX}/H5N1_HA_metadata.csv`, rows: false },
		elapsedMs: 25,
		result: `{
  "analysis": "dates",
  "ok": true,
  "headline": "98 of 98 sequence(s) dated from table — 98 by numeric; 1996 to 2005 (years). Units years (inferred).",
  "clock": { "has_clock": true, "dating_possible": true, "temporal_possible": true, "reasons": [], "temporal_reasons": [] },
  "gate": { "ok": true, "blocking": [], "overrides": { "accept_bare_numbers": false, "drop_undated": false }, "applied": [] },
  "date_review": {
    "source": "table", "time_units": "years", "time_units_source": "inferred",
    "coverage": { "taxa_total": 98, "dated": 98, "undated": 0, "coverage": 1, "from_table": 98, "from_header": 0, "imputed": 0 },
    "by_rule": { "numeric": 98 },
    "span": { "min": 1996, "max": 2005, "span": 9, "unique": 10, "tied": 29 },
    "match_tiers": { "exact": 98, "case_insensitive": 0, "first_token": 0, "field_containment": 0 },
    "table": { "delimiter": ",", "delimiter_source": "sniffed", "columns": ["taxon", "date", "location", "lat", "lon"],
               "strain_col": "taxon", "date_col": "date", "rows_read": 98, "rows_dated": 98, "duplicates": [] },
    "unmatched_metadata": { "count": 0, "names": [] },
    "warnings": [
      { "code": "DATES_DELIMITER_GUESSED", "severity": "info" },
      { "code": "DATES_UNITS_INFERRED", "severity": "warn" }
    ]
  },
  "engine": "in-process (no model, no graph)"
}`
	},
	{
		role: 'tool',
		tool: 'hyphaeon_dating',
		args: { alignment: `${EX}/korber_env_gp160.fasta`, root_taxon: 'CONSENSUS', drop_undated: true, summary_only: true },
		elapsedMs: 85,
		result: `{
  "analysis": "dating",
  "summary": {
    "taxa_count": 142, "dated": 142, "timespan": [1959.5, 1997.5],
    "distance_mode": "tn93", "active_model": "spline", "clock_model": "auto", "ci_method": "fieller",
    "selected_clock": "Restricted Spline (rate deceleration (0.04x) detected: F=5.26, p=0.0234, dAIC=+3.3)",
    "t_mrca": 1938.77, "ci_mrca": [1938.77, 1938.77], "mu": 2.2627e-3,
    "root_description": "explicit_root_CONSENSUS", "latent_root": null,
    "ols": { "mu": 1.1690e-3, "t_mrca": 1893.91, "ci_fieller": [1850.90, 1916.79], "r2": 0.2314, "n": 141 },
    "pgls": null,
    "outliers": 0, "taxa_summary_rows": 142,
    "honesty": {
      "distance_mode": "tn93", "model_pass": false,
      "estimators_not_built": [ "Attention PGLS", "Latent root search", "Power-law clock", "Leave-one-out / jackknife" ],
      "note": "t_mrca moves with distance_mode: model-free and model-based are different answers, measured twelve years apart on this example (1938.77 against 1926.81)."
    }
  },
  "provenance": {
    "surface": "mcp-stdio", "engine": "in-process", "elapsed_sec": 0.083,
    "preprocessing": { "tree_source": "tn93", "date_source": "header", "date_units": "years",
                       "date_gate": { "ok": true, "applied": ["DATES_UNDATED_PRESENT"] } },
    "reference_command": {
      "command": "hyphaeon dating -a alignment.fasta --no-tree --distance-mode tn93 --root-taxon CONSENSUS --method ols --clock-model auto --ci-method fieller --cpu -o <out.json> -c <out.csv>",
      "reproduces": false,
      "caveats": [
        "Running this does not make the two files diff clean ... compare numerically, not with diff.",
        "The dates on this run were read from the sequence names by this build's own date layer, which reads headers hyphaeon dating cannot (142 of 143 by the korber_isolate rule). A different dated set is a different regression; export the dates as a two-column CSV and pass -d to reproduce this run.",
        "This build does not estimate Attention PGLS, Latent root search, Power-law clock, Leave-one-out / jackknife, so no flag for them is printed above."
      ]
    }
  }
}`
	},
	{
		role: 'tool',
		tool: 'hyphaeon_temporal',
		args: {
			alignment: `${EX}/H5N1_HA_geo.fasta`,
			tree: `${EX}/H5N1_HA.nwk`,
			dates_file: `${EX}/H5N1_HA_metadata.csv`,
			dates_file_name: 'H5N1_HA_metadata.csv',
			n_permutations: 1000,
			time_points: 250
		},
		elapsedMs: 4291,
		result: `{
  "analysis": "temporal", "job_id": "4368ab5e04a952f42fce650bcd9ff05c", "status": "completed", "stage": "complete",
  "sections": ["summary","sites","curves","waves","permutations","dates","candidates","warnings","honesty","provenance"],
  "summary": {
    "taxa_total": 97, "taxa_timestamped": 97, "codons_total": 566, "codons_variable": 169,
    "timespan_years": 9, "t_min": 1996, "t_max": 2005, "bandwidth_years": 0.45,
    "sig_static_q10": 1, "stage1_candidates": 168,
    "confirmed_sweeps": 16, "concordant_sweeps": 0, "rescued_sweeps": 16, "filtered_static_noise": 1,
    "fpca_wave_variance_pct": [97.13, 1.48, 0.60, 0.47], "runtime_sec": 4.018,
    "regime": { "time_units": "years", "sweep_mode": "episodic", "prune_duplicates": true },
    "dates": { "file": "H5N1_HA_metadata.csv", "dated": 97, "undated": 0, "source": "table",
               "by_rule": { "numeric": 98 }, "beyond_reference": { "count": 0, "rules": {} } },
    "warnings": ["TEMPORAL_DUPLICATES_COLLAPSED/warn","TEMPORAL_DATES_TIED/info",
                 "TEMPORAL_WAVES_NEAR_DEGENERATE/warn","TEMPORAL_WAVE_SIGN_CONVENTION/info"],
    "primaeon": { "surface": "mcp-stdio", "seed": 42, "wave_sign": "canonical",
                  "score_invariable_sites": true, "scored_codons": 566, "taxon_cap": null,
                  "tree_free": null, "duplicates_collapsed": 1 }
  },
  "honesty": {
    "stage": "complete", "null_state": "finished", "calls_are_final": true,
    "uncalled_because": null, "wave_columns_pending": false,
    "permutations": { "requested": 1000, "completed": 1000, "cancelled": false, "skipped": false,
                      "grid_step": 0.000999, "q_min": 0.0839, "q_rank1_bound": 0.1678,
                      "work": 1.036e9, "budget": 5.0e10, "within": true,
                      "rng": "xoshiro256**", "seed": 42, "chunks": 10, "ms_per_draw": 1.167, "tested": true },
    "p_perm_fill": "p_perm and q_perm are 1.0 at the 398 codons that never reached stage two ... not a measurement (temporal.py:620-621). A 1.0 does NOT mean untested — a tested candidate every shuffle beat scores (1 + B) / (B + 1) = 1.0 exactly. The column that tells them apart is classification; on this surface the mask is get_results section=candidates.",
    "escape_hatch_used": false, "solitary_regime": false, "gate_vacuous": false,
    "wave_variance": {
      "shares_pct": [97.13, 1.48, 0.60, 0.47], "source": "confirmed-sweeps", "sign": "canonical",
      "conditioned_on": "the confirmed-sweep set, which is thresholded on the permutation p",
      "note": "these shares MOVE WITH THE NULL ... measured upstream on H1N1 at B = 100: 32 confirmed here against 18 there. Compare shapes and ordering, not digits."
    },
    "reference_command": {
      "command": "hyphaeon temporal -a alignment.fasta -t tree.nwk -d H5N1_HA_metadata.csv -B 1000 --time-points 250 --sweep-mode episodic --perm-alpha 0.05 --min-r2 0.35 -o temporal",
      "reproduces": false,
      "caveats": [
        "Running this does not make the four files diff clean ... 1 of 4,384 sites rows byte-identical on H1N1. Compare numerically, not with diff.",
        "The 1000 date shuffles this run drew came from xoshiro256** per-draw substreams (D17); hyphaeon temporal draws from numpy's MT19937 at a hard-coded RandomState(42). Both are valid nulls and neither is the other.",
        "Wave signs follow this application's canonical convention (D28); hyphaeon temporal has none."
      ]
    }
  },
  "next": "get_results job_id=... section=<summary|sites|curves|waves|permutations|dates|candidates|warnings|honesty|provenance>. The whole record is never returned inline: its trajectory store alone is megabytes."
}`
	},
	{
		role: 'tool',
		tool: 'get_results',
		args: { job_id: '4368ab5e04a952f42fce650bcd9ff05c', section: 'sites', top: 3 },
		elapsedMs: 2,
		result: `{
  "analysis": "temporal", "section": "sites", "stage": "complete",
  "rows": [
    { "site": 123, "mutation_label": "R123S", "classification": "CONFIRMED_SWEEP", "cross_classification": "RESCUED_SWEEP",
      "is_confirmed_sweep": true, "is_rescued_sweep": true, "lrt": 0.128, "p_static": 0.3602, "q_static": 0.4032,
      "p_perm": 0.01099, "q_perm": 0.1319, "r2_fpca": 0.6784,
      "peak_date": 1998.458, "peak_intensity": 0.2021, "fwhm_years": 0.506, "auc": 0.1136, "Wave_1_loading": 15.797 },
    { "site": 288, "mutation_label": "G288S", "classification": "CONFIRMED_SWEEP", "cross_classification": "RESCUED_SWEEP",
      "is_confirmed_sweep": true, "is_rescued_sweep": true, "lrt": 1.081, "p_static": 0.1492, "q_static": 0.3285,
      "p_perm": 0.01099, "q_perm": 0.1319, "r2_fpca": 0.6784,
      "peak_date": 1998.458, "peak_intensity": 0.1776, "fwhm_years": 0.506, "auc": 0.0999, "Wave_1_loading": 15.797 },
    { "site": 455, "mutation_label": "D455Y", "classification": "CONFIRMED_SWEEP", "cross_classification": "RESCUED_SWEEP",
      "is_confirmed_sweep": true, "is_rescued_sweep": true, "lrt": 3.036, "p_static": 0.0407, "q_static": 0.2458,
      "p_perm": 0.01099, "q_perm": 0.1319, "r2_fpca": 0.6784,
      "peak_date": 1998.458, "peak_intensity": 0.1633, "fwhm_years": 0.506, "auc": 0.0916, "Wave_1_loading": 15.797 }
  ],
  "rows_returned": 3, "rows_available": 168, "codons_total": 566,
  "selection": "the 168 stage-one candidate codon(s), strongest peak intensity first (pass sites to name others; p_perm at a NON-candidate is the reference's assumed 1.0, not a measurement)",
  "truncated": { "rows": { "returned": 3, "total": 168, "ranked_by": "peak_intensity" } },
  "honesty": { "null_state": "finished", "calls_are_final": true, "uncalled_because": null }
}`
	},
	{
		role: 'assistant',
		text:
			'The dates are clean, and that is worth saying before anything else: all 98 sequences matched the metadata table exactly, all 98 dated by its numeric date column, spanning 1996 to 2005, with nothing imputed and no metadata row left unmatched — so this analysis is about the dataset you submitted rather than a subset of it. One sequence was then collapsed as a duplicate haplotype, leaving 97 for the model. Over 566 codons, 168 passed the stage-one sweep-energy floor and 16 were confirmed as sweeps by the full 1,000-draw permutation null, which completed inside its work budget; all 16 are "rescued" rather than "concordant", meaning the static MEME-surrogate call did not flag them (only one codon reaches q_static ≤ 0.10) and the temporal signal is what identifies them. The strongest are R123S, G288S and D455Y, all peaking together in mid-1998 with a half-width of about six months — one wave, not three independent events, which the fPCA agrees with: the leading mode carries 97% of the variance and the run is flagged TEMPORAL_WAVES_NEAR_DEGENERATE, so treat the four modes as one shape plus noise rather than four dynamics. Three caveats I would not drop. The permutation q values bottom out at 0.13 because 168 candidates against 1,000 draws puts the BH floor there, so "confirmed" here means p_perm ≈ 0.011 rather than a controlled false-discovery rate. The wave variance shares are computed over the confirmed set, which is thresholded on a null drawn from a different generator than the reference\'s, so compare their shape and ordering with a command-line run, not their digits — the tool says so itself, and sets `reproduces: false` on the reproduction command for exactly that reason. And these are surrogate scores for MEME: the ranking is the result, and codons 123, 288 and 455 are the three to confirm with real MEME on Datamonkey before reporting them.'
	}
];
