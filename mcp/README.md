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

Or from a checkout of this repository:

```
cd hyphaeon-app/mcp && npm install
claude mcp add hyphaeon -- node /path/to/hyphaeon-app/mcp/bin/hyphaeon-mcp.js
```

### Phase 0 prerequisite: the Python reference

Until the JavaScript port of each pillar lands in `@veg/hyphaeon-js`, every analysis tool runs
through the Python reference CLI. Install it and make sure `hyphaeon` is on `PATH` (or set
`HYPHAEON_PY_BIN`):

```
pip install hyphaeon            # or: pip install -e /path/to/HyphAeon
export HYPHAEON_WEIGHTS=/path/to/model.safetensors   # optional; otherwise Hugging Face
```

`hyphaeon_validate`, `list_models`, the resources and the prompts work without Python.

## Environment

| Variable | Meaning |
|---|---|
| `HYPHAEON_PY_BIN` | Path to the `hyphaeon` executable (default: `hyphaeon` on PATH) |
| `HYPHAEON_WEIGHTS` | Local weights file passed through to the CLI (else Hugging Face / package default) |
| `HYPHAEON_VARIANT` | Default model variant for the CLI (`general` or `viral`) |
| `HF_HUB_OFFLINE` | Set to `1` to forbid Hugging Face downloads (passed through) |
| `HYPHAEON_MODELS_DIR` | Directory holding `manifest.json` (default: sibling `HyphAeon/models`, then `@veg/hyphaeon-js/models`) |
| `HYPHAEON_EXAMPLES_DIR` | Directory of example inputs (default: sibling `HyphAeon/examples`) |
| `HYPHAEON_MCP_LOG` | `debug` / `info` / `warn` / `error` / `silent` (stderr only) |
| `HYPHAEON_MCP_SKIP_BRIDGE` | `1` skips the Python end-to-end test in `npm test` |

## Tools

