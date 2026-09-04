# hyphaeon-app

The HyphAeon application: everything that *runs* the HyphAeon neural MEME surrogate. npm
workspaces `runtime/`, `web/`, `mcp/` (later `server/`), all consuming `@veg/hyphaeon-js`, the
library in `../HyphAeon/js` that mirrors the Python reference `../HyphAeon/hyphaeon/*.py`. Plan of
record: `PLAN.md` (draft v5).

## Key commands

- `npm install` — at the root, once every workspace exists; installs all workspaces and links
  `@veg/hyphaeon-js` from `../HyphAeon/js` (a `file:` dependency in `runtime/package.json`, pinned
  to a published tag once one exists).
- `cd runtime && npx vitest run` (or `npm -w runtime test`) — one workspace alone. Do NOT run a
  bare `npm install` inside a workspace directory: npm climbs to the root and rebuilds the whole
  tree anyway, and the root lockfile (`package-lock.json`) is the only lockfile; per-workspace
  lockfiles were removed at Phase 0 integration and must not come back.
- `npm test` — `vitest run` in every workspace with a test script (`npm -ws run test --if-present`).
  The MCP's two bridge tests shell to the Python CLI: export `HYPHAEON_PY_BIN=<venv>/bin/hyphaeon`
  (plus the weights variables below) or `HYPHAEON_MCP_SKIP_BRIDGE=1`.
- `cd runtime && npx vitest run` — the runtime suite alone; `test/pipeline.test.js` and
  `test/parity-fixtures.test.js` score the examples through the real general graph under
  onnxruntime-node, `test/hyphy*.test.js` run HyPhy WASM under Node and in headless Chromium (~8 s).
- `npm run build` — `web/` static build (adapter-static). Its `prebuild` copies the ORT WASM, the
  graphs + `manifest.json` and HyPhy WASM into `web/static/` and then prebakes the gallery
  (`web/scripts/prebake-gallery.mjs`, stamp-cached; `HYPHAEON_PREBAKE=skip` on a machine without
  `onnxruntime-node` keeps the committed records).
- `npm run e2e` — Playwright from `e2e/` (`npm -w e2e run e2e`; the built site under `vite preview`
  on port 4173, so run `npm run build` first). `e2e/` is a workspace so `@playwright/test` is
  installed once at the root; its script is named `e2e`, not `test`, so `npm test` never starts a
  browser. Do not rebuild `web/build` while the suite runs; the preview serves it live.
- Parity: `node runtime/scripts/parity-node.mjs --examples all --busted-examples all` writes the
  `node` surface into `../HyphAeon/parity/node/`, the e2e writes bat_oas1's browser run into
  `parity/browser/` and `parity/web/`, then `cd ../HyphAeon && python scripts/parity.py --examples
  all --surfaces python,node,web` compares (`browser` is not a surface name it knows).
- `node mcp/bin/hyphaeon-mcp.js` — the stdio MCP server; `HYPHAEON_MODELS_DIR` defaults to
  `web/static/models` of the checkout (so build once), `HYPHAEON_MCP_THREADS` to 1.

Python reference, for parity runs (never at product runtime): a venv with `hyphaeon` installed
editable from `../HyphAeon`; `HYPHAEON_WEIGHTS=../HyphAeon/model.safetensors HF_HUB_OFFLINE=1`.

## The split (not negotiable)

- `../HyphAeon/js` (`@veg/hyphaeon-js`) is **a library of pure functions that mirror
  `hyphaeon/*.py`**: parsing strings, tokenising, trees, distances, MDS, tensor assembly, and (as
  they land) the statistics, filter, attribution, omnibus, epistasis, DMS, phenotype and evaluate
  methods. No onnxruntime, no file or network I/O, no workers, no server, no MCP, no UI, no result
  semantics. It ships with the Python under one tag.
- **Everything that runs lives here.** `runtime/` holds the ONNX sessions (`session-web.js`,
  `session-node.js`), the manifest reader and sha256 verification (`manifest.js`), the pipeline
  orchestration (`pipeline.js`: parse → prepare → infer → postprocess with
  `progress(phase, done, total, message)`), the result semantics (`postprocess.js`,
  `callModes.js`), and the app-side validators DM3 already used on every upload
  (`fastaValidation.js`, `treeSanitation.js`, `prescreen/`). `web/`, `mcp/` and `server/` wrap
  `runtime/`; none of them talks to the library directly for anything the runtime already does.
