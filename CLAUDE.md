# hyphaeon-app

The HyphAeon application: everything that *runs* the HyphAeon neural MEME surrogate. npm
workspaces `runtime/`, `web/`, `mcp/`, `server/` (+ `e2e/`), all consuming `@veg/hyphaeon-js`, the
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
  Nothing shells out any more (the Python bridge is deleted, Phase 3): the MCP and server suites
  need only `HYPHAEON_MODELS_DIR=../HyphAeon/models`.
- `cd runtime && npx vitest run` — the runtime suite alone; `test/pipeline.test.js`,
  `test/parity-fixtures.test.js`, `test/tree-free.test.js` and `test/phenotype.test.js` score the
  examples through the real general graph under onnxruntime-node (~45 s), and
  `test/no-hyphy.test.js` asserts HyPhy stayed removed.
- `npm run build` — `web/` static build (adapter-static). Its `prebuild` copies the ORT WASM and
  the graphs + `manifest.json` into `web/static/`, writes `web/static/_headers`, and then prebakes
  the gallery (`web/scripts/prebake-gallery.mjs`, stamp-cached; `HYPHAEON_PREBAKE=skip` on a
  machine without `onnxruntime-node` keeps the committed records, `=force` rebakes all five in
  about 3 min).
- `npm run e2e` — Playwright from `e2e/` (`npm -w e2e run e2e`; the built site under `vite preview`
  on port 4173, so run `npm run build` first). `e2e/` is a workspace so `@playwright/test` is
  installed once at the root; its script is named `e2e`, not `test`, so `npm test` never starts a
  browser. Do not rebuild `web/build` while the suite runs; the preview serves it live.
- Parity: `node runtime/scripts/parity-node.mjs --examples all --analyses
  meme,busted,epistasis,dms,phenotype --busted-examples all` writes the `node` surface into
  `../HyphAeon/parity/node/` — and a tree-free run (camelid, HIV1_RT under D22) into
  `parity/node-tn93/`, whose reference is `fixtures/e2e/*_tn93.json`, not `parity/python/`. The e2e
  writes the browser runs into `parity/browser/` and `parity/web/`. Then `cd ../HyphAeon && python
  scripts/parity.py --examples all --surfaces python,node,web` compares (`browser` is not a surface
  name it knows, and neither is `node-tn93`; PHASE3.md's table evaluates those files at PLAN §5.4's
  classes with a scratch comparator).
- `node mcp/bin/hyphaeon-mcp.js` — the stdio MCP server; `HYPHAEON_MODELS_DIR` defaults to
  `web/static/models` of the checkout (so build once), `HYPHAEON_MCP_THREADS` to 1.
- Server (`server/`, PLAN.md §3.5 + the MCP over HTTP behind OAuth at `/mcp`):
  `cd server && HYPHAEON_MODELS_DIR=../web/static/models npm start` listens on
  `HYPHAEON_SERVER_PORT` (7040; `npm start` passes `--disable-warning=ExperimentalWarning` for
  `node:sqlite`); `HYPHAEON_MODELS_DIR=../../HyphAeon/models npm test` runs its vitest + supertest
  suite (~40 s: a full `analyze` job on bat_oas1 runs the DMS at `HYPHAEON_SERVER_THREADS`, default
  2). Other knobs: `HYPHAEON_SERVER_ISSUER` (public origin; the OAuth issuer and the only allowed
  `Origin`), `HYPHAEON_DATA_DIR`, `HYPHAEON_SERVER_WORKERS`, `HYPHAEON_JOB_TTL_MS`,
  `HYPHAEON_JOB_TIMEOUT_MS`, `HYPHAEON_MCP_AUTH` (never `0` on a public host). Smoke:
  `curl -s localhost:7040/api/v1/health`, then `POST /api/v1/jobs {"analysis":"analyze","alignment":…}`
  → `GET /api/v1/jobs/<id>/events` (SSE) → `GET /api/v1/jobs/<id>/result`. `deploy/README.md` is the
  runbook (Apache vhost, pm2, Docker, `rsync-web.sh`).
