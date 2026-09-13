/**
 * packages.d.ts — ambient types for the two untyped JavaScript packages the results page imports.
 *
 * WHY THIS FILE EXISTS. `@veg/hyphaeon-runtime` and `@veg/hyphaeon-js` ship JSDoc'd ES modules
 * without declaration files; under `strict` and `moduleResolution: bundler` an import of either
 * is TS7016. These declarations cover exactly the names the results page uses, typed from the
 * source (runtime/src/postprocess.js, callModes.js, pipeline.js; js/src/writers.js) so a signature
 * change upstream is a type error here rather than a silent `any`. Extend, do not widen, when a
 * new name is needed.
 */

declare module '@veg/hyphaeon-runtime' {
	export interface CallDefaults {
		mode: 'percentile' | 'zscore' | 'pvalue';
		tier1LrtGate: number;
		tier2LrtGate: number;
		tier1Zscore: number;
		tier2Zscore: number;
		tier1Percentile: number;
		tier2Percentile: number;
	}
	export interface PredictionRow {
		site: number;
		refCodon: string;
		refAa: string;
		isVariable: boolean;
		lrt: number;
		logLrt: number;
		zScore: number;
		percentile: number;
		call: string;
	}
	export const CALL_DEFAULTS: Readonly<CallDefaults>;
	export const CALL_MODES: readonly string[];
	export const NEUTRAL_CALL: string;
	export function describeCallMode(mode?: string, cfg?: Partial<CallDefaults>): string;
	export function buildPredictions(
		outputs: { lrt: ArrayLike<number> },
		sites: { refCodons: string[]; variable: boolean[] },
		callOptions?: Partial<CallDefaults>
	): PredictionRow[];
	/**
	 * runtime/src/results.js: the CLI writers over a RUNTIME result (one carrying `arrays` and
	 * `attributionRecords`, which the prebake and the analyze flow keep on the record).
	 */
	export function memeJsonText(
		result: unknown,
		options?: { alignment?: string; tree?: string | null; provenance?: boolean }
	): string;
	export function memeCsvText(result: unknown): string;
}

/**
 * The date ingestion layer (runtime/src/dates/), reached through its own subpath so the /time route
 * never imports the runtime's main entry and therefore never pulls in ORT or the graph manifest.
 */
