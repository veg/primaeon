/**
 * meme-hit-likelihood.test.js — ported from datamonkey3/src/test/meme-hit-likelihood.test.js
 * (main@fac1330), TRIMMED to what the runtime package owns.
 *
 * What is here: scope, feature extraction against the fixtures, the shipped artifact's identity
 * and structure, walker-vs-XGBoost parity on the golden vectors, the walker's refusals, the level
 * boundaries, the input clip, the domain guard, every estimateHitLikelihood status, the
 * recommendation routing, the state-enumeration scope guard, and the reachability guard that
 * proves no ML runtime is importable from the prescreen (with this package's two legitimate
 * optional runtimes allow-listed).
 *
 * What is NOT here, and why: every assertion that read MemeHitLikelihood.svelte — the band copy,
 * the rate phrases, the CSS-inlining rule — belongs to the web app's panel, which is where that
 * copy lives; and the two calibration blocks that score datamonkey-test-corpus TSVs skip without
 * the corpus anyway and pin the panel's prose, so they went with it. DM3's original header
 * follows.
 *
 * Unit tests for the MEME hit-likelihood estimate.
 *
 * Scoring runs through the SHIPPED path — `loadHitLikelihoodModel()` -> xgbEnsemble.js walking
 * XGBoost's own `save_model()` output (meme_gate.json) — which is exactly what the browser
 * executes. There is no converter, no intermediate representation and no ML runtime anywhere in
 * this file, so it runs on any CPU architecture; two suites ago this could not even be COLLECTED on
 * an x64 node, because the ONNX runtime it imported shipped no darwin/x64 binary.
 *
 * FOUR THINGS IN HERE ARE LOAD-BEARING RATHER THAN ROUTINE, and each is marked where it lives:
 *
 *   1. THE GOLDEN VECTORS COME FROM XGBOOST, NOT FROM THIS CODE. golden.fixtures.json is written by
 *      `verify_parity.py --emit-golden`, which scores the shipped file with
 *      `xgboost.Booster.inplace_predict`. If those expectations were ever recorded from the JS
 *      walker the comparison would be circular — it would assert only that the walker is
 *      deterministic — so the file's `generated_from` is asserted here, not just trusted.
 *
 *   2. THE WALKER MUST REFUSE MODELS IT CANNOT SCORE. Deleting the converter deleted the build-time
 *      failure that used to meet an unsupported construct. A walker that just walks returns a
 *      confident wrong number instead, and a researcher cannot tell a correct 0.19 from a 0.19
 *      produced by summing the wrong output group. Every guard rail is exercised.
 *
 *   3. THE COPY HAS TO BE TRUE AT THE OBSERVED RATE. The band names and the sentences under them
 *      make checkable claims ("about 1 in 20"), and the previous gate shipped a band labelled
 *      'unlikely' whose alignments reported a site 72% of the time. Nothing in the old suite
 *      noticed, because nothing in it compared a sentence to an outcome. The calibration block
 *      does exactly that, against real completed MEME jobs.
 *
 *   4. THE ESTIMATE MAY ONLY EVER TALK ABOUT MEME. The model was trained on one label. See the
 *      final describe block for why that is enforced by state enumeration rather than by a grep.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
	hasHitLikelihood,
	treeHasBranchLengths,
	normalizeTreeSource,
	loadHitLikelihoodModel,
	estimateHitLikelihood,
	hitLikelihoodError,
	STATUS,
	MODEL_BASIS,
	HIT_LIKELIHOOD_CAVEAT
} from '../src/prescreen/hitLikelihood.js';
import {
	extractHitLikelihoodFeatures,
	checkFeatureDomain,
	clipModelInput,
	levelOf,
	scoreHitLikelihood,
	runHitLikelihood,
	BRANCH_SPLIT_COUNTS,
	FEATURE_DOMAIN,
	FEATURE_NAMES,
	LIVE_FEATURES,
	LIKELY_MIN,
	UNLIKELY_MAX,
	MODEL_INPUT_CLIP
} from '../src/prescreen/hitLikelihoodModel.js';
import {
	recommendFor,
	substitutionBudget,
	ROUTING
} from '../src/prescreen/recommendation.js';
import {
	prepareXgbModel,
	evalXgbModel,
	parseBaseScore,
	EXPECTED_FEATURES,
	EXPECTED_FEATURE_COUNT
} from '../src/prescreen/xgbEnsemble.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(HERE, '..');
const PRESCREEN = join(HERE, '..', 'src', 'prescreen');
const MODEL_FILE = join(PRESCREEN, 'meme_gate.json');

const featureFixtures = JSON.parse(readFileSync(join(PRESCREEN, 'feature.fixtures.json'), 'utf8'));
const golden = JSON.parse(readFileSync(join(PRESCREEN, 'golden.fixtures.json'), 'utf8'));
const sidecar = JSON.parse(readFileSync(join(PRESCREEN, 'meme_gate.meta.json'), 'utf8'));

/**
 * The shipped model file, read from disk.
 *
 * Read as BYTES and parsed here, deliberately, while `model` below comes through the app's own
 * `import('./meme_gate.json?raw')`. The two are asserted to score identically, which is how the
 * "the bytes the ML team exports are the bytes the browser parses" claim becomes a test rather
 * than a comment: if Vite's handling of the model ever stopped being byte-preserving, these two
 * would diverge.
 */
const modelBytes = readFileSync(MODEL_FILE);
const modelDoc = JSON.parse(modelBytes.toString('utf8'));
const MODEL_SHA256 = createHash('sha256').update(modelBytes).digest('hex');

let model; // the shipped scorer, loaded exactly as the browser loads it
let fromDisk; // the same model, parsed from the file's bytes here

beforeAll(async () => {
	model = await loadHitLikelihoodModel();
	fromDisk = prepareXgbModel(modelDoc);
});

// -------------------------------------------------------------------------------------------
// Scope, tree and source plumbing
// -------------------------------------------------------------------------------------------

describe('method scope', () => {
	it('applies to MEME only (case-insensitive)', () => {
		expect(hasHitLikelihood('meme')).toBe(true);
		expect(hasHitLikelihood('MEME')).toBe(true);
		expect(hasHitLikelihood('fel')).toBe(false);
		expect(hasHitLikelihood('busted')).toBe(false);
		expect(hasHitLikelihood(null)).toBe(false);
	});
});

describe('treeHasBranchLengths', () => {
	it('accepts a tree with positive branch lengths', () => {
		expect(treeHasBranchLengths('((a:0.1,b:0.2):0.05,c:0.3);')).toBe(true);
	});
	it('rejects a topology-only tree', () => {
		expect(treeHasBranchLengths('((a,b),c);')).toBe(false);
	});
	it('rejects empty / non-string input', () => {
		expect(treeHasBranchLengths('')).toBe(false);
		expect(treeHasBranchLengths(null)).toBe(false);
	});
});

