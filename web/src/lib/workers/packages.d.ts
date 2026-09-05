/**
 * packages.d.ts — ambient types for the names the workers and the analyze flow import from the
 * two untyped JavaScript packages (`@veg/hyphaeon-runtime`, `@veg/hyphaeon-js`).
 *
 * WHY THIS FILE EXISTS. Same reason as web/src/lib/results/packages.d.ts, which declares the
 * names the results page uses: the packages ship JSDoc'd ES modules without declaration files,
 * and under `strict` an untyped import is TS7016. Ambient module declarations merge across
 * files, so this one adds only the names the analyze side needs (runMeme, runPhenotype, the
 * manifest helpers, loadSession, the prescreen, diagnose, memeSitePq, the parser and tree helpers)
 * and repeats none of the results page's. The vendored tree engine's subpath module was declared
 * here until Phase 3 removed it (D22). Typed from the source (runtime/src/pipeline.js, manifest.js,
 * session-web.js, prescreen/hitLikelihood.js; js/src/diagnostics.js, stats.js, preprocess/*.js).
 * Loose where the runtime's Phase 1b shape is still landing (`runMeme`'s result is typed as
 * `RuntimeMemeResult`, an open record, and lib/analyze/record.ts is where it is read).
 */

declare module '@veg/hyphaeon-runtime' {
	export interface RuntimeProgress {
		(phase: string, done: number, total: number, message: string): void;
	}
	export interface RuntimeSessionHandle {
		session: unknown;
		ort: unknown;
		sha256: string | null;
		verified: boolean;
		bytes: number;
		numThreads: number;
		modelUrl: string;
		outputNames: string[];
		[k: string]: unknown;
	}
	/** `runMeme`'s return: PLAN.md §3.5's shape, read by lib/analyze/record.ts. */
	export interface RuntimeMemeResult {
		schema_version: number;
		method: string;
		is_surrogate: boolean;
		surrogate_for: string;
		sites: Array<Record<string, unknown>>;
		summary: Record<string, unknown>;
		provenance: Record<string, unknown> & {
			preprocessing?: Record<string, unknown>;
			warnings?: Array<Record<string, unknown>>;
		};
		attention?: { data: Float32Array; dims: number[] };
		root_repr?: { data: Float32Array; dims: number[] };
		[k: string]: unknown;
	}
	export function runMeme(args: {
		alignmentText: string;
		treeText: string;
		options?: Record<string, unknown>;
		session: RuntimeSessionHandle;
		progress?: RuntimeProgress;
		surface?: string;
		signal?: AbortSignal;
		provenance?: Record<string, unknown>;
	}): Promise<RuntimeMemeResult>;
	export function clampMaxSpecies(value: unknown, fallback?: number): number;
	/** runtime/src/busted.js: the BUSTED surrogate over the backbone and (optionally) the head session. */
	export function runBusted(args: {
		alignmentText: string;
		treeText?: string | null;
		options?: Record<string, unknown>;
		session: RuntimeSessionHandle;
		head?: RuntimeSessionHandle | null;
		progress?: RuntimeProgress;
		surface?: string;
		signal?: AbortSignal;
		provenance?: Record<string, unknown>;
	}): Promise<Record<string, unknown> & { record: Record<string, unknown>; statistics: Record<string, unknown>; provenance: Record<string, unknown> }>;
	/**
	 * runtime/src/analyze.js (Phase 2 orchestrator contract): everything on one dataset, sections
	 * posted through `onSection` as they finish. Declared optional-at-runtime in analyze.worker.ts,
	 * which falls back to a runMeme + runBusted bridge while the module is not yet in the package.
	 */
	export function runEverything(args: {
		alignmentText: string;
		treeText: string | null;
		inputs: { alignmentName: string; treeName: string | null; demo?: string };
		options: Record<string, unknown>;
		session: RuntimeSessionHandle;
		head?: RuntimeSessionHandle | null;
		surface?: string;
		signal?: AbortSignal;
		progress?: RuntimeProgress;
		onSection?: (name: string, payload: unknown, meta: { final: boolean }) => void;
	}): Promise<Record<string, unknown>>;
	/**
	 * runtime/src/pipeline.js — parse, decide the tree (D22: a usable tree, else TN93 distances),
	 * match, prune, cap, MDS, tokenise. Its `loaded` is the LoadedAlignment every pillar reads.
	 */
	export function prepareRun(args: {
		alignmentText: string;
		treeText: string | null;
		options?: Record<string, unknown>;
		progress?: RuntimeProgress;
		signal?: AbortSignal;
		defaultMaxSpecies?: number;
	}): Promise<{ loaded: Record<string, unknown>; [k: string]: unknown }>;
	/**
	 * runtime/src/phenotype.js — the on-demand phenotype pillar (Phase 3, D22). The trait goes in as
	 * the reader's OPTIONS so the library resolves the vector itself and writes the CLI's own
	 * `phenotype_meta.description`. With `prepared` and a `session` it runs the reference's own
	 * all-sites attribution loop; with a report's `attention` + `lrt` it costs no forward pass.
	 * A tree-free run comes back with the permulations skipped and a reason, never an error.
	 */
	export function runPhenotype(args: {
		loaded?: Record<string, unknown> | null;
		prepared?: Record<string, unknown> | null;
		attention?: unknown;
		lrt?: ArrayLike<number> | null;
		attributions?: unknown;
		session?: RuntimeSessionHandle | null;
		predict?: unknown;
		phenotype: Record<string, unknown>;
		options?: Record<string, unknown>;
		tree?: unknown;
		inputs?: { alignment?: string | null; tree?: string | null };
		progress?: RuntimeProgress;
		signal?: AbortSignal;
	}): Promise<Record<string, unknown>>;
	export const PHENOTYPE_CLI_DEFAULTS: Readonly<Record<string, unknown>>;
	export const PERMULATION_SKIP_REASONS: Readonly<Record<string, string>>;
	export const PERMULATION_TREE_FREE_NOTE: string;
	/** runtime/src/nj.js — the display-only neighbour-joining tree on the TN93 distances (D22). */
	export function njNewick(dist: ArrayLike<number>, taxa: readonly string[], options?: Record<string, unknown>): string;
	export const MIN_SPECIES: number;
	export const MAX_SPECIES_CAP: number;
	export const PHASES: readonly string[];
	export const NO_TREE_MESSAGE: string;
	export const NO_BRANCH_LENGTHS_MESSAGE: string;

