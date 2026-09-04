# HyPhy WebAssembly build, vendored

WHY THIS DIRECTORY EXISTS. The app's tree tools (HKY85 branch lengths, NJ, alignment format
conversion; `runtime/src/hyphy/index.js`) run HyPhy compiled to WebAssembly, in a browser worker
and under Node. The build is DataMonkey 3's, copied here so this repository builds and tests on
its own (PLAN.md section 4.4: every asset served from this origin, none fetched from elsewhere;
the project notebook: no CDNs). `scripts/copy-assets.mjs` copies `<version>/` into
`web/static/wasm/hyphy/<version>/` before a web build; `runtime/src/hyphy/index.js` reads
`<version>/` directly under Node and names the version (`HYPHY_WASM_VERSION`).

## Source

| | |
|---|---|
| Copied from | `../datamonkey3/static/wasm/hyphy/2.5.98/` (checkout `main@fac1330`, v0.1.0-beta.41) |
| Added there by | DataMonkey 3 commit `2cf8dcd` "Upgrade HyPhy WASM from 2.5.94 to 2.5.98" |
| HyPhy version | `HYPHY 2.5.98(MP) for Emscripten on wasm32` (what `hyphy --version` prints from this binary) |
| Upstream | https://github.com/veg/hyphy, the `develop` build DataMonkey ships; @biowasm-style status hooks (`_jsSendStatusUpdate*` in `src/utils/hyphyunixutils.cpp`, `src/mains/unix.cpp`) |

## Files

| File | Bytes | sha256 |
|---|---|---|
| `2.5.98/hyphy.js` | 149,113 | `7c03679fdcc6fa97ca0822603e2db8489564bdaa9864041b291a688fee0d0c97` |
| `2.5.98/hyphy.wasm` | 1,639,931 | `53f2909ed59338d5a65b421bfe167d0a655830e5332beaaa6b1d6d2fadb9b0df` |
| `2.5.98/hyphy.data` | 4,902,419 | `f9ca06c788674b7d5f34098ab36b394b4edef8e664847916e1db636faf43d868` |

`hyphy.data` is the Emscripten file package of HyPhy's `res/` directory (TemplateBatchFiles,
genetic codes, substitution classes), mounted at `/res` in the virtual file system; HyPhy's
`LIBPATH` resolves there.

## How it was built (as far as the artefacts and the hyphy checkout say)

The link line recorded in `../hyphy/hyphy/build-wasm/CMakeCache.txt` (that checkout is at
2.5.96; the flags are the ones DataMonkey's build uses):

```
-sTOTAL_STACK=2097152 -O2 -sASSERTIONS=1 -sMODULARIZE=1 -sALLOW_MEMORY_GROWTH
-sFORCE_FILESYSTEM=1 -sEXIT_RUNTIME=0
-sEXPORTED_RUNTIME_METHODS=["callMain","FS","PROXYFS","WORKERFS","UTF8ToString","getValue","AsciiToString"]
-lworkerfs.js -lproxyfs.js -sINVOKE_RUN=0 -sENVIRONMENT=web,worker -fwasm-exceptions
--preload-file ../res@/res
```

What follows from those flags, and what `runtime/src/hyphy/index.js` does about it:

- `MODULARIZE=1` without `EXPORT_ES6`: `hyphy.js` is a classic script declaring a global
  `Module` factory (`var Module = (() => { ... return async function(moduleArg) {...} })()`),
  with `module.exports = Module` only when a CommonJS `module` is in scope. A classic worker
  loads it with `importScripts`; anything else evaluates the text (`new Function`).
- `ENVIRONMENT=web,worker` with `ASSERTIONS=1`: the glue throws under Node three ways (a
  version-check IIFE on bare `process.versions.node`, `assert(!ENVIRONMENT_IS_NODE)` on
  `globalThis.process`, and the worker branch's `if (!(globalThis.window ||
  globalThis.WorkerGlobalScope)) throw`). `index.js` evaluates the text with those identifiers
  shadowed so the glue sees a worker; it never needs fetch because the `.wasm` is handed over
  through `instantiateWasm` and the `.data` through `getPreloadedPackage`.
- `INVOKE_RUN=0`, `EXIT_RUNTIME=0`: `main` runs only through `Module.callMain(argv)`, which
  returns the exit status and leaves the runtime (and `FS`) alive afterwards.
- The C++ status hooks call a bare `postMessage({type: "biowasm", ...})`; `index.js` intercepts
  it in both environments (see its header).
- `-sPTHREAD` is absent: single-threaded, no SharedArrayBuffer or COOP/COEP needed.

## Verifying a copy

```
shasum -a 256 runtime/vendor/hyphy/2.5.98/*
```

should print the table above. Replacing the build: put the new `<version>/` directory beside
this one, update `HYPHY_WASM_VERSION` and `HYPHY_VERSION_STRING` in `runtime/src/hyphy/index.js`,
rerun `runtime/test/hyphy*.test.js` (the Node suite prints the HKY85 comparison against a native
`hyphy` when one is on PATH), and record the new hashes here.