- If it is unclear which side something belongs on: could two different apps (a browser, an MCP,
  a batch CLI) want it unchanged? Then it is the library's. Does it know about a URL, a file, a
  session, a thread count, a tier label, a warning to show? Then it is the app's.
- Port from the reference source, never "improve" during a port. A Python bug is replicated,
  flagged, fixed upstream, fixtures regenerated, then fixed in JS.

## Why-config

- **`paths.base` and `trailingSlash: 'always'`** (`web/svelte.config.js`, `web/src/routes/+layout`):
  the site is rsynced under a path prefix on silverback behind Apache, which serves static files
  only and does not resolve `/analyze` → `/analyze.html`. With `trailingSlash: 'always'` the
  adapter emits `analyze/index.html`, which Apache serves at `/analyze/`; with `paths.base`
  parameterised every in-app URL goes through `$app/paths.base`, so the same build works at `/`
  in dev and under the prefix in production. Same pattern as `datamonkey-metrics`.
- **No CDNs, anywhere.** ORT's WASM, the ONNX graphs, HyPhy WASM, tn93, fonts: all vendored at
  build time from npm or from the library package, served from this origin. `session-web.js` sets
  `ort.env.wasm.wasmPaths` to the vendored path and imports `onnxruntime-web/wasm` (the CPU-only
  entry), never the default entry (which reaches for the 26.8 MB WebGPU binary and then a CDN).
  A CDN dependency is a delivery bug, not a convenience; the e2e asserts every origin.
- **COOP/COEP headers** are set on the production origin so `crossOriginIsolated` is true and ORT
  can run multi-threaded; `session-web.js` honours a `numThreads` request only when it is, and
  reports the count it used, so the e2e can assert threads engaged (PLAN.md D13).
- **Every session verifies the sha256** of the graph it loads against `models/manifest.json` and
  refuses to score on a mismatch. The hashes live in the manifest (written by
  `hyphaeon export-onnx`), not in source. A failed load is never memoised; only verified sessions
  are.
- **`onnxruntime-node` is pinned EXACTLY to 1.23.2** in `runtime/package.json`. 1.23.2 is the last
  release that ships darwin/x64 bindings, and the development Node on this machine is an x64 build
  under Rosetta (`process.arch === 'x64'` on an Apple-silicon Mac). 1.29.0 ships darwin/arm64 only
  and fails with `Cannot find module '../bin/napi-v6/darwin/x64/onnxruntime_binding.node'`.
  Production is linux/x64 where the pin costs nothing. Bump it deliberately, together with an
  arm64 Node, not as part of a routine dependency update. (datamonkey-js-server records the same
  pin for the same reason.)
- **Workspace packages depend on each other by version, never by `file:`.** `web/package.json`
  declares `"@veg/hyphaeon-runtime": "0.0.0"`; npm resolves that to the workspace link. Declaring
  `file:../runtime` on top of the workspace link made arborist (npm 10.9) crash with
  `Cannot read properties of null (reading 'edgesOut')` at the root install. The one `file:`
  dependency in the tree is `@veg/hyphaeon-js: file:../../HyphAeon/js` in `runtime/`, which points
  outside the repository and becomes a pinned npm version at the first tagged release.
- **`runtime/` is `private: true`** and consumed by workspace link; `mcp/` is what gets published
  (`@veg/hyphaeon-mcp`), bundling what it needs.
- **The prescreen reads `meme_gate.json` through Vite's `?raw` import** in the browser (bytes
  untransformed, as DM3 does) and falls back to `fs.readFile` of the same file under plain Node
  (the MCP and the server), so both surfaces parse XGBoost's own bytes.
- **Dynamic imports of Node modules hold their specifier in a variable** (`manifest.js`,
  `createSession.js`, `web/src/routes/results/[...id]/+page.ts`). A literal
  `import(/* @vite-ignore */ './session-node.js')` is still followed by Rollup, and
  `session-node.js`'s `node:crypto` then breaks every browser bundle that imports the runtime's
  main entry ("createHash is not exported by __vite-browser-external", measured in Phase 1b).
- **`web/tsconfig.json` has `checkJs: false`.** With it on, `svelte-check` type-checks the linked
  JavaScript packages (`@veg/hyphaeon-runtime`, `@veg/hyphaeon-js`) under strict and reports ~20
  errors in code that runs its own typecheck with `checkJs` off. Phase 0's 0-error check only held
  because nothing imported the runtime yet.