	export interface Manifest {
		model_version: string;
		reference_version?: string;
		variants: Record<string, { onnx_sha256: string; [k: string]: unknown }>;
		taxon_cap?: number;
		default_taxon_cap?: number;
		[k: string]: unknown;
	}
	export interface VariantPick {
		name: string;
		onnxSha256: string;
		bustedHeadSha256: string | null;
		onnxFile: string;
		bustedHeadFile: string | null;
		trainedOn?: string;
		regime?: string;
		raw: Record<string, unknown>;
	}
	export function loadManifest(source: string | URL | object, options?: Record<string, unknown>): Promise<Manifest>;
	export function parseManifest(doc: object | string): Manifest;
	export function listVariants(manifest: Manifest): string[];
	export function pickVariant(manifest: Manifest, name?: string): VariantPick;
	export function modelLocation(base: string, manifest: Manifest, variantName?: string): string;
	export function sha256Hex(bytes: ArrayBuffer | Uint8Array): Promise<string | null>;
	export const DEFAULT_VARIANT: string;
}

declare module '@veg/hyphaeon-runtime/web' {
	import type { RuntimeSessionHandle } from '@veg/hyphaeon-runtime';
	export function loadSession(options: {
		modelUrl: string;
		expectedSha256?: string;
		ortWasmPath?: string;
		numThreads?: number;
		expectedInputs?: readonly string[];
	}): Promise<RuntimeSessionHandle>;
	export function loadBustedHead(options: {
		modelUrl: string;
		expectedSha256?: string;
		ortWasmPath?: string;
		numThreads?: number;
	}): Promise<RuntimeSessionHandle>;
	export function isSessionLoaded(options?: {
		modelUrl: string;
		expectedSha256?: string;
		ortWasmPath?: string;
		numThreads?: number;
	}): boolean;
	export function resolveThreads(requested: number): number;
	export function resetSession(): void;
	export const DEFAULT_ORT_WASM_PATH: string;
}

