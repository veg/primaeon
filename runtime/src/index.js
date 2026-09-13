/**
 * index.js — the public surface of @veg/hyphaeon-runtime.
 *
 * WHY THIS FILE EXISTS. One entry for everything that is cheap to import: manifest handling,
 * the pipelines (`runMeme`, `runBusted`, `runEvaluate`), the session factory (`createSession`,
 * which dynamic-imports the runtime it needs), the result serialisation (results.js), the
 * predict-callback glue (predict.js), post-processing, call modes, and the app-side validators.
 * The ONNX session modules are deliberately NOT re-exported here — they are the `./web` and
 * `./node` subpath exports (session-web.js, session-node.js), so a consumer names which runtime
 * it wants and a bundler never sees the other. Importing either session module is still free
 * (the runtime is loaded by a dynamic import inside loadSession()), but keeping them off the
 * default path makes the delivery discipline visible in the import statement.
 *
 * PHASE 3 ADDS THE PHENOTYPE PILLAR AND REMOVES HYPHY. `runPhenotype` (phenotype.js) runs
 * `hyphaeon phenotype` in process on every surface — the Python bridge is gone — and
 * `runPhenotypeForReport` is its on-demand form over a finished report. `nj.js` is the
 * neighbour-joining routine PLAN.md D22 asks for: a DISPLAY-ONLY topology on the TN93 distances
 * the tree-free path already computed. The `./hyphy` subpath export, `src/hyphy/` and
 * `vendor/hyphy/` were deleted with D22; nothing in this package loads WebAssembly other than
 * onnxruntime.
 *
 * PHASE 2 ADDS THE REPORT. `runEverything` (analyze.js) is the one call PLAN.md §4.0's product
 * rule needs — one upload runs every pillar in order over one loaded alignment and one session —
 * and `report.js` is the record it returns plus that record's downloads. The pillars it
 * orchestrates are exported beside it (`runEpistasis`, `runDms`) so a surface that wants one of
 * them alone (the MCP's per-pillar tools, the parity runner) does not go through the report.
 *
 * The MEME hit-likelihood prescreen is the `./prescreen` subpath for the same reason DM3 kept it
 * behind a dynamic import: it carries a 735 KB model file that only the "before you run" panel
 * needs, and `./prescreen/scope` is the import-free leaf a caller asks before loading it.
 */

export * from './manifest.js';
export { buildFeeds, runSites, fetchesFor, buildBustedHeadFeeds, runBustedHead } from './feeds.js';
export {
	predictFromSession,
	inferSites,
	bundleFromTokens,
	adaptiveBatchSize,
	resolveBatchSize,
	yieldToLoop,
	abortError,
	throwIfAborted
} from './predict.js';
export { createSession, detectRuntime } from './createSession.js';
export { CALL_DEFAULTS, describeCallMode } from './callModes.js';
export { buildPredictions, NEUTRAL_CALL, isSiteVariable, siteVariability } from './postprocess.js';
export * from './pipeline.js';
export { runBusted } from './busted.js';
export { runEvaluate } from './evaluate.js';
export * from './epistasis.js';
export * from './dms.js';
export * from './phenotype.js';
export * from './nj.js';
export { runEverything, runPhenotypeForReport, geneFromPass, calledSiteIndices, REPORT_DEFAULTS, SURROGATE_FOR } from './analyze.js';
export * from './report.js';
export * from './results.js';
export * from './treeSanitation.js';
export * from './fastaValidation.js';

/**
 * PHASE 2 OF PLAN-TEMPORAL.md ADDS THE DATE LAYER. `runtime/src/dates/` is what `@veg/hyphaeon-js`
 * must not do: sniffing a delimiter, reading a table, guessing which column is which, walking an
 * Auspice build, matching metadata names to taxa, and deciding what to tell the reader. Every
 * string-to-time conversion inside it goes through the library's `parseDate` / `extractDate` /
 * `parseHeaderDate` / `parseFlexibleDate`; there is no second date parser in this package.
 * It is additive: `pipeline.js` is not edited, `prepareRun` keeps its signature and its exact
 * `preprocessing` block, and `alignDatesToRun(ingest, prep)` is the read-only seam between them.
 * `./dates` is also a subpath export, so the `/time` route imports it without the ONNX surface.
 */
export * from './dates/index.js';

/**
 * PHASE 3 OF PLAN-TEMPORAL.md ADDS THE DATING PILLAR, MODEL-FREE. `runtime/src/dating/` orchestrates
 * `hyphaeon dating --no-tree --method ols` over the library's ported estimators (`runOlsDating`,
 * `runRestrictedSplineClockDating`, `computeTreeFreeDivergences`, `clockFittedAndPredicted`) and
 * owns what the library must not: the `'*' → '-'` convention this pillar's reference-of-record used,
 * the `L mod 3` trim, the coverage/holdout rule, the outlier flag, clock-model selection and its
 * sentence, ensemble admission, the reference-shaped JSON and CSV, and every refusal a reader sees.
 * It loads no model and imports nothing that could: `./dating` is also a subpath export, so the
 * `/time` route reaches it without the ONNX surface, and `dating-port.test.js` asserts the boundary.
 * `clockRegression.js` is NOT touched by any of it — it is the independent check this port is
 * compared against, and the same suite runs the two side by side.
 */
export * from './dating/index.js';