declare module '@veg/hyphaeon-runtime/dates' {
	export interface DateParseRow {
		taxon: string;
		raw: string | null;
		value: number | null;
		rule: string;
		source: 'map' | 'auspice' | 'table' | 'regex' | 'header' | 'none';
		imputed: boolean;
		imputations: { month: boolean; day: boolean; dayClamped: boolean };
		matched: string | null;
		matched_name: string | null;
		match_tier: string | null;
	}
	export interface DateIngest {
		schema_version: number;
		ok: boolean;
		time_units: 'years' | 'generations' | 'days' | 'arbitrary';
		time_units_source: 'supplied' | 'inferred';
		time_units_evidence: Record<string, unknown>;
		source: string;
		sources_used: string[];
		source_name: string | null;
		source_kind: string | null;
		coverage: {
			taxa_total: number;
			dated: number;
			undated: number;
			coverage: number;
			from_map: number;
			from_auspice: number;
			from_table: number;
			from_regex: number;
			from_header: number;
			imputed: number;
			day_clamped: number;
			out_of_range: number;
			archival_1959: number;
		};
		by_rule: Record<string, number>;
		rows: DateParseRow[];
		unmatched_metadata: { count: number; names: string[]; sample: string[] };
		unmatched_taxa: { count: number; names: string[]; sample: string[] };
		match_tier: string | null;
		match_tiers: Record<string, number>;
		ambiguous: Array<{ name: string; taxa: string[]; tier: string }>;
		span: { min: number; max: number; span: number; unique: number; tied: number; finite: number } | null;
		table: Record<string, unknown> | null;
		auspice: Record<string, unknown> | null;
		regex: Record<string, unknown> | null;
		headers: Record<string, unknown> | null;
		warnings: Array<{ code: string; severity: string; message: string; data?: unknown }>;
	}
	export function ingestDates(args: {
		taxa: string[];
		headerOf?: Map<string, string> | Record<string, string> | null;
		source?: string | object | null;
		sourceName?: string;
		sourceKind?: string;
		timeUnits?: string | null;
		strainCol?: string | null;
		dateCol?: string | null;
		delimiter?: string | null;
		dateRegex?: string | null;
		regexFlags?: string;
		archival1959?: boolean;
		headerFallback?: boolean;
		sampleNames?: number;
	}): DateIngest;
	export function taxaForDates(alignmentText: string): string[];
	export function detectDateSourceKind(text: string, fileName?: string): string;
	export function compileDateRegex(
		pattern: string,
		options?: { flags?: string }
	): { regex: RegExp | null; valid: boolean; error: string | null; code: string | null; groups: number; pattern: string; flags: string; source: string };
	export function archival1959Candidates(taxa: string[]): string[];
	export function sniffDelimiter(
		text: string,
		options?: { fileName?: string; delimiter?: string | null; candidates?: string[]; lines?: number }
	): { delimiter: string; source: string; confidence: number; fields: number; extensionHint: string | null; agrees: boolean };
	export function readDateTable(
		text: string,
		options?: { fileName?: string; delimiter?: string | null; strainCol?: string | null; dateCol?: string | null; timeUnits?: string }
	): { columns: string[]; strain: { column: string | null; source: string }; date: { column: string | null; source: string }; rowsRead: number; rowsDated: number };
	export function hasDateLayer(): boolean;
	export const DATE_MATCH_TIERS: readonly string[];
	export const DATE_SOURCES: readonly string[];
	export const DATE_DIAGNOSTIC_CODES: readonly string[];
	export const DATE_THRESHOLDS: Readonly<Record<string, number>>;
}

/**
 * The clock preview (runtime/src/rootToTip.js + clockRegression.js), through `./clock`, for the
 * same reason: /time loads no model.
 */
declare module '@veg/hyphaeon-runtime/clock' {
	export const TREE_REFUSALS: Readonly<Record<string, string>>;
	export const CLOCK_STATUS: Readonly<Record<string, string>>;
	export const CLOCK_REFUSALS: Readonly<Record<string, string>>;
	export const MIN_DATED: number;
	export const OUTLIER_Z: number;
	export const NEGLIGIBLE_RATE: number;
	export const NEGLIGIBLE_R2: number;
	export interface PhyloTreeLike {
		name: Array<string | null>;
		branchLength: Array<number | null>;
		children: number[][];
		parent: Int32Array | number[];
		root: number;
	}
	export function parseClockTree(text: string | null | undefined): PhyloTreeLike | null;
	export function leafNames(tree: PhyloTreeLike): string[];
	export function branchLengthGate(tree: PhyloTreeLike): {
		ok: boolean;
		code: string | null;
		branches: number;
		positive: number;
		ratio: number;
		nonFinite: number;
		unit: boolean;
		tips: number;
	};
	export function midpointRoot(
		tree: PhyloTreeLike
	): { node: number; fraction: number; pathLength: number; tips: [string, string] } | null;
	export function outgroupRoot(tree: PhyloTreeLike, name: string, fraction?: number): { node: number; fraction: number } | null;
	export function rootToTipDivergences(
		tree: PhyloTreeLike,
		rooting: { node: number; fraction: number }
	): { names: string[]; divergence: Float64Array } | null;
	export function populationStd(values: ArrayLike<number> | Iterable<number>): number;
	export function treeDivergences(
		treeText: string | null,
		options?: { root?: 'midpoint' | 'outgroup'; outgroup?: string | null }
	): {
		ok: boolean;
		code: string | null;
		tree: PhyloTreeLike | null;
		gate: ReturnType<typeof branchLengthGate> | null;
		rooting: { node: number; fraction: number } | null;
		rootLabel: string;
		names: string[];
		divergence: Float64Array | null;
		sd: number;
	};
	export function pearson(x: ArrayLike<number>, y: ArrayLike<number>): number;
	export function clockRegression(input: {
		taxa: string[];
		divergence: ArrayLike<number>;
		times: ArrayLike<number>;
		undated?: number;
		units?: string;
	}): Record<string, unknown> & { ok: boolean; rows: Array<Record<string, number | string | boolean>> };
	export function rootSensitivity(
		fits: Array<{ label: string; fit: unknown }>,
		samplingSpan: number
	): { values: Array<{ label: string; tMrca: number }>; spread: number; wide: boolean } | null;
}