describe('normalizeTreeSource', () => {
	it('maps the store keys DM3 actually uses', () => {
		expect(normalizeTreeSource('user')).toBe('user');
		expect(normalizeTreeSource('usertree')).toBe('user');
		expect(normalizeTreeSource('nj')).toBe('inferred-nj');
		expect(normalizeTreeSource(undefined)).toBe('unknown');
	});

	it('maps the D22 tree sources: an embedded tree is the user\'s, and tn93 is the NJ case', () => {
		// PLAN.md §3.5's `tree_source` vocabulary after D22 is 'user' | 'embedded' | 'tn93'. An
		// embedded tree is one the user uploaded, inside the alignment. A tree-free run has only
		// the display NJ tree to offer this estimator, whose branch lengths are the nucleotide
		// distances the 'inferred-nj' caveat is about.
		expect(normalizeTreeSource('embedded')).toBe('user');
		expect(normalizeTreeSource('tn93')).toBe('inferred-nj');
		expect(normalizeTreeSource('hyphy-hky85')).toBe('unknown'); // gone with D22
	});
});

// -------------------------------------------------------------------------------------------
// Feature extraction
// -------------------------------------------------------------------------------------------

describe('feature extraction', () => {
	// Each fixture carries its own derivation in `why`, so the expectations are checkable by
	// reading them rather than by having been recorded from this code. See feature.fixtures.json.
	it('exposes exactly the three features every other artifact declares', () => {
		expect(FEATURE_NAMES).toEqual(['num_seqs', 'num_sites', 'median_pos_dist']);
		expect(EXPECTED_FEATURES).toEqual(FEATURE_NAMES);
		expect(EXPECTED_FEATURE_COUNT).toBe(3);
		expect(featureFixtures._about.features).toEqual(FEATURE_NAMES);
		expect(sidecar.features).toEqual(FEATURE_NAMES);
		expect(golden.features).toEqual(FEATURE_NAMES);
	});

	for (const fx of featureFixtures.cases) {
		it(`matches on fixture: ${fx.name}`, () => {
			const got = extractHitLikelihoodFeatures(fx.alignment, fx.tree);
			// Width is asserted, not assumed. The previous suite indexed got[3] against a fixture that
			// no longer had a 4th element, so `undefined === undefined` passed and the assertion had
			// quietly stopped testing anything.
			expect(got).toHaveLength(FEATURE_NAMES.length);
			expect(got[0]).toBe(fx.expected[0]); // num_seqs
			expect(got[1]).toBe(fx.expected[1]); // num_sites
			expect(Math.abs(got[2] - fx.expected[2])).toBeLessThan(1e-12); // median_pos_dist
		});
	}
});

// -------------------------------------------------------------------------------------------
// The artifact: what is shipped, and that it is what everything else says it is
// -------------------------------------------------------------------------------------------

describe('the shipped model artifact', () => {
	it('is the file the golden fixtures were generated from', () => {
		// Hash the bytes on disk rather than pattern-matching the field. A /^[0-9a-f]{64}$/ check
		// passes for ANY hash, so it would not notice fixtures regenerated against a different model
		// than the one sitting next to them — the single failure this pin exists to catch.
		expect(golden.model_sha256).toBe(MODEL_SHA256);
	});

	it('declares itself as an XGBoost binary:logistic gbtree with three inputs', () => {
		expect(model.meta.objective).toBe('binary:logistic');
		expect(model.meta.booster).toBe('gbtree');
		expect(model.meta.features).toEqual(FEATURE_NAMES);
		expect(model.meta.nTrees).toBe(500);
		expect(model.backend).toBe('js');
	});

	it('matches the structure BRANCH_SPLIT_COUNTS claims, read from the model rather than memory', () => {
		// hitLikelihoodModel.js writes these down for the UI to disclose. Asserting the constant
		// against the model's own recomputed counts is what stops the pair drifting into agreeing on
		// a stale number: a retrain that moves the model's attention between features fails here
		// instead of silently making the disclosure false.
		expect(BRANCH_SPLIT_COUNTS).toEqual(model.meta.splitCountsByFeature);
		// And every feature is live — there is no inert padding slot any more.
		for (const name of FEATURE_NAMES) {
			expect(model.meta.splitCountsByFeature[name]).toBeGreaterThan(0);
		}
		expect(LIVE_FEATURES).toEqual(FEATURE_NAMES);
	});

	it('routes no node on missing input, which is why the walker may refuse NaN', () => {
		// evalXgbModel deliberately does not implement default_left. That is only safe while nothing
		// in the model depends on it; this is the assertion that makes the choice reviewable rather
		// than a comment nobody re-checks after a retrain.
		expect(model.meta.defaultLeftNodes).toBe(0);
	});

	it('agrees with the same file read straight off disk', () => {
		// `model` came through the app's `import('./meme_gate.json?raw')`; `fromDisk` came through
		// readFileSync. Equal scores mean the bundler handed the browser the artifact's own bytes.
		for (const v of golden.vectors) {
			expect(model.score(v.input)).toBe(evalXgbModel(fromDisk, v.input));
		}
	});

	it('carries a sidecar whose clip matches the one the app applies', () => {
		expect(sidecar.bl_floor).toBe(MODEL_INPUT_CLIP.median_pos_dist.floor);
		expect(sidecar.bl_cap).toBe(MODEL_INPUT_CLIP.median_pos_dist.cap);
	});
});

// -------------------------------------------------------------------------------------------
// Parity with XGBoost, via fixtures XGBoost itself wrote
// -------------------------------------------------------------------------------------------