- **Release ONNX sessions before the process exits.** `onnxruntime-node` 1.23.2 aborts at exit
  (`libc++abi: … mutex lock failed: Invalid argument`, SIGABRT) when an `InferenceSession` is still
  alive on its thread pool, at 1 thread as well as 4 (measured on the MCP stdio server and the
  parity runner). `session-node.js` `releaseSessions()` releases every memoised session AND drops
  it from the memo (releasing a handle alone hands the next caller a "Session already disposed"
  session); `mcp` `engine.close()` calls it and the bin sets `process.exitCode` afterwards instead
  of `process.exit(0)`.
- **HyPhy WASM is vendored in `runtime/vendor/hyphy/<version>/`** (DM3's 2.5.98 build, 6.4 MB,
  hashes in `PROVENANCE.md`) so the repository builds and tests without a DM3 checkout;
  `copy-assets.mjs` copies it to `web/static/wasm/hyphy/` and `runtime/src/hyphy` reads it under
  Node. The build is `ENVIRONMENT=web,worker`; the Node loader evaluates the glue with a shimmed
  `self`/`postMessage` (see `runtime/src/hyphy/index.js`), and in a module worker the glue is
  loaded by fetch + `new Function`, which needs `'unsafe-eval'` in the CSP (DM3's `_headers` grant it).
- **The gallery records and inputs under `web/static/gallery/` are tracked** (2.8 MB): they are the
  prebaked demos and let a machine without `onnxruntime-node` build with `HYPHAEON_PREBAKE=skip`.
  The prebake is stamp-cached on inputs, graph hash, options, library version and runtime sources,
  so a no-change build costs ~0.4 s and a runtime change rebakes (~30 s, HIV1_RT's HKY85 fit).

## Working rules

- Never restart or kill the user's dev servers; there are unrelated vite processes on this
  machine. Start your own on a different port if you need one.
- No AI attribution anywhere: not in commits, not in comments, not in metadata.
- Every new source file starts with a `WHY THIS FILE EXISTS` header: what it does, what it was
  ported from (file + commit), and the measurement behind any non-obvious constant.
- Reference checkouts, read-only: `../datamonkey3` (`main@fac1330`), `../datamonkey-js-server`
  (`main@1e84d6f`), `../axomeme3`, `../datamonkey-metrics`.

---

## Release notes

### 2026-09-04 — Phase 0: scaffold, runtime package

Repository initialised (`git init -b main`, nothing committed yet) as npm workspaces
`runtime`, `web`, `mcp`; `.gitignore` covers build output and the vendored web assets
(`web/static/{ort,models,wasm}`), `parity/`, and Playwright artifacts.

**`runtime/` (`@veg/hyphaeon-runtime`, private)**, exports `.`, `./web`, `./node`, `./prescreen`,
`./prescreen/scope`:

- `src/manifest.js` — reads `models/manifest.json` (path, URL or object), validates PLAN.md §3.3's
  shape, picks a variant (`general` default, D10), resolves `<variant>.onnx` (or an explicit
  `onnx_file`), exposes the graph's input/output names, isomorphic `sha256Hex` (Web Crypto or
  node:crypto), and the one mismatch message every surface raises.
- `src/session-web.js` — from DM3 `session.js`: dynamic `import('onnxruntime-web/wasm')` inside
  `loadSession({modelUrl, expectedSha256, ortWasmPath, numThreads})`, verify-before-create,
  allow-list memoisation of verified sessions only, failures un-memoised, threads honoured only
  when `crossOriginIsolated`.
- `src/session-node.js` — from datamonkey-js-server `session.js`, CJS → ESM: lazy
  `import('onnxruntime-node')`, `loadSession({modelPath, expectedSha256, threads})`, one intra-op
  thread by default, ENOENT kept distinguishable.
- `src/feeds.js` — the one `runSites`/`buildFeeds` both sessions share; reads back only the
  outputs the manifest names (`lrt`, `mean_root_attns`, `root_repr`), omits absent heads.
- `src/pipeline.js` — `runMeme({alignmentText, treeText, options, session, progress, surface,
  signal, provenance})`: DM3's runner phase order without BaseAnalysisRunner; tree gates verbatim
  from predict.js; refuses < 3 taxa (#7); batches by the library's `batchSizeFor`; validates the
  first bundle with the library's `validateInputBundle`; accumulates attention into `[L, N]`;
  returns `{sites, summary, provenance}` per PLAN.md §3.5 with structured warnings
  (`TAXA_NOT_IN_TREE`, `TREE_NEGATIVE_LENGTHS`, `DISTANCES_CLAMPED`, `UNKNOWN_CODON_FRACTION`,
  `IN_FRAME_STOPS`, …). No p/q yet (stats port is order 2 in PLAN.md §5.2).
- `src/postprocess.js`, `src/callModes.js` — DM3's `buildPredictions` and the call modes;
  `isSiteVariable`/`siteVariability` are imported from the library and re-exported.
- `src/fastaValidation.js` (+ `stripEmbeddedTrees`, console.log removed: MCP stdio is the
  protocol channel), `src/treeSanitation.js`, `src/prescreen/*` (whole directory incl.
  `meme_gate.json` and fixtures) — DM3 ports with provenance headers.
- `test/` — DM3's postprocess (minus variability), call-modes, session (adapted), tree-sanitation,
  meme-hit-likelihood (trimmed of the Svelte-panel and corpus blocks), review-regressions, plus new
  session-node, manifest and pipeline suites. The pipeline suite runs the real
  `../HyphAeon/models/viral.onnx` (hash from the engine's manifest) on `examples/bat_oas1`:
  351 sites, 18 taxa, finite LRT at every variable site, attention `[351, 18]`.

**Parity against the Python reference on bat_oas1, measured (same weights on both sides,
`hyphaeon meme -w models/_hf/model.viral.safetensors` vs `models/viral.onnx` through this pipeline):**
invariable flags agree 351/351, but over the 182 variable sites the Spearman correlation of LRTs is
**0.13** (viral) / **0.10** (general) and the JS LRTs are nearly flat. A scratch experiment that
swapped preprocessing steps in on the prepared tensors, without touching the library, isolates the
causes (variable-site Spearman vs the reference, viral / general):

| Preprocessing | viral | general |
|---|---|---|
| DM3 port as is | 0.13 | 0.10 |
| + dataset.py's `>10` distance rescale (divide by L; dataset.py:680-681) | 0.68 | 0.57 |
| + dataset.py's 61-codon vocabulary and AA sentinel 20 (dataset.py:25-57) | 0.94 | 0.69 |
| MDS on the real N instead of the padded 512 matrix | no change | no change |

bat_oas1's tree is in Mya (max patristic 123), so the rescale is load-bearing on every example
with a chronogram. Neither change is applied here — both are the library's (`@veg/hyphaeon-js`,
which records them as open questions in its headers); the remaining gap after both (max |ΔLRT|
2.2 viral, 3.7 general) is for the per-function fixture harness. Until they land, browser and MCP
numbers will NOT match `hyphaeon meme`.

**Known divergences to settle with the fixture harness (recorded in the library's headers, not
resolved here):** the DM3-derived tokenizer (TCAG-64 codon order with gap 64 / unknown 65, amino
acids 21/22) differs from `hyphaeon/dataset.py` (61 sense codons with stops and unknowns at 64,
amino-acid unknown at 20); the serine-island rule in `isSiteVariable` is not in `dataset.py`.
The freshly exported `viral.onnx` (sha256 `c3ea5795…`) is a new three-output export from the
suite weights, not byte-identical to DM3's pinned `de765904…` graph; PLAN.md §3.3's example
manifest still quotes the old hash.

### 2026-09-04 — Phase 0: integration (web, mcp, e2e, workspace)

Seven builders' output (library, ONNX export, fixtures, engine CI, runtime, web, MCP) integrated
into one working tree per repository; every check in `PHASE0.md` passes. Seam fixes:

- Root `npm install` now works: `web/` depends on `@veg/hyphaeon-runtime` by version (`0.0.0`)
  instead of `file:../runtime`; `e2e/` joined the workspaces (its Playwright script is `e2e`, so
  `npm test` stays browser-free); the per-workspace `package-lock.json` files and `node_modules`
  were removed in favour of the root lockfile. `npm test` runs runtime (178), web (10) and mcp (39).
- `../HyphAeon/scripts/gen_fixtures.py` recorded every fixture's byte size without its trailing
  newline (off by one on all 41 files); fixed and regenerated. `../HyphAeon/js/test/fixtures.test.js`
  now validates `fixtures/manifest.json` against the files and replays `dataset/tokenizer.json`,
  pinning the DM3-vs-dataset.py vocabulary divergence exactly (54/64 codon tokens differ) so the
  library's tokenizer change in Phase 1 flips it.
- `mcp` `list_models` reports `available: true` against `../HyphAeon/models/manifest.json` now
  that the export has landed (the builder wrote it before the manifest existed).

Web: `npm run build` copies ORT WASM (13.3 MB), the three graphs + manifest (16.7 MB) and HyPhy
WASM (6.4 MB) into `web/static/` and prerenders six routes; `svelte-check` 0 errors; Playwright
4/4 (title, same-origin only, no model/ORT fetch on the landing route, COOP/COEP with
`crossOriginIsolated === true`).

Carried to Phase 1 (details in `PHASE0.md`): the library tokenizer and the `>10` distance rescale
(parity with `hyphaeon meme` is Spearman 0.13 until they land); no p/q columns until the stats
port; `/analyze` has no run path; no CI workflow in this repository yet; the BUSTED neural head is
non-deterministic upstream; PLAN.md §3.3 still quotes the pre-export viral hash `de765904…`.

### 2026-09-04 — Phase 1: site selection end to end (browser, gallery, MCP), tree tools, parity

Six builders' output (runtime pipeline, HyPhy tree tools, web `/analyze`, web results page, gallery
prebake, MCP switch) plus the e2e suite integrated; every check in `PHASE1.md` passes, and the
parity table there is the one to read. Headlines:

- **`runtime/`** reproduces `cmd_meme` phase for phase over `@veg/hyphaeon-js` phase-1a (`runMeme`
  with `--filter` / `--attribute`, float32 p/q, `estimateTree` hook), adds `runBusted`,
  `runEvaluate`, `createSession`, `results.js` (Python-byte-equal writers), `predict.js`, the
  HyPhy WASM driver (`@veg/hyphaeon-runtime/hyphy`: HKY85, NJ, format conversion; Node and browser
  workers) and `scripts/parity-node.mjs`. 16 files / 235 tests.
- **`web/`** runs everything in three module workers (prep: `diagnose()` + prescreen; tree: HyPhy
  WASM; infer: `runMeme` with the session inside, threads = `hardwareConcurrency` ≤ 16 when
  `crossOriginIsolated`), persists runs in IndexedDB, and renders `/results/local/?id=` and
  `/results/gallery/<name>/` (Manhattan canvas with entropy overlays, Observable Plot ranked views,
  table, phylotree site tree with Fitch substitutions, provenance, downloads, MCP snippet). The
  five README examples are prebaked at build (`web/scripts/prebake-gallery.mjs`). `svelte-check`
  0 errors; 8 files / 50 tests; Playwright 19/19.
- **`mcp/` 0.2.0** runs `hyphaeon_meme`, `hyphaeon_busted` and `hyphaeon_evaluate` in-process
  (`provenance.surface: mcp-stdio | mcp-http`, `reference_command` to reproduce with the CLI);
  epistasis, DMS and phenotype stay bridged. `hyphaeon_validate` is the library's `diagnose()`;
  resources gained `hyphaeon://gallery{,/name}`. 5 files / 63 tests + 1 skipped (the LRT clause).
- **Parity** (`../HyphAeon/parity/report.json`): Smc6 reproduces `hyphaeon meme` at max |ΔLRT|
  5.7e-6 with p/q bit-exact on node and browser, and the busted statistics at class; bat_oas1 and
  RHO differ at ~1e-2 relative (ρ ≥ 0.999) because the library's MDS eigenvector signs differ
  from LAPACK's on two columns and the model is not sign-invariant — the library's to fix (flipping
  the columns restores 1.8e-6); camelid and HIV1_RT additionally go through HyPhy WASM 2.5.98 vs
  the fixtures' native 2.5.65 (informational). The BUSTED neural-head fields are unseeded upstream.

Seam fixes at integration (details in `PHASE1.md`): `./hyphy` export, variable-specifier dynamic
imports (the vite stub plugin is gone), `releaseSessions()` + MCP shutdown without SIGABRT, the
results route's `node:fs` warning, `_sample.json` removed, root lockfile regenerated.

Carried to Phase 2: the MDS sign convention (upstream), `parity.py`'s 1e-6 graph tolerance and
neural-head fields, the NJ / filter / attribute paths and RHO's embedded tree not yet driven in the
browser e2e, TN93 tree-free mode, `server/`, `deploy/`, CI, npm publish of `@veg/hyphaeon-mcp`
(it depends on `@veg/hyphaeon-js@1.0.0`, resolved by the workspace link today).