/**
 * The dating pillar (runtime/src/dating/), Phase 3. Its own subpath for the same reason `/dates`
 * has one: nothing under it imports a manifest, a session or `predict.js`, so the `/time` route and
 * its worker reach the estimators without reaching ORT — which is what keeps the route's "no
 * `*.onnx`, no `ort-*.wasm`" assertion true by construction rather than by care.
 */
declare module '@veg/hyphaeon-runtime/dating' {
	export const DATING_SCHEMA_VERSION: number;
	export const DATING_DIAGNOSTIC_CODES: readonly string[];
	export const DATING_REFUSALS: Readonly<Record<string, string>>;
	export const DATING_THRESHOLDS: Readonly<Record<string, number>>;
	export const DATING_MESSAGES: Readonly<Record<string, string>>;
	export const DATING_CI_METHODS: readonly string[];
	export const PREDICTION_METHODS: readonly string[];
	/** `dating.py:3052-3062`'s ten columns, in its order; the CSV download's contract. */
	export const TAXON_COLUMNS: readonly string[];
	/** `dating.py:3150-3181`'s 22 top-level keys, in its order. */
	export const RECORD_KEYS: readonly string[];
	/** What this build declines to estimate, and why, carried in the record so a page can say it. */
	export const NOT_BUILT: ReadonlyArray<{ name: string; reason: string }>;
	/** Phase 4: the two entries that appear ONLY when the dating graph did not run. */
	export const NOT_BUILT_WITHOUT_MODEL: ReadonlyArray<{ name: string; reason: string }>;
	export const DATING_DISTANCE_MODES: readonly string[];
	/** `dating.py:2745`'s 1,500. Above it a model-based run is refused rather than downgraded. */
	export const DATING_NEURAL_MAX_TAXA: number;
	export function resolveDistanceMode(
		requested: 'auto' | 'tn93' | 'latent',
		hasModel: boolean
	): { mode: 'tn93' | 'latent'; reason: string };

