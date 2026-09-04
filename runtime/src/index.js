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
export * from './results.js';
export * from './treeSanitation.js';
export * from './fastaValidation.js';
