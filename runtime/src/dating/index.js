/**
 * index.js — the barrel of the dating pillar.
 *
 * WHY THIS FILE EXISTS. `runtime/package.json` gains a `./dating` subpath and `runtime/src/index.js`
 * gains ONE additive line, so a surface that only dates an alignment — the `/time` route, which must
 * never load ORT or a graph — imports this directory and nothing else. The same boundary `./dates`
 * draws for the date layer and `./clock` for the preview, and here it is load-bearing rather than
 * tidy: PLAN-TEMPORAL phase 3 is "the half that needs no neural model", and the import graph is
 * what makes that a fact instead of a claim. Nothing under `runtime/src/dating/` imports
 * `manifest.js`, `predict.js`, a session or `tn93-wasm.js`; `dating-port.test.js` asserts it.
 *
 * THE ONE CALL MOST SURFACES MAKE IS `runDating`. The leaves are exported beside it because the
 * page drives them one at a time as the reader edits — `verifyCodingAlignment` and `coverageHoldout`
 * answer "what will this run do to my data" before it runs, `selectClockModel` and
 * `datingTaxonRecords` are testable alone, and `datingJsonText` / `datingCsvText` are the downloads.
 *
 * WHAT IS NOT HERE. `clockRegression.js` and `rootToTip.js` stay where they are, un-reconciled and
 * un-imported by this directory. They are the INDEPENDENT CHECK this port is compared against
 * (read `clockRegression.js`'s header), so folding them in would delete the check; the deliberate
 * duplication of `CLOCK_STATUS`'s three strings between the two is the visible cost of keeping it,
 * and it is worth paying. `dating-port.test.js` runs the two side by side on the same divergences
 * and asserts they agree on every field the preview has, which is the whole point of the exercise.
 */

export {
	DATING_SCHEMA_VERSION,
	DATING_DIAGNOSTIC_CODES,
	DATING_REFUSALS,
	DATING_THRESHOLDS,
	DATING_MESSAGES,
	PREDICTION_METHODS,
	sortDatingWarnings,
	datingWarning
} from './codes.js';
export { verifyCodingAlignment, starsToGaps, coverageHoldout } from './alignment.js';
export { selectClockModel, admitEnsembleCandidates } from './select.js';
export { TAXON_COLUMNS, RECORD_KEYS, datingTaxonRecords, rankTaxonRows, buildDatingRecord } from './record.js';
export { runDating, DATING_CI_METHODS, DATING_DISTANCE_MODES, resolveDistanceMode, NOT_BUILT, NOT_BUILT_WITHOUT_MODEL } from './run.js';
export {
	DATING_NEURAL_MAX_TAXA,
	effectiveRidge,
	fitPgls,
	latentRoot,
	latentRootDescription,
	neuralKernel,
	sliceRows,
	sliceSymmetric
} from './modelFits.js';
export { datingJsonText, datingCsvText, datingDownloads, DATING_FLOAT_KEYS, DATING_INT_KEYS } from './results.js';
