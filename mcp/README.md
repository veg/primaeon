# @veg/hyphaeon-mcp

MCP server for [HyphAeon](https://github.com/veg/HyphAeon): one tool that runs the whole report
from an alignment — site-level episodic selection (a neural surrogate for HyPhy MEME), the
gene-level omnibus (BUSTED surrogate), co-selection networks and epistatic sectors, attribution,
the alignment-artifact filter, a digital deep mutational scan and, when you give it a trait,
phenotype association — plus the per-pillar tools and concordance evaluation against real MEME, as
tools an MCP client (Claude Code, Claude Desktop, a claude.ai connector) can call.

**Everything runs in this process.** There is no Python, no `hyphaeon` CLI, no HyPhy and no
subprocess of any kind: the analyses are the JavaScript port of `hyphaeon/*.py`
(`@veg/hyphaeon-js`) through `@veg/hyphaeon-runtime` over ONNX Runtime for Node, with the graphs
named by `models/manifest.json` and hash-verified before they score anything.

**A tree is optional on every tool.** One with branch lengths is used as it is. Without one — or
with a tree that has none — HyphAeon computes pairwise Tamura-Nei 93 distances from the sequences
and feeds those to the model: the reference's own `--use-tn93` path, which the manuscript measures
at rho = 0.9997 against the tree-based one. Every result says which happened in
`provenance.preprocessing.tree_source` (`user` | `embedded` | `tn93`).

## Install

Local, over stdio (private; runs on your own machine, nothing leaves it):

```
npx @veg/hyphaeon-mcp
claude mcp add hyphaeon -- npx @veg/hyphaeon-mcp
```

Or from a checkout of this repository (`npm install` at the repository root links the runtime
and the library):

```
claude mcp add hyphaeon -- node /path/to/hyphaeon-app/mcp/bin/hyphaeon-mcp.js
```

Node 22 and a models directory are the whole requirement. Set `HYPHAEON_MODELS_DIR` if the
manifest and the `.onnx` graphs are not where the search order below expects them.

Remote, over streamable HTTP: the Node server (`server/`) mounts this package at `/mcp` behind
its OAuth ceremony; add it as a connector the way the Datamonkey connector is added.

## One action: `hyphaeon_analyze`

The product has one action (PLAN.md 4.0, D21): give `hyphaeon_analyze` an in-frame codon
alignment, with or without a tree, and everything that needs no further input runs, in a fixed
order, over ONE loaded alignment and ONE forward pass, into a `ReportRecord`:

| Order | Section | What runs | In the report |
|---|---|---|---|
| 1 | `diagnostics` | the library's "Before you run" checks with the automatic repairs: U->T, trailing-codon trim, duplicate collapse, Faith's-PD taxon cap, the variant chosen from tree depth, and the tree decision — a tree with branch lengths is used as it is, otherwise pairwise TN93 distances (`TREE_FREE_TN93`, info, with the reason) | `{taxa_in_alignment, taxa_used, codon_count, preprocessing, warnings}` |
| 2 | `sites` | site selection (`hyphaeon meme`): LRT, MEME mixture p, BH q, invariable flag, the app's rank columns | `runMeme`'s `{sites, summary, ...}` |
| 3 | `gene` | the omnibus (`hyphaeon busted`) from the same pass: ACAT, Simes, omnibus LRT, the busted head on the pooled representation | `{record, statistics, neural_head}` |
| 4 | `epistasis` | co-selection network and sectors (`hyphaeon epistasis`) from the same pass's attention | `{edges, sectors, plasticity, graph, permutations}` |
| 5 | `attribution` | per-taxon counterfactual attribution on the CALLED sites | `{attributions, attribution_enabled, gate}` |
| 6 | `filter` | the alignment-artifact screen, reported BESIDE the primary sites (masked/unmasked toggle) | `{artifacts_masked, filter_enabled, cleaned}` |
| 7 | `dms` | the digital DMS: progressive, cancellable, capped by a work budget; when partial the section says so | `{plasticity, focal_taxon, total_mutations, progress, cancelled?, skipped?}` |
| 8 | `phenotype` | **only with a `phenotype` trait block** (`preset`, `foreground` or `phenotype_file`), because a trait cannot be guessed. Given one, it is computed from the SAME forward pass the sections above used — graph maths, no extra inference (`provenance.phenotype_source: "report-pass"`) | `{sites, trait_sectors, coselection_pairs, permulations, ...}` or `null` |

The record is `{schema_version: 2, kind: "report", id, createdAt, inputs, options, diagnostics,
sections, provenance, timings}`. Advanced settings (`variant`, `max_species`, `reference_sequence`,
`call_mode`, `seed`, `permutations`, `dms`, `dms_work_budget`, `use_tn93`, `phenotype`) are the
report's "Re-run with..." disclosure, not a prerequisite: the defaults come from diagnostics.

**How the call answers.** The run is always a job, so the report has an id from the first
second. The call waits up to `wait_seconds` (default 120, max 600; `0` returns at once) and then:

- the whole record, inline, when it is at most 256 KB;
- otherwise `{job_id, summary, collections, note}` — the overview strip (gene verdict, called
  sites, taxa used, variant, surface) and one line per section;
- if the report is still running, `{job_id, status: "running", sections_ready, ready_summary}`.

`get_results` with `section=` pages one section at a time — `diagnostics`, `sites`, `gene`,
`epistasis`, `attribution`, `filter`, `dms`, `phenotype`, `provenance`, `timings` — with `top`
(ranked collections), `fields` and `summary_only` applied to it, and it serves a section that
is already final WHILE the report is still running (`job_status` lists `sections_ready`). The
finished record is the resource `hyphaeon://report/{id}` for as long as the job lives (7 days).
The `interpret-report` prompt says how to read the sections, in order, and what each can and
cannot support.

## One engine

| Tool | Engine | `provenance.surface` |
|---|---|---|
| `hyphaeon_validate` | library `diagnose()` in-process | — |
| `hyphaeon_analyze` | in-process (runtime `runEverything`: the whole report) | `mcp-stdio` / `mcp-http` |
| `hyphaeon_meme` | in-process (runtime `runMeme`: LRT, MEME mixture p, BH q, `--filter`, `--attribute`) | `mcp-stdio` / `mcp-http` |
| `hyphaeon_busted` | in-process (runtime `runBusted`: ACAT, Simes, omnibus LRT, the busted head) | `mcp-stdio` / `mcp-http` |
| `hyphaeon_epistasis` | in-process (runtime `runEpistasis`: attributions, cosine network, sectors with the permutation null, sector-site DMS) | `mcp-stdio` / `mcp-http` |
| `hyphaeon_dms` | in-process (runtime `runDms`: 19 substitutions per site, progressive) | `mcp-stdio` / `mcp-http` |
| `hyphaeon_phenotype` | in-process (runtime `runPhenotype` over the library's `phenotype.py` port) | `mcp-stdio` / `mcp-http` |
| `hyphaeon_dates` | in-process, **no model**: the runtime's `./dates` subtree, which imports no manifest, no session and no `predict.js` (measured: 93 ms of import, zero onnxruntime modules loaded) | — |
| `hyphaeon_dating` | in-process; **no model unless `use_model`**, which loads the second artifact `<variant>_taxa.onnx` (runtime `runDatingModelPass` + `runDating`) | `mcp-stdio` / `mcp-http` |
| `hyphaeon_temporal` | in-process (runtime `runTemporal` over the library's `temporal.py` port) | `mcp-stdio` / `mcp-http` |
| `hyphaeon_evaluate` | in-process (runtime `runEvaluate` over the library's `evaluation.py` port) | `mcp-stdio` / `mcp-http` |
| `job_status`, `get_results`, `cancel_job`, `list_models` | — | — |

Parity with `hyphaeon <cmd>`, measured in `test/` against the reference's own fixtures
(regenerated under the canonical MDS sign convention, HyphAeon/MDS_SIGN.md, which both sides
apply — `test/engine.test.js` compares the MDS coordinates exactly per column with no sign
allowance):

- `hyphaeon_meme` bat_oas1: site order and `is_invariable` exact; `hyphaeon_lrt` within
  1e-5 x max(1, |lrt|) (measured 2.4e-6); `p_value` / `q_value` the same float32 values
  `cmd_meme` writes.
- **`hyphaeon_meme` camelid with NO TREE** vs `hyphaeon meme --use-tn93`: `hyphaeon_lrt` within
  1e-5 (measured 2.3e-6), taxa and site order exact. This is the case the app could not reach
  before D22, because camelid's tree has no branch lengths and the two sides fitted them with
  different HyPhy builds; both now compute the same TN93 matrix (bit-identical, HyphAeon/PHASE3A.md)
  and the gap is closed by construction (`test/tn93.test.js`).
- `hyphaeon_busted` Smc6: the statistical fields at their classes (counts exact, 1e-6 derived,
  L x 1e-6 sums); the neural head fields are one seeded draw of a head the reference loads
  unseeded and are not compared.
- `hyphaeon_epistasis` Smc6 (B = 1,000, seed 42): edge set, order, ints and strings exact;
  cosine / p / q within 1e-6; `lrt_u`, `lrt_v`, `cesi` at the 1e-5 graph class; sector
  membership, ids, sizes and signatures exact; `spectral_coherence` within 1e-6; `p_perm` within
  3 sqrt(p(1-p)/B) and the null moments within the Monte Carlo error of B = 1,000; the sector-site
  DMS at the graph class.
- `hyphaeon_dms` bat_oas1 and Smc6: every record at the graph class — a mutant delta is the
  difference of two ORT LRTs, so its scale is the sum of theirs — with keys, key order, residues
  and the focal taxon exact.
- **`hyphaeon_phenotype` RHO** (the README's marine foreground, `--n-permutations 0 --seed 42`)
  vs `hyphaeon phenotype`: the 21 top-level keys in order, `phenotype_meta` (description string
  included), the four counts, the site table's length / order / key order, every residue and both
  frequency columns, and the trait sector's membership, signatures and whole null block, all
  EXACT; the model-derived columns at the 1e-5 graph class (worst 4.7e-6); every p-value within
  1e-6 absolute (worst 4.7e-7) — a p is exponential in an LRT, so the relative class is the wrong
  ruler for a number whose scale is 1e-10 (`test/phenotype.test.js`).
- `hyphaeon_evaluate`: 1e-9.

## Environment

| Variable | Meaning |
|---|---|
| `HYPHAEON_MODELS_DIR` | Directory holding `manifest.json` and the `.onnx` graphs (default: `web/static/models` of the checkout, then the sibling `HyphAeon/models`, then `@veg/hyphaeon-js/models`) |
| `HYPHAEON_VARIANT` | Default model variant (`general` or `viral`); `hyphaeon_analyze` otherwise chooses from tree depth |
| `HYPHAEON_MCP_THREADS` | ONNX Runtime intra-op threads (default 1) |
| `HYPHAEON_EXAMPLES_DIR` | Directory of example inputs (default: sibling `HyphAeon/examples`) |
| `HYPHAEON_GALLERY_DIR` | Directory holding the prebaked gallery (default: `web/static/gallery` of the checkout) |
| `HYPHAEON_MCP_LOG` | `debug` / `info` / `warn` / `error` / `silent` (stderr only) |

## Tools

| Tool | What it does | Runs the model |
|---|---|---|
| `hyphaeon_validate` | The library's "Before you run" diagnostics (format, alphabet, frame, stops, unknown codons, duplicates, three-tier tree/alignment name matching, the tree decision, negative lengths, the `> 10` patristic rescale, TN93 saturation, depth regime, cost) plus this server's caps and run mode; `analysis: "analyze"` sizes the whole report, and `analysis: "dates" / "dating" / "temporal"` **also reads the dates** with the same arguments and the same gates the run will apply. Returns `{ok, warnings:[{code, severity, message, data}], summary}` | no |
| `hyphaeon_analyze` | The whole report (above): `variant`, `max_species`, `reference_sequence`, `call_mode`, `seed`, `permutations`, `dms`, `dms_work_budget`, `use_tn93`, `phenotype`, `phenotype_file`, `wait_seconds`, `section` | yes |
| `hyphaeon_meme` | Per-site LRT, MEME mixture p, BH q, invariable flag, the app's rank columns (`zScore`, `percentile`, `call`); `filter`, `attribute`, `model_variant`, `max_species` | yes |
| `hyphaeon_busted` | ACAT / Simes combination, omnibus LRT, total selection energy, neural BUSTED head (selection probability, gene LRT, omega classes, SRV) | yes |
| `hyphaeon_epistasis` | Co-selection network (cosine, Student-t p, BH q, CESI), sectors with spectral coherence and the seeded permutation null, the sector-site DMS unless `no_dms`; `seed`, `n_permutations`, the CLI's thresholds | yes |
| `hyphaeon_dms` | 19-substitution digital DMS per site with intrinsic plasticity; `focal_taxon`; app-side `sites` sweeps a subset | yes |
| `hyphaeon_phenotype` | Directional trait association per site (foreground vs background attention, rho, t-test p, ACAT with the site LRT, BH q), a PARS signature, trait co-selection pairs, trait sectors, and — with `permulations` > 0 and a tree — a gene-level Brownian-motion permulation p. Trait: `preset`, `foreground`, or `phenotype_file` (the CSV/TSV **text**) | yes |
| `hyphaeon_dates` | The date review stage as data: a sampling date per sequence from the FASTA headers, a Nextstrain Auspice JSON, a name-to-date JSON object, a CSV/TSV table or a pattern you supply, with **which rule dated each sequence**, what did not match, what was imputed, the seven-tier name ladder's counts, and whether the set carries a clock at all. Also reports the two gates the two pillars below refuse on. Runs no model; milliseconds | no |
| `hyphaeon_dating` | The molecular clock: root-to-tip regression, rate `mu`, `t_mrca` with a Fieller / delta / linear interval, a restricted-cubic-spline alternative adjudicated against the line, an ensemble, and a per-taxon table of divergences, predicted dates, residuals, z-scores and outliers. **Model-free by default** and takes no tree (D34); `use_model: true` is a *different* estimator, not a better one | only with `use_model` |
| `hyphaeon_temporal` | Per-site selection trajectories through calendar time: prevalence and sweep velocity over a dense grid, peak date and intensity, half-rise / half-fall, FWHM, area; a two-stage filter (energy floor, then a date-shuffling permutation null with BH q); an fPCA decomposition into four wave modes; a four-way classification against the static call. **Always a job**, and the record is read one `section` at a time | yes |
| `hyphaeon_evaluate` | Concordance of a `hyphaeon meme` CSV with a HyPhy MEME JSON | no |
| `job_status` | Status of a queued job, with the latest progress phase and, for a running report, `sections_ready`; for a cancelled job, whether a partial record survived (`partial_result`) or may still arrive (`result_pending`) | — |
| `get_results` | Result of a completed job — or of a STOPPED one, labelled `status: "cancelled"`, `partial_result: true` with the draw count it reached — with `fields`, `top`, `summary_only`, and `section` for reports (also while running, for final sections) and for temporal records | — |
| `cancel_job` | Cancel a queued or running job. A `hyphaeon_temporal` run KEEPS what it had finished (the runtime classifies at the achieved draw count); a report keeps nothing | — |
| `list_models` | The manifest read through the runtime (variants, hashes, graph paths), and the engine's status: models directory, onnxruntime-node, MDS convention, and which runtime entry points are present | — |

Per-pillar analysis inputs mirror the CLI options one-to-one (`--filter` -> `filter`,
`--n-permutations` -> `n_permutations`, `--permulations` -> `permulations`, `--seed` -> `seed`,
`--use-tn93` -> `use_tn93`, `--mds-sign` -> `mds_sign`, and so on). Over stdio, `alignment`,
`tree`, `phenotype_file`, `dates_file`, `prediction` and `meme_result` also accept a `file://` URL
(the file's basename becomes the document's label).

### The time pillars

Call `hyphaeon_dates` first. It runs no model, costs milliseconds, and is the only place that says
which sequences carry a date and by what rule — which is the difference between an analysis of your
dataset and an analysis of a subset of it (measured on the bundled examples: H1N1 dates 95 of 100
from its headers, korber 142 of 143, H5N1 98 of 98).

`hyphaeon_dating` and `hyphaeon_temporal` **refuse two date sets the browser asks a human about**,
because a tool call has nobody to ask and must never pick the interpretation that produces the
prettier answer:

- `DATES_BARE_NUMBER_MAJORITY` — half or more of the dates were read as a bare number in the
  sequence name, a rule that claims any number it finds. Measured on the bundled H1N1 set: with the
  units inferred, 95 of 100 sequences date by the decimal-year rule over 2009.25–2009.91; forced to
  `time_units: "generations"`, 100 of 100 date and the axis runs **from 1 to 46,241,654**, with no
  error anywhere. Override with `accept_bare_numbers: true`, which is recorded in provenance.
- `DATES_UNDATED_PRESENT` — some sequences carry no date and would be dropped silently. Override
  with `drop_undated: true`, also recorded.

Both pillars carry a `{command, reproduces, caveats}` **object** as `provenance.reference_command`
rather than the argv array the other six carry, because neither can promise a reproduction:
`hyphaeon temporal` draws its null from numpy's MT19937 where this build draws from xoshiro256**
per-draw substreams (D17), and this build's date layer is the union of all three upstream parsers
and reads headers `hyphaeon dating` cannot. `reproduces` is false on every temporal run whose null
drew at all, and the caveats name why.

A temporal record is **never returned inline** — measured at 2.1 MB on the 98 × 566 H5N1 example at
the reference's own `--time-points 250`, and 7.2 MB on the engine's 4,384-codon acceptance run, of
which the trajectory store alone is 92%. The tool waits inside the call and answers with the
summary plus a `job_id`; `get_results section=<summary|sites|curves|waves|permutations|dates|candidates|warnings|honesty|provenance>`
pages the rest, and **every section carries the `honesty` block**: `null_state`
(`not-started | running | finished | stopped`), whether the calls are final, why nothing is called
when nothing is, the note that `p_perm` is 1.0 at every codon that never reached stage two (the
reference's own fill, temporal.py:620-621, not a measurement), and the set the wave variance shares
are conditioned on, and — on a run stopped by `cancel_job` — `null_truncated` with the draw count
the null actually reached.

Two replies that are not the analysis, and say so. A call that has not finished inside
`wait_seconds` answers with `shape: "pending"` — the job id, the status, `sections_ready: []` and a
`next` naming `job_status`, the only call that can work before the run ends, because every call,
count and wave mode is computed after the null. And `cancel_job` on a temporal run does not throw
the run away: `runTemporalNull` catches its own abort, classifies at the draws it finished and
returns a complete record, so `get_results` serves it as a PARTIAL run — measured on the H5N1
example, a run stopped 1.5 s into a 10,000-draw null kept 4,364 draws, 168 candidates and 16
confirmed sweeps, with the p-grid it bought (2.29e-4) printed beside them. A cancel that arrives
before the first chunk keeps nothing, and says that instead.

Every analysis tool and `get_results` accept `fields`
(top-level keys to keep), `top` (keep the N best records of each ranked collection) and
`summary_only` (counts plus a per-pillar summary).

Seams between the CLI and the in-process tools, each recorded in `provenance`:

- `max_species` unset means no taxon cap for `hyphaeon_meme`, `hyphaeon_epistasis`,
  `hyphaeon_dms` and `hyphaeon_phenotype` (the CLI's behaviour) and 512 for `hyphaeon_busted`, as
  in `cli.py`. The report (`hyphaeon_analyze`) defaults to the manifest's 256, a product decision.
- MDS eigenvector signs are `canonical` on both sides (HyphAeon/MDS_SIGN.md). The library
  computes only that convention, so `mds_sign: "lapack"` (the pre-convention numbers) is refused
  with an input-class error; `provenance.mds_sign` records `canonical` and the
  `reference_command` spells `--mds-sign canonical`.
- **The tree (D22).** No tool requires one. A tree with branch lengths is used as it is; no tree,
  a tree without usable branch lengths, or `use_tn93` / `no_tree` all take the library's tree-free
  path, and `provenance.preprocessing` records `tree_source: "tn93"` with
  `tree_free.reason` (`requested` | `no_tree` | `no_branch_lengths`) and `tn93_saturated_pairs`.
  A tree TEXT that will not parse is still an error — a bad tree is not a missing one. The
  Python reference REFUSES a missing tree and silently substitutes 1e-3 defaults for a tree with
  no lengths, so `reference_command` spells `--use-tn93` whenever the run was tree-free: it is the
  only invocation that reproduces it.
- `seed` feeds the sector permutation null and the phenotype permulations. The reference draws
  with PCG64, the library with xoshiro256**: the same seed gives a different sequence, so
  `p_perm`, `p_assoc_perm` and `gene_p_value_perm` agree statistically (within
  3 sqrt(p(1-p)/B)), never bit for bit. At B = 1,000 each side carries about +/-0.03 absolute;
  every epistasis result carries `permutations: {n, seed, rng, note}` saying so, and every
  phenotype result carries `sector_permutations` and `permulations`.
- **Permulations need a phylogeny.** `hyphaeon phenotype --permulations N` draws Brownian-motion
  permutations of the trait over the tree's covariance; a tree-free run has no tree to draw from,
  so they are skipped and `permulations: {requested, ran: 0, reason: "tree-free", detail}` says
  so — the association p-values are then the parametric t-test ones, which is what
  `hyphaeon phenotype --use-tn93` reports too. The display-only neighbour-joining tree is
  deliberately not substituted: a null built from the same distances as the alternative shares
  its error.
- `phenotype_file` is the table's TEXT, not a path. The library does no I/O and a remote server
  must never read its own disk on a caller's behalf; over stdio a `file://` URL is read for you
  and its basename becomes the `--phenotype-file` name in `reference_command`.
- `min_patch_consec` is recorded but only its default (3) is applied; a different value adds an
  `OPTION_NOT_APPLIED` warning.
- `cpu` is accepted and recorded; the engine is CPU-only.
- The busted head's fields (`selection_probability`, `predicted_gene_lrt`,
  `synonymous_rate_variation`, `omega_3`, `proportion_*`) come from one seeded draw of a head the
  reference loads unseeded; `provenance.neural_head.deterministic_upstream` is false. The
  statistical fields are reproducible.
- `hyphaeon epistasis` and `hyphaeon dms` have no `--model-variant`, so those two tools do not
  expose one; `HYPHAEON_VARIANT` applies.
- `hyphaeon_dms`'s `sites` is app-side (the CLI sweeps every site); `total_mutations` stays
  19 x codon_count as the reference computes it, and `progress` says how many sites were swept.
  `focal_taxon` is matched as a lower-cased substring and a miss silently means taxon 0 — the
  reference's behaviour; `provenance.focal_name` names the taxon actually swept.

### Synchronous or job

A per-pillar run answers inside the tool call when the alignment is at most 12,000 codon sites and
the work term `sites x sequences^2` (x19 for dms) is at most 2.5e9, both measured on the file as
submitted (longest sequence, all sequences). Above that, or with `run_async: true`, the tool
returns a `job_id`; poll `job_status` (which shows the runtime's `{phase, done, total, message}`
progress), fetch with `get_results`. `hyphaeon_analyze` is sized like `meme` (its DMS section caps
itself by `dms_work_budget`) and is always a job, waiting inside the call for `wait_seconds`.
Hard caps: 8 MiB of alignment text, 3 to 1,000 sequences, 30,000 codon sites (3,000 for dms),
work 2.5e9, 10,000 permutations, 2,000 permulations, a 10-minute timeout per run.

### Errors

Every error is `{error, kind, hint?}` with `isError: true`. `kind` is `"input"` (your alignment,
tree or options; the hint says what to change) or `"server"` (the model files, onnxruntime-node,
or the hardware; nothing in your data will change it). This is the split
datamonkey-js-server's `axomeme_scan` uses.

### Provenance

Every result carries a `provenance` block (PLAN.md 3.5): `surface` (`mcp-stdio` / `mcp-http`),
`engine: "in-process"`, `hyphaeon_js_version`, `reference_version`, `model_version`,
`model_variant`, `artifact_sha256` and `artifact_verified`, `is_surrogate`, `surrogate_for`,
`seed`, `mds_sign`, `elapsed_sec`, the `options` as submitted, `preprocessing` (taxa in and used,
duplicates collapsed, PD subsampling, `tree_source`, `tree_free`, `tn93_saturated_pairs`,
`distance_rescaled`, unknown-codon fraction, in-frame stops), the library's diagnostics as
`warnings`, and `reference_command`, the `hyphaeon <cmd>` line that reproduces the run (a report
carries `reference_commands`, one per section, plus `variant_source` and, when a trait was given,
`phenotype_source`).

## Resources and prompts

| Resource | Content |
|---|---|
| `hyphaeon://models` | The manifest as the runtime validates it (variants, hashes, graph paths, caps), or the reference's known variants when absent |
| `hyphaeon://methods/requirements` | Per-pillar inputs (`requires_tree: false` everywhere, with the tree-free rule spelled out), options with CLI defaults, result keys, caps, the report's sections, and every validation code |
| `hyphaeon://caveats` | `caveats.json`: model card facts and the `model_eval` calibration, concordance and invariance tables, keyed by `model_version` |
| `hyphaeon://examples/{name}` | Bundled examples (`Smc6.fasta`, `Smc6.nwk`, `bat_oas1.fasta`, ...) |
| `hyphaeon://gallery` | The prebaked gallery index (`web/static/gallery/index.json`, written by `web/scripts/prebake-gallery.mjs` at build) |
| `hyphaeon://gallery/{name}` | The prebaked report for a bundled example, by id (`bat_oas1`, `Smc6`, ...), when present |
| `hyphaeon://report/{id}` | A finished `hyphaeon_analyze` report by its job id; lists the completed reports; a running id reads as an error naming the sections that are ready |

Prompts: `choose-analysis`, `interpret-report` (the whole report: the order of its sections,
what each can and cannot support, the `p_perm` Monte Carlo caveat), and one interpretation guide
per pillar — `interpret-meme`, `interpret-busted`, `interpret-epistasis`, `interpret-dms`,
`interpret-phenotype`, `interpret-evaluate`.

## Validation codes

The library's (js/src/diagnostics.js, thresholds and sources in its header): `FORMAT_UNKNOWN`,
`ALPHABET_U_TO_T`, `NON_ACGT_FRACTION`, `LENGTH_NOT_MULTIPLE_OF_3`, `IN_FRAME_STOPS`,
`FRAMESHIFT_SUSPECTED`, `UNKNOWN_CODON_FRACTION`, `UNEQUAL_LENGTHS`, `DUPLICATE_SEQUENCES`,
`TOO_FEW_TAXA`, `TAXA_OVER_CAP`, `TAXA_OVER_LIMIT`, `TREE_UNPARSEABLE`, `TREE_FREE_TN93`,
`TAXA_NOT_IN_TREE`, `TIPS_NOT_IN_ALIGNMENT`, `NEGATIVE_BRANCH_LENGTHS`, `DISTANCE_RESCALED`,
`TN93_SATURATED_PAIRS`, `SHALLOW_TREE`, `DEEP_LARGE_TREE`, `STAR_LIKE`, `COST_ESTIMATE`. This
server's: `CAPS_EXCEEDED` (refuse) and `RUN_MODE` (info). Severity is `info`, `warn` or `refuse`;
`ok` is false when anything refuses. **D22 retired three codes**: `TREE_MISSING` and
`BRANCH_LENGTHS_MISSING` became `TREE_FREE_TN93` at *info* level with the reason, and
`TN93_UNAVAILABLE` is gone because the library computes the distances. The same library codes are
the contract for the web app's diagnostics panel and the Node server's `/validate`.

## Known gaps

- The neural BUSTED head is one seeded draw of a head the reference loads unseeded; only the
  statistical fields of `hyphaeon_busted` are reproducible upstream.
- Neither time pillar has a comparator in `scripts/parity.py`. The acceptance evidence is
  `runtime/test/temporal-port.test.js` (against `fixtures/temporal/acceptance/`) and
  `runtime/test/dating-port.test.js`; `test/temporal.test.js` and `test/dating.test.js` here pin the
  SURFACE — the size rule, the sections, the null's four states, the refusals — not the numbers.
- `DATES_BARE_NUMBER_MAJORITY` and `DATES_UNDATED_PRESENT` are this surface's codes, not the
  runtime's. They belong in `runtime/src/dates/codes.js` beside the other thirty-one, so all three
  surfaces read one threshold and the browser renders the refusal instead of computing it; Phase 6's
  MCP work did not touch `runtime/src/`. `src/time.js`'s header carries the duplication and the
  reason.
- `datingReferenceCommand` HAS MOVED to `runtime/src/dating/results.js` beside
  `temporalReferenceCommand`, where phase 6's report said it belonged; `src/time.js` re-exports it
  and holds no copy. It came back with two caveats the MCP's copy never had, both about which date
  a surface may quote — see `datingHeadline` below.
- `headline` is on `honesty` and on `summary` of every dating result: `datingHeadline`
  (`runtime/src/dating/headline.js`) is the `/time` route's own rule, and it refuses to headline a
  fit whose `ci_mrca` is a point estimate `[x, x]` (every spline fit, because the spline's bootstrap
  never runs upstream) and attaches a refutation to a clock whose slope is not distinguishable from
  zero. `record.t_mrca` and `summary.t_mrca` are still `active_model`'s and are never hidden; a
  client that prints either one flat is doing what the browser deliberately does not.
- `DATING_MODEL_TOO_MANY_TAXA` (the runtime's refusal above 1,500 sequences for the model-based
  estimators) is unreachable through this server: `MAX_TAXA` is 1,000, so no admitted submission can
  reach the pillar's own ceiling. The mapping exists and is correct; the caps make it moot.
- BEAST XML is refused (`DATES_BEAST_XML_UNSUPPORTED`); the reference reads one (dating.py:433-434).
- `hyphaeon dating`'s `--clock-model power`, `--loocv`, `--bootstrap` and its `poisson`,
  `residual-boot`, `site-boot` and `jackknife` interval methods are not ported and are refused by
  the schema rather than silently answered with a substitute. `record.primaeon.estimators_not_built`
  names each one and why.
- `--mds-sign lapack` cannot run in-process (the library computes the canonical convention only);
  use the Python reference for pre-convention numbers.
- `p_perm` at the report's default B = 1,000 is a noisy estimate on every surface; the parity
  class was written for B = 10,000.
- Permulations are skipped in tree-free mode, by design (see the seam above). A dataset with no
  tree therefore has no `gene_p_value_perm` and no `p_assoc_perm` column.

## Programmatic use

```js
import { createServer } from "@veg/hyphaeon-mcp";          // McpServer + job store + engine
import { mountHttp } from "@veg/hyphaeon-mcp/http";        // streamable HTTP on an Express app
import { createEngine } from "@veg/hyphaeon-mcp/engine";   // the in-process engine on its own

const app = express();
app.use(express.json());
// `authenticate` is an Express middleware (the server's OAuth Bearer check, server/src/oauth.js);
// without it the mount serves unauthenticated and warns loudly at startup.
mountHttp(app, { path: "/mcp", authenticate });
```

`mountHttp(app, {path, authenticate, engine, serverOptions, allowedHosts, allowedOrigins,
enableJsonResponse, logger})` returns `{sessions, engine, authenticated, path, close}`. One
shared in-process engine serves every session; `file://` inputs are disabled over HTTP.
`@veg/hyphaeon-mcp/engine` also exports `runPhenotypeSection`, which fills a finished report's
phenotype section out of the pass it already ran — the Node server uses it so a REST `analyze`
job and `hyphaeon_analyze` cannot disagree.

## Development

```
npm install                              # at the repository root
cd mcp
HYPHAEON_MODELS_DIR=/path/to/HyphAeon/models npm test
```

The tests use the SDK's `InMemoryTransport`: the tool registry, validation on the bundled
examples through the library's `diagnose` (camelid's `TREE_FREE_TN93`, bat_oas1's
`DISTANCE_RESCALED`), job paging with a stubbed engine (including a stubbed report, streamed
section by section), the resources including the gallery and the report template,
`hyphaeon_meme` on bat_oas1 and `hyphaeon_busted` on Smc6 against the reference's e2e fixtures
with the MDS coordinates compared exactly, **`hyphaeon_meme` on camelid with no tree against
`hyphaeon meme --use-tn93`**, `hyphaeon_epistasis` on Smc6 against `hyphaeon epistasis`
(B = 1,000, seed 42), `hyphaeon_dms` against `fixtures/dms` and the Smc6 sector-site table,
**`hyphaeon_phenotype` on RHO against `hyphaeon phenotype`** with the permulation gate checked
both ways, `hyphaeon_analyze` on bat_oas1 (every section, the sites section equal to
`hyphaeon meme`, paging by section, the report resource, streaming while running, the tree-free
path and the phenotype trait block), `hyphaeon_evaluate` against the evaluation fixtures, and
`mountHttp` with and without `authenticate` over a real HTTP round trip. Model-running tests use
`HYPHAEON_MCP_THREADS` (default 4 in the tests). Nothing in the suite starts a subprocess.