	/**
	 * What `runDatingModelPass` returns: the two matrices `splits.py:152-153` produces, over ALL
	 * alignment taxa in alignment order and already divided. Declared here rather than in the main
	 * module because the estimators that consume it live here.
	 */
	export interface DatingModelPass {
		crossAttn: Float64Array;
		taxaRepr: Float64Array;
		taxa: string[];
		N: number;
		L: number;
		embedDim: number;
		rowLayers: number;
		batchSize: number;
		calls: number;
		starsRewritten: number;
		elapsedSeconds: number;
	}
	export interface DatingWarning {
		code: string;
		severity: string;
		message: string;
		data?: unknown;
	}
	export interface DatingTaxonRow {
		taxon: string;
		sampling_date: number;
		root_divergence: number;
		fitted_divergence: number;
		predicted_date: number;
		divergence_residual: number;
		temporal_residual: number;
		z_score: number;
		is_outlier: boolean;
		is_holdout: boolean;
		prediction_method: string;
	}
	export interface DatingRun {
		ok: boolean;
		refusal: string | null;
		warnings: DatingWarning[];
		record: Record<string, unknown>;
		rows: DatingTaxonRow[];
		taxa: string[];
		times: Float64Array;
		divergences: Float64Array;
		coverage: Float64Array;
		trainIndices: number[];
		ols: Record<string, unknown>;
		/** Phase 4: null unless the dating graph ran. */
		pgls: Record<string, unknown> | null;
		latent: Record<string, unknown> | null;
		spline: Record<string, unknown> | null;
		distanceMode: 'tn93' | 'latent';
		distanceModeReason: string;
		pagelLambda: number | null;
		printedRidge: number | null;
		active: Record<string, unknown>;
		activeName: 'ols' | 'pgls' | 'spline';
		selectedClock: string;
		ensemble: { t_mrca: number | null; ci_mrca: number[] | null; weights: Record<string, number> };
		methods: string[];
		rootDescription: string;
		rootCase: 1 | 2 | 3 | 4 | null;
		rootSequence: string | null;
	}
	/**
	 * `hyphaeon dating -a <alignment> --no-tree --method ols`, in process. Never throws except on an
	 * unported `ciMethod` (a RangeError) and on abort (`err.name === 'AbortError'`).
	 */
	export function runDating(args: {
		alignmentText?: string | null;
		sequences?: Map<string, string> | Record<string, string> | null;
		alignmentName?: string | null;
		dates: Map<string, number> | Record<string, number> | { rows: Array<{ taxon: string; value: number | null }> };
		rootTaxon?: string | null;
		decayGamma?: number | null;
		decayHalfLife?: number | null;
		excludedTaxa?: readonly string[];
		clockModel?: 'auto' | 'linear' | 'spline';
		ciMethod?: 'fieller' | 'delta' | 'linear';
		/**
		 * Phase 4. `auto` — the reference's default — resolves to `latent` when `neural` is supplied
		 * and to `tn93` when it is not; `latent` without `neural` is a RangeError, because the latent
		 * root is a position in the MODEL'S space and there is nothing to approximate it with.
		 */
		distanceMode?: 'auto' | 'tn93' | 'latent';
		/** What `runDatingModelPass` returned, or null. Its absence is a fact, not an error. */
		neural?: DatingModelPass | null;
		/** Why `neural` is absent, when the caller knows; reported as DATING_MODEL_GRAPH_ABSENT. */
		modelUnavailableReason?: string | null;
		timeUnits?: string;
		allowStopCodons?: boolean;
		autoTrimTrailing?: boolean;
		progress?: (phase: string, done: number, total: number, message: string) => void;
		signal?: AbortSignal;
		provenance?: Record<string, unknown>;
	}): DatingRun;
	export function rankTaxonRows(rows: DatingTaxonRow[]): DatingTaxonRow[];
	/**
	 * The adjudication (`dating.py:2943-2996`) and the admission rule (`:2894-2941`), pure and
	 * exported separately so a caller can replay them on a record it did not produce — which is how
	 * `datingModel.test.ts` checks this build's `selected_clock` sentence against the reference's own
	 * bytes without running a model.
	 */
	export function selectClockModel(args: {
		ols: Record<string, unknown> | null;
		pgls?: Record<string, unknown> | null;
		spline: Record<string, unknown> | null;
		clockModel?: 'auto' | 'linear' | 'spline';
	}): {
		name: 'ols' | 'pgls' | 'spline';
		model: Record<string, unknown>;
		selectedClock: string;
		cladeAttenuated: boolean;
		attenuation: number;
		warnings: DatingWarning[];
	};
	export function admitEnsembleCandidates(args: {
		ols: Record<string, unknown> | null;
		pgls?: Record<string, unknown> | null;
		spline: Record<string, unknown> | null;
		minSampleTime: number;
		selected?: string | null;
		cladeAttenuated?: boolean;
	}): {
		ensemble: { t_mrca: number | null; ci_mrca: number[] | null; weights: Record<string, number> };
		admitted: string[];
		warnings: DatingWarning[];
	};
	export function sortDatingWarnings<W extends { code: string }>(warnings: W[]): W[];
	export function datingJsonText(
		record: Record<string, unknown>,
		options?: { includeProvenance?: boolean; predictionMethod?: boolean }
	): string;
	export function datingCsvText(rows: DatingTaxonRow[], options?: { predictionMethod?: boolean }): string;
	export function datingDownloads(
		run: DatingRun,
		options?: { stem?: string }
	): Array<{ name: string; type: string; text: string }>;
}

