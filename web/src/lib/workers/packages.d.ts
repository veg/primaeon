/**
 * packages.d.ts — ambient types for the names the workers and the analyze flow import from the
 * two untyped JavaScript packages (`@veg/hyphaeon-runtime`, `@veg/hyphaeon-js`).
 *
 * WHY THIS FILE EXISTS. Same reason as web/src/lib/results/packages.d.ts, which declares the
 * names the results page uses: the packages ship JSDoc'd ES modules without declaration files,
 * and under `strict` an untyped import is TS7016. Ambient module declarations merge across
 * files, so this one adds only the names the analyze side needs (runMeme, the manifest helpers,
 * loadSession, the prescreen, diagnose, memeSitePq, the parser and tree helpers) and repeats none
 * of the results page's. Typed from the source (runtime/src/pipeline.js, manifest.js,
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

declare module '@veg/hyphaeon-runtime/hyphy' {
	export type HyPhyProgress = (phase: string, done: number, total: number, message: string) => void;
	export interface HyPhyRun {
		result: string;
		stdout: string;
		stderr: string;
		elapsedMs: number;
	}
	export interface HyPhy {
		hyphyVersion(progress?: HyPhyProgress): Promise<string>;
		estimateBranchLengths(alignmentFasta: string, newick: string, opts?: { progress?: HyPhyProgress }): Promise<HyPhyRun>;
		njTree(alignmentFasta: string, opts?: { progress?: HyPhyProgress }): Promise<HyPhyRun>;
		convertAlignment(text: string, opts?: { fileName?: string; progress?: HyPhyProgress }): Promise<HyPhyRun>;
	}
	export function createHyPhy(options?: {
		locateFile?: (name: string) => string | URL;
		glueStrategy?: 'auto' | 'importScripts' | 'eval';
		progress?: HyPhyProgress;
	}): Promise<HyPhy>;
	export const HYPHY_WASM_VERSION: string;
	export const HYPHY_ASSETS: readonly string[];
	export class HyPhyError extends Error {
		exitCode: number;
		stdout: string;
		stderr: string;
	}
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
}