describe('model parity (the JS walker vs XGBoost, on the same bytes)', () => {
	it('was generated from XGBoost and not from the code under test', () => {
		// The one property that decides whether this whole block means anything. Fixtures recorded
		// from the JS walker would assert only that the walker is deterministic.
		expect(golden.generated_from).toBe('xgboost:meme_gate.json');
		expect(golden.generator).toMatch(/verify_parity\.py/);
		expect(golden.xgboost_version).toMatch(/^\d+\.\d+/);
	});

	it('reproduces every golden vector within 1e-6', () => {
		let maxDiff = 0;
		let worst = null;
		for (const v of golden.vectors) {
			const d = Math.abs(evalXgbModel(fromDisk, v.input) - v.expected_prob);
			if (d > maxDiff) {
				maxDiff = d;
				worst = v.input;
			}
		}
		expect(maxDiff, `worst vector ${JSON.stringify(worst)}`).toBeLessThan(1e-6);
	});

	it('puts every golden vector in the band XGBoost puts it in', () => {
		// The binding assertion. The delta above is decorative by comparison: a researcher reads the
		// band, never the number, so agreement on the band is the claim worth making.
		for (const v of golden.vectors) {
			expect(levelOf(evalXgbModel(fromDisk, v.input)), JSON.stringify(v.input)).toBe(
				v.expected_level
			);
		}
	});

	it('covers both band cuts from both sides', () => {
		// Fixtures that only sample the flat middle of a band cannot fail on a routing bug small
		// enough to be plausible. These are the vectors that can.
		for (const cut of [UNLIKELY_MAX, LIKELY_MIN]) {
			const near = golden.vectors.filter((v) => Math.abs(v.expected_prob - cut) < 1e-3);
			expect(near.filter((v) => v.expected_prob < cut).length, `below ${cut}`).toBeGreaterThan(0);
			expect(near.filter((v) => v.expected_prob >= cut).length, `above ${cut}`).toBeGreaterThan(0);
		}
	});

	it('covers values sitting exactly on the model’s own split thresholds', () => {
		// XGBoost routes `value < threshold` LEFT, so a value ON a threshold goes RIGHT. `<=` differs
		// ONLY on these rows — which is why a comparison-operator bug survives any amount of random
		// testing and is caught here with certainty. Thresholds are read out of the model, not
		// hard-coded, so this cannot rot into checking stale numbers.
		const thresholds = FEATURE_NAMES.map(() => new Set());
		for (const t of modelDoc.learner.gradient_booster.model.trees) {
			for (let i = 0; i < t.left_children.length; i++) {
				if (t.left_children[i] !== -1) {
					thresholds[t.split_indices[i]].add(Math.fround(t.split_conditions[i]));
				}
			}
		}
		const onThreshold = golden.vectors.filter((v) =>
			v.input.every((x, f) => thresholds[f].has(Math.fround(x)))
		);
		expect(onThreshold.length).toBeGreaterThanOrEqual(3);

		// And prove the coverage is not decorative: flipping `<` to `<=` must move at least one of
		// them. Re-walked here with the opposite comparison, over the same compiled trees.
		const flipped = (m, features) => {
			const x = features.map(Math.fround);
			let margin = m.base;
			for (const t of m.trees) {
				let i = 0;
				while (t.left[i] !== -1) i = x[t.feat[i]] <= t.thr[i] ? t.left[i] : t.right[i];
				margin += t.thr[i];
			}
			return 1 / (1 + Math.exp(-margin));
		};
		const moved = onThreshold.filter(
			(v) => Math.abs(flipped(fromDisk, v.input) - v.expected_prob) > 1e-6
		);
		expect(
			moved.length,
			'no on-threshold vector distinguishes `<` from `<=` — the fixtures cannot catch the ' +
				'comparison bug they exist for'
		).toBe(onThreshold.length);
	});

	it('scores the same through the loaded scorer as through the raw walker', () => {
		// model.score() applies MODEL_INPUT_CLIP first. It is inert on this fixture set — every
		// median sits inside [floor, cap] — so the two must agree EXACTLY, and any future fixture
		// that breaks that assumption fails the guard below rather than this comparison.
		const { floor, cap } = MODEL_INPUT_CLIP.median_pos_dist;
		for (const v of golden.vectors) {
			expect(v.input[2], JSON.stringify(v.input)).toBeGreaterThanOrEqual(floor);
			expect(v.input[2], JSON.stringify(v.input)).toBeLessThanOrEqual(cap);
			expect(model.score(v.input)).toBe(evalXgbModel(fromDisk, v.input));
		}
	});
});

// -------------------------------------------------------------------------------------------
// base_score, the one field that scales every score in the model
// -------------------------------------------------------------------------------------------

describe('parseBaseScore', () => {
	it('reads the bracketed string form XGBoost 3.4 actually writes', () => {
		// The trap the ML team's own walker fell into: parseFloat("[8.516667E-1]") is NaN.
		expect(parseBaseScore('[8.516667E-1]')).toBeCloseTo(0.8516667, 12);
		expect(parseBaseScore(' [0.5] ')).toBe(0.5);
	});

	it('reads the plain-number form older writers emit', () => {
		expect(parseBaseScore(0.25)).toBe(0.25);
	});

	it('refuses a multi-component intercept rather than taking the first element', () => {
		expect(() => parseBaseScore('[0.3,0.3,0.4]')).toThrow(/components/i);
	});

	it('refuses a truncated number rather than returning a plausible prefix', () => {
		// parseFloat("8.516667E-") would return 8.516667. This must not.
		expect(() => parseBaseScore('[8.516667E-]')).toThrow(/not a number/i);
		expect(() => parseBaseScore('[]')).toThrow(/not a number/i);
		expect(() => parseBaseScore('[0x1p-1]')).toThrow(/not a number/i);
	});

	it('refuses an intercept outside (0, 1), where the logit is infinite', () => {
		expect(() => parseBaseScore('[0]')).toThrow(/outside/i);
		expect(() => parseBaseScore('[1]')).toThrow(/outside/i);
		expect(() => parseBaseScore('[-0.2]')).toThrow(/outside/i);
	});

	it('refuses a missing or wrong-typed field', () => {
		expect(() => parseBaseScore(undefined)).toThrow(/missing/i);
		expect(() => parseBaseScore(null)).toThrow(/expected a number/i);
	});

	it('agrees with what the shipped model declares', () => {
		expect(model.meta.baseScore).toBe(
			parseBaseScore(modelDoc.learner.learner_model_param.base_score)
		);
	});
});

// -------------------------------------------------------------------------------------------
// Guard rails: the walker REFUSES a model it cannot score, rather than scoring it wrongly
// -------------------------------------------------------------------------------------------