declare module '@veg/hyphaeon-js' {
	/** js/src/dates.js: the 21 rule ids every DateParse reports; the /time page maps them to words. */
	export const DATE_RULES: Readonly<Record<string, string>>;
	export const TIME_UNITS: readonly string[];
	/** js/src/writers.js: `nx.write_graphml` (cli.py:821-833) over the co-selection edges. */
	export function graphml(
		edges: Array<{ site_u: number | string; site_v: number | string; similarity: number; cesi: number; shared_branches: number; fdr_q: number }>,
		nodes?: Array<number | string>
	): string;
	export function memeJson(result: unknown): string;
	export function memeCsv(
		sites: Array<Record<string, unknown>>,
		options?: { attribution?: boolean }
	): string;
	export function memeResult(parts: {
		alignment: string;
		tree?: string | null;
		taxaCount: number;
		codonCount: number;
		runtimeSec: number | null;
		filterEnabled?: boolean;
		artifactsMasked?: unknown[];
		attributionEnabled?: boolean;
		attributions?: Record<string, unknown> | null;
		sites: Array<Record<string, unknown>>;
	}): Record<string, unknown>;
}

declare module 'phylotree' {
	export class phylotree {
		constructor(newick: string, options?: Record<string, unknown>);
		nodes: import('d3').HierarchyNode<{ name: string; [k: string]: unknown }>;
		display: TreeRender | undefined;
		render(options: Record<string, unknown>): TreeRender;
		getNewick(): string;
		/** `src/rooting.js`: MUTATES the tree and rebuilds its hierarchy. Root then walk, never the reverse. */
		reroot(node: PhyloNode, fraction?: number): phylotree;
		getNodeByName(name: string): PhyloNode | undefined;
	}
	/** `src/metrics/compute-midpoint.js:68-71`. Its two fields are the two arguments `reroot` wants. */
	export function computeMidpoint(tree: phylotree): { location: PhyloNode; breakpoint: number };
	/** `src/metrics/root-to-tip.js:160`: annotates each leaf with `data.rootToTip`. THROWS A BARE STRING. */
	export function rootToTip(tree: phylotree): void;
	/** `src/metrics/root-to-tip.js`: best-root search by max R². Not on any production path; see clock.test.ts. */
	export function fitRootToTip(tree: phylotree, options?: Record<string, unknown>): Record<string, unknown>;
	/** `src/extract-dates.js`: a date getter anchored to the end of a name. Unusable here; see clock.test.ts. */
	export function extractDates(tree: phylotree, options?: Record<string, unknown>): unknown;
	export interface TreeRender {
		nodeLabel(fn: (node: import('d3').HierarchyNode<{ name: string }>) => string): TreeRender;
		style_edges(
			fn: (
				element: import('d3').Selection<SVGPathElement, unknown, null, undefined>,
				edge: { source: PhyloNode; target: PhyloNode }
			) => void
		): TreeRender;
		style_nodes(
			fn: (
				element: import('d3').Selection<SVGGElement, unknown, null, undefined>,
				node: PhyloNode
			) => void
		): TreeRender;
		update(transitions?: boolean): TreeRender;
		show(): SVGSVGElement;
	}
	export type PhyloNode = import('d3').HierarchyNode<{ name: string; [k: string]: unknown }> & {
		collapsed?: boolean;
		[k: string]: unknown;
	};
}