- Parity, Phase 2–3: the same runner writes the epistasis (B = 10,000, `parity.py`'s default), the
  Smc6 DMS and RHO's phenotype files; the e2e writes bat_oas1's meme, Smc6's epistasis (B = 1,000),
  camelid's tree-free meme and RHO's phenotype browser files.

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
- **No CDNs, anywhere.** ORT's WASM, the ONNX graphs, fonts: all vendored at
  build time from npm or from the library package, served from this origin. (TN93 distances are
  pure JavaScript in `@veg/hyphaeon-js`; nothing else fetches a binary.) `session-web.js` sets
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
- **There is no tree tool and no HyPhy (D22, Phase 3).** A tree with usable branch lengths is used
  as given; no tree, or a tree without them, takes the library's tree-free path — pairwise TN93
  distances straight into the MDS, the reference's own `--use-tn93` — and the report gets a tree
  for DISPLAY ONLY (site trees, foreground picking): since Phase 4 (D6) the reader's own topology
  with unit branch lengths when the upload carried one (`display_tree_source: 'user-topology'`,
  labelled `USER_TOPOLOGY_LABEL`), otherwise `runtime/src/nj.js`'s neighbour-joining tree on the
  same distances (`'nj'`); the model never sees a topology in either case. `runtime/src/hyphy/`,
  `runtime/vendor/hyphy/` (a 6.4 MB tracked WebAssembly build), the `./hyphy` export and
  `web/static/wasm/` are deleted, `runtime/test/no-hyphy.test.js` and `e2e/smoke.spec.ts` keep them
  deleted, and the bare `'unsafe-eval'` its glue needed in a module worker is out of both
  `web/static/_headers` (now written by `copy-assets.mjs` rather than copied from DM3) and
  `deploy/apache-hyphaeon.conf`.
- **The gallery records and inputs under `web/static/gallery/` are tracked** (7.9 MB at Phase 3:
  6.5 MB of full `ReportRecord`s + 1.4 MB inputs): they are the prebaked demos and let a machine
  without `onnxruntime-node` build with `HYPHAEON_PREBAKE=skip`. The prebake is stamp-cached on
  inputs, graph hash, options, library version, runtime sources and the script's own version, so a
  no-change build costs ~0.4 s and a runtime change rebakes everything (3 min at 8 threads: DMS
  bat_oas1 3.1 s, Smc6 9.6 s, camelid 19.2 s, HIV1_RT 70.0 s, RHO 71.6 s).

## Working rules

- Never restart or kill the user's dev servers; there are unrelated vite processes on this
  machine. Start your own on a different port if you need one.
- No AI attribution anywhere: not in commits, not in comments, not in metadata.
- Every new source file starts with a `WHY THIS FILE EXISTS` header: what it does, what it was
  ported from (file + commit), and the measurement behind any non-obvious constant.
- Reference checkouts, read-only: `../datamonkey3` (`main@fac1330`), `../datamonkey-js-server`
  (`main@1e84d6f`), `../axomeme3`, `../datamonkey-metrics`.

## CI

`.github/workflows/ci.yml`, on every push to `main` and every pull request (one run per ref at a
time; `workflow_dispatch` takes an `engine_ref` input). Node from `.nvmrc` (22).

- **Both repositories are checked out, as siblings.** `runtime/package.json` links the library by
  `file:../../HyphAeon/js`, the runtime tests resolve `../../../HyphAeon` from `runtime/test/`,
  the web build copies `../HyphAeon/models/` and the e2e reads `../HyphAeon/fixtures/e2e/`, so
  the workflow checks this repository out into `$GITHUB_WORKSPACE/hyphaeon-app` and `veg/HyphAeon`
  into `$GITHUB_WORKSPACE/HyphAeon` (actions/checkout refuses a `path` outside the workspace, which
  is why this repository is not at the workspace root). Every `run` step has
  `working-directory: hyphaeon-app` by default.
- **The engine is private**, so its checkout uses the repository secret **`ENGINE_TOKEN`**: a
  fine-grained personal access token with *Contents: read* on `veg/HyphAeon` (Settings → Secrets
  and variables → Actions). It is the only secret the workflow needs. Pull requests from forks do
  not receive secrets and fail at that step by design.
- **`ENGINE_REF`** (workflow `env`, `phase-3a` today) is the engine commit CI runs against — a
  tag, branch or SHA. It is bumped in the same change that moves the app onto a new library, never
  by itself; a push to the engine's default branch cannot break this repository's CI. Once the
  library is a published npm version the `file:` link goes away, but the models and fixtures the
  suites read still come from this checkout, so the ref stays.
- **Job `app`**: `npm ci` (root; `node_modules` cached on the lockfile + `.nvmrc` hash, restored
  whole on a hit and `npm ci` skipped — the library link inside it is a relative symlink and
  survives), `npm run test --workspaces --if-present` with `HYPHAEON_MODELS_DIR` and
  `HYPHAEON_ENGINE_DIR` pointing into the engine checkout, `cd web && npm run check && npm run
  build` (the FULL prebuild: asset copy, gallery prebake, caveats check; the prebake is
  stamp-cached against the committed records and rebakes all five examples under onnxruntime-node
  when a runtime source or the library changed, 3–5 min on a 4-vCPU runner), then `npx playwright
  install --with-deps chromium` (the browser cached under `~/.cache/ms-playwright` on the
  playwright-core version; on a hit only `install-deps` runs) and `cd e2e && npx playwright test
  --reporter=github,html`. `playwright-report/` and `test-results/` are uploaded on failure.
- **Job `parity`** (PLAN.md §5.4, `../HyphAeon/PARITY.md`): `npm ci`, Python 3.11 with CPU torch
  and `pip install -e ".[all]"` of the engine (the `tn93` extra is the pure-Python fallback
  `dataset.py --use-tn93` takes when no `tn93` binary is on PATH), then
  `node runtime/scripts/parity-node.mjs --engine $ENGINE_DIR --examples all --analyses
  meme,busted,epistasis,dms,phenotype --busted-examples all --threads $(nproc)` (writes
  `parity/node/` and `parity/node-tn93/` in the engine checkout), then from the engine
  `HYPHAEON_WEIGHTS=$ENGINE_DIR/model.safetensors HF_HUB_OFFLINE=1 python scripts/parity.py
  --examples all --surfaces python,node,node-tn93`. Exit 0 is no violation at the plan's classes,
  1 a violation, 2 a failed reference run; `parity/report.json`, both `summary.json` files and the
  CLI logs are uploaded whether or not it passed.
- **`ONNXRUNTIME_NODE_INSTALL=skip`** is set for the whole workflow: onnxruntime-node 1.23.2's
  postinstall metadata lists `cuda12` as a requirement on `linux/x64` and would download the CUDA
  execution-provider binaries from NuGet on every uncached `npm ci`; the CPU binding is bundled and
  is all this repository uses.
- Budget: `app` is bounded at 45 min, `parity` at 60. Measured locally at this change: the four
  vitest suites 82 s in all (runtime 32 s, web 2 s, mcp 33 s, server 15 s); Phase 3 measured the
  node parity surfaces at 2:28 with 6 threads and the Python reference at ~1.5 min of CLI time,
  before the torch install; a 4-vCPU runner is slower per pass.

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

### 2026-09-05 — Phase 2: one action, one report; epistasis + DMS in the browser; server; remote MCP

Six builders' output (runtime orchestrator, web report, landing + gallery, server, MCP switch,
methods + caveats) plus the rewritten e2e suite integrated; every check in `PHASE2.md` passes, and
the parity table there is the one to read. Headlines:

