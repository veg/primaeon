# hyphaeon-app

The application for [HyphAeon](https://github.com/veg/HyphAeon), a neural surrogate for HyPhy's
MEME and BUSTED with co-selection networks, a digital deep mutational scan and phenotype
association on top. This repository holds **everything that runs**:

| Workspace | What it is |
|---|---|
| `web/` | The site. SvelteKit 2 + Svelte 5, fully prerendered static build. Drop an alignment and one report streams in; every analysis runs in the browser under ONNX Runtime WASM. Sequences never leave the browser on this path. |
| `runtime/` | `@veg/hyphaeon-runtime` (private): the ONNX sessions for the browser and Node, manifest loading and sha256 verification, the pipelines and the report orchestrator over the library. Shared by the three surfaces below. |
| `mcp/` | `@veg/hyphaeon-mcp`: one `hyphaeon_analyze` tool that runs the whole report in-process, the per-pillar tools and MEME concordance, over stdio or streamable HTTP. |
| `server/` | `@veg/hyphaeon-server`: the REST job API (SSE progress, progressive sections) and the MCP mounted at `/mcp` behind an auto-approving OAuth ceremony, for a claude.ai connector. |
| `e2e/` | Playwright: origins, headers, bytes per route, and the browser leg of the parity harness. |
| `deploy/` | The runbook: Apache vhost with COOP/COEP, pm2 or Docker for the server, the rsync script. |

Every result carries `is_surrogate` and a path to run the real analysis on Datamonkey. No Python
and no HyPhy run anywhere in the product (PLAN.md D16, D22): a tree with branch lengths is used
as given; without one, pairwise TN93 distances feed the model, the reference's own `--use-tn93`.

## The two-repository rule

HyphAeon is two repositories split by what they are, and the line between them is not negotiable
(PLAN.md D9, §5.5):

- **[`veg/HyphAeon`](https://github.com/veg/HyphAeon)** holds the *methods*: the Python reference
  (`hyphaeon/*.py`), the JavaScript library that mirrors it function for function
  (`js/`, published as `@veg/hyphaeon-js`), the fixtures generated from the Python and replayed by
  the JavaScript in the same CI run, the exported ONNX graphs and their manifest (`models/`), and
  the end-to-end parity harness (`scripts/parity.py`, `PARITY.md`). One tag publishes the Python to
  PyPI and the library to npm from one commit. The library is pure functions: no onnxruntime, no
  I/O, no workers, no server, no UI.
- **This repository** holds everything that *runs* the methods, and pins the library. If two
  different apps (a browser, an MCP, a batch CLI) would want a piece of code unchanged, it belongs
  in the library; if it knows about a URL, a file, a session, a thread count or a warning to show,
  it belongs here.

A method is ported from the reference source and never "improved" during the port. A Python bug is
replicated, flagged, fixed upstream, the fixtures regenerated, then fixed in the JavaScript.

## Running locally

The library is consumed by a `file:` link (`runtime/package.json`:
`"@veg/hyphaeon-js": "file:../../HyphAeon/js"`), and the runtime tests, the web build and the
e2e read the engine's `models/` and `fixtures/` from the same place, so **the engine must be
checked out as a sibling of this repository**, at the ref this repository is developed against
(`ENGINE_REF` in `.github/workflows/ci.yml`; `phase-3a` today):

```
parent/
├── HyphAeon/        git clone git@github.com:veg/HyphAeon.git && git checkout phase-3a
└── hyphaeon-app/    this repository
```

Node 22 (`.nvmrc`; `nvm use`). Then, from this repository's root:

```bash
npm ci                                   # every workspace; links @veg/hyphaeon-js from ../HyphAeon/js
npm test                                 # vitest in runtime/, web/, mcp/, server/ (~1.5 min; scores the examples through the real graphs)
cd web && npm run check && npm run build # svelte-check, then the static build into web/build/
cd ../e2e && npx playwright install chromium && npx playwright test   # Playwright against `vite preview` of that build
cd ../web && npm run dev                 # the dev server (copies the ORT WASM and the graphs into static/ first)
```

The build's `prebuild` copies ONNX Runtime's WASM and the engine's graphs and manifest into
`web/static/`, writes `web/static/_headers`, prebakes the five gallery reports under
`onnxruntime-node` (stamp-cached; a full rebake is about three minutes) and validates
`web/caveats.json` against the manifest. Nothing served by the site comes from another origin.

Environment variables you may need:

| Variable | Read by | Meaning |
|---|---|---|
| `HYPHAEON_ENGINE_DIR` | `scripts/copy-assets.mjs`, `web/scripts/*.mjs`, `e2e/` | The engine checkout, when it is not `../HyphAeon`. |
| `HYPHAEON_MODELS_DIR` | `mcp/`, `server/`, their tests | A directory with `manifest.json` and the `.onnx` graphs. Defaults search `web/static/models` (after a build) and `../HyphAeon/models`. |
| `HYPHAEON_PREBAKE` | `web/scripts/prebake-gallery.mjs` | `skip` keeps the committed gallery records (a machine without `onnxruntime-node` bindings); `force` rebakes every example. |
| `HYPHAEON_BASE` | `web/svelte.config.js` | The path prefix the site is served under (`''` for its own origin). |
| `HYPHAEON_SERVER_PORT`, `HYPHAEON_SERVER_ISSUER`, `HYPHAEON_DATA_DIR`, … | `server/` | See `deploy/README.md`. |

`onnxruntime-node` is pinned exactly to 1.23.2 (the last release with darwin/x64 bindings; see
`CLAUDE.md`). On an Apple-silicon Mac running an x64 Node under Rosetta it is the version that
loads; production is linux/x64 where the pin costs nothing.

### The MCP server

Local, over stdio (private; nothing leaves your machine):

```bash
claude mcp add hyphaeon -- npx @veg/hyphaeon-mcp
```

Or from this checkout, after `npm ci` at the root:

```bash
claude mcp add hyphaeon -- node /path/to/hyphaeon-app/mcp/bin/hyphaeon-mcp.js
```

Set `HYPHAEON_MODELS_DIR` if the graphs are not where the search order in `mcp/README.md`
expects them. Remote, over streamable HTTP: the server (`server/`) mounts the same package at
`/mcp` behind its OAuth ceremony; add it as a connector the way the Datamonkey connector is added.

### The server

```bash
cd server && HYPHAEON_MODELS_DIR=../web/static/models npm start   # listens on HYPHAEON_SERVER_PORT (7040)
curl -s localhost:7040/api/v1/health
```

`deploy/README.md` is the runbook: what the host needs (Node and the model files, nothing else),
the Apache vhost, pm2 or Docker, and the smoke checks.

### Parity against the Python reference

```bash
node runtime/scripts/parity-node.mjs --examples all --analyses meme,busted,epistasis,dms,phenotype --busted-examples all
cd ../HyphAeon && HYPHAEON_WEIGHTS=$PWD/model.safetensors HF_HUB_OFFLINE=1 \
  python scripts/parity.py --examples all --surfaces python,node,node-tn93
```

The runner writes the `node` surface (and `node-tn93` for the runs that went tree-free) into the
engine's `parity/`; `parity.py` runs the reference CLI on the same examples and compares at the
classes of PLAN.md §5.4 (`../HyphAeon/PARITY.md` is the contract). The e2e writes the browser
surface the same way. CI runs both on every push (`.github/workflows/ci.yml`; the `parity` job).

## Continuous integration

`.github/workflows/ci.yml` runs two jobs on every push to `main` and every pull request: `app`
(install, every workspace's tests, `svelte-check`, the full build, Playwright) and `parity` (the
node surfaces, then the Python reference and the comparison). Both check out `veg/HyphAeon` at
`ENGINE_REF` beside this repository with the `ENGINE_TOKEN` secret, because the engine is
private; the section "CI" in `CLAUDE.md` says what to set and how to bump the ref.

## Documents

- [`PLAN.md`](PLAN.md): the plan of record — architecture, the port, parity classes, phases and
  every decision (D1–D22).
- [`CLAUDE.md`](CLAUDE.md): the project notebook — commands, why each non-obvious configuration is
  the way it is, working rules, release notes per phase.
- Phase reports, each with the checks that were run and what they printed, the parity table and
  the gaps carried forward: [`PHASE0.md`](PHASE0.md), [`PHASE1.md`](PHASE1.md),
  [`PHASE2.md`](PHASE2.md), [`PHASE3.md`](PHASE3.md).
- In the engine: `PHASE0.md`, `PHASE1A.md`, `PHASE2A.md`, `PHASE3A.md` (the library side of each
  phase), `PARITY.md` (the parity contract) and `MDS_SIGN.md` (the eigenvector sign convention,
  D20).
- [`mcp/README.md`](mcp/README.md), [`server/README.md`](server/README.md),
  [`deploy/README.md`](deploy/README.md).

## License

MIT.
