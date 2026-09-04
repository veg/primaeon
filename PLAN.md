# HyphAeon web application — plan

**Status:** draft v5, 2026-09-04, against `veg/HyphAeon@3cb9cc6` (v1.0.0), the Overleaf manuscript,
`datamonkey3/HYPHAEON-HANDOFF.md` (`main@fac1330`), and `veg/axomeme3` (live at
https://data.hyphy.org/web/axomeme3).
**Reference checkouts:** `../HyphAeon`, `../hyphaeon-manuscript`, `../axomeme3`, `../axomeme`,
`../datamonkey3`, `../datamonkey-js-server`, `../hyphy-scope`.
**Changes from v4:** the JavaScript port in `veg/HyphAeon` is **a library and nothing else**: functions
that mirror `hyphaeon/*.py` (preprocessing and the analysis methods), with no runtime concerns. The
MCP server, the ONNX runtime glue, the Node server, and the web app all live in `veg/hyphaeon-app`.
**Changes from v3:** the JavaScript port lives in `veg/HyphAeon` beside the Python it mirrors (one
repository, one CI, one release tag published to both pip and npm). §5.5 gives the layout and reasons.
**Changes from v2:** the Python analysis code is ported to JavaScript (internal decision). The JS
package is the product implementation on every surface (browser, Node MCP, Node server); the Python
package is the reference implementation used for parity, fixtures, training, and the ONNX export.
§5 is the port inventory. MCP stays required and runs on the same package.

---

## 0. Recommendation in one paragraph

Build **a browser-first application in the lineage of axomeme3 and DataMonkey's in-browser
AxoMEME**, on top of **one JavaScript package that ports every HyphAeon analysis** (site selection
with filtering and attribution, the omnibus test, epistasis and sectors, digital DMS, phenotype
association, evaluation, diagnostics) and runs the network through ONNX Runtime. The same package
runs in browser workers, in a **Node MCP server** (stdio for local use, streamable HTTP with the
Datamonkey OAuth ceremony for a claude.ai connector), and in a small **Node worker** for oversize jobs.
The Python package is the **reference implementation**: it generates per-function golden fixtures,
it is one side of the parity harness in CI, it trains the model, and it exports the ONNX graphs.
**The port is a library in the HyphAeon repository, beside the Python it mirrors, and contains only
functions that mirror `hyphaeon/*.py`**, so a method change, its port, its fixtures, and the parity
check land in one pull request and ship under one tag to pip and npm. **Everything that runs lives in
the app repository**: the web app, the ONNX runtime glue, the Node server, and the MCP server, all
consuming the library. Until a pillar's port lands,
the Node MCP bridges to the Python CLI so every pillar is reachable from day one; the bridge is
removed pillar by pillar. One weights manifest and one parity harness keep browser, MCP, and reference
equal. Sequences stay on the user's machine by default.

---

## 1. What HyphAeon is today (the surface the app must expose)

HyphAeon is a ~1.9M-parameter axial transformer that takes a codon alignment plus a metric tree as
four tensors (codon tokens, amino-acid tokens, patristic distance matrix, 4-D MDS coordinates) and
emits a per-site MEME-style LRT through a 16-threshold ordinal head. The bundled repo weights are the
full multi-task suite (backbone + `head_meme` + `head_busted` + `head_absrel`, 2,455,128 parameters);
the HuggingFace base file is backbone + `head_meme` only. Every pillar except `evaluate` runs the
network; epistasis and phenotype also read the root-to-leaf attention (`mean_root_attns`); busted
reads the pooled hidden state (`root_repr`) through its own head.

| Command | What it does | Model outputs needed | Browser today | Browser after the port + export |
|---|---|---|---|---|
| `meme` (`predict`, `site-selection`) | Per-site LRT, p (MEME mixture null), BH q, invariable flag; `--filter` masks alignment artifacts and re-scores; `--attribute` gives per-taxon counterfactual ΔLRT, epoch, driver taxon | `lrt` | Yes for the core: HF's `model.viral.onnx` is byte-identical to DM3's pinned artifact (sha256 `de765904…`); DM3's 2,013-line preprocessing port is reusable as is | Filter and attribution ported (§5) |
| `busted` (`omnibus`) | Cauchy/Simes combination of site p-values, neural gene LRT, selection probability, ω-class summary, SRV | `lrt` + `root_repr` → `head_busted` | Combination tests only | Full, with `busted_head.onnx` |
| `epistasis` (`coselection`) | Attribution vectors → cosine network, t-test p, BH q, CESI; sectors via modularity and spectral coherence; Monte Carlo null; optional DMS per node | `lrt` + `mean_root_attns` | No | Yes (§5, needs the attention export) |
| `dms` (`essm`) | 19 substitutions × L sites, ΔLRT per mutant, intrinsic plasticity | `lrt` (19·L passes) | Small genes, in principle | Yes, capped by work 19·L·N² |
| `phenotype` (`phylowas`) | Directional trait association per site, permutation p, BH q, PARS, trait sectors, gene-level Brownian-motion permulations | `lrt` + `mean_root_attns` | No | Yes (§5, needs the attention export) |
| `evaluate` | Concordance of a `meme` CSV against HyPhy MEME JSON | none | Yes | Yes |

Out of scope for v1: `disease` (pulled from the manuscript), `list-models` as a UI, the aBSREL head
(no CLI, no paper results), training (`train.py`, `training_data.py`).

### Measured cost on a laptop CPU, Python reference path

Apple M4 Pro, torch 2.10, fp32, bundled suite weights; ~1.5 s of start-up included per invocation.

| Analysis | Dataset | Taxa × codons | Wall (s) | Peak RSS |
|---|---|---|---|---|
| meme | Smc6 | 20 × 1,097 | 3.5 (model 0.21) | 0.5 GB |
| meme | bat_oas1 | 18 × 351 | 1.7 | 0.5 GB |
| meme | camelid | 212 × 96 | 4.0 | 1.5 GB |
| meme | HIV1_RT | 476 × 335 | 17.3 | 1.5 GB |
| meme `--attribute` | Smc6 | 20 × 1,097 | 1.8 | 0.5 GB |
| busted | Smc6 | 20 × 1,097 | 1.7 | 0.5 GB |
| epistasis, 10k perms | Smc6 | 20 × 1,097 | 2.0 | 0.5 GB |
| epistasis, 1k perms | HIV1_RT | 475 × 335 | 21.5 | — |
| dms | Smc6 | 20 × 1,097 | 4.4 | 0.5 GB |
| dms | HIV1_RT | 475 × 335 | 46.4 | — |
| phenotype, no permulations | RHO | 710 × 349 | 4.8 | 2.7 GB |

Cost scales as L × N². The browser path is slower per forward pass (single-threaded WASM unless the
site sets COOP/COEP, §4.4) but has no upload, no queue, and no start-up beyond the first model fetch.
The Node worker exists for MCP over HTTP and for jobs past the browser caps, not because the browser
is slow.

---

## 2. Hard truths that shape the product

1. **It is a MEME surrogate, evaluated against MEME, not against truth.** Every result carries
   `is_surrogate` / `surrogate_for` as data and a one-click path to run real MEME on Datamonkey.
2. **Rank is strong, scale is compressed.** HIV-1 RT: ρ = 0.53 vs MEME, regression slope 0.16.
   Literature aggregate ROC-AUC 0.914, PPV 50.6%, Spearman 0.49. Sort by LRT, show rank and
   percentile, show p and BH q but never alone.
3. **Calibration depends on regime.** FPR ≈ 5–7% for 20–50 taxa on neutral simulations, 36% at 100
   taxa on deep trees. The diagnostics panel classifies the regime before the run.
4. **Nearly invariant to the tree, sensitive to the wrong things** (issue #13): branch-length units,
   reading frame, U-vs-T, missing taxa zeroed silently (#9), max patristic > 10 rescaled silently
   (#8), 2-taxon bug (#7). One implementation of the checks, run before the model on every surface.
5. **Shallow single-ancestor panels return nothing, silently** (issue #33). Alignment-level regime
   warning required.
6. **Base vs viral variant matters.** ρ ≈ 0.10 vs ≈ 0.43 on unseen viral families. A visible choice
   with an automatic suggestion from tree depth.
7. **Invariable sites are "not scored", not zero.** Keep DM3's and axomeme3's rendering rule.
8. **Real submissions are unpublished research.** The browser path never transmits sequences. Any
   server path says so before sending, keeps nothing in logs, and expires jobs.
9. **The package is CLI-first**: no library entry points for `meme`/`busted`, stdout progress, stale
   example outputs, duplicated JSON keys. §7 lists the upstream PRs.
10. **A port is a second implementation.** The handoff's §1.4 lists ten ways a well-formed tensor can
    mean the wrong thing, none of which throws. The port discipline in §5.3 exists because of that
    list: port from the reference source with the citation next to the constant, generate fixtures
    from Python per function, and never "improve" during the port.

---

## 3. Architecture: one package, three surfaces, one reference

### 3.1 Options considered

| Option | Verdict | Why |
|---|---|---|
| **A. Full JS port; browser, Node MCP and Node worker on one package; Python as reference** | **Adopt** | One product implementation, privacy by default, no Python at runtime, MCP on the same code the browser runs. The cost is the port (§5, ≈10 developer-weeks) and a permanent parity harness. |
| **B. Browser for `meme`, Python service for the rest, Python MCP** (v2) | Superseded | Two product implementations and two languages at runtime; the internal decision is to port. |
| **C. Pyodide running the Python package in the browser** | Reject | Single implementation, but a 15 MB+ payload, no torch (so the model still goes through ORT with a shim), slow start, and awkward workers. Kept only as a fallback idea if a specific port proves intractable. |
| **D. datamonkey-js-server (Socket.IO + SLURM)** for oversize jobs | Reject for v1 | Scheduling latency exceeds the runtimes. Its MCP module, however, is the pattern for ours and the place to mount our tools in phase 4. |

### 3.2 Components

```
 veg/HyphAeon  —  the methods (one repo, one CI, one tag → pip + npm)
 ┌──────────────────────────────────────────────────────────────────────────┐
 │ hyphaeon/  (Python)  —  REFERENCE                                        │
 │ training · export-onnx · scripts/gen_fixtures.py · one side of parity    │
 └───────────────┬──────────────────────────────────────────────────────────┘
                 │ fixtures/ + models/ (ONNX + manifest.json), same commit
 ┌───────────────▼──────────────────────────────────────────────────────────┐
 │ js/  (@veg/hyphaeon-js)  —  A LIBRARY, nothing else                      │
 │ pure functions that mirror hyphaeon/*.py: parse/tokenize/tree/MDS/tensor │
 │ assembly · stats · filter · attribution · omnibus · epistasis · sectors  │
 │ dms · phenotype · permulations · evaluate · diagnostics · numeric kernel │
 │ no onnxruntime, no I/O, no workers, no server, no MCP                    │
 └───────────────┬──────────────────────────────────────────────────────────┘
                 │ npm, pinned tag
 veg/hyphaeon-app  —  everything that runs
 ┌───────────────▼──────────────────────────────────────────────────────────┐
 │ runtime/  (private workspace package)                                    │
 │ ORT sessions (web / node) · manifest + sha256 verification · pipeline    │
 │ orchestration (prep → MDS → infer → postprocess) over the library        │
 └──────┬──────────────────┬───────────────────────────┬────────────────────┘
 ┌──────▼───────────┐ ┌────▼─────────────────────┐ ┌───▼──────────────────┐
 │ web/             │ │ mcp/  (@veg/hyphaeon-mcp) │ │ server/  (Node)      │
 │ SvelteKit static │ │ tools · prompts ·         │ │ jobs · SSE · caps ·  │
 │ workers · HyPhy  │ │ resources · stdio bin ·   │ │ mounts /mcp (http)   │
 │ WASM · tn93      │ │ http mount (OAuth) ·      │ │ same origin as web/  │
 └──────────────────┘ │ bridge → python CLI until │ └──────────────────────┘
                      │ ported                    │
                      └───────────────────────────┘
                 │ phase 4: mcp/ also mounted in datamonkey-js-server,
                 │ replacing axomeme_scan; DM3 Predict switches to the library
```

- **Two repositories, split by what they are.** `veg/HyphAeon` holds the methods: the Python
  reference and its JavaScript mirror (`js/`, a library of pure functions), the fixtures, the
  exported models, and the parity CI. A change to a method and its port are one pull request,
  reviewed side by side, released under one tag to pip and npm. `veg/hyphaeon-app` holds everything
  that runs: `web/`, `runtime/`, `mcp/`, `server/`, `deploy/`, `e2e/`, consuming `@veg/hyphaeon-js`
  from npm at a pinned version. §5.5 has the layout and the versioning rule.
- **Hosting:** one host, same origin, `/` static and `/api/` + `/mcp` reverse-proxied to the Node
  server. Silverback already hosts axomeme3, datamonkey-metrics and dm-viz-2026 by rsync; the Node
  server runs under pm2 or Compose beside them. Domain is decision D1.
- **No GPU, no Python at runtime.** `onnxruntime-node` on CPU covers the measured envelope.

### 3.3 One manifest, one parity harness

A single `models/manifest.json` in `veg/HyphAeon`, packaged into both the pip and npm artifacts
from the same commit and copied into the web static directory at build:

```json
{
  "model_version": "v1",
  "variants": {
    "general": { "safetensors_sha256": "…", "onnx_sha256": "…", "busted_head_onnx_sha256": "…",
                 "trained_on": "TOGA mammalian, 742 species", "regime": "deep / cross-species" },
    "viral":   { "safetensors_sha256": "…", "onnx_sha256": "c3ea5795… (three-output export; DM3's single-output graph is de765904…)",
                 "trained_on": "base + ~9,300 Datamonkey viral", "regime": "viral / shallow" }
  },
  "taxon_cap": 512, "default_taxon_cap": 256, "dropped_heads_policy": "omit",
  "onnx": { "opset": 17, "inputs": ["msa_codons","msa_aas","dist_matrix","mds_coords"],
            "outputs": ["lrt","mean_root_attns","root_repr"] },
  "prng": { "algorithm": "xoshiro256**", "default_seed": 42 }
}
```

Every surface verifies the hash of what it loads and refuses to score on a mismatch. Every result
records `model_version`, variant, artifact hash, surface, and PRNG seed. CI runs the five bundled
examples through the JS package under Node, the JS package in headless Chromium, the MCP tool, and
the Python reference, and compares per §5.4's parity classes. This is the handoff's coupling hazard
solved by construction.

### 3.4 The ONNX export the port needs (upstream PR 1)

Same four inputs as `v1-viral`, so DM3's contract, `validateInputBundle`, and the handoff's trap list
hold unchanged. Three outputs instead of one:

| Output | Shape | Unlocks |
|---|---|---|
| `lrt` | `[batch]` | `meme`, `--filter`, `--attribute`, `dms`, site p-values for the omnibus |
| `mean_root_attns` | `[batch, num_species]` | `epistasis` attribution vectors (`mean_attns × delta`), `phenotype` fg/bg attention |
| `root_repr` | `[batch, embed_dim]` | `busted` neural head, exported as a second graph `busted_head.onnx` (`[1, L, 384]` + mask → `cls_prob`, gene LRT, ω proportions, `syn_var`) |

Both variants exported; the busted head is only validated with the suite backbone. Issue #16 reopened
with the scope it asked for.

### 3.5 Node server API (v1, optional surface)

The web app runs everything locally by default. The Node server exists for MCP over HTTP and for jobs
past the browser caps; it is the same package under `onnxruntime-node`.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/v1/validate` | Sync diagnostics from the package (identical codes to the browser). |
| `POST` | `/api/v1/jobs` | `{analysis, alignment, tree?, variant, options{}, seed?}` → `202 {id}`. |
| `GET` | `/api/v1/jobs/{id}` · `/events` | Status, progress `{phase, done, total, message}`, warnings, expiry; SSE. |
| `GET` | `/api/v1/jobs/{id}/result` | JSON with provenance; `?format=csv|graphml`; `?fields=` / `?top=`. |
| `DELETE` | `/api/v1/jobs/{id}` | Early deletion; default is TTL. |
| `GET` | `/api/v1/models`, `/health`, `/version` | Manifest; liveness; package versions. |

Caps (from the measurements and `axomeme_scan`): alignment ≤ 8 MiB; 3 ≤ taxa ≤ 1,000 raw with
haplotype collapse then Faith's-PD to 512; codons ≤ 30,000 (`meme`/`busted`), ≤ 3,000 (`dms`); work
`L × N_used²` ≤ 2.5 × 10⁹; permutations ≤ 10,000; permulations ≤ 2,000; job timeout 10 min; TTL 7
days; no accounts; 128-bit job ids; per-IP rate limit; CSP `default-src 'self'`.

**Provenance block** in every result, from every surface:

```json
"provenance": {
  "schema_version": 1, "surface": "browser | node-server | mcp-stdio | mcp-http | python-reference",
  "hyphaeon_js_version": "0.1.0", "reference_version": "1.0.0", "model_version": "v1",
  "model_variant": "general", "artifact_sha256": "…", "is_surrogate": true, "surrogate_for": "MEME",
  "seed": 42, "elapsed_sec": 2.1, "options": { "…": "as submitted" },
  "preprocessing": {
    "taxa_in_alignment": 24, "taxa_used": 20, "dropped_taxa": ["…"], "duplicates_collapsed": 3,
    "pd_subsampled": false, "reference_sequence": "hg38",
    "tree_source": "user | embedded | hyphy-hky85 | nj | tn93", "branch_lengths_estimated": false,
    "distance_rescaled": false, "codons_trimmed": 0, "unknown_codon_fraction": 0.004, "in_frame_stops": 0
  },
  "warnings": [ { "code": "DEEP_LARGE_TREE", "severity": "warn", "message": "…" } ]
}
```

### 3.6 MCP (required deliverable, Node)

Modelled on `datamonkey-js-server/lib/mcp/` (tools, prompts, resources; StreamableHTTP with an
auto-approving OAuth ceremony; stdio entry for Claude Code; best-effort completion notifications with
polling as the source of truth). Implemented once in Node as `mcp/` in `veg/hyphaeon-app`, published
as `@veg/hyphaeon-mcp`, on top of `runtime/` and the library, using `@modelcontextprotocol/sdk` as
Datamonkey does. It lives in the app repository because it is a runtime, like the web app and the
server; the library repository holds only mirrored methods.

**Transports.**
- **stdio, local:** `npx @veg/hyphaeon-mcp` (or the `hyphaeon-mcp` bin); `claude mcp add hyphaeon -- npx @veg/hyphaeon-mcp`.
  Runs on the user's machine with `onnxruntime-node` and the vendored ONNX: private, offline, the
  analysis-engine analogue of the browser. Accepts `file://` paths as well as inline text.
- **streamable HTTP, remote:** `https://<host>/mcp` mounted in `server/`, OAuth 2.1 with dynamic
  client registration, PKCE, and the out-of-band redirect for headless clients, auto-approved exactly
  as Datamonkey's is, so it can be added as a claude.ai connector the same way the Datamonkey
  connector was.

**Bridge, then port.** For any pillar whose JS port has not landed, the tool shells to the Python CLI
(`hyphaeon <cmd>`) the way datamonkey-js-server shells to hivtrace, with the same tool schema and the
same result shape, and marks `provenance.surface = "python-reference"`. Once the port lands the bridge
is deleted for that pillar. All pillars are reachable through MCP from phase 1.

**Tools.** `hyphaeon_validate`, `hyphaeon_meme` (answers inside the call under `axomeme_scan`'s caps,
12,000 codons and work 2.5 × 10⁹; otherwise returns a job id), `hyphaeon_busted`,
`hyphaeon_epistasis`, `hyphaeon_dms`, `hyphaeon_phenotype`, `hyphaeon_evaluate`, `job_status`,
`get_results` (with `fields`, `top`, `summary_only`), `cancel_job`, `list_models`. Inputs mirror the
CLI options one-to-one; the error taxonomy keeps `axomeme_scan`'s split between "the model is broken
on the server" and "your alignment has a problem".

**Resources.** `hyphaeon://models`, `hyphaeon://methods/requirements`, `hyphaeon://caveats`,
`hyphaeon://examples/{name}`. **Prompts.** One interpretation guide per pillar, written from §2.

**Integration.** Phase 4 mounts the same tool module inside datamonkey-js-server's MCP (it already
carries the OAuth, redis notifier, and `onnxruntime-node`), replacing `axomeme_scan`; the web app's
results page shows the `claude mcp add` line and a "reproduce this with MCP" snippet; `/mcp` is a
documented route.

---

## 4. Front end

**Stack:** SvelteKit 2 + Svelte 5 runes + TypeScript, `adapter-static` with a parameterised
`paths.base`, scoped CSS carrying DM3's tokens as CSS variables (DM Serif Display / Source Sans 3 /
JetBrains Mono, which axomeme3 also uses), Observable Plot for statistical charts, canvas for the
Manhattan plot, d3-force for the network, phylotree.js for trees, Web Workers for preprocessing and
inference, Playwright e2e, vitest for the package. No Tailwind, no CDNs.

### 4.1 Routes

| Route | Content |
|---|---|
| `/` | What HyphAeon is in three sentences, the surrogate caveat, "your sequences stay in this browser", demo buttons, links to paper, package, MCP. |
| `/analyze` | Upload → diagnostics → analysis picker → options → run. Everything runs here; a "run on the server" option appears only when an input exceeds the browser caps, and says what will be sent. |
| `/results/[local-id]`, `/jobs/[id]` | Same results component. Local runs persist in IndexedDB under the user's control; server jobs by URL. |
| `/gallery` | Six bundled examples with prebaked results. |
| `/methods` | One page per pillar; caveats generated from `caveats.json`. |
| `/evaluate` | `meme` CSV + HyPhy MEME JSON → metrics + scatter. |
| `/mcp` | Install lines for stdio and the remote connector, tool list, example transcript. |

### 4.2 The client-side pipeline

The axomeme3 step list, made into workers and the shared package, with the handoff's traps closed:

| Step | Implementation | Source |
|---|---|---|
| Decompress and parse | pako for `.gz`; FASTA / NEXUS / PHYLIP; HyPhy WASM auto-conversion fallback with `NORMALIZE_SEQUENCE_NAMES=0` | axomeme3 + DM3 `fastaValidation.js` |
| Reference sequence | Dropdown; coordinates in reference space, gaps skipped; `hg`/`hg38`/`human` heuristic then first sequence | axomeme3, DM3 `chooseReference` |
| Tree | Upload or embedded; three-tier name matching; **no branch lengths → HyPhy WASM HKY85**; **no tree → NJ via HyPhy WASM or TN93 distances**; axomeme3's silent star-tree fallback is dropped | axomeme3 HBL, DM3 `NJ.bf`, tn93 WASM |
| Taxon cap | Faith's-PD greedy selection keeping the reference; default 256, hard max 512 | axomeme3, DM3 `patristic.js` |
| Patristic + MDS | In a Web Worker | DM3 `patristic.js`, `symmetricEigen.js`, `mds.js` |
| Inference | ORT in a Worker; `onnxruntime-web/wasm` entry, self-hosted WASM, lazy-loaded, hash verified; batched across sites | DM3 `session.js`, `assemble.js` |
| Post-process | Variability, z, percentile, tiers, p and BH q via the MEME mixture, entropy, Fitch parsimony on demand | DM3 `postprocess.js` + axomeme3 |
| Pillars | Filter, attribution, omnibus, epistasis, sectors, DMS, phenotype, evaluate from the ported package (§5), each in a worker with progress callbacks | `@veg/hyphaeon-js` |

Progress is a step checklist like axomeme3's, each step marked with its measured time.

### 4.3 The "Before you run" panel

One implementation of the checks in the package, run in the browser instantly and by the server's
`/validate`; both produce the same `warnings[]` codes.

| Check | Outcome |
|---|---|
| Format sniff, embedded tree, U→T, non-ACGT fraction | info / warn |
| Length % 3, in-frame stops, frameshift heuristic | warn; refuse if pervasive |
| Unknown-codon fraction > 5% | warn |
| Unequal lengths | warn (padded as gaps) |
| Identical sequences | info: N collapsed |
| Taxa < 3 | refuse (#7) |
| Taxa > cap | info: PD subsampling; > 1,000 refuse |
| Tree ↔ alignment names | list unmatched both ways; refuse if any alignment taxon lacks a tip (#9) |
| Branch lengths absent | HKY85 in HyPhy WASM, or TN93 (D5/D6) |
| Negative / saturated lengths | warn with magnitude |
| Max patristic > 10 | warn: chronogram or mutation counts; rescaled (#8) |
| Depth regime, unique haplotypes | shallow → suggest `viral`; deep + ≥ 100 taxa → FPR warning; star-like → outside regime (#33) |
| MEME hit-likelihood prescreen (XGBoost) | advisory band, never blocks |
| Cost estimate | seconds here; whether the input exceeds browser caps |

### 4.4 Delivery discipline, plus one upgrade

- Import `onnxruntime-web/wasm`, never the default entry; vendor the WASM at build time; never fetch
  from a CDN; dynamic-import ORT inside `loadSession()`; memoise only the verified session.
- **Set COOP/COEP headers on the new origin** so SharedArrayBuffer and multi-threaded ORT work; DM3
  could not. The e2e asserts the headers and that threads engage.
- Lazy per step: ONNX (7.8 MB per variant), ORT WASM (12.9 MB), HyPhy WASM + data, tn93 WASM fetched
  on first use and cached with the Cache API; the landing page requests none of them.

### 4.5 Results, per pillar

- **meme** — Manhattan canvas with tier colouring and codon/AA entropy overlays (axomeme3),
  ranked-sites plot (DM3), site table with reference state, AA-composition spark bars, variable flag,
  log LRT, LRT, local z, local percentile, p, q, call; "not scored" for invariable; calls toggle
  between "q ≤ 0.10" and "Top 5% of variable sites"; site-specific tree with Fitch parsimony
  substitutions; masks and attribution when requested; CSV, JSON, estimated-tree downloads.
- **busted** — Gene card with `p_ACAT`, `p_Simes`, selection probability, ω-class bars, SRV.
- **epistasis** — Force network (node size LRT, edge width CESI, colour by sector), pair table,
  sector panel with coherence, `p_perm`, null bands and the paper's reference ranges; GraphML.
- **dms** — 20 × L ΔLRT heatmap, plasticity track, per-site detail; CSV.
- **phenotype** — Trait UI (presets, pick tips on the tree, paste, CSV, continuous), association
  impulse plot with q ≤ α highlighted, PARS, trait sectors, gene-level card.
- **evaluate** — Metrics at 0.05 and 0.10, confusion matrices, LRT scatter.
- **Every page** — provenance panel with surface and seed, warnings, surrogate badge, variant + hash,
  the Datamonkey deep link, and the MCP reproduction snippet.

Visualisations start in `web/src/lib/viz/` and move to `hyphy-scope` once stable (D4).

---

## 5. The JavaScript port

### 5.1 Inventory

`hyphaeon/` is 6,996 lines of Python. About 1,000 are out of scope (`disease.py`, `training_data.py`,
`train.py`); about 1,200 are plumbing replaced by the package's own (`cli.py` argument handling,
`weights.py`, `io.py`, `_progress.py`); `model.py` (760) is not ported but exported. What remains is
the port, listed by dependency order. "Exists" refers to DM3's `src/lib/services/axomeme/` port.

| Python | Lines | Computes | Numerical primitives | JS module | Status | Parity class |
|---|---|---|---|---|---|---|
| `dataset.py` | 730 | parsers (FASTA/NEXUS/PHYLIP, gz), tokenizer (TCAG, 64/65 and 20 sentinels), tree extraction, name matching, duplicate pruning, Faith's-PD downsampling, patristic distances, `>10` rescale, classical MDS (dense `eigh`; Lanczos `eigsh` for N > 500), invariable flag | `eigh`, `eigsh` | `parse/`, `tokenizer`, `newick`, `patristic`, `mds`, `assemble` | **Exists** (2,013 lines, 149 tests). Gaps: PHYLIP, duplicate pruning, the rescale rule, three-tier name matching. Lanczos path not needed at cap 512 (dense is exact). | exact; MDS ≤ 1e-5 with the reference sign convention |
| `inference.py` | 192 | device, adaptive batch, `predict_site_lrts` | — | **Not library.** The ORT sessions live in the app's `runtime/` (ported from DM3 `session.js` and datamonkey-js-server `session.js`); only the pure `assemble.batchSizeFor` stays in the library | **Exists** (ORT) | ≤ 1e-6 vs torch |
| `stats.py` | 84 | MEME mixture p (⅓δ₀ + ⅔(0.45χ²₁ + 0.55χ²₂)), Self–Liang p, Benjamini–Hochberg, Cauchy combination | χ² survival (regularized incomplete gamma), `tan` | `stats` | new | exact to 1e-12 |
| `filter.py` | 399 | hypergeometric patch scan (window ≤ 35, k ≥ 3, `p_local` ≤ 0.01), Outlier Contamination Index, contiguous-run detection, NNN masking, re-score | hypergeometric CDF (log-choose), forward passes | `filter` | new | patches exact; re-score ≤ 1e-6 |
| `attribution.py` | 175 | per-taxon counterfactual ΔLRT (consensus revert), driver ranking, % signal, weighted patristic depth → epoch, adaptation mode | numpy arithmetic, forward passes | `attribution` | new | ≤ 1e-6 |
| `cli.py` busted section (~240) + `model.py` `BustedMultiTaskHead` | 240 | Self–Liang site p, ACAT, Simes, omnibus LRT (Σ max(0, LRT − 3.841)), verdict; neural head via `busted_head.onnx` | in-graph softmax/sigmoid/softplus | `omnibus` | new; head via export | stats exact; head ≤ 1e-6 |
| `epistasis.py` | 776 | attribution matrix `mean_attns × delta`, cosine network, Student-t p, BH, CESI, APC; sectors: connected components → greedy modularity communities (Clauset–Newman–Moore, networkx semantics) → spectral coherence λ₁/Tr; vectorized permutation null (einsum + `eigvalsh` in batches ≤ 25,000); DMS driver | `t.sf` (incomplete beta), `eigh`/`eigvalsh` (have tred2/tql2), `norm`, `default_rng`, networkx | `epistasis`, `sectors`, `dms` | new; needs `mean_root_attns` | network and sectors exact given identical graph; `p_perm` statistical |
| `phenotype.py` | 644 | trait vector (presets, foreground list or regex, CSV, continuous), attribution projection, per-site ρ and t-test p, BH, PARS signature, trait sectors (reuses sectors), spectral energy and length-adjusted EVD p, Brownian-motion permulations (phylogenetic covariance → Cholesky → Gaussian draws), normal survival | `t.sf`, `norm.sf`, `cholesky`, `randn`, `norm` | `phenotype`, `permulations` | new; needs `mean_root_attns` | site stats exact; permulation p statistical |
| `evaluation.py` | 667 | CSV/JSON loading, gene matching, Pearson, Spearman (ties), ROC-AUC, PPV/FPR, confusion, warnings, report | `pearsonr`, `spearmanr`, `roc_auc_score` | `evaluate` | new | exact to 1e-9 |
| `cli.py` output writers, `io.py` | ~150 | JSON/CSV/GraphML writers | — | `writers` | new (GraphML is a small XML emitter) | byte-equal after canonicalisation |

**Numeric kernel** (`numeric/`, built once, tested against scipy fixtures): log-gamma (Lanczos),
regularized incomplete gamma (χ² survival), regularized incomplete beta (Student t survival),
hypergeometric CDF via log-choose, erfc (normal survival), symmetric eigendecomposition (existing
tred2/tql2 plus a batched largest-eigenvalue path for the permutation null), Cholesky, seeded PRNG
(xoshiro256**, seed recorded in provenance), BH, rank with ties, Mann–Whitney ROC-AUC, cosine,
connected components, Clauset–Newman–Moore greedy modularity with networkx's tie-breaking.

### 5.2 Order and effort

| Order | Module(s) | Depends on | Estimate |
|---|---|---|---|
| 1 | numeric kernel + fixture harness | — | 1.5 weeks |
| 2 | `stats`, `filter`, `attribution`, `omnibus` (combination tests) | `lrt` only | 2 weeks |
| 3 | `evaluate`, writers, dataset gaps (PHYLIP, dedupe, rescale, matching) | — | 1 week |
| 4 | `epistasis` + `sectors` + `dms` | attention export | 3 weeks |
| 5 | `phenotype` + `permulations` + omnibus neural head | attention export, `busted_head.onnx` | 2 weeks |
| 6 | Bridge removal, three-surface parity complete | all above | 0.5 week |

≈ 10 developer-weeks of porting, overlapping with the front-end phases in §8.

### 5.3 Port discipline

Each rule below exists because of a specific failure the team already paid for. Phase 0 added a
fresh one: DM3's port, byte-identical to the AxoMEME 2.0 training scripts, disagrees with
`dataset.py` at v1.0.0 on 54 of 64 codon tokens (61 sense codons numbered consecutively in TCAG
order, stops/gaps/unknown all 64), on the amino-acid sentinels (everything non-residue is 20), on the
site-variability rule (amino-acid tokens only, no serine two-family case, stops excluded), on which
matrix MDS runs on (the real N × N, not the padded 512 × 512, with no sign canonicalisation), and on
the `> 10` patristic rescale. Measured consequence: the seeded browser pipeline reaches Spearman 0.13
against `hyphaeon meme` on bat_oas1; adding the rescale alone lifts it to 0.68. Rule 1 applies: the
library mirrors `dataset.py`, and the fixture replay in `js/test/fixtures.test.js` pins every token.

1. **Port from the reference source, not from a driver.** The handoff records that the ML team's
   inference driver tokenised 63 of 64 codons differently from training and passed its own parity
   test. Every ported function cites the Python file and line in its header comment.
2. **Fixtures per function, generated by Python, committed as JSON.** A script upstream
   (`scripts/gen_fixtures.py`) runs every function in §5.1 on the five examples plus seeded random
   inputs and writes inputs and outputs. JS tests replay them. End-to-end parity alone cannot say
   which of twelve steps drifted.
3. **No improvements during the port.** A Python bug is replicated, flagged, fixed upstream, the
   fixtures regenerated, and then fixed in JS. Otherwise parity becomes a matter of opinion.
4. **Match precision deliberately.** Attention and LRT come out of the graph as float32; the Python
   holds them as float32 arrays. The JS uses `Float32Array` where Python does and `Float64Array`
   elsewhere, and the fixture tolerance is set per function from that choice.
5. **Randomness is a documented contract, not an implementation detail.** Permutation and
   permulation nulls cannot match Python's PCG64 bit-for-bit. The manifest names the PRNG and the
   default seed; results record the seed; parity for these outputs is statistical (§5.4).
6. **networkx semantics are part of the spec.** Community detection tie-breaking and node ordering
   change sector membership. The port reproduces networkx's behaviour and the fixtures pin it.
7. **"WHY THIS FILE EXISTS" headers**, with the measurement next to the constant, on every module.

### 5.4 Parity classes

| Class | Applies to | Test |
|---|---|---|
| exact | tokenisation, patches, graph edges and sectors, BH, ranks, confusion matrices, writers | equality after canonicalisation |
| tolerance | LRT and attention through ORT, MDS, cosine, t/χ²/normal p-values, ROC-AUC | `max |Δ|` ≤ 1e-5·max(1, \|lrt\|) for the graph (measured in Phase 0: fp32 torch paths themselves differ by 6.7e-6, so 1e-6 is unreachable), ≤ 1e-5 (MDS), ≤ 1e-9 (special functions on float64; note `cmd_meme` writes p/q as float32) |
| statistical | `p_perm`, `gene_p_value_perm`, `null_coherence_*`, `p_assoc_perm` | JS and Python each at B = 10,000 with their own seeds; difference within 3·√(p(1−p)/B); null moments within 2% |

Three surfaces plus the reference run this on every push: JS under Node, JS in headless Chromium, the
MCP tool, and Python.

### 5.5 Where the port lives: in `veg/HyphAeon`, as a library

The port goes into the HyphAeon repository as **a library of functions that mirror `hyphaeon/*.py`**
and nothing else: no onnxruntime dependency, no file I/O beyond parsing strings, no workers, no
server, no MCP. Runtime glue (ORT sessions, manifest loading and hash verification, pipeline
orchestration) is the app repository's `runtime/` package. Reasons, in order of weight:

1. **Drift becomes a CI failure in one place.** The handoff's central hazard is two copies of the
   same method updated separately. If the Python and the JS sit in one repository, a change to
   `epistasis.py` without a matching change to `js/src/epistasis.ts` fails the fixture replay in the
   same pull request. Across two repositories it fails days later, in the consumer.
2. **Fixtures are generated and consumed in the same commit.** `scripts/gen_fixtures.py` writes
   `fixtures/`; `js/test` replays them. No submodule, no tarball, no version skew.
3. **The export and the contract are tested together.** `export-onnx` writes `models/` and the
   manifest; `js/src/session-node` loads them in the same CI run.
4. **Ownership.** The ML team owns the methods. A port reviewed beside the Python it mirrors is
   reviewable by the people who wrote the Python; a port in another repository is not.
5. **One release.** A tag `v1.x` publishes `hyphaeon` to PyPI and `@veg/hyphaeon-js` +
   `@veg/hyphaeon-mcp` to npm from the same commit; `manifest.json` carries the tag. The app pins it.

Layout inside `veg/HyphAeon`:

```
HyphAeon/
├── hyphaeon/                 Python reference (unchanged layout)
├── js/                       @veg/hyphaeon-js — the library (TypeScript, vitest, tsup); no onnxruntime
│   ├── src/numeric/  parse/  tree/  stats.ts  filter.ts  attribution.ts  omnibus.ts
│   │   epistasis.ts  sectors.ts  dms.ts  phenotype.ts  permulations.ts  evaluate.ts
│   │   diagnostics.ts  callModes.ts  writers.ts  modelContract.ts (tensor assembly + validateInputBundle)
│   ├── test/                 DM3's 149 cases (with provenance headers) + fixture replay
│   └── package.json          version = the repo tag
├── models/                   manifest.json, general.onnx, viral.onnx, busted_head.onnx (committed, like model.safetensors)
├── fixtures/                 generated by scripts/gen_fixtures.py; replayed by js/test
├── scripts/                  export_onnx.py, gen_fixtures.py, parity.py (four-way run on examples)
├── tests/  model_eval/       Python, unchanged
├── .github/workflows/        tests.yml (py) · js.yml (build, vitest, fixture replay) · parity.yml (four-way) · model_eval.yml · release.yml (tag → PyPI + npm)
└── CODEOWNERS                hyphaeon/ and js/ share reviewers
```

Consequences for the app repository: `veg/hyphaeon-app` is an npm-workspaces repository holding
everything that runs (`web/`, `runtime/`, `mcp/`, `server/`), depending on `@veg/hyphaeon-js` at a
pinned tag. The ONNX graphs and manifest are copied from the npm package into `web/static/` at build,
the way DM3 copies ORT's WASM. The MCP is published from here as `@veg/hyphaeon-mcp`.

Costs, named so they are not a surprise: the HyphAeon repository becomes polyglot (Python + TypeScript)
and its CI gains a Node matrix; `pytest` and `vitest` both run on every push; the ML team's pull
requests will sometimes need a JS reviewer. CODEOWNERS and separate workflow files keep the two halves
from blocking each other on unrelated failures.

---

## 6. Reuse map

| From | Take | Notes |
|---|---|---|
| `datamonkey3/src/lib/services/axomeme/*` (10 files, 2,013 lines) | **seed of `veg/HyphAeon/js`** | contract, newick, patristic, eigen, MDS, tokenizer, assemble, postprocess, callModes, session; pinned hash equals HF's viral ONNX |
| `datamonkey3/src/lib/services/prescreen/*` + `meme_gate.json` | whole directory | XGBoost hit-likelihood, import-free gate |
| `datamonkey3` `fastaValidation.js`, `treeSanitation.js`, `stripEmbeddedTrees()` | whole | parsing, repair, branch-length inspection |
| `datamonkey3/static/wasm/`, `NJ.bf`, `stores/aioli.js` | HyPhy WASM + NJ | self-hosted |
| `datamonkey3` `copy-ort-wasm.mjs`, `e2e/19-axomeme.spec.js` | build + e2e pattern | URL assertions catch delivery bugs |
| `axomeme3/index.html` | HBL scripts (HKY85 fit, format conversion), `selectSpeciesMaximizePD`, Manhattan canvas + entropy overlays, site-tree modal with Fitch parsimony, AA-composition spark bars, progress checklist, methodology modal, copy | port out of the single file into components; drop the star-tree fallback and the CDN loads |
| `datamonkey-js-server/lib/mcp/*` | MCP structure, and the mount point for phase 4 | tools/prompts/resources split, OAuth ceremony, OOB redirect, notifier, `axomeme_scan` caps and error taxonomy |
| `datamonkey-js-server/lib/axomeme/{cli,session}.js`, `app/hivtrace/*.sh` | Node ORT session, bounded-progress conventions, the Python-bridge pattern | the CJS vendor copy itself is retired |
| `hyphy-scope` `AxomemeVisualization`, `axomeme-plots.ts`, `BgmVisualization`, `PhylogeneticTreeViewer` | patterns + components | rank-first prose, site-pair view, tree viewer |
| `HyphAeon/examples/*`, `tests/test_{stats,epistasis,phenotype,evaluation,busted}.py` (96 cases), `model_eval/README.md` | gallery, fixture seeds, golden tests, `caveats.json` | regenerate outputs first; the Python tests define the behaviours the fixtures must cover |
| `datamonkey-metrics` | deploy pattern | prebake at build, `paths.base`, rsync, CLAUDE.md-as-notebook |

**Leave behind:** `AxomemeAnalysisRunner`'s inheritance, the DM3 method registration triplet, the
SLURM descriptor, Socket.IO, Tailwind, axomeme3's CDN dependencies and star-tree fallback, the 2.0
five-input model, and any Python at product runtime once the bridge is gone.

---

## 7. Changes in `veg/HyphAeon`

The port itself (§5) is the largest change and lands as `js/` in this repository, with the
scaffolding that goes with it: the package, the `js.yml` / `parity.yml` / `release.yml` workflows,
CODEOWNERS, and an npm publish step keyed to the same tag as PyPI. The reference-side
changes the port needs:

1. **`hyphaeon export-onnx --variant {general,viral}`**: opset 17, the four inputs, outputs `lrt`,
   `mean_root_attns`, `root_repr`; plus `busted_head.onnx`; parity vs PyTorch ≤ 1e-6; writes
   `models/` and the manifest with hashes.
2. **`scripts/gen_fixtures.py`**: per-function fixtures for every row of §5.1 on the examples and
   seeded random inputs; committed under `fixtures/` and replayed by `js/test` in the same CI.
3. **Library entry points** `hyphaeon.api.run_meme(...)`, `run_busted(...)`; typed exceptions instead
   of `sys.exit` (the bridge needs clean exit codes and stderr).
4. **Progress callback** `(phase, done, total, message)`; `--progress-json` on the CLI so the bridge
   can stream phases.
5. **Result schema** `schema_version` + `provenance`; one name per collection in epistasis JSON;
   regenerate `examples/*` and `expected_results/*` with a test that compares them.
6. **`diagnose(alignment, tree)`** returning the structured warnings of §4.3; the JS package
   implements the same codes and the fixtures pin them.
7. **Seed and PRNG flags** on `epistasis` and `phenotype` (`--seed`) so statistical parity runs are
   reproducible on the Python side.
8. **`list-models --json`** reading the manifest.

---

## 8. Phases

| Phase | Scope | Exit criterion |
|---|---|---|
| **0 — Decide, scaffold, fixtures** (≈1 week) | Answers to §9; `js/` in `veg/HyphAeon` seeded from DM3's pure preprocessing port with its tests and provenance headers; `js.yml` and `release.yml` workflows; PRs 1–8 of §7 opened; fixture harness and numeric kernel started; manifest with the viral ONNX; `veg/hyphaeon-app` scaffolded as workspaces (`web/`, `runtime/` with the ORT sessions from DM3 and datamonkey-js-server, `mcp/` skeleton with the Python bridge) consuming the library by a `file:` link | Smc6 scores in the browser from the app repo, through the library from the methods repo, with per-site parity to DM3; scipy fixtures pass in JS |
| **1 — Client-side site selection + stdio MCP** (≈3 weeks) | Web pipeline in workers; HyPhy WASM HKY85 and NJ; tn93 tree-free; diagnostics; Manhattan, table, site tree; ports 1–3 of §5.2 (stats, filter, attribution, omnibus tests, evaluate) landing in `veg/HyphAeon`; gallery; e2e with URL and header assertions; `@veg/hyphaeon-mcp` stdio with the Python bridge for unported pillars; first tagged release to PyPI + npm; staging on silverback | The axomeme3 successor is live at the new URL; every pillar is reachable through the stdio MCP; the app pins a published tag |
| **2 — Epistasis and DMS in the browser + remote MCP** (≈3 weeks) | Attention export consumed; port 4 (epistasis, sectors, dms) with fixtures; network, sector and heatmap UIs; Node `server/` with jobs, SSE, `/validate`, and `/mcp` over HTTP with OAuth; bridge removed for these pillars | Epistasis and DMS run in the browser on the examples with parity to Python; the remote MCP is a working claude.ai connector |
| **3 — Phenotype in the browser, bridge gone** (≈3 weeks) | Port 5 (phenotype, permulations, busted neural head); trait UI and plots; statistical parity for permutation outputs; Python bridge deleted; four-way parity in CI | No Python at runtime anywhere in the product; all five examples fully browsable |
| **4 — Harden and share** (≈2 weeks) | Promote viz to hyphy-scope; DM3's Predict switches to `@veg/hyphaeon-js`; tool module mounted in datamonkey-js-server's MCP replacing `axomeme_scan`; caveats from model_eval; rate limits, TTL, monitoring; `/methods`, `/mcp` docs; launch | Public launch; axomeme3 redirects here |

---

## 9. Decisions needed (recommendation first)

| # | Decision | Recommendation |
|---|---|---|
| D1 | Host and domain | Silverback, same origin, e.g. `hyphaeon.hyphy.org`; Apache reverse proxy to the Node server; COOP/COEP in the vhost. |
| D2 | Canonical weights | Resolved: the repo's 9.8 MB file is the suite, a superset of HF's base. Export both ONNX variants from it via PR 1, tag HF, pin the tag. |
| D3 | Pillars in v1 | `meme`, `busted`, `epistasis`, `dms`, `phenotype`, `evaluate`. Exclude `disease`. |
| D4 | Where visualisations live | In-app first, promote to hyphy-scope in phase 4. |
| D5 | Tree optional? | Yes. No tree → NJ in HyPhy WASM or TN93 tree-free; default NJ. |
| D6 | Topology-only trees | HKY85 in HyPhy WASM (axomeme3's behaviour) on every surface, since HyPhy WASM also runs under Node. |
| D7 | Accounts and persistence | None. Browser results in IndexedDB; server jobs by URL with a 7-day TTL. |
| D8 | Styling | Scoped CSS with DM3's tokens; no Tailwind; no CDNs. |
| D9 | Repository | **Resolved: two repositories split by what they are.** `veg/HyphAeon` holds the methods: the Python reference, the `js/` library that mirrors it, fixtures, models, and parity CI, publishing to PyPI and npm from one tag. `veg/hyphaeon-app` holds everything that runs: `web/`, `runtime/`, `mcp/`, `server/`, `deploy/`, `e2e/`, and pins the library (§5.5). |
| D10 | Default variant | `general`, with an automatic suggestion of `viral` from the diagnostics. |
| D11 | Significance display | LRT + rank/percentile first; p and BH q shown; one `callModes` (percentile / z / q) shared by every surface. |
| D12 | Client-side statistics pillars | **Resolved: JS port** (§5). Pyodide kept only as a fallback if a specific port proves intractable. |
| D13 | Threads | COOP/COEP on, multi-threaded ORT; one-thread fallback when headers are absent. |
| D14 | Fate of axomeme3 and DM3's copy | axomeme3 redirects here at launch; DM3's `src/lib/services/axomeme` is replaced by the package in phase 4. |
| D15 | Remote MCP auth | Datamonkey's auto-approving OAuth (dynamic registration, PKCE, OOB). |
| D16 | Python at runtime | None after phase 3. The Python CLI bridge in the MCP is temporary and labelled as such in provenance. |
| D17 | PRNG and seeds | xoshiro256** with a default seed of 42, recorded in provenance; `--seed` added upstream so both sides are reproducible; statistical parity per §5.4. |
| D18 | Where the port's fixtures live | **Resolved by D9:** `veg/HyphAeon/fixtures/`, generated and replayed in the same repository and CI run. |
| D19 | Versioning and publishing | The JS packages carry the repository tag as their version (`hyphaeon==1.4.0` ↔ `@veg/hyphaeon-js@1.4.0`); `release.yml` publishes both on tag; `manifest.json` records the tag; the app pins an exact version and bumps deliberately. |

---

## Appendix A — Repository layouts

The engine (`veg/HyphAeon`) is laid out in §5.5. The application:

```
hyphaeon-app/                        npm workspaces: web, runtime, mcp, server
├── PLAN.md
├── CLAUDE.md                        project notebook: deploy commands, why-config, release notes
├── package.json                     workspaces; @veg/hyphaeon-js pinned at an exact tag
├── runtime/                         private package shared by web, mcp, server
│   ├── src/session-web.js           ORT web session (from DM3 session.js), hash verified against the manifest
│   ├── src/session-node.js          ORT node session (from datamonkey-js-server session.js)
│   ├── src/pipeline.js              prep → MDS → infer → postprocess over the library, with progress callbacks
│   └── src/manifest.js              manifest loading, sha256 verification, model paths
├── web/                             SvelteKit 2 + Svelte 5 + TS, adapter-static
│   ├── src/lib/workers/             prep, mds, inference, pillars (thin wrappers over runtime/)
│   ├── src/lib/viz/                 per-pillar visualisations (→ hyphy-scope later)
│   ├── src/routes/                  /, /analyze, /results/[id], /jobs/[id], /gallery, /methods, /evaluate, /mcp
│   ├── static/models/  static/ort/  static/wasm/    copied at build from the library's models, ORT, and DM3's HyPhy WASM
│   └── caveats.json
├── mcp/                             @veg/hyphaeon-mcp: tools, prompts, resources, stdio bin, http mount, python bridge
├── server/                          Node: jobs, SSE, caps, /validate, mounts mcp/ over HTTP
├── deploy/                          pm2 or compose, apache vhost (COOP/COEP, /api, /mcp), rsync script
└── e2e/                             Playwright: delivery assertions (origins, headers, bytes per route)
```

## Appendix B — Output schemas the front end consumes (from code, not the stale examples)

- **meme** `sites[]`: `site`, `hyphaeon_lrt`, `p_value`, `q_value`, `is_invariable`; with attribution:
  `evolutionary_epoch`, `adaptation_mode`, `top_driver`, `top_mutation`, `attribution_details`. Top
  level: `taxa_count`, `codon_count`, `runtime_sec`, `filter_enabled`, `artifacts_masked[]`,
  `attribution_enabled`.
- **busted**: `p_value_acat`, `p_value_simes`, `omnibus_lrt`, `predicted_gene_lrt`,
  `selection_probability`, `synonymous_rate_variation`, `total_selection_energy`,
  `sig_sites_p05/p10`, `rate_distributions{omega_k, proportion_k}`, `positive_selection_detected`.
- **epistasis** `edges[]`: `site_u/v`, `ref_u/v`, `lrt_u/v`, `similarity`, `shared_taxa`,
  `shared_branches`, `p_val`/`hyper_p`, `fdr_q`, `cesi`. `sectors[]`: `sector_id`, `size`, `sites[]`,
  `spectral_coherence`, `p_perm`, `null_coherence_mean/std/95`, `isotropic_baseline`, `mean_lrt`,
  `pars_signature`. `plasticity[]` as in dms.
- **dms** `plasticity[]`: `site`, `wt_aa`, `baseline_lrt`, `p_value`, `intrinsic_plasticity`,
  `mean/max/min_delta_lrt`, `mutant_deltas{AA: ΔLRT}`; top level `focal_taxon`, `total_mutations`.
- **phenotype** `sites[]`: `site`, `ref_aa`, `derived_aa`, `hyphaeon_lrt`, `p_lrt`,
  `association_rho`, `p_value`, `p_assoc`, `p_assoc_parametric`, `p_assoc_perm`, `score`,
  `foreground_freq_pct`, `background_freq_pct`, `q_value`, `fg_mean_attn`, `bg_mean_attn`; top level
  `phenotype_meta`, `spectral_energy`, `norm_spectral_ratio`, `max_assoc`, `p_evd_length_adjusted`,
  `compact_pars_signature`, `permulations_count`, `gene_p_value_perm`, `trait_sectors[]`,
  `coselection_pairs[]`.
- **evaluate**: `matched_genes`, `total_sites`, `evaluated_sites`, `pearson_r`, `spearman_rho`,
  `thresholds{"0.05","0.10" → roc_auc, ppv, fpr, confusion}`, `per_gene[]`, `warnings[]`.

## Appendix C — Sources

- `../HyphAeon`: README, ARCHITECTURE, `model_config.json`, `hyphaeon/*.py` (line counts and
  primitive inventory in §5.1), `tests/*.py`, `model_eval/README.md`, workflows; bundled
  `model.safetensors` key inventory (backbone 179, head_meme 5, head_busted 20, head_absrel 10).
- GitHub issues veg/HyphAeon #7, #8, #9, #13, #16, #33; PRs #16–#32.
- HuggingFace `datamonkey/hyphaeon`: model card, `config.json`, `model.viral.onnx` (sha256
  `de765904107ba436c6ad6abbecb8af54962abd8444e1b5044947bb945d8ccda3`, identical to DM3's).
- `../axomeme3`: `index.html`, README; live site at data.hyphy.org/web/axomeme3.
- `../hyphaeon-manuscript`: `main.tex`, sections 00–11, figure captions.
- `../datamonkey3`: `HYPHAEON-HANDOFF.md`, `CLAUDE.md`, `src/lib/services/{axomeme,prescreen}/`,
  `fastaValidation.js`, `treeSanitation.js`, `static/{wasm,ort,models}`.
- `../datamonkey-js-server`: `lib/mcp/*`, `lib/axomeme/`, `app/hivtrace/`, `CLAUDE.md`.
- `../hyphy-scope`: `index.ts`, `AxomemeVisualization.svelte`, `axomeme-*.ts`.
- Local benchmark: scratch venv, `hyphaeon` from `../HyphAeon`, bundled weights, CPU.