describe('the walker refuses a malformed model', () => {
	/**
	 * Clone only along `path`, so a 500-tree / 9,546-node document is not deep-copied once per
	 * mutant. Everything off the path stays shared by reference, which is also what lets the
	 * "structurally intact" assertions below be a cheap identity check.
	 */
	function patch(root, path, value) {
		const out = Array.isArray(root) ? root.slice() : { ...root };
		let node = out;
		for (let i = 0; i < path.length - 1; i++) {
			const k = path[i];
			node[k] = Array.isArray(node[k]) ? node[k].slice() : { ...node[k] };
			node = node[k];
		}
		node[path[path.length - 1]] = value;
		return out;
	}

	const LEARNER = ['learner'];
	const LMP = [...LEARNER, 'learner_model_param'];
	const GBM = [...LEARNER, 'gradient_booster', 'model'];
	const TREE0 = [...GBM, 'trees', 0];

	it('accepts the pristine model — the control for everything below', () => {
		expect(() => prepareXgbModel(modelDoc)).not.toThrow();
	});

	/**
	 * Each case is a construct the walker would otherwise score WITHOUT ERROR and WRONGLY. The
	 * message pattern is asserted, not just the throw: a refusal for the wrong reason is not a
	 * passing test, and it is the difference between a guard and a coincidence.
	 */
	const REFUSALS = [
		// --- multi-class: the walker sums ONE tree group; K groups produce a plausible number with
		// --- no meaning at all.
		[
			'multi-class (declared)',
			patch(modelDoc, [...LMP, 'num_class'], '3'),
			/num_class=3|multi-class/i
		],
		[
			'multi-class (structural, via tree_info)',
			patch(
				modelDoc,
				[...GBM, 'tree_info'],
				modelDoc.learner.gradient_booster.model.tree_info.map((g, i) => (i % 2 ? 1 : g))
			),
			/output group|multi-class/i
		],
		['multi-output', patch(modelDoc, [...LMP, 'num_target'], '2'), /multi-output/i],

		// --- categorical splits: split_conditions stops being a threshold and becomes an index into
		// --- a bitset. Comparing a feature against that index is nonsense that still routes.
		[
			'categorical split (split_type)',
			patch(
				modelDoc,
				[...TREE0, 'split_type'],
				modelDoc.learner.gradient_booster.model.trees[0].split_type.map((s, i) => (i === 0 ? 1 : s))
			),
			/categorical/i
		],
		[
			'categorical split (categories_nodes)',
			patch(modelDoc, [...TREE0, 'categories_nodes'], [0]),
			/categorical/i
		],
		[
			'categorical encoding table (cats.enc)',
			patch(modelDoc, [...GBM, 'cats'], {
				enc: [{ values: [1, 2, 3] }],
				feature_segments: [],
				sorted_idx: []
			}),
			/categorical/i
		],

		// --- arity: silent in BOTH directions, so it has to be declared and checked.
		['a four-feature retrain', patch(modelDoc, [...LMP, 'num_feature'], '4'), /4 features/i],
		[
			'reordered feature_names',
			patch(modelDoc, [...LEARNER, 'feature_names'], ['num_sites', 'num_seqs', 'median_pos_dist']),
			/feature ORDER is frozen/i
		],

		// --- dropout: xgboost 3.4 still labels these gbtree. The only trace is weight_drop, applied
		// --- at predict time; summing leaves without it is wrong by ~0.2 in probability.
		[
			'DART / rate_drop weights',
			patch(
				modelDoc,
				[...GBM, 'weight_drop'],
				Array.from({ length: 500 }, (_, i) => (i % 3 ? 1 : 0.4))
			),
			/dropout|weight_drop|DART/i
		],

		// --- objective and booster: the output transform is objective-specific, and a wrong one
		// --- still returns a number in [0, 1] that looks exactly like a probability.
		[
			'a regression objective',
			patch(modelDoc, [...LEARNER, 'objective'], { name: 'reg:squarederror' }),
			/objective/i
		],
		[
			'binary:logitraw (sigmoid already applied by the caller)',
			patch(modelDoc, [...LEARNER, 'objective'], { name: 'binary:logitraw' }),
			/objective/i
		],
		[
			'a linear booster',
			patch(modelDoc, [...LEARNER, 'gradient_booster'], { name: 'gblinear', model: {} }),
			/booster/i
		],

		// --- forest / vector-leaf modes change what a leaf MEANS.
		[
			'random-forest mode (trees averaged, not summed)',
			patch(modelDoc, [...GBM, 'gbtree_model_param', 'num_parallel_tree'], '4'),
			/num_parallel_tree|forest/i
		],
		[
			'vector leaves',
			patch(modelDoc, [...TREE0, 'tree_param', 'size_leaf_vector'], '2'),
			/size_leaf_vector|vector leaves/i
		],

		// --- topology: a child index past the end reads `undefined` and compares false forever; a
		// --- child index of 0 is a cycle back to the root, which would hang the browser.
		[
			'a child index past the end of the tree',
			patch(
				modelDoc,
				[...TREE0, 'right_children'],
				modelDoc.learner.gradient_booster.model.trees[0].right_children.map((r, i) =>
					i === 0 ? 999999 : r
				)
			),
			/out of range/i
		],
		[
			'a child index that cycles back to the root',
			patch(
				modelDoc,
				[...TREE0, 'left_children'],
				modelDoc.learner.gradient_booster.model.trees[0].left_children.map((l, i) =>
					i === 0 ? 0 : l
				)
			),
			/out of range/i
		],
		[
			'a half-leaf (one child -1, one not)',
			patch(
				modelDoc,
				[...TREE0, 'right_children'],
				modelDoc.learner.gradient_booster.model.trees[0].right_children.map((r, i) =>
					i === 0 ? -1 : r
				)
			),
			/one child set to -1/i
		],

		// --- provenance / version.
		// Both ends of the supported range, because they fail for different reasons and only one of
		// them is about a layout nobody has seen yet.
		['a future format major', patch(modelDoc, ['version'], [4, 0, 0]), /major version/i],
		[
			// The dangerous end. Before XGBoost 2, base_score is serialised in MARGIN space, so the
			// walker's logit() would be applied to an already-logitted number and every score in the
			// model shifts. parseBaseScore's (0, 1) guard catches only the half of that range outside
			// (0, 1); the half INSIDE it — like this 0.3 — is accepted and scores confidently wrong.
			// Measured with the version guard widened to admit 1.x: this document scores
			// [50, 200, 0.02] at 0.6135 ('uncertain') against the shipped model's 0.9551 ('likely').
			'a version-1 export, where base_score is a margin rather than a probability',
			patch(patch(modelDoc, ['version'], [1, 7, 6]), [...LMP, 'base_score'], '0.3'),
			/written by XGBoost 1\.7\.6/
		],
		['no version array at all', patch(modelDoc, ['version'], undefined), /version/i],
		[
			'a base_score the walker will not guess at',
			patch(modelDoc, [...LMP, 'base_score'], '[0.3,0.3,0.4]'),
			/components/i
		]
	];

	for (const [name, doc, pattern] of REFUSALS) {
		it(`refuses ${name}`, () => {
			expect(() => prepareXgbModel(doc)).toThrow(pattern);
		});
	}

	it('refuses models that are otherwise perfectly walkable', () => {
		// The point of the guards. For the metadata-only mutants the TREE ARRAYS ARE UNTOUCHED — the
		// same objects by reference — so nothing about the file stops a walker from producing a
		// confident number from them. It is the check that stops it, not a structural break.
		const trees = modelDoc.learner.gradient_booster.model.trees;
		for (const [name, doc] of REFUSALS.filter(([n]) =>
			/declared|multi-output|four-feature|DART|regression objective|logitraw|forest/.test(n)
		)) {
			expect(doc.learner.gradient_booster.model?.trees, name).toBe(trees);
		}
	});

	it('refuses a row of the wrong width rather than scoring it', () => {
		// Silent in both directions on a bare walk: a 4-wide row never touches the extra slot, and a
		// 2-wide row routes every split on the missing feature by `undefined < threshold` (false),
		// i.e. consistently right. Neither errors, and neither is detectable from the output.
		expect(() => evalXgbModel(fromDisk, [50, 200, 0.02, 1.0])).toThrow(/3 features/);
		expect(() => evalXgbModel(fromDisk, [50, 200])).toThrow(/3 features/);
		expect(() => evalXgbModel(fromDisk, [])).toThrow(/3 features/);
		expect(() => evalXgbModel(fromDisk, null)).toThrow(/3 features/);
	});

	it('refuses non-finite input instead of routing it as missing', () => {
		// The walker does not implement default_left. A NaN here means feature extraction is broken,
		// and the only correct response to that is an exception — the old evaluator ROUTED
		// (NaN, NaN, NaN) and returned 0.99997, i.e. a parse failure rendered as "99%, run MEME".
		for (const bad of [NaN, Infinity, -Infinity, null, undefined, '50']) {
			expect(() => evalXgbModel(fromDisk, [bad, 200, 0.02]), String(bad)).toThrow();
			expect(() => evalXgbModel(fromDisk, [50, 200, bad]), String(bad)).toThrow();
		}
	});

	it('names meme_gate.json in every refusal, so a failure is traceable to the artifact', () => {
		expect(() => prepareXgbModel({})).toThrow(/meme_gate\.json/);
		expect(() => prepareXgbModel(null)).toThrow(/meme_gate\.json/);
	});
});

// -------------------------------------------------------------------------------------------
// Bands and the input clip
// -------------------------------------------------------------------------------------------

