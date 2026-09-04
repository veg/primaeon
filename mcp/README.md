# @veg/hyphaeon-mcp

MCP server for [HyphAeon](https://github.com/veg/HyphAeon): site-level episodic selection
(a neural surrogate for HyPhy MEME), a gene-level omnibus test, co-selection networks and
epistatic sectors, digital deep mutational scanning, phenotype association, and concordance
evaluation against real MEME — as tools an MCP client (Claude Code, Claude Desktop, a claude.ai
connector) can call.

## Install

Local, over stdio (private; runs on your own machine):

```
npx @veg/hyphaeon-mcp
claude mcp add hyphaeon -- npx @veg/hyphaeon-mcp
```

Or from a checkout of this repository (`npm install` at the repository root links the runtime
and the library):

```
claude mcp add hyphaeon -- node /path/to/hyphaeon-app/mcp/bin/hyphaeon-mcp.js
```

## Native or bridged

Site selection, the omnibus test and the evaluation run **in the MCP process**: the JavaScript
library `@veg/hyphaeon-js` (the port of `hyphaeon/*.py`) through `@veg/hyphaeon-runtime` over
ONNX Runtime for Node, with the graphs named by `models/manifest.json` and hash-verified before
they score anything. No Python is involved and nothing leaves the machine. The three pillars
whose ports have not landed still shell out to the Python reference CLI (PLAN.md 3.6, "bridge,
then port"), and every result says which in `provenance.surface`.

| Tool | Engine | `provenance.surface` |
|---|---|---|
| `hyphaeon_validate` | library `diagnose()` in-process | — |
| `hyphaeon_meme` | in-process (runtime `runMeme`: LRT, MEME mixture p, BH q, `--filter`, `--attribute`) | `mcp-stdio` / `mcp-http` |
| `hyphaeon_busted` | in-process (runtime `runBusted`: ACAT, Simes, omnibus LRT, the busted head) | `mcp-stdio` / `mcp-http` |
| `hyphaeon_evaluate` | in-process (runtime `runEvaluate` over the library's `evaluation.py` port) | `mcp-stdio` / `mcp-http` |
| `hyphaeon_epistasis` | Python reference CLI (`src/bridge.js`) | `python-reference` |
| `hyphaeon_dms` | Python reference CLI | `python-reference` |
| `hyphaeon_phenotype` | Python reference CLI | `python-reference` |
| `job_status`, `get_results`, `cancel_job`, `list_models` | — | — |

Parity of the native tools with `hyphaeon <cmd>` (measured in `test/engine.test.js` against the
reference's e2e fixtures): site order and `is_invariable` exact; `p_value` / `q_value` the same
float32 values `cmd_meme` writes (checked against `hyphaeon.stats` when the reference is
installed); the busted statistical fields at their classes; evaluate at 1e-9. The LRT clause
(1e-5 relative) is currently blocked upstream by an MDS eigenvector sign convention in the
library — see "Known gaps" — and the test says so instead of passing vacuously.

### The bridged pillars need the Python reference

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
| `HYPHAEON_VARIANT` | Default model variant (`general` or `viral`) for the native tools and the CLI |
| `HYPHAEON_MCP_THREADS` | ONNX Runtime intra-op threads for the native tools (default 1) |
| `HYPHAEON_PY_BIN` | Path to the `hyphaeon` executable for the bridged pillars (default: `hyphaeon` on PATH) |
| `HYPHAEON_WEIGHTS` | Local weights file passed through to the CLI (else Hugging Face / package default) |
| `HF_HUB_OFFLINE` | Set to `1` to forbid Hugging Face downloads (passed through) |
| `HYPHAEON_EXAMPLES_DIR` | Directory of example inputs (default: sibling `HyphAeon/examples`) |
| `HYPHAEON_GALLERY_DIR` | Directory holding the prebaked gallery (default: `web/static/gallery` of the checkout) |
| `HYPHAEON_MCP_LOG` | `debug` / `info` / `warn` / `error` / `silent` (stderr only) |
| `HYPHAEON_MCP_SKIP_BRIDGE` | `1` skips the Python end-to-end tests in `npm test` |

## Tools

| Tool | What it does | Runs the model |
|---|---|---|
| `hyphaeon_validate` | The library's "Before you run" diagnostics (format, alphabet, frame, stops, unknown codons, duplicates, three-tier tree/alignment name matching, branch-length regime, the `> 10` patristic rescale, depth regime, cost) plus this server's caps and run mode. Returns `{ok, warnings:[{code, severity, message, data}], summary}` | no |
| `hyphaeon_meme` | Per-site LRT, MEME mixture p, BH q, invariable flag, the app's rank columns (`zScore`, `percentile`, `call`); `filter`, `attribute`, `model_variant`, `max_species` | yes, in-process |
| `hyphaeon_busted` | ACAT / Simes combination, omnibus LRT, total selection energy, neural BUSTED head (selection probability, gene LRT, omega classes, SRV) | yes, in-process |
| `hyphaeon_epistasis` | Co-selection network (CESI, BH q), sectors with spectral coherence and permutation p, optional per-sector DMS | yes, via Python |
| `hyphaeon_dms` | 19-substitution digital DMS per site with intrinsic plasticity | yes, via Python |
| `hyphaeon_phenotype` | Directional trait association per site, PARS signature, trait sectors, optional permulations | yes, via Python |
| `hyphaeon_evaluate` | Concordance of a `hyphaeon meme` CSV with a HyPhy MEME JSON | no |
| `job_status` | Status of a queued job, with the latest progress phase | — |
| `get_results` | Result of a completed job, with `fields`, `top`, `summary_only` | — |
| `cancel_job` | Cancel a queued or running job | — |
| `list_models` | The manifest read through the runtime (variants, hashes, graph paths), the native engine's status (models directory, onnxruntime-node, branch-length estimator) and the bridge's reachability | — |

Analysis inputs mirror the CLI options one-to-one (`--filter` -> `filter`, `--n-permutations` ->
`n_permutations`, and so on). Over stdio, `alignment`, `tree`, `phenotype_file`, `prediction` and
`meme_result` also accept a `file://` URL (the file's basename becomes the document's label).
Every analysis tool and `get_results` accept `fields` (top-level keys to keep), `top` (keep the N
best records of each ranked collection) and `summary_only` (counts plus a per-pillar summary).

Seams between the CLI and the in-process tools, each recorded in `provenance`:

- `max_species` unset means no taxon cap for `hyphaeon_meme` (the CLI's default) and 512 for
  `hyphaeon_busted`, as in `cli.py`.
- A tree without branch lengths gets HKY85 lengths from HyPhy (the reference's own behaviour)
  through the runtime's HyPhy WebAssembly driver; `provenance.preprocessing.tree_source` is then
  `hyphy-hky85` and `branch_lengths_estimated` true. The reference prunes tree tips that have no
  sequence before the fit; this server does not, so such a tree is refused with HyPhy's message.
- `use_tn93` / `no_tree` (TN93 distances in place of a tree) is not implemented in-process and is
  refused for the native tools with an input-class error; the bridged tools pass it to the CLI.
- `min_patch_consec` is recorded but only its default (3) is applied; a different value adds an
  `OPTION_NOT_APPLIED` warning.
- `cpu` is accepted and recorded; the native engine is CPU-only.
- The busted head's fields (`selection_probability`, `predicted_gene_lrt`,
  `synonymous_rate_variation`, `omega_3`, `proportion_*`) come from one seeded draw of a head the
  reference loads unseeded; `provenance.neural_head.deterministic_upstream` is false. The
  statistical fields are reproducible.
- `hyphaeon epistasis` and `hyphaeon dms` have no `--model-variant`, so those two tools do not
  expose one.

### Synchronous or job

A run answers inside the tool call when the alignment is at most 12,000 codon sites and the work
term `sites x sequences^2` (x19 for dms) is at most 2.5e9, both measured on the file as submitted
(longest sequence, all sequences). Above that, or with `run_async: true`, the tool returns a
`job_id`; poll `job_status` (which shows the runtime's `{phase, done, total, message}` progress),
fetch with `get_results`. Hard caps: 8 MiB of alignment text, 3 to 1,000 sequences, 30,000 codon
sites (3,000 for dms), work 2.5e9, 10,000 permutations, 2,000 permulations, a 10-minute timeout
per run.

### Errors

Every error is `{error, kind, hint?}` with `isError: true`. `kind` is `"input"` (your alignment,
tree or options; the hint says what to change) or `"server"` (the model files, onnxruntime-node,
the Python environment, or the hardware; nothing in your data will change it). This is the split
datamonkey-js-server's `axomeme_scan` uses.

### Provenance

Every result carries a `provenance` block (PLAN.md 3.5). Native results: `surface`
(`mcp-stdio` / `mcp-http`), `engine: "in-process"`, `hyphaeon_js_version`, `reference_version`,
`model_version`, `model_variant`, `artifact_sha256` and `artifact_verified`, `is_surrogate`,
`surrogate_for`, `elapsed_sec`, the `options` as submitted, `preprocessing` (taxa in and used,
duplicates collapsed, PD subsampling, `tree_source`, `branch_lengths_estimated`,
`distance_rescaled`, unknown-codon fraction, in-frame stops), the library's diagnostics as
`warnings`, and `reference_command`, the `hyphaeon <cmd>` line that reproduces the run. Bridged
results keep `surface: "python-reference"`, `reference_version`, `elapsed_sec` and the `command`
that ran (temp paths redacted).

## Resources and prompts

| Resource | Content |
|---|---|
| `hyphaeon://models` | The manifest as the runtime validates it (variants, hashes, graph paths, caps), or the reference's known variants when absent |
| `hyphaeon://methods/requirements` | Per-pillar inputs, options with CLI defaults, result keys, caps, which pillars run in-process, and every validation code |
| `hyphaeon://caveats` | `caveats.json`: model card facts and the `model_eval` calibration, concordance and invariance tables, keyed by `model_version` |
| `hyphaeon://examples/{name}` | Bundled examples (`Smc6.fasta`, `Smc6.nwk`, `bat_oas1.fasta`, ...) |
| `hyphaeon://gallery` | The prebaked gallery index (`web/static/gallery/index.json`, written by `web/scripts/prebake-gallery.mjs` at build) |
| `hyphaeon://gallery/{name}` | The prebaked site-selection record for a bundled example, by id (`bat_oas1`, `Smc6`, ...), when present |

Prompts: `choose-analysis`, and one interpretation guide per pillar — `interpret-meme`,
`interpret-busted`, `interpret-epistasis`, `interpret-dms`, `interpret-phenotype`,
`interpret-evaluate`.

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

- **LRT parity vs `hyphaeon meme` is blocked by an MDS sign convention in the library.**
  `computeMdsCoordinates` (js/src/preprocess/mds.js at phase-1a) returns eigenvector columns
  with no sign convention; numpy's `eigh` has one, and the graph is not sign-invariant in `z`.
  On bat_oas1 columns 1 and 2 come out flipped, giving max |delta LRT| 0.119 (8.4 % relative);
  with the signs matched, or numpy's `z` substituted, the same graph agrees with the fixture at
  4.8e-6. `test/engine.test.js` detects the flip against `test/data/python_mds.json` and skips
  the 1e-5 clause with that message; it becomes strict when the library pins the convention.
- The reference prunes tree tips without a sequence before HyPhy fits branch lengths; the
  library has no Newick writer, so this server refuses such a tree instead.
- TN93 tree-free mode is not available in-process.
- `mountHttp` has no OAuth yet (Phase 2).

## Programmatic use

```js
import { createServer } from "@veg/hyphaeon-mcp";          // McpServer + job store + engine
import { mountHttp } from "@veg/hyphaeon-mcp/http";        // streamable HTTP on an Express app
import { createEngine } from "@veg/hyphaeon-mcp/engine";   // the in-process engine on its own

const app = express();
app.use(express.json());
mountHttp(app, { path: "/mcp" });   // one shared engine for every session; no auth yet (Phase 2)
```

## Development

```
npm install                              # at the repository root
cd mcp
HYPHAEON_PY_BIN=/path/to/venv/bin/hyphaeon HYPHAEON_WEIGHTS=/path/to/model.safetensors HF_HUB_OFFLINE=1 npm test
HYPHAEON_MCP_SKIP_BRIDGE=1 npm test      # without Python
```

The tests use the SDK's `InMemoryTransport`: the tool registry, validation on the bundled
examples through the library's `diagnose` (camelid's `BRANCH_LENGTHS_MISSING`, bat_oas1's
`DISTANCE_RESCALED`), job paging with a stubbed engine and a stubbed bridge, the resources
including the gallery, `hyphaeon_meme` on bat_oas1 and `hyphaeon_busted` on Smc6 in-process
against the reference's e2e fixtures, `hyphaeon_evaluate` against the evaluation fixtures, and,
when the reference is installed, `hyphaeon_epistasis` on bat_oas1 through the bridge and the
p/q float32 check against `hyphaeon.stats`.
