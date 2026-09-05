# @veg/hyphaeon-mcp

MCP server for [HyphAeon](https://github.com/veg/HyphAeon): one tool that runs the whole report
from an alignment — site-level episodic selection (a neural surrogate for HyPhy MEME), the
gene-level omnibus (BUSTED surrogate), co-selection networks and epistatic sectors, attribution,
the alignment-artifact filter and a digital deep mutational scan — plus the per-pillar tools,
phenotype association, and concordance evaluation against real MEME, as tools an MCP client
(Claude Code, Claude Desktop, a claude.ai connector) can call.

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

Remote, over streamable HTTP: the Node server (`server/`) mounts this package at `/mcp` behind
its OAuth ceremony; add it as a connector the way the Datamonkey connector is added.

## One action: `hyphaeon_analyze`

The product has one action (PLAN.md 4.0, D21): give `hyphaeon_analyze` an in-frame codon
alignment, with or without a tree, and everything that needs no further input runs, in a fixed
order, over ONE loaded alignment and ONE forward pass, into a `ReportRecord`:

| Order | Section | What runs | In the report |
|---|---|---|---|
| 1 | `diagnostics` | the library's "Before you run" checks with the automatic repairs: U->T, trailing-codon trim, duplicate collapse, Faith's-PD taxon cap, the variant chosen from tree depth, HKY85 branch lengths from HyPhy WASM when the tree has none, a neighbour-joining tree from HyPhy when there is no tree at all | `{taxa_in_alignment, taxa_used, codon_count, preprocessing, warnings}` |
| 2 | `sites` | site selection (`hyphaeon meme`): LRT, MEME mixture p, BH q, invariable flag, the app's rank columns | `runMeme`'s `{sites, summary, ...}` |
| 3 | `gene` | the omnibus (`hyphaeon busted`) from the same pass: ACAT, Simes, omnibus LRT, the busted head on the pooled representation | `{record, statistics, neural_head}` |
| 4 | `epistasis` | co-selection network and sectors (`hyphaeon epistasis`) from the same pass's attention | `{edges, sectors, plasticity, graph, permutations}` |
| 5 | `attribution` | per-taxon counterfactual attribution on the CALLED sites | `{attributions, attribution_enabled, gate}` |
| 6 | `filter` | the alignment-artifact screen, reported BESIDE the primary sites (masked/unmasked toggle) | `{artifacts_masked, filter_enabled, cleaned}` |
| 7 | `dms` | the digital DMS, LAST: progressive, cancellable, capped by a work budget; when partial the section says so | `{plasticity, focal_taxon, total_mutations, progress, cancelled?, skipped?}` |
| 8 | `phenotype` | `null`: it needs a trait, so the report offers `hyphaeon_phenotype` instead of running it | — |

The record is `{schema_version: 2, kind: "report", id, createdAt, inputs, options, diagnostics,
sections, provenance, timings}`. Advanced settings (`variant`, `max_species`, `reference_sequence`,
`call_mode`, `seed`, `permutations`, `dms`, `dms_work_budget`) are the report's "Re-run with..."
disclosure, not a prerequisite: the defaults come from diagnostics.

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

## Native or bridged

Everything except phenotype runs **in the MCP process**: the JavaScript library
`@veg/hyphaeon-js` (the port of `hyphaeon/*.py`, at tag `phase-2a`) through
`@veg/hyphaeon-runtime` over ONNX Runtime for Node, with the graphs named by
`models/manifest.json` and hash-verified before they score anything. No Python is involved and
nothing leaves the machine. Phenotype association is the ONE pillar whose port has not landed
(Phase 3); its tool still shells out to the Python reference CLI (PLAN.md 3.6, "bridge, then
port"), and every result says which engine ran in `provenance.surface`.

| Tool | Engine | `provenance.surface` |
|---|---|---|
| `hyphaeon_validate` | library `diagnose()` in-process | — |
| `hyphaeon_analyze` | in-process (runtime `runEverything`: the whole report) | `mcp-stdio` / `mcp-http` |
| `hyphaeon_meme` | in-process (runtime `runMeme`: LRT, MEME mixture p, BH q, `--filter`, `--attribute`) | `mcp-stdio` / `mcp-http` |
| `hyphaeon_busted` | in-process (runtime `runBusted`: ACAT, Simes, omnibus LRT, the busted head) | `mcp-stdio` / `mcp-http` |
| `hyphaeon_epistasis` | in-process (runtime `runEpistasis`: attributions, cosine network, sectors with the permutation null, sector-site DMS) | `mcp-stdio` / `mcp-http` |
| `hyphaeon_dms` | in-process (runtime `runDms`: 19 substitutions per site, progressive) | `mcp-stdio` / `mcp-http` |
| `hyphaeon_evaluate` | in-process (runtime `runEvaluate` over the library's `evaluation.py` port) | `mcp-stdio` / `mcp-http` |
| `hyphaeon_phenotype` | Python reference CLI (`src/bridge.js`) — the only bridged tool | `python-reference` |
| `job_status`, `get_results`, `cancel_job`, `list_models` | — | — |

Parity of the native tools with `hyphaeon <cmd>`, measured in `test/` against the reference's
fixtures (regenerated under the canonical MDS sign convention, HyphAeon/MDS_SIGN.md, which both
sides now apply — PHASE1.md's gap 1 is closed and `test/engine.test.js` compares the MDS
coordinates exactly per column with no sign allowance):

- `hyphaeon_meme` bat_oas1: site order and `is_invariable` exact; `hyphaeon_lrt` within
  1e-5 x max(1, |lrt|) (measured 2.4e-6); `p_value` / `q_value` the same float32 values
  `cmd_meme` writes.
- `hyphaeon_busted` Smc6: the statistical fields at their classes (counts exact, 1e-6 derived,
  L x 1e-6 sums); the neural head fields are one seeded draw of a head the reference loads
  unseeded and are not compared.
- `hyphaeon_epistasis` Smc6 (B = 1,000, seed 42): edge set, order, ints and strings exact;
  cosine / p / q within 1e-6; `lrt_u`, `lrt_v`, `cesi` at the 1e-5 graph class; sector
  membership, ids, sizes and signatures exact; `spectral_coherence` within 1e-6; `p_perm` within
  3 sqrt(p(1-p)/B) and the null moments within the Monte Carlo error of B = 1,000; the sector-site
  DMS at the graph class.
- `hyphaeon_dms` bat_oas1 (the fixture's target sites, default and `r_ferr` focal taxa) and Smc6
  (the CLI's sector sites): every record at the graph class — a mutant delta is the difference of
  two ORT LRTs, so its scale is the sum of theirs — with keys, key order, residues and the focal
  taxon exact.
- `hyphaeon_evaluate`: 1e-9.

### The bridged pillar needs the Python reference

Install it and make sure `hyphaeon` is on `PATH` (or set `HYPHAEON_PY_BIN`):

```
pip install hyphaeon            # or: pip install -e /path/to/HyphAeon
export HYPHAEON_WEIGHTS=/path/to/model.safetensors   # optional; otherwise Hugging Face
```

Everything else works without Python.

## Environment

| Variable | Meaning |
|---|---|
| `HYPHAEON_MODELS_DIR` | Directory holding `manifest.json` and the `.onnx` graphs (default: `web/static/models` of the checkout, then the sibling `HyphAeon/models`, then `@veg/hyphaeon-js/models`) |
| `HYPHAEON_VARIANT` | Default model variant (`general` or `viral`) for the native tools and the CLI; `hyphaeon_analyze` otherwise chooses from tree depth |
| `HYPHAEON_MCP_THREADS` | ONNX Runtime intra-op threads for the native tools (default 1) |
| `HYPHAEON_PY_BIN` | Path to the `hyphaeon` executable for `hyphaeon_phenotype` (default: `hyphaeon` on PATH) |
| `HYPHAEON_WEIGHTS` | Local weights file passed through to the CLI (else Hugging Face / package default) |
| `HF_HUB_OFFLINE` | Set to `1` to forbid Hugging Face downloads (passed through) |
| `HYPHAEON_EXAMPLES_DIR` | Directory of example inputs (default: sibling `HyphAeon/examples`) |
| `HYPHAEON_GALLERY_DIR` | Directory holding the prebaked gallery (default: `web/static/gallery` of the checkout) |
| `HYPHAEON_MCP_LOG` | `debug` / `info` / `warn` / `error` / `silent` (stderr only) |
| `HYPHAEON_MCP_SKIP_BRIDGE` | `1` skips the Python end-to-end tests in `npm test` |

## Tools

| Tool | What it does | Runs the model |
|---|---|---|
| `hyphaeon_validate` | The library's "Before you run" diagnostics (format, alphabet, frame, stops, unknown codons, duplicates, three-tier tree/alignment name matching, branch-length regime, the `> 10` patristic rescale, depth regime, cost) plus this server's caps and run mode; `analysis: "analyze"` sizes the whole report. Returns `{ok, warnings:[{code, severity, message, data}], summary}` | no |
| `hyphaeon_analyze` | The whole report (above): `variant`, `max_species`, `reference_sequence`, `call_mode`, `seed`, `permutations`, `dms`, `dms_work_budget`, `wait_seconds`, `section` | yes, in-process |
| `hyphaeon_meme` | Per-site LRT, MEME mixture p, BH q, invariable flag, the app's rank columns (`zScore`, `percentile`, `call`); `filter`, `attribute`, `model_variant`, `max_species` | yes, in-process |
| `hyphaeon_busted` | ACAT / Simes combination, omnibus LRT, total selection energy, neural BUSTED head (selection probability, gene LRT, omega classes, SRV) | yes, in-process |
| `hyphaeon_epistasis` | Co-selection network (cosine, Student-t p, BH q, CESI), sectors with spectral coherence and the seeded permutation null, the sector-site DMS unless `no_dms`; `seed`, `n_permutations`, the CLI's thresholds | yes, in-process |
| `hyphaeon_dms` | 19-substitution digital DMS per site with intrinsic plasticity; `focal_taxon`; app-side `sites` sweeps a subset | yes, in-process |
| `hyphaeon_phenotype` | Directional trait association per site, PARS signature, trait sectors, optional permulations; `seed`, `mds_sign` | yes, via Python |
| `hyphaeon_evaluate` | Concordance of a `hyphaeon meme` CSV with a HyPhy MEME JSON | no |
| `job_status` | Status of a queued job, with the latest progress phase and, for a running report, `sections_ready` | — |
| `get_results` | Result of a completed job, with `fields`, `top`, `summary_only`, and `section` for reports (also while running, for final sections) | — |
| `cancel_job` | Cancel a queued or running job | — |
| `list_models` | The manifest read through the runtime (variants, hashes, graph paths), the native engine's status (models directory, onnxruntime-node, branch-length estimator, which runtime entry points are present) and the bridge's reachability | — |

Per-pillar analysis inputs mirror the CLI options one-to-one (`--filter` -> `filter`,
`--n-permutations` -> `n_permutations`, `--seed` -> `seed`, `--mds-sign` -> `mds_sign`, and so
on). Over stdio, `alignment`, `tree`, `phenotype_file`, `prediction` and `meme_result` also accept
a `file://` URL (the file's basename becomes the document's label). Every analysis tool and
`get_results` accept `fields` (top-level keys to keep), `top` (keep the N best records of each
ranked collection) and `summary_only` (counts plus a per-pillar summary).

Seams between the CLI and the in-process tools, each recorded in `provenance`:

- `max_species` unset means no taxon cap for `hyphaeon_meme`, `hyphaeon_epistasis` and
  `hyphaeon_dms` (the CLI's behaviour) and 512 for `hyphaeon_busted`, as in `cli.py`. The report
  (`hyphaeon_analyze`) defaults to the manifest's 256, a product decision.
- MDS eigenvector signs are `canonical` on both sides (HyphAeon/MDS_SIGN.md). The library
  computes only that convention, so `mds_sign: "lapack"` (the pre-convention numbers) is refused
  in-process with an input-class error; `provenance.mds_sign` records `canonical` and the
  `reference_command` spells `--mds-sign canonical`.
- `seed` feeds the sector permutation null. The reference draws with PCG64, the library with
  xoshiro256**: the same seed gives a different sequence of K-subsets, so `p_perm` agrees
  statistically (within 3 sqrt(p(1-p)/B)), never bit for bit. At B = 1,000 each side carries about
  +/-0.03 absolute; every epistasis result carries `permutations: {n, seed, rng, note}` saying so.
- A tree without branch lengths gets HKY85 lengths from HyPhy (the reference's own behaviour)
  through the runtime's HyPhy WebAssembly driver; `provenance.preprocessing.tree_source` is then
  `hyphy-hky85` and `branch_lengths_estimated` true. The reference prunes tree tips that have no
  sequence before the fit; this server does not, so such a tree is refused with HyPhy's message.
  An alignment with no tree at all is refused by the per-pillar tools (as the CLI would) and
  accepted by `hyphaeon_analyze`, which builds a neighbour-joining tree first (`tree_source: "nj"`).
- `use_tn93` / `no_tree` (TN93 distances in place of a tree) is not implemented in-process and is
  refused for the native tools with an input-class error; `hyphaeon_phenotype` passes it to the CLI.
- `min_patch_consec` is recorded but only its default (3) is applied; a different value adds an
  `OPTION_NOT_APPLIED` warning.
- `cpu` is accepted and recorded; the native engine is CPU-only.
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
the Python environment, or the hardware; nothing in your data will change it). This is the split
datamonkey-js-server's `axomeme_scan` uses.

### Provenance

Every result carries a `provenance` block (PLAN.md 3.5). Native results: `surface`
(`mcp-stdio` / `mcp-http`), `engine: "in-process"`, `hyphaeon_js_version`, `reference_version`,
`model_version`, `model_variant`, `artifact_sha256` and `artifact_verified`, `is_surrogate`,
`surrogate_for`, `seed`, `mds_sign`, `elapsed_sec`, the `options` as submitted, `preprocessing`
(taxa in and used, duplicates collapsed, PD subsampling, `tree_source`, `branch_lengths_estimated`,
`distance_rescaled`, unknown-codon fraction, in-frame stops), the library's diagnostics as
`warnings`, and `reference_command`, the `hyphaeon <cmd>` line that reproduces the run (a report
carries `reference_commands`, one per section, and `variant_source`). Bridged results keep
`surface: "python-reference"`, `reference_version`, `elapsed_sec` and the `command` that ran (temp
paths redacted).

## Resources and prompts

| Resource | Content |
|---|---|
| `hyphaeon://models` | The manifest as the runtime validates it (variants, hashes, graph paths, caps), or the reference's known variants when absent |
| `hyphaeon://methods/requirements` | Per-pillar inputs, options with CLI defaults, result keys, caps, the report's sections, which pillars run in-process, and every validation code |
| `hyphaeon://caveats` | `caveats.json`: model card facts and the `model_eval` calibration, concordance and invariance tables, keyed by `model_version` |
| `hyphaeon://examples/{name}` | Bundled examples (`Smc6.fasta`, `Smc6.nwk`, `bat_oas1.fasta`, ...) |
| `hyphaeon://gallery` | The prebaked gallery index (`web/static/gallery/index.json`, written by `web/scripts/prebake-gallery.mjs` at build) |
| `hyphaeon://gallery/{name}` | The prebaked site-selection record for a bundled example, by id (`bat_oas1`, `Smc6`, ...), when present |
| `hyphaeon://report/{id}` | A finished `hyphaeon_analyze` report by its job id; lists the completed reports; a running id reads as an error naming the sections that are ready |

Prompts: `choose-analysis`, `interpret-report` (the whole report: the order of its sections,
what each can and cannot support, the `p_perm` Monte Carlo caveat), and one interpretation guide
per pillar — `interpret-meme`, `interpret-busted`, `interpret-epistasis`, `interpret-dms`,
`interpret-phenotype`, `interpret-evaluate`.

## Validation codes

The library's (js/src/diagnostics.js, thresholds and sources in its header): `FORMAT_UNKNOWN`,
`ALPHABET_U_TO_T`, `NON_ACGT_FRACTION`, `LENGTH_NOT_MULTIPLE_OF_3`, `IN_FRAME_STOPS`,
`FRAMESHIFT_SUSPECTED`, `UNKNOWN_CODON_FRACTION`, `UNEQUAL_LENGTHS`, `DUPLICATE_SEQUENCES`,
`TOO_FEW_TAXA`, `TAXA_OVER_CAP`, `TAXA_OVER_LIMIT`, `TREE_MISSING`, `TREE_UNPARSEABLE`,
`TAXA_NOT_IN_TREE`, `TIPS_NOT_IN_ALIGNMENT`, `BRANCH_LENGTHS_MISSING`, `NEGATIVE_BRANCH_LENGTHS`,
`DISTANCE_RESCALED`, `SHALLOW_TREE`, `DEEP_LARGE_TREE`, `STAR_LIKE`, `COST_ESTIMATE`. This
server's: `CAPS_EXCEEDED` (refuse), `RUN_MODE` (info), `TN93_UNAVAILABLE` (refuse). Severity is
`info`, `warn` or `refuse`; `ok` is false when anything refuses. The same library codes are the
contract for the web app's diagnostics panel and the Node server's `/validate`.

## Known gaps

- Phenotype association runs through the Python reference until its port lands (Phase 3); the
  report offers it and does not run it.
- The reference prunes tree tips without a sequence before HyPhy fits branch lengths; the
  library has no Newick writer, so this server refuses such a tree instead.
- TN93 tree-free mode is not available in-process.
- `--mds-sign lapack` cannot run in-process (the library has no `mdsSign` option on its loader,
  HyphAeon/PHASE2A.md gap 9); use the Python CLI for pre-convention numbers.
- `p_perm` at the report's default B = 1,000 is a noisy estimate on every surface; the parity
  class was written for B = 10,000.

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

## Development

```
npm install                              # at the repository root
cd mcp
HYPHAEON_PY_BIN=/path/to/venv/bin/hyphaeon HYPHAEON_WEIGHTS=/path/to/model.safetensors HF_HUB_OFFLINE=1 npm test
HYPHAEON_MCP_SKIP_BRIDGE=1 npm test      # without Python
```

The tests use the SDK's `InMemoryTransport`: the tool registry, validation on the bundled
examples through the library's `diagnose` (camelid's `BRANCH_LENGTHS_MISSING`, bat_oas1's
`DISTANCE_RESCALED`), job paging with a stubbed engine and a stubbed bridge (including a stubbed
report, streamed section by section), the resources including the gallery and the report
template, `hyphaeon_meme` on bat_oas1 and `hyphaeon_busted` on Smc6 in-process against the
reference's e2e fixtures with the MDS coordinates compared exactly, `hyphaeon_epistasis` on Smc6
against `hyphaeon epistasis` (B = 1,000, seed 42), `hyphaeon_dms` against `fixtures/dms` and the
Smc6 sector-site table, `hyphaeon_analyze` on bat_oas1 (every non-phenotype section, the sites
section equal to `hyphaeon meme`, paging by section, the report resource, streaming while
running, the NJ path), `hyphaeon_evaluate` against the evaluation fixtures, `mountHttp` with and
without `authenticate` over a real HTTP round trip, and, when the reference is installed,
`hyphaeon_phenotype` on bat_oas1 through the bridge and the p/q float32 check against
`hyphaeon.stats`. Model-running tests use `HYPHAEON_MCP_THREADS` (default 4 in the tests).