describe('level boundaries', () => {
	it('likely >= 0.70, unlikely < 0.10, uncertain between', () => {
		expect(LIKELY_MIN).toBe(0.7);
		expect(UNLIKELY_MAX).toBe(0.1);
		expect(levelOf(1)).toBe('likely');
		expect(levelOf(0.7)).toBe('likely');
		expect(levelOf(0.6999999)).toBe('uncertain');
		expect(levelOf(0.1)).toBe('uncertain');
		expect(levelOf(0.0999999)).toBe('unlikely');
		expect(levelOf(0)).toBe('unlikely');
	});

	it('is the same cut the golden fixtures were labelled at', () => {
		expect(golden.likely_min).toBe(LIKELY_MIN);
		expect(golden.unlikely_max).toBe(UNLIKELY_MAX);
	});
});

describe('MODEL_INPUT_CLIP', () => {
	it('reproduces the training pipeline bounds and is idempotent', () => {
		expect(clipModelInput([50, 200, 0.0005])[2]).toBe(0.001);
		expect(clipModelInput([50, 200, 50])[2]).toBe(10.0);
		expect(clipModelInput([50, 200, 0.02])[2]).toBe(0.02);
		const once = clipModelInput([50, 200, 0.0005]);
		expect(clipModelInput(once)).toEqual(once);
		// It clips the median only — the other two features pass through untouched.
		expect(clipModelInput([50, 200, 0.02]).slice(0, 2)).toEqual([50, 200]);
	});

	it('leaves non-finite values for the domain guard rather than clamping them to a plausible number', () => {
		expect(clipModelInput([50, 200, NaN])[2]).toBeNaN();
	});

	it('is currently inert, which is a fact about THIS model and is re-derived here', () => {
		// hitLikelihoodModel.js claims the clip cannot change a route because the floor sits below
		// the model's lowest median_pos_dist split and the cap above its highest. The margin at the
		// floor is 0.001 vs 0.00102927 — one retrain from being load-bearing — so the claim is
		// measured from the model rather than repeated.
		const f = FEATURE_NAMES.indexOf('median_pos_dist');
		let lo = Infinity;
		let hi = -Infinity;
		for (const t of modelDoc.learner.gradient_booster.model.trees) {
			for (let i = 0; i < t.left_children.length; i++) {
				if (t.left_children[i] !== -1 && t.split_indices[i] === f) {
					lo = Math.min(lo, t.split_conditions[i]);
					hi = Math.max(hi, t.split_conditions[i]);
				}
			}
		}
		const { floor, cap } = MODEL_INPUT_CLIP.median_pos_dist;
		expect(floor, `lowest median_pos_dist split is ${lo}`).toBeLessThan(lo);
		expect(cap, `highest median_pos_dist split is ${hi}`).toBeGreaterThan(hi);
	});
});

// -------------------------------------------------------------------------------------------
// Domain guard
// -------------------------------------------------------------------------------------------

describe('out-of-distribution guard', () => {
	const feat = (seqs, sites, dist) => [seqs, sites, dist];

	it('accepts a vector inside the fitted range', () => {
		expect(checkFeatureDomain(feat(50, 200, 0.02)).ok).toBe(true);
	});

	it('rejects a tree whose branch lengths are not substitutions/site', () => {
		// A time-calibrated tree, in millions of years. Past the training pipeline's cap, so the
		// model has never been shown anything like it and the units are almost certainly wrong.
		const d = checkFeatureDomain(feat(20, 300, 12.5));
		expect(d.ok).toBe(false);
		expect(d.reasons[0]).toMatchObject({ feature: 'median_pos_dist', code: 'above-max' });
		expect(d.summary).toContain('not measured in substitutions per site');
	});

	it('rejects the median = 0 sentinel rather than scoring it', () => {
		const d = checkFeatureDomain(feat(50, 200, 0));
		expect(d.ok).toBe(false);
		expect(d.reasons[0].code).toBe('missing');
	});

	it('rejects non-finite features', () => {
		const d = checkFeatureDomain(feat(NaN, 200, 0.02));
		expect(d.ok).toBe(false);
		expect(d.reasons[0].code).toBe('non-finite');
	});

	it('rejects vectors below the input-validity floor', () => {
		expect(checkFeatureDomain(feat(2, 200, 0.02)).reasons[0].code).toBe('below-min');
		expect(checkFeatureDomain(feat(50, 0, 0.02)).reasons[0].code).toBe('below-min');
	});

	it('saturates rather than refusing above the split support', () => {
		// v2's guard is input-validity only: the model is monotone BY CONSTRUCTION, so past its
		// topmost splits it pins at a ceiling instead of returning an arbitrary memorised leaf.
		// Fencing the support instead would refuse a quarter of real submissions, in the population
		// where the model is most nearly right.
		expect(checkFeatureDomain(feat(5000, 20000, 0.02)).ok).toBe(true);
		expect(FEATURE_DOMAIN.num_seqs.max).toBeNull();
		expect(FEATURE_DOMAIN.num_sites.max).toBeNull();
		const ceiling = model.score([298, 3687, 0.4023226]);
		expect(model.score([2980, 36870, 0.4023226])).toBe(ceiling);
	});

	it('never scores an out-of-domain vector', async () => {
		const res = await runHitLikelihood(
			'>a\n' + 'ATG'.repeat(300) + '\n>b\n' + 'ATG'.repeat(300) + '\n',
			'(a:12.0,b:14.0);',
			model
		);
		expect(res.status).toBe(STATUS.CANNOT_ASSESS);
		expect(res.hit_probability).toBeNull();
		expect(res.level).toBeNull();
	});

	it('documents a cap no wider than the training pipeline it cites', () => {
		expect(FEATURE_DOMAIN.median_pos_dist.max).toBeLessThanOrEqual(sidecar.bl_cap);
	});
});

// -------------------------------------------------------------------------------------------
// The estimate as a whole
// -------------------------------------------------------------------------------------------

