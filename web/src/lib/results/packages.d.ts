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

declare module '@veg/hyphaeon-js' {
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
	}
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
