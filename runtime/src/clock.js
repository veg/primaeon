/**
 * clock.js — the barrel of the clock PREVIEW: rooting and root-to-tip walking
 * (`rootToTip.js`) plus the centred ordinary-least-squares fit (`clockRegression.js`).
 *
 * WHY THIS FILE EXISTS. `runtime/package.json` gains a `./clock` subpath so the `/time` route can
 * import the preview without importing the runtime's main entry — which reaches the pipeline, the
 * ONNX sessions and the graph manifest. `/time` never loads a model (its e2e asserts no `*.onnx`
 * and no `ort-*.wasm` is requested), so the import boundary is the mechanism that keeps that true,
 * exactly as `./dates` does for the date layer and `./prescreen` for the gate.
 *
 * NEITHER HALF IS A LIBRARY MIRROR. Both files carry the reason in their own headers: they are the
 * app-side preview that PLAN-TEMPORAL phase 3's port of `run_ols_dating` will be CHECKED against,
 * in the way `nj.js` is app-side and mirrors nothing.
 */

export {
	MIN_POSITIVE_RATIO,
	MIN_DIVERGENCE_SD,
	TREE_REFUSALS,
	parseClockTree,
	leafIndices,
	leafNames,
	branchLengthGate,
	midpointRoot,
	outgroupRoot,
	rootToTipDivergences,
	populationStd,
	treeDivergences
} from './rootToTip.js';

export {
	CLOCK_STATUS,
	CLOCK_REFUSALS,
	MIN_DATED,
	OUTLIER_Z,
	NEGLIGIBLE_RATE,
	NEGLIGIBLE_R2,
	pearson,
	clockRegression,
	rootSensitivity
} from './clockRegression.js';