describe('estimateHitLikelihood statuses', () => {
	// A comfortably in-domain submission: 20 taxa, 100 codons, medium branch lengths.
	const seqs = Array.from({ length: 20 }, (_, i) => `>t${i}\n${'ATGACTGGTCCC'.repeat(25)}`);
	const bigAln = seqs.join('\n') + '\n';
	const bigTree = '(' + Array.from({ length: 20 }, (_, i) => `t${i}:0.08`).join(',') + ');';

	it('never returns null, and says which case it is', async () => {
		for (const args of [
			{ method: 'fel', alignment: bigAln, tree: bigTree },
			{ method: 'meme', alignment: '', tree: bigTree },
			{ method: 'meme', alignment: bigAln, tree: '((a,b),c);' },
			{ method: 'meme', alignment: bigAln, tree: bigTree }
		]) {
			const res = await estimateHitLikelihood({ ...args, model });
			expect(res).not.toBeNull();
			expect(Object.values(STATUS)).toContain(res.status);
			expect(res.caveat).toBe(HIT_LIKELIHOOD_CAVEAT);
			expect(res.basis).toBe(MODEL_BASIS);
		}
	});

	it('is not-applicable for a non-MEME method', async () => {
		const res = await estimateHitLikelihood({
			method: 'fel',
			alignment: bigAln,
			tree: bigTree,
			model
		});
		expect(res.status).toBe(STATUS.NOT_APPLICABLE);
		expect(res.reason).toBe('method-not-supported');
	});

	it('is not-applicable with no alignment', async () => {
		const res = await estimateHitLikelihood({
			method: 'meme',
			alignment: '',
			tree: bigTree,
			model
		});
		expect(res.status).toBe(STATUS.NOT_APPLICABLE);
		expect(res.reason).toBe('no-alignment');
	});

	it('cannot-assess (with a reason) on a topology-only tree', async () => {
		const res = await estimateHitLikelihood({
			method: 'meme',
			alignment: bigAln,
			tree: '((a,b),c);',
			model
		});
		expect(res.status).toBe(STATUS.CANNOT_ASSESS);
		expect(res.reason).toBe('no-branch-lengths');
		expect(res.detail).toBeTruthy();
		expect(res.hit_probability).toBeNull();
	});

	it('returns a populated ok result for a real MEME submission', async () => {
		const res = await estimateHitLikelihood({
			method: 'meme',
			alignment: bigAln,
			tree: bigTree,
			treeSource: 'user',
			model
		});
		expect(res.status).toBe(STATUS.OK);
		expect(['likely', 'uncertain', 'unlikely']).toContain(res.level);
		expect(res.hit_probability).toBeGreaterThanOrEqual(0);
		expect(res.hit_probability).toBeLessThanOrEqual(1);
		expect(res.level).toBe(levelOf(res.hit_probability));
		expect(res.num_seqs).toBe(20);
		expect(res.num_sites).toBe(100);
		expect(res.recommend_run).toBe(res.level !== 'unlikely');
		// The routing is surfaced, not computed and dropped on the floor.
		expect(res.recommendation).not.toBeNull();
		expect(res.recommendation.message).toBeTruthy();
		expect(res.budget.branches).toBe(37);
		expect(res.tree_source).toBe('user');
		expect(res.tree_source_caveat).toBeNull();
	});

	it('discloses that an inferred NJ tree makes the estimate optimistic', async () => {
		const res = await estimateHitLikelihood({
			method: 'meme',
			alignment: bigAln,
			tree: bigTree,
			treeSource: 'nj',
			model
		});
		expect(res.tree_source).toBe('inferred-nj');
		expect(res.tree_source_caveat).toContain('neighbour-joining');
	});

	it('reports an error status instead of a blank when the scorer throws', async () => {
		const broken = {
			backend: 'js',
			score: () => {
				throw new Error('boom');
			}
		};
		const res = await estimateHitLikelihood({
			method: 'meme',
			alignment: bigAln,
			tree: bigTree,
			model: broken
		});
		expect(res.status).toBe(STATUS.ERROR);
		expect(res.detail).toBeTruthy();
		// Still reports what it managed to read, so the failure is inspectable.
		expect(res.num_seqs).toBe(20);
	});

	it('exposes an error result for a scorer that never loaded', () => {
		const res = hitLikelihoodError('nope');
		expect(res.status).toBe(STATUS.ERROR);
		expect(res.detail).toBe('nope');
		expect(res.level).toBeNull();
	});

	it('refuses to score without a scorer rather than inventing one', async () => {
		await expect(scoreHitLikelihood([50, 200, 0.02], null)).rejects.toThrow(/scorer/i);
	});

	it('is monotone in all three features, which is what the disclosure promises', () => {
		// "Adding sequences, adding codons, or deeper branches can raise it and never lower it" is a
		// user-facing sentence, and the panel now says it holds at EVERY input the model can score.
		//
		// The constraint that makes it true (monotone_constraints=(1,1,1)) is NOT in the artifact:
		// Booster.save_model() does not persist it, so it cannot be asserted from the file and the
		// sidecar's copy of it is free text nothing reads. The property therefore has to be measured.
		//
		// A tree ensemble can only change its answer at a split threshold, so the axis under test
		// walks every DISTINCT threshold of that feature — read out of the model, not hard-coded —
		// plus one float32 step either side of each, crossed with a spread of holdouts on the other
		// two. That is every routing-distinct value on each axis: a break anywhere in the reachable
		// input space has to appear between two adjacent points of this sweep. The 18-evaluation
		// version of this test that walked one ray from [10, 100, 0.01] could not have seen one.
		//
		// verify_parity.py's SHAPE section runs the same sweep against xgboost itself, so the model
		// and the walker are each checked by the implementation that is not being tested.
		const thresholds = FEATURE_NAMES.map(() => new Set());
		for (const t of modelDoc.learner.gradient_booster.model.trees) {
			for (let i = 0; i < t.left_children.length; i++) {
				if (t.left_children[i] !== -1) {
					thresholds[t.split_indices[i]].add(Math.fround(t.split_conditions[i]));
				}
			}
		}
		const HOLDOUTS = [
			[4, 10, 50, 300],
			[20, 200, 1000, 3000],
			[0.001, 0.01, 0.1, 1.0]
		];
		const step = (v, dir) => {
			// One float32 ULP either side, so the pair straddles the threshold exactly the way the
			// walker's `<` sees it.
			const buf = new Float32Array([v]);
			const bits = new Int32Array(buf.buffer);
			bits[0] += v >= 0 ? dir : -dir;
			return buf[0];
		};
		let pairs = 0;
		for (let f = 0; f < FEATURE_NAMES.length; f++) {
			const axis = [...thresholds[f]]
				.flatMap((v) => [step(v, -1), v, step(v, 1)])
				.filter((v, i, a) => a.indexOf(v) === i)
				.sort((a, b) => a - b);
			const [o1, o2] = [0, 1, 2].filter((i) => i !== f);
			for (const a of HOLDOUTS[o1]) {
				for (const b of HOLDOUTS[o2]) {
					let previous = -Infinity;
					for (const x of axis) {
						const row = [];
						row[f] = x;
						row[o1] = a;
						row[o2] = b;
						const score = model.score(row);
						expect(
							score,
							`${FEATURE_NAMES[f]}=${x} (others ${a}, ${b}) scored below ${FEATURE_NAMES[f]} one step lower`
						).toBeGreaterThanOrEqual(previous);
						previous = score;
						pairs++;
					}
				}
			}
		}
		// The sweep has to be big enough to mean something — a threshold set that came back empty
		// would make every assertion above vacuous.
		expect(pairs).toBeGreaterThan(5000);
	});
});

describe('substitutionBudget', () => {
	it('counts unrooted binary branches and multiplies through', () => {
		const b = substitutionBudget({ num_seqs: 10, num_sites: 100, median_pos_dist: 0.05 });
		expect(b.branches).toBe(17);
		expect(b.per_site).toBeCloseTo(0.85, 10);
		expect(b.total).toBeCloseTo(85, 10);
	});
});