| Tool | What it does | Runs the model |
|---|---|---|
| `hyphaeon_validate` | Format sniff (FASTA/NEXUS/PHYLIP), counts, frame, stops, unknown codons, unequal lengths, duplicates, exact tree/alignment name matching, branch-length and depth regime, cost estimate. Returns `{ok, warnings:[{code, severity, message}], summary}` | no |
| `hyphaeon_meme` | Per-site LRT, MEME mixture p, BH q, invariable flag; `filter`, `attribute`, `model_variant`, `max_species`, `use_tn93` | yes |
| `hyphaeon_busted` | ACAT / Simes combination, omnibus LRT, neural BUSTED head (selection probability, gene LRT, omega classes, SRV) | yes |
| `hyphaeon_epistasis` | Co-selection network (CESI, BH q), sectors with spectral coherence and permutation p, optional per-sector DMS | yes |
| `hyphaeon_dms` | 19-substitution digital DMS per site with intrinsic plasticity | yes |
| `hyphaeon_phenotype` | Directional trait association per site, PARS signature, trait sectors, optional permulations | yes |
| `hyphaeon_evaluate` | Concordance of a `hyphaeon meme` CSV with a HyPhy MEME JSON | no |
| `job_status` | Status of a queued job | — |
| `get_results` | Result of a completed job, with `fields`, `top`, `summary_only` | — |
| `cancel_job` | Cancel a queued or running job | — |
| `list_models` | The weights manifest (or the reference's known variants) and whether the bridge is reachable | — |

Analysis inputs mirror the CLI options one-to-one (`--filter` -> `filter`, `--n-permutations` ->
`n_permutations`, and so on). Over stdio, `alignment`, `tree`, `phenotype_file`, `prediction` and
`meme_result` also accept a `file://` URL. Every analysis tool and `get_results` accept `fields`
(top-level keys to keep), `top` (keep the N best records of each ranked collection) and
`summary_only` (counts plus a per-pillar summary). Note that `hyphaeon epistasis` and `hyphaeon
dms` have no `--model-variant`, so those two tools do not expose one.

### Synchronous or job

A run answers inside the tool call when the alignment is at most 12,000 codon sites and the work
term `sites x sequences^2` (x19 for dms) is at most 2.5e9, both measured on the file as submitted
(longest sequence, all sequences). Above that, or with `run_async: true`, the tool returns a
`job_id`; poll `job_status`, fetch with `get_results`. Hard caps: 8 MiB of alignment text, 3 to
1,000 sequences, 30,000 codon sites (3,000 for dms), work 2.5e9, 10,000 permutations, 2,000
permulations, a 10-minute timeout per run.

### Errors

Every error is `{error, kind, hint?}` with `isError: true`. `kind` is `"input"` (your alignment,
tree or options; the hint says what to change) or `"server"` (the Python environment, the weights,
or the hardware; nothing in your data will change it). This is the split datamonkey-js-server's
`axomeme_scan` uses.

### Provenance

Every result carries a `provenance` block. While the Python bridge is in place its `surface` is
`"python-reference"`, with `reference_version`, `elapsed_sec`, the `command` that ran (temp paths
redacted), `model_variant`, `is_surrogate: true` and `surrogate_for: "MEME"`.

## Resources and prompts

| Resource | Content |
|---|---|
| `hyphaeon://models` | Manifest (variants, hashes, caps) or the reference's known variants when `models/manifest.json` is absent |
| `hyphaeon://methods/requirements` | Per-pillar inputs, options with CLI defaults, result keys, caps, and every validation code |
| `hyphaeon://caveats` | `caveats.json`: model card facts and the `model_eval` calibration, concordance and invariance tables, keyed by `model_version` |
| `hyphaeon://examples/{name}` | Bundled examples (`Smc6.fasta`, `Smc6.nwk`, `bat_oas1.fasta`, ...) |

Prompts: `choose-analysis`, and one interpretation guide per pillar — `interpret-meme`,
`interpret-busted`, `interpret-epistasis`, `interpret-dms`, `interpret-phenotype`,
`interpret-evaluate`.

## Validation codes

`FORMAT_UNRECOGNISED`, `FORMAT_DETECTED`, `EMBEDDED_TREE`, `RNA_U_TO_T`, `NON_ACGT_FRACTION`,
`LENGTH_NOT_MULTIPLE_OF_3`, `IN_FRAME_STOPS`, `FRAMESHIFT_SUSPECTED`, `UNKNOWN_CODON_FRACTION`,
`UNEQUAL_LENGTHS`, `IDENTICAL_SEQUENCES`, `TOO_FEW_TAXA`, `TOO_MANY_TAXA`, `TAXA_ABOVE_CAP`,
`TREE_MISSING`, `TREE_UNPARSEABLE`, `TREE_TIPS_UNMATCHED`, `ALIGNMENT_TAXA_MISSING_FROM_TREE`,
`BRANCH_LENGTHS_ABSENT`, `NEGATIVE_BRANCH_LENGTHS`, `SATURATED_BRANCH_LENGTH`,
`MAX_PATRISTIC_ABOVE_10`, `DEEP_LARGE_TREE`, `SHALLOW_TREE`, `STAR_LIKE_TREE`, `COST_ESTIMATE`.
Severity is `info`, `warn` or `refuse`; `ok` is false when anything refuses. The same codes are
the contract for the web app's diagnostics panel and the Node server's `/validate`.

## Bridge, then port

This package is one of the three surfaces (browser, MCP, Node server) that will run
`@veg/hyphaeon-js`, the JavaScript library that mirrors `hyphaeon/*.py` function for function.
Until a pillar's port has landed with per-function fixtures and parity, its tool shells out to the
Python CLI (`src/bridge.js`) with the same schema and the same result shape it will have after
the port, and says so in `provenance.surface`. When the port lands, that pillar's bridge branch is
deleted and the tool switches to `runtime/` (ONNX Runtime under Node); nothing changes for the
client. Order of removal (PLAN.md 8): meme with filter and attribution, the busted combination
tests and evaluate (Phase 1); epistasis and dms once the attention export lands (Phase 2);
phenotype, permulations and the busted neural head (Phase 3), after which no Python runs anywhere.

## Programmatic use

```js
import { createServer } from "@veg/hyphaeon-mcp";          // McpServer + job store
import { mountHttp } from "@veg/hyphaeon-mcp/http";        // streamable HTTP on an Express app

const app = express();
app.use(express.json());
mountHttp(app, { path: "/mcp" });   // no auth yet: Phase 2 adds the OAuth ceremony
```

## Development

```
npm install
HYPHAEON_PY_BIN=/path/to/venv/bin/hyphaeon HYPHAEON_WEIGHTS=/path/to/model.safetensors HF_HUB_OFFLINE=1 npm test
HYPHAEON_MCP_SKIP_BRIDGE=1 npm test     # without Python
```

The tests use the SDK's `InMemoryTransport`: tool listing, validation on the bundled examples,
argv mapping and error classification without Python, job paging with a stubbed bridge, the
resources, and one end-to-end `hyphaeon_meme` on `bat_oas1` through the Python reference.
