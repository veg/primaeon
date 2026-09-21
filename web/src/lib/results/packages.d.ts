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
		source: 'map' | 'auspice' | 'table' | 'beast' | 'regex' | 'header' | 'none';
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
			from_beast: number;
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
		/** Present only when a BEAST XML was the date source; see `BeastSummary`. */
		beast: BeastSummary | null;
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

	/**
	 * The record-shaped half of a BEAST read (`ingestDates(...).beast`). The SEQUENCES are
	 * deliberately absent — a record is stored in IndexedDB and an alignment has its own slot — so a
	 * surface that wants them keeps its `parseBeastXml` result or calls `beastToFasta` again.
	 */
	export interface BeastSummary {
		version: string;
		sequences: number;
		dates: number;
		taxa: number;
		tree_present: boolean;
		tree_newick: string | null;
		tree_from: string | null;
		namespaced: boolean;
		alignments: { seen: number; chosen_index: number; sizes: Array<{ index: number; size: number; dataType: string | null }> };
		sequence_sources: { value_attr: number; element_text: number; taxon_tail: number };
		traits: Array<{ name: string; entries: number; exact: boolean }>;
		dates_from: { beast1: number; beast2: number };
		direction_attrs: number;
		units_attrs: number;
		/** How many dates came from a calendar string, and therefore from BEAST's own arithmetic. */
		calendar_dates: number;
		ungated: string[];
		nonfinite: string[];
		duplicates: { sequences: string[]; dates: string[] };
		reconciliation: { renamed: Array<{ from: string; to: string }>; dates_added: string[] };
		names_with_whitespace: string[];
		elements: number;
		depth: number;
		[k: string]: unknown;
	}
	/** `parseBeastXml`'s return: `parse_beast_xml`'s five keys plus an app-only provenance block. */
	export interface BeastDocument {
		version: string;
		sequences: Map<string, string>;
		dates: Map<string, number>;
		tree_newick: string | null;
		taxa: string[];
		provenance: {
			raws: Map<string, string>;
			rules: Map<string, string>;
			namespaced: boolean;
			elements: number;
			depth: number;
			alignments: BeastSummary['alignments'];
			sequence_sources: BeastSummary['sequence_sources'];
			traits: BeastSummary['traits'];
			dates_from: BeastSummary['dates_from'];
			direction_attrs: number;
			units_attrs: number;
			calendar_dates: number;
			ungated: string[];
			nonfinite: string[];
			duplicates: BeastSummary['duplicates'];
			reconciliation: BeastSummary['reconciliation'];
			/**
			 * JavaScript's `/\s/` class, kept as it is because `ingest.js` consumes it. It is NOT the
			 * FASTA hazard list: `fastaNameHazard` uses Python's 29-character whitespace class, so the
			 * two disagree on U+001C-U+001F, U+0085 (Python whitespace, not `\s`) and U+FEFF (the
			 * reverse). Read `names_unsafe_for_fasta` when the question is whether a name survives.
			 */
			names_with_whitespace: string[];
			/** Every taxon `beastToFasta` would refuse, with the hazard that would take it. */
			names_unsafe_for_fasta: Array<{ name: string; hazard: string }>;
			tree_from: string | null;
			/** The work meter this read spent, against `XML_LIMITS.maxWork`. */
			work: { spent: number; max: number };
			[k: string]: unknown;
		};
	}
	/** dataset.py:84-233. Throws `XmlReadError` and nothing else. */
	export function parseBeastXml(text: string, options?: { fileName?: string; limits?: Record<string, number> }): BeastDocument;
	/** dataset.py:62-81, the reference's OWN date arithmetic; never the library's. */
	export function beastDateParse(value: string | null | undefined): { value: number; rule: string } | null;
	export function beastDateValue(value: string | null | undefined): number | null;
	/** dating.py:436-442 — the other reconciliation ladder, read-only, keyed on the original taxon. */
	export function beastDatesForTaxa(taxa: readonly string[], parsed: BeastDocument): Map<string, number>;
	/**
	 * The app's own: the XML's sequences as FASTA, in `taxa` order. THROWS `BeastFastaError` when a
	 * taxon id would not read back as itself through the library's FASTA reader — it refuses rather
	 * than renaming, so a surface that calls it must be ready to show the message.
	 */
	export function beastToFasta(parsed: BeastDocument, options?: { lineWidth?: number }): string;
	/** The three ways a BEAST taxon id fails to round-trip a FASTA header. */
	export const FASTA_NAME_HAZARDS: Readonly<Record<'EMPTY' | 'WHITESPACE' | 'QUOTED', string>>;
	/** A `FASTA_NAME_HAZARDS` member, or `null` when the name reads back byte for byte. */
	export function fastaNameHazard(name: string): string | null;
	/** Every name in `taxa` that would not survive the round trip, with its hazard. */
	export function unsafeFastaNames(taxa: Iterable<string>): Array<{ name: string; hazard: string }>;
	/** `beastToFasta`'s refusal. `code` is always `'BEAST_NAME_NOT_FASTA'`. */
	export class BeastFastaError extends Error {
		code: string;
		names: Array<{ name: string; hazard: string }>;
	}
	export class XmlReadError extends Error {
		/** An `XML_REFUSALS` member: `'malformed' | 'too_large' | 'too_deep' | 'entity_expansion' | 'entity_depth' | 'too_much_work'`. */
		reason: string;
		line: number;
		column: number;
	}
	/** The five numbers the XML reader refuses on; see `runtime/src/dates/xml.js`'s header. */
	export const XML_LIMITS: Readonly<{
		maxChars: number;
		maxDepth: number;
		maxEntityChars: number;
		maxEntityDepth: number;
		maxWork: number;
	}>;
	export const XML_REFUSALS: readonly string[];
	/** The work meter one document read shares; over its limit every traversal throws `too_much_work`. */
	export function createWorkBudget(limits?: { maxWork?: number }): { spent: number; max: number };
	export function chargeWork(budget: { spent: number; max: number } | null | undefined, units: number): void;
	export const BEAST_DATE_RULES: Readonly<Record<'FLOAT' | 'YMD' | 'YEAR_MONTH', string>>;
	export const BEAST_DATE_RULE_IDS: readonly string[];
	export const BEAST_MATCH_TIERS: readonly string[];
	export const DATE_SCHEMA_VERSION: number;
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
		/** Who computed the square TN93 matrix the pass fed the graph: 'wasm' | 'custom'. There is no
		 * 'js': a pass that could not reach the compiled engine threw instead of substituting one. */
		tn93Engine: 'wasm' | 'custom';
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
		/** Who computed the root-to-tip distances; null in latent mode, where none were computed. */
		tn93Engine: 'wasm' | 'custom' | null;
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
		/**
		 * An ALREADY-RESOLVED options object for the library's RECTANGULAR `tn93CrossDistanceMatrix`
		 * — `resolveTn93Options({shape: 'cross'})`'s `tn93Options`, which puts veg/tn93's own compiled
		 * code behind the hook. It arrives resolved because `runDating` is synchronous and the loader
		 * is not. It is REQUIRED on a tn93-mode run: @veg/hyphaeon-js computes no distance of its
		 * own, so without it the first matrix throws `Tn93EngineRequiredError`.
		 */
		tn93Options?: Record<string, unknown> | null;
		/** What that object actually is; derived from it when absent, never assumed. */
		tn93Engine?: 'wasm' | 'custom' | null;
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

	/** Phase 6 review X2/X4: which ancestor date a surface quotes, and whether it may quote it flatly. */
	export interface DatingHeadline {
		key: 'ols' | 'pgls' | 'spline';
		model: Record<string, unknown>;
		activeKey: string;
		/** True when this differs from the reference's own top-level `t_mrca`. */
		departed: boolean;
		/** False when the date must be rendered with `refutation` in the same breath. */
		quotable: boolean;
		refutation: string | null;
		signal: { hasSignal: boolean; p: number; r2: number; g: number | null; alpha: number } | null;
	}
	export const DATING_SIGNAL_ALPHA: number;
	export const DATING_MODEL_KEYS: readonly string[];
	export function isDegenerateInterval(ci: readonly number[] | null | undefined): boolean;
	export function isUnboundedInterval(ci: readonly number[] | null | undefined): boolean;
	export function datingClockSignal(
		record: Record<string, unknown>
	): { hasSignal: boolean; p: number; r2: number; g: number | null; alpha: number } | null;
	export function datingHeadline(record: Record<string, unknown> | null | undefined): DatingHeadline | null;

	/** Phase 6 review X6: `temporalReferenceCommand`'s counterpart, and the notes that travel with the files. */
	export function datingReferenceCommand(
		run: DatingRun,
		options?: Record<string, unknown>,
		names?: { alignment?: string; dates?: string | null },
		ingest?: unknown
	): {
		command: string;
		reproduces: boolean;
		caveats: string[];
		headline: { key: string; activeKey: string; departed: boolean; quotable: boolean } | null;
	};
	export function datingDownloadNotes(
		run: DatingRun,
		options?: { predictionMethod?: boolean; includeProvenance?: boolean }
	): string[];
}