- **D21 is the product.** `/` is the drop zone; dropping, pasting or picking an example starts
  `runEverything` (`runtime/src/analyze.js`) in one analyze worker and navigates at once to
  `/report/local/?id=…`, where the sections stream in — diagnostics strip, Sites, Gene, Epistasis +
  sectors, Attribution, Filter, DMS (progressive, cancellable, work-capped), the Phenotype offer,
  Data and provenance, one "Re-run with…" disclosure. Records persist in IndexedDB (`reports`,
  DB v2); the five examples are prebaked full reports at `/report/gallery/<id>/`; `/results/…`
  and `/gallery/` redirect. `svelte-check` 0 errors; 10 files / 65 tests; Playwright 37/37 in 15 s.
- **`runtime/`** gained `runEverything`, `runEpistasis` (on the meme pass's own attention — the
  graph is never re-run), `runDms` (slabbed, abortable, `19·L·N²` budget), `report.js` (the
  `ReportRecord` v2 and every CLI download). 20 files / 274 tests. Epistasis on Smc6 vs the CLI
  fixture: edges and sectors identical, worst float |Δ| 2.9e-6, `p_perm` inside the statistical
  class; DMS worst |Δ delta_lrt| 1.8e-5 at an LRT scale of 5.5.
- **`server/`** (new workspace, `@veg/hyphaeon-server`): Express 5, PLAN §3.5 jobs API with SSE and
  progressive DMS sections, `worker_threads` pool, SQLite (`node:sqlite`), TTL / timeout / restart
  recovery, the Datamonkey OAuth ceremony ported, `@veg/hyphaeon-mcp` mounted at `/mcp` behind it;
  `deploy/` runbook. 5 files / 52 tests; driven end to end by `e2e/server.spec.ts`.