declare module '@veg/hyphaeon-runtime/prescreen' {
	export function loadHitLikelihoodModel(): Promise<unknown>;
	export function estimateHitLikelihood(args: {
		method: string;
		alignment: string;
		tree: string;
		treeSource?: string;
		model?: unknown;
		opts?: Record<string, unknown>;
	}): Promise<Record<string, unknown>>;
	export function treeHasBranchLengths(tree: string | null): boolean;
}

declare module '@veg/hyphaeon-runtime/prescreen/scope' {
	export function hasHitLikelihood(method: string | null): boolean;
	export function treeHasBranchLengths(tree: string | null): boolean;
}

declare module '@veg/hyphaeon-js' {
	export interface Diagnostic {
		code: string;
		severity: 'info' | 'warn' | 'refuse';
		message: string;
		data: Record<string, unknown>;
	}
	export interface Diagnosis {
		ok: boolean;
		warnings: Diagnostic[];
		summary: Record<string, unknown>;
	}
	export function diagnose(input: {
		alignmentText: string;
		treeText?: string | null;
		parsed?: unknown;
		maxSpecies?: number;
		taxaLimit?: number;
		/** D22: force the tree-free TN93 path even when a usable tree was given. */
		useTn93?: boolean;
	}): Diagnosis;
	export const DIAGNOSTIC_CODES: readonly string[];
	export function sniffAlignmentFormat(text: string): 'phylip' | 'fasta' | 'nexus' | 'unknown';
	export function parseAlignmentSequences(text: string): Map<string, string>;
	export interface PhyloTree {
		root: number;
		branchLength: Array<number | null>;
		[k: string]: unknown;
	}
	export function extractTree(content: string): PhyloTree | null;
	export function treeTaxa(tree: PhyloTree): string[];
	export function matchTaxa(
		treeTaxaList: string[],
		alignmentNames: Iterable<string>
	): { taxa: string[]; tier: 'exact' | 'quote_stripped' | 'case_insensitive' };
	export function hasNonzeroBranchLengths(tree: PhyloTree): boolean;
	export function needsBranchLengths(tree: PhyloTree): boolean;
	export function memeSitePq(lrts: ArrayLike<number>): { pvals: Float32Array; qvals: Float32Array };
	export const MAX_SPECIES_DEFAULT: number;
	export const MAX_SPECIES_CAP: number;

	// --- phenotype (js/src/phenotype.js, Phase 3a) ---
	/** The eight curated trait presets, phenotype.py:48-111 verbatim. */
	export const PRESETS: Readonly<
		Record<string, { title: string; description: string; foreground: string[]; controls?: string[] }>
	>;
	/** The literals of `run_phenotype_association` that the CLI does not expose. */
	export const PHENOTYPE_THRESHOLDS: Readonly<Record<string, number>>;
	export interface PhenotypeVector {
		y: Float64Array;
		mode: 'discrete' | 'continuous';
		fgCount: number;
		bgCount: number;
		description: string;
		meta: { mode: string; foreground_count: number; background_count: number; description: string };
	}
	/**
	 * `resolve_phenotype_vector` (phenotype.py:121-274). `phenotypeCsv` is the table's CONTENT and
	 * `phenotypeFile` its name (the name decides TAB vs comma and goes into the description);
	 * `background` is accepted and ignored, as in the reference.
	 */
	export function resolvePhenotypeVector(
		taxa: ArrayLike<string>,
		options?: {
			preset?: string | null;
			foreground?: string | ArrayLike<string> | null;
			background?: string | ArrayLike<string> | null;
			phenotypeCsv?: string | null;
			phenotypeFile?: string | null;
			sep?: string | null;
			traitCol?: string | null;
			speciesCol?: string | null;
			continuous?: boolean;
		}
	): PhenotypeVector;
	/** `re.search` first, then `fnmatch`: the reference's own pattern test (phenotype.py:249-260). */
	export function pyFnmatch(name: string, pattern: string): boolean;
	export function parsePhenotypeTable(
		text: string,
		sep: string
	): { columns: string[]; rows: Array<Record<string, string>>; floatColumns: string[] };
}