/**
 * The temporal pillar's VOCABULARY ONLY — codes, thresholds and the sentences a surface renders.
 * A separate subpath from `@veg/hyphaeon-runtime/temporal` because that one reaches `predict.js`
 * and therefore onnxruntime; this one imports nothing but the date layer's own import-free codes,
 * so the `/time` route can print what the pillar means before any button is pressed.
 */
declare module '@veg/hyphaeon-runtime/temporal/codes' {
	export const TEMPORAL_SCHEMA_VERSION: number;
	export const TEMPORAL_DIAGNOSTIC_CODES: readonly string[];
	export const TEMPORAL_REFUSALS: Readonly<Record<string, string>>;
	export const TEMPORAL_THRESHOLDS: Readonly<Record<string, number>>;
	export const TEMPORAL_MESSAGES: Readonly<Record<string, string>>;
	export const TEMPORAL_REFERENCE_RULES: readonly string[];
	export const TEMPORAL_BEYOND_REFERENCE_RULES: readonly string[];
	/** Phase 6 review X1: what the date-shuffling null assumes, in one place all three surfaces read. */
	export const TEMPORAL_NULL_ASSUMPTION: Readonly<{ lead: string; rest: string }>;
	export function fillMessage(template: string, values: Record<string, unknown>): string;
	export function nameSample(names: readonly string[]): string;
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
