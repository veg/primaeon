/**
 * index.js — the public surface of @veg/hyphaeon-runtime.
 *
 * WHY THIS FILE EXISTS. One entry for everything that is cheap to import: manifest handling,
 * post-processing, call modes, the pipeline, and the app-side validators. The ONNX sessions are
 * deliberately NOT here — they are the `./web` and `./node` subpath exports (session-web.js,
 * session-node.js), so a consumer names which runtime it wants and a bundler never sees the other.
 * Importing either session module is still free (the runtime is loaded by a dynamic import inside
 * loadSession()), but keeping them off the default path makes the delivery discipline visible in
 * the import statement.
 *
 * The MEME hit-likelihood prescreen is the `./prescreen` subpath for the same reason DM3 kept it
 * behind a dynamic import: it carries a 735 KB model file that only the "before you run" panel
 * needs, and `./prescreen/scope` is the import-free leaf a caller asks before loading it.
 */

export * from './manifest.js';
export { buildFeeds, runSites } from './feeds.js';
export { CALL_DEFAULTS, describeCallMode } from './callModes.js';
export { buildPredictions, NEUTRAL_CALL, isSiteVariable, siteVariability } from './postprocess.js';
export * from './pipeline.js';
export * from './treeSanitation.js';
export * from './fastaValidation.js';