describe('recommendation routing', () => {
	const res = (level, num_seqs, num_sites, median_pos_dist) => ({
		level,
		num_seqs,
		num_sites,
		median_pos_dist
	});

	it('says nothing to change when MEME is the right tool', () => {
		const r = recommendFor(res('likely', 100, 300, 0.05));
		expect(r.action).toBeNull();
		expect(r.caveat).toBe(HIT_LIKELIHOOD_CAVEAT);
	});

	it('has no action to offer on a borderline alignment', () => {
		// Scope discipline: this model was trained on one label — did MEME report a site. It has no
		// evidence about any other method, so it must not claim what they would find.
		const r = recommendFor(res('uncertain', 50, 200, 0.02));
		expect(r.action).toBeNull();
		expect(r.message).toMatch(/MEME/);
	});

	it('says what about the DATA would change the answer when the alignment is too thin', () => {
		// The demo-fixture shape: 10 taxa, 17 codons.
		const r = recommendFor(res('unlikely', 10, 17, 0.03));
		expect(r.action).toBeNull();
		expect(r.message).toMatch(/more divergent/i);
		expect(r.budget.total).toBeLessThan(ROUTING.totalSubsFloor);
	});

	it('distinguishes a thin total from thin-per-site', () => {
		const thinTotal = recommendFor(res('unlikely', 10, 17, 0.03));
		const thinPerSite = recommendFor(res('unlikely', 40, 500, 0.05));
		expect(thinTotal.message).not.toBe(thinPerSite.message);
		expect(thinPerSite.budget.total).toBeGreaterThanOrEqual(ROUTING.totalSubsFloor);
	});

	it('only names the Resample control when the caller says it is on screen', () => {
		const args = res('unlikely', 40, 500, 0.05);
		expect(recommendFor(args).secondary.some((s) => s.action.kind === 'set-option')).toBe(false);
		expect(
			recommendFor(args, { resampleAvailable: true }).secondary.some(
				(s) => s.action.kind === 'set-option'
			)
		).toBe(true);
	});

	it('never names another analysis method, at any level', () => {
		// The regression guard for this whole scope decision. If someone reintroduces routing, this
		// fails before it reaches a researcher.
		const others = /\b(BUSTED|aBSREL|FUBAR|FEL|SLAC|PRIME|RELAX|GARD|BGM|FADE)\b/i;
		const all = [
			recommendFor(res('likely', 100, 300, 0.05)),
			recommendFor(res('uncertain', 50, 200, 0.02)),
			recommendFor(res('unlikely', 10, 17, 0.03)),
			recommendFor(res('unlikely', 8, 400, 0.3)),
			recommendFor(res('unlikely', 40, 500, 0.05), { resampleAvailable: true })
		];
		for (const r of all) {
			const text = [r.message, r.caveat, ...r.secondary.map((s) => s.message)].join(' ');
			expect(text).not.toMatch(others);
			expect([r.action, ...r.secondary.map((s) => s.action)].filter(Boolean)).not.toContainEqual(
				expect.objectContaining({ kind: 'switch-method' })
			);
		}
	});
});

describe('copy', () => {
	it('states what the estimate is not', () => {
		expect(HIT_LIKELIHOOD_CAVEAT).toContain('not whether this gene is under selection');
	});
});