- **`mcp/` 0.3.0**: epistasis and DMS in-process (bridge deleted for them), `hyphaeon_analyze`
  returns the report (inline ≤ 256 KB, else summary + `job_id` with `get_results section=`),
  `hyphaeon://report/{id}`, `interpret-report`, `mountHttp({authenticate})`. 9 files / 93 tests.
  Phenotype is the one remaining bridged tool.
- **Parity** with the canonical MDS sign (`../HyphAeon/MDS_SIGN.md`, phase-2a): bat_oas1 and RHO now
  reproduce `hyphaeon meme` at the graph class (max relative |ΔLRT| 2.4e-6 / 1.9e-6) on node and
  browser, as Smc6 already did; epistasis edges / sectors exact on Smc6, bat_oas1 and RHO with
  `p_perm` in class at B = 10,000; camelid and HIV1_RT remain informational (HyPhy WASM 2.5.98 vs
  native 2.5.65). `parity.py` still prints FAIL on its own 1e-6 absolute tolerance, the unseeded
  BUSTED head fields and `fdr_q` (engine-repository follow-ups, `PHASE2.md` gap 4).

Seam fixes at integration (details in `PHASE2.md`): the report page's load effect tracked the live
record's status and remounted the whole report on every progress tick (Smc6's DMS 56 s → 12.6 s
once untracked; it also made the Cancel button unclickable); the "Re-run with…" work-budget input's
`step` grid excluded the default and blocked the form; `runEverything` takes `provenance` overrides
so the browser record names its variant; `server` in the root workspaces with version-pinned
sibling dependencies and the root lockfile regenerated; the analyze worker's interim bridge
deleted; the e2e's gene-card p format; the MCP gallery resource descriptions; the server README's
install line.

Carried to Phase 3: the phenotype port and the last bridge, TN93 tree-free + JS NJ replacing HyPhy
WASM (D22), the over-budget DMS → server handoff, `parity.py`'s conventions and a `dms` comparator,
one caveats file, CI, npm publish, deployment (nothing is deployed; `deploy/` has placeholders).


### 2026-09-05 — Phase 3: tree-free by default, phenotype in the browser, no Python and no HyPhy

Three builders' output (runtime tree-free + phenotype, web phenotype UI, MCP/server bridge removal)
plus the rewritten e2e suite integrated; every check in `PHASE3.md` passes, and the parity table
there is the one to read. Headlines:

- **D22 is the tree policy.** A tree with usable branch lengths is used as it is; no tree, or a tree
  without them, takes the library's tree-free path — pairwise TN93 distances straight into the MDS,
  the reference's own `--use-tn93` — and every record says which happened and why (`tree_source:
  'user' | 'embedded' | 'tn93'`, `tree_free {reason}`, `tn93_saturated_pairs`). `runtime/src/nj.js`
  (new, app-side, not a mirror of any Python) builds a neighbour-joining tree on the same distances
  for DISPLAY ONLY — site trees and foreground picking — and the model never sees it. **HyPhy is
  gone**: `runtime/src/hyphy/`, `runtime/vendor/hyphy/` (6.4 MB tracked), the `./hyphy` export, the
  browser's tree worker, the copy-assets step and `web/static/wasm/` are deleted, and
  `runtime/test/no-hyphy.test.js` + `e2e/smoke.spec.ts` keep them deleted.
- **The Phase 1–2 parity gap is closed, as D22 predicted.** camelid and HIV1_RT reproduce
  `hyphaeon meme --use-tn93` at PLAN §5.4's strict graph class on node (0/96 and 0/335 sites beyond
  it) and in the browser (0/96), where Phase 2 had 44/96 and 149/335 through HyPhy WASM 2.5.98
  against the fixtures' native 2.5.65. Both sides now compute the same TN93 matrix.
- **Phenotype runs in the browser.** `runtime/src/phenotype.js` runs the pillar over the meme pass's
  own attention; the report's Phenotype section takes a trait four ways (matching preset, tips on
  the tree, pasted list or pattern, trait table) and draws the association plot, PARS, trait sectors
  and the gene card; permulations are offered only when the run has a real tree and are otherwise
  skipped with the reason. RHO marine reproduces the reference document key for key (145 sites in
  order, worst site residual 2.2e-5 on `hyphaeon_lrt`, everything else ≤ 7e-7).
- **No Python anywhere.** `mcp/src/bridge.js` is deleted with `HYPHAEON_PY_BIN` and
  `BRIDGED_ANALYSES`; `mcp/` 0.4.0 runs all seven analyses in-process and every per-pillar tool now
  accepts an alignment with no tree; the server gained a `phenotype` analysis and `phenotype_file`
  input. `e2e/server.spec.ts` starts the server with an empty PATH and scans the sources for any
  subprocess route.
- **Suites**: runtime 22 files / 294 tests, web 11 / 79, mcp 10 / 113, server 5 / 57,
  `svelte-check` 571 files 0 errors, Playwright 60/60 in 29 s.

Seam fixes at integration (details in `PHASE3.md`): the MCP classified the runtime's new TN93
refusal as a server fault rather than an input one; `web/static/_headers` was still DataMonkey's
copied file, granting unpkg.com and the `'unsafe-eval'` only the HyPhy glue needed, and is now
authored by `copy-assets.mjs` to match the Apache CSP; the diagnostics panel promised to draw a
supplied topology that `displayTreeFor` replaces with the NJ tree; `/mcp` still advertised the
Python bridge and 0.2.0, so the tool table was corrected and the transcript re-recorded against
0.4.0 with a phenotype turn; the `static/wasm` ignore rules and the gallery's permissive
`BranchLengthMethod` escape hatch were removed.

Carried to Phase 4 (`PHASE3.md`'s gaps): `parity.py` has no `node-tn93` surface, no `phenotype` and
no `dms` comparator, and still prints FAIL on its 1e-6 absolute tolerance and the unseeded BUSTED
head fields; the browser's phenotype run cannot be compared element-wise with the RHO fixture while
the app caps at 256 taxa and the fixture used 655; the over-budget DMS → server handoff; one
caveats file; permulation cost in the browser; CI, npm publish and deployment.

### 2026-09-05 — Phase 4: CI and repository hygiene for the first public push

- **`.github/workflows/ci.yml`** (new; the section "CI" above is the reference): two jobs on every
  push to `main` and every pull request, one run per ref. `app` installs, runs every workspace's
  vitest suite, `svelte-check`, the full web build (asset copy, gallery prebake, caveats check,
  vite build) and Playwright against the built site; `parity` writes the `node` and `node-tn93`
  surfaces with `runtime/scripts/parity-node.mjs` and then runs the engine's `scripts/parity.py
  --surfaces python,node,node-tn93` (the Python reference on the same examples, compared at
  PLAN.md §5.4's classes), uploading `parity/report.json` either way. Both jobs check out
  `veg/HyphAeon` at `ENGINE_REF` (`phase-3a`) beside this repository with the `ENGINE_TOKEN`
  secret — the engine is private and the `file:` link, the runtime tests, the build and the e2e
  all resolve `../HyphAeon`. `node_modules` and the Playwright browser are cached;
  `ONNXRUNTIME_NODE_INSTALL=skip` keeps `npm ci` from downloading CUDA binaries on linux/x64.
- **`.nvmrc`** (new): `22`, read by `actions/setup-node` and by `nvm use`.
- **`README.md`** rewritten for a public reader: what the repository is (web, runtime, mcp,
  server, e2e, deploy), the two-repository rule (D9, §5.5), how to run locally (the engine as a
  sibling checkout, the environment variables, the commands), the MCP install line, the server,
  the parity commands, what CI runs, and links to `PLAN.md`, the phase reports and the engine's
  documents.
- Verified at this change: `HYPHAEON_MODELS_DIR=… npm run test --workspaces --if-present` (the
  CI step as written) passes runtime 22 files / 294 tests, web 11 / 79, mcp 10 / 113, server
  5 / 57; `ci.yml` parses (PyYAML); `HYPHAEON_PREBAKE=skip npm run build` in `web/` still builds.
  Nothing under `package.json` scripts changed: `check`, `build` and `e2e` already existed.
- The `parity` job's step was run in its exact shape against the engine's rewritten
  `scripts/parity.py` (landed in the `feat/js-port` working tree during this change, not yet in a
  tag) on a copy of `parity/`: `--examples camelid,Smc6 --surfaces python,node,node-tn93` ran the
  reference for both (a `python-tn93` reference for the tree-free example, the `tn93` binary hidden
  so the pure-Python package computes the distances — the reason the job installs `.[all]`),
  compared 7 files in 48 s, and exited 1: meme, busted and epistasis pass on `node` (Smc6) and
  `node-tn93` (camelid), the new DMS comparator fails on `mutant_deltas` (Smc6 dms 5 violations at
  1.48× its bound; camelid's sector DMS 34 at 2.24×). That is the job doing its work, and an
  engine/runtime question to settle, not a workflow one.
- Carried: `ENGINE_REF` is `phase-3a`, whose `parity.py` refuses `node-tn93` ("unknown surface"),
  so the `parity` job fails at that step until the ref is bumped to one carrying the rewrite; the
  `ENGINE_TOKEN` secret must be created in the repository settings before the first run; npm
  publish of `@veg/hyphaeon-mcp` and deployment remain open.

### 2026-09-05 — Phase 4 integrated (`PHASE4.md`)

The CI, the four report polish items and `HANDOFF.md` integrated; every check in `PHASE4.md`
passes and its parity table is the one to read. Headlines:

- **D6 is done.** A tree-free run whose upload carried a topology draws the READER'S topology,
  pruned to the loaded taxa with unit branch lengths (`display_tree_source: 'user-topology'`,
  `display_tree.label` = `USER_TOPOLOGY_LABEL`, runtime `unitTopologyNewick`); neighbour joining is
  for no tree at all. The modal, the provenance panel, the foreground picker and the diagnostics
  strip all say so; a Phase 3 record that drew NJ keeps saying NJ. The gallery was rebaked: camelid
  and HIV1_RT carry the reader's topology.
- **Site views work on a locally run report.** The `{names, sequences}` block is derived on read
  from the stored alignment text minus `dropped_taxa` (`web/src/lib/report/alignmentBlock.ts`);
  measured against storing it (+3 % Smc6, +15 % HIV1_RT) before choosing. `/mcp` reads the mcp
  workspace's version and `TOOL_NAMES` at build. The MCP's TN93 refusal is an INPUT error,
  `TN93_UNCOMPUTABLE`.
- **Parity, all app surfaces, on the engine's rewritten `parity.py`**: `reference runs: 23 (0
  failed); self-check violations: 0; comparisons: 20 (20 pass, 0 fail); violations: 0` — `PASS`,
  exit 0. DMS (Smc6, node) and phenotype (RHO, node) now have comparators and pass them; the CI
  builder's earlier `mutant_deltas` excursion is gone on the final script. The browser's RHO
  phenotype stays incomparable (256-taxon cap vs 655).
- **Suites**: runtime 22 files / 297 tests, web 13 / 93, mcp 10 / 113, server 5 / 57;
  `svelte-check` 577 files 0 errors; Playwright 62/62 in 28.5 s; `ci.yml` parses and
  `actionlint` is clean.
- Seam fixes at integration: `runtime/test/parity-fixtures.test.js` compared the busted record's
  keys to a fixture that the engine's regeneration had given two CLI-absent arrays (`site_lrts`,
  `is_invariable`); they are now dropped from the key check and the per-site LRTs compared at the
  graph class instead. `ProvenancePanel`, `TreePicker` and `diagnostics/panel.ts` still described
  the `user-topology` source as the model's tree or as NJ. Four e2e specs asserted `'nj'` for
  topology-only uploads, and the "a live run cannot draw the tree" comment was false.
- Carried (details in `PHASE4.md` and `HANDOFF.md`): `ENGINE_REF` must be bumped past `phase-3a`
  once the engine tags the Phase 4a rewrite; `ENGINE_TOKEN` and the `veg/hyphaeon-app` repository
  do not exist yet; nothing is published or deployed; the packages do not carry the models.