describe('scope: the estimate only ever talks about MEME', () => {
	// WHY THIS EXISTS. The model was trained on a single label — did a MEME run report at least one
	// selected site. It has never scored BUSTED, aBSREL, FUBAR or anything else, so any sentence
	// about another method is the author's judgement wearing the model's authority, and a reader
	// cannot tell the two apart. An earlier version shipped five such sentences ("BUSTED can detect
	// selection here", "FUBAR holds up better than MEME here"). A human caught them; nothing in the
	// suite did.
	//
	// So this walks every state the estimate can reach and asserts no other analysis method is named
	// in anything a user can read. It is deliberately state-enumeration rather than a grep of the
	// source: a new string in a new file is still covered, as long as some state renders it.
	const OTHER_METHODS =
		/\b(BUSTED|aBSREL|FUBAR|FEL|SLAC|PRIME|RELAX|BGM|GARD|FADE|Contrast-FEL|MULTI-HIT|NRM)\b/i;

	const seqs = Array.from({ length: 20 }, (_, i) => `>t${i}\n${'ATGACTGGTCCC'.repeat(25)}`);
	const bigAln = seqs.join('\n') + '\n';
	const bigTree = '(' + Array.from({ length: 20 }, (_, i) => `t${i}:0.08`).join(',') + ');';
	// 5 taxa x 100 codons, median branch length 0.02 -> 0.559 on the shipped model, i.e. the middle
	// band. Sized deliberately: bigAln (20 x 100 @ 0.08) scores 0.931 and tinyAln 0.0006, so without
	// this fixture the enumeration below skipped straight over 'uncertain'.
	const midAln =
		Array.from({ length: 5 }, (_, i) => `>m${i}\n${'ATGACTGGTCCC'.repeat(25)}`).join('\n') + '\n';
	const midTree = '(' + Array.from({ length: 5 }, (_, i) => `m${i}:0.02`).join(',') + ');';
	const tinyAln = '>a\nATGACTGGTCCC\n>b\nATGACAGGTCCC\n>c\nATGACTGATCCC\n';
	const tinyTree = '((a:0.004,b:0.003):0.002,c:0.005);';
	const timeTree = '(' + Array.from({ length: 20 }, (_, i) => `t${i}:12.5`).join(',') + ');';

	/** Every field of a result that can reach a screen. */
	function visibleText(res) {
		if (!res) return '';
		const parts = [res.detail, res.caveat, res.note, res.basis, res.tree_source_caveat];
		if (res.domain && res.domain.summary) parts.push(res.domain.summary);
		if (res.recommendation) {
			parts.push(res.recommendation.message, res.recommendation.caveat);
			for (const alt of res.recommendation.secondary || []) parts.push(alt.message);
			if (res.recommendation.action) parts.push(res.recommendation.action.label);
		}
		return parts.filter(Boolean).join(' — ');
	}

	it('names no other method in any reachable state, and reaches all three bands', async () => {
		const states = [
			['non-MEME method', { method: 'fel', alignment: bigAln, tree: bigTree }],
			['no alignment', { method: 'meme', alignment: '', tree: bigTree }],
			['topology-only tree', { method: 'meme', alignment: bigAln, tree: '((a,b),c);' }],
			['out of distribution', { method: 'meme', alignment: bigAln, tree: timeTree }],
			['scored, ample data', { method: 'meme', alignment: bigAln, tree: bigTree }],
			// 5 taxa x 100 codons at a median branch length of 0.02 scores 0.559 on the shipped model.
			// THE ENUMERATION HAD NO SUCH STATE, which made this test's own premise — "every state the
			// estimate can reach" — false for the band that fires on ~15% of real submissions. Proved
			// by injecting "consider BUSTED" into the uncertain copy: this test still passed. Only the
			// sibling test below, which iterates levels directly, caught it.
			['scored, borderline data', { method: 'meme', alignment: midAln, tree: midTree }],
			['scored, thin data', { method: 'meme', alignment: tinyAln, tree: tinyTree }],
			['user tree', { method: 'meme', alignment: bigAln, tree: bigTree, treeSource: 'user' }],
			['inferred tree', { method: 'meme', alignment: bigAln, tree: bigTree, treeSource: 'nj' }],
			['unknown tree', { method: 'meme', alignment: bigAln, tree: bigTree, treeSource: 'zzz' }]
		];
		const levelsSeen = new Set();
		for (const [name, args] of states) {
			const res = await estimateHitLikelihood({
				...args,
				model,
				opts: { resampleAvailable: true }
			});
			if (res.level) levelsSeen.add(res.level);
			const text = visibleText(res);
			expect(text, `state "${name}" named another method: ${text}`).not.toMatch(OTHER_METHODS);
		}
		// The coverage assertion that keeps the enumeration honest. Without it a band can quietly
		// stop being reachable — because the model moved, not because anyone edited this list — and
		// the states above go on passing while covering less.
		expect(
			[...levelsSeen].sort(),
			'the state enumeration no longer reaches all three bands, so it is not enumerating the ' +
				'states a user can reach. Re-derive the fixtures above against the shipped model.'
		).toEqual(['likely', 'uncertain', 'unlikely']);
		// The failure path is constructed, not reachable through estimateHitLikelihood.
		expect(visibleText(hitLikelihoodError())).not.toMatch(OTHER_METHODS);
	});

	it('names no other method in the per-level guidance', () => {
		// DM3 also read the band copy out of MemeHitLikelihood.svelte here. That component is the
		// web app's, not the runtime's, so the band-copy half of this guard lives with the panel;
		// the service-layer half stays here.
		for (const f of [
			{ level: 'likely', num_seqs: 100, num_sites: 300, median_pos_dist: 0.05 },
			{ level: 'uncertain', num_seqs: 50, num_sites: 200, median_pos_dist: 0.02 },
			{ level: 'unlikely', num_seqs: 10, num_sites: 17, median_pos_dist: 0.03 },
			{ level: 'unlikely', num_seqs: 8, num_sites: 400, median_pos_dist: 0.3 },
			{ level: 'unlikely', num_seqs: 40, num_sites: 500, median_pos_dist: 0.05 }
		]) {
			const r = recommendFor(f, { resampleAvailable: true });
			const text = [r.message, r.caveat, ...r.secondary.map((s) => s.message)].join(' ');
			expect(text, `level ${f.level} named another method: ${text}`).not.toMatch(OTHER_METHODS);
		}
	});

	it('the shared caveat still says what the number is NOT', () => {
		// The one sentence that has to survive any rewrite of the copy.
		expect(HIT_LIKELIHOOD_CAVEAT).toMatch(/not whether this gene is under selection/i);
		expect(MODEL_BASIS).toMatch(/MEME/);
	});

	it('reaches no ML runtime from anywhere in the gate', () => {
		// A tombstone, RESCOPED — read this before you touch it.
		//
		// This assertion was written as "DM3 ships no ML runtime, anywhere", and for as long as the
		// gate was the only model in the repository those two statements were the same statement.
		// They are not any more. AxoMEME 2.0 is a 3.78 MB transformer that genuinely needs
		// onnxruntime-web: its graph is a real neural network, not 500 trees of three features, and
		// no 40-line walker is going to execute it. So the repo-wide ban would now fail for a
		// legitimate reason, and the fix someone reaches for when a guard fails legitimately is
		// deleting the guard.
		//
		// What was actually being defended was never "no runtime exists". It was: THE GATE COSTS
		// ALMOST NOTHING AND IS REACHABLE FROM EVERY METHOD, SO IT MUST NOT DRAG A RUNTIME BEHIND
		// IT. The gate renders for one method out of fifteen; the first version of this feature
		// downloaded 13.5 MB of ONNX Runtime WASM for all fifteen and then rendered nothing for
		// fourteen of them. That failure mode gets MORE available once a runtime is a legitimate
		// dependency, not less, because now a stray import resolves instead of erroring.
		//
		// So the guard is now about REACHABILITY, which is the property that was always load-bearing:
		// walk the gate's own import closure and prove no ML runtime is in it. That is strictly
		// stronger than the per-file grep it replaces — the old version listed four files by hand and
		// would not have noticed a fifth.
		const RUNTIME = /^(onnxruntime|@tensorflow\/|@xenova\/|onnx|torch|tflite)/i;
		// THREE forms, because the first version of this test had only the first and therefore did
		// not fire when `import 'onnxruntime-web';` was injected into a reachable module to prove it
		// could. A side-effect import has no `from` clause, and it is the exact shape a runtime
		// arrives in — you import it for the WASM registration, not for a binding.
		const SPECIFIER_FORMS = [
			/\bfrom\s*['"]([^'"]+)['"]/g, // import … from 'x' / export … from 'x'
			/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // dynamic import('x')
			/^\s*import\s+['"]([^'"]+)['"]/gm // side-effect import 'x'
		];

		const seen = new Set();
		const offenders = [];
		const visit = (absPath) => {
			if (seen.has(absPath) || !existsSync(absPath)) return;
			seen.add(absPath);
			// Strip comments before matching. hitLikelihoodModel.js documents its own usage with a
			// literal `import … from './hitLikelihood.js'` inside a doc block, and a commented-out
			// runtime import must not be reported as a live edge in either direction.
			const src = readFileSync(absPath, 'utf8')
				.replace(/\/\*[\s\S]*?\*\//g, '')
				.replace(/^\s*\/\/.*$/gm, '');
			for (const re of SPECIFIER_FORMS) {
				re.lastIndex = 0;
				let m;
				while ((m = re.exec(src)) !== null) {
					const spec = m[1];
					if (!spec) continue;
					if (RUNTIME.test(spec)) {
						offenders.push(`${absPath.replace(PKG_ROOT, '')} imports ${spec}`);
						continue;
					}
					// Follow relative edges only. A bare specifier that is not a runtime is somebody
					// else's package and cannot pull one in without appearing in package.json, which
					// is checked separately below.
					if (spec.startsWith('.')) visit(join(dirname(absPath), spec));
				}
			}
		};
		// Every entry point a caller can reach the gate through.
		for (const f of ['scope.js', 'hitLikelihood.js', 'hitLikelihoodModel.js', 'xgbEnsemble.js']) {
			visit(join(PRESCREEN, f));
		}
		expect(offenders, 'an ML runtime is reachable from the gate').toEqual([]);
		// The walk has to have actually walked. Without this the test passes trivially if the entry
		// filenames are ever renamed out from under it.
		expect(seen.size).toBeGreaterThanOrEqual(4);

		// package.json is still checked, but as an ALLOWLIST rather than a ban. This package
		// legitimately declares BOTH ONNX runtimes (as optionalDependencies: the browser gets
		// onnxruntime-web through session-web.js, Node gets onnxruntime-node through
		// session-node.js); anything else in this family is not, and adding one is a deliberate edit
		// to this line rather than something that slips in with a lockfile. The reachability walk
		// above is what proves the prescreen itself reaches neither.
		const ALLOWED = new Set(['onnxruntime-web', 'onnxruntime-node']);
		const pkg = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8'));
		const deps = Object.keys({
			...pkg.dependencies,
			...pkg.optionalDependencies,
			...pkg.devDependencies
		});
		const unexpected = deps.filter((d) => RUNTIME.test(d) && !ALLOWED.has(d));
		expect(unexpected, 'unexpected ML runtime in package.json').toEqual([]);
	});
});
