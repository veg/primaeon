/**
 * panel.ts — what the "Before you run" panel says, derived from the library's `diagnose()` and
 * the runtime's MEME hit-likelihood prescreen. Pure functions; the Svelte component renders them.
 *
 * WHY THIS FILE EXISTS. PLAN.md §4.3 has one implementation of the checks (`@veg/hyphaeon-js`
 * `diagnose`, run in `workers/prep.worker.ts`) and this file holds the APP semantics layered on
 * its codes: which severities block the Run button, the variant suggestion (§2 hard truth 6: "a
 * visible choice with an automatic suggestion from tree depth"), the regime line, and the browser
 * cost estimate. The library's `diagnostics.js` header says "reports and never decides"; deciding
 * is done here, in one place, so the page and the tests read the same rules.
 *
 * D22 SIMPLIFIED THE TREE RULES TO ONE ROW. Until Phase 3 the app had to recover from two of the
 * library's own findings — a missing tree (which the library refused) and a tree without branch
 * lengths (which it warned about) — by running a second WebAssembly engine to build or fit one,
 * so `RECOVERABLE_CODES` existed and `treePlan` had five outcomes. Both codes are gone from the
 * library. A tree with branch lengths is used as given; anything else is `TREE_FREE_TN93`, an
 * INFO row carrying `data.reason` (`no_tree` | `no_branch_lengths` | `requested`), and the
 * pairwise TN93 distances go into the MDS in its place. Nothing about the tree blocks a run any
 * more, and the only new refusal is `TN93_SATURATED_PAIRS` at refuse level, which the library
 * emits when the distance matrix could not be computed at all (the point where the reference
 * itself raises).
 *
 * COST ESTIMATE. `diagnose` reports `predictedSeconds = L·N²/4.7e6` calibrated on CPU torch
 * (its header). The browser path is ORT WASM, where three terms matter at the sizes people
 * paste: a fixed session cost (graph optimisation and thread-pool start, paid per run because
 * the inference worker is recreated per page), a per-variable-site constant (graph launch, feed
 * construction, the [b, N, N] copy), and the L·N² term. The first two were MEASURED on this
 * machine (Apple M4 Pro, headless Chromium, 14 threads under COOP/COEP, model and ORT served
 * from localhost) by the scratch Playwright drive in the Phase 1b report, second runs, the
 * checklist's `infer` step (session load through scoring):
 *
 *   bat_oas1  18 taxa × 351 codons, 182 variable sites   328 ms  (first run 373 ms)
 *   Smc6      20 taxa × 1,097 codons, 97 variable sites   246 ms  (first run 333 ms)
 *
 * Two points, two unknowns: ~1.0 ms per variable site and ~150 ms fixed. Hence
 *
 *   WASM_SESSION_SECONDS   the fixed term
 *   WASM_SECONDS_PER_SITE  seconds per VARIABLE site at small N (invariable sites are skipped
 *                          and cost nothing, inference.py:170-186)
 *   WASM_WORK_PER_SECOND   L·N² per second, the N² term, from the camelid drive in the same
 *                          report (212 taxa × 96 codons, 86 variable sites, HKY85 tree): the
 *                          `infer` step took 1,165 ms, of which 150 + 86 ms are the two terms
 *                          above, so 86 × 212² / 0.93 s ≈ 4.2e6 with 14 threads. One point;
 *                          recalibrate from a HIV1_RT (476-taxon) drive.
 *
 * The estimate is a range, not a number, because the variable-site count is unknown before the
 * run (low: half the sites; high: every site) and a first run also downloads ~13 MB of ORT and
 * ~7.8 MB of graph; the panel says so.
 */

import type { DiagnosisSnapshot, DiagnosticWarning, TreeFreeReason, Variant } from '$lib/api';

/** Fixed per-run session cost in the browser; see the header. */
export const WASM_SESSION_SECONDS = 0.15;
/** Measured per-variable-site inference cost in the browser; see the header. */
export const WASM_SECONDS_PER_SITE = 0.001;
/** L·N² per second in the browser with 14 threads; see the header (one measured point). */
export const WASM_WORK_PER_SECOND = 4.2e6;
/** Bytes a first run downloads before scoring: ORT WASM + loader (13.3 MB) and one graph (7.8 MB). */
export const FIRST_RUN_DOWNLOAD_BYTES = 13.3e6 + 7.8e6;

export type Severity = DiagnosticWarning['severity'];

/** Display order: refusals first, then warnings, then information. */
export const SEVERITY_RANK: Record<Severity, number> = { refuse: 0, warn: 1, info: 2 };

/** Codes that are bookkeeping rather than something to read as a warning. */
export const QUIET_CODES = new Set(['COST_ESTIMATE']);

/** The library's tree-free code and its saturation companion, named once (D22). */
export const TREE_FREE_CODE = 'TREE_FREE_TN93';
export const TN93_SATURATED_CODE = 'TN93_SATURATED_PAIRS';

/**
 * What the run will do about the tree. `tree-free` is not a failure state: it is the reference's
 * own `--use-tn93` path, made the default whenever a usable tree is absent (D22), and the
 * manuscript measures it against tree-based at rho = 0.9997.
 */
export type TreePlan =
	| { kind: 'user' }
	| { kind: 'embedded' }
	| { kind: 'tree-free'; reason: TreeFreeReason; treeKeptForDisplay: boolean }
	| { kind: 'none' };

export interface PanelRow {
	code: string;
	severity: Severity;
	/** True when the finding is something the pipeline does rather than something to fix. */
	handled: boolean;
	message: string;
	data: Record<string, unknown>;
}

export interface CostEstimate {
	L: number;
	N: number;
	variableSites: number | null;
	/** Seconds of scoring, low and high (the high bound assumes every site is variable). */
	secondsLow: number;
	secondsHigh: number;
	/** Whether the input exceeds PLAN.md §3.5's browser caps (codons or work). */
	exceedsCaps: { codons: boolean; work: boolean };
	firstRunDownloadBytes: number;
}

export interface PanelModel {
	rows: PanelRow[];
	/** Refusals; non-empty blocks Run. */
	blocking: PanelRow[];
	canRun: boolean;
	treePlan: TreePlan;
	/** Pairs that came back at the TN93 saturation sentinel, when the run is tree-free. */
	saturatedPairs: number | null;
	suggestedVariant: Variant;
	suggestionReason: string | null;
	regime: string | null;
	cost: CostEstimate | null;
}

/**
 * The tree the run will use, from the diagnosis alone: the file as given, the alignment's embedded
 * tree as given, or tree-free TN93 distances with the library's own reason for it.
 *
 * `TREE_FREE_TN93.data.treeKeptForDisplay` says whether a topology was supplied at all (a tree
 * without branch lengths). Either way the runtime draws a neighbour-joining tree built from the
 * TN93 distances (runtime/src/pipeline.js displayTreeFor, nj.js) — a topology without lengths is
 * not drawable as a phylogram — and the model sees distances, never any topology.
 */
export function treePlan(diagnosis: DiagnosisSnapshot | null): TreePlan {
	if (!diagnosis) return { kind: 'none' };
	const treeFree = diagnosis.warnings.find((w) => w.code === TREE_FREE_CODE);
	if (treeFree) {
		const reason = treeFree.data?.reason;
		return {
			kind: 'tree-free',
			reason: (reason === 'no_tree' || reason === 'no_branch_lengths' || reason === 'requested' ? reason : 'no_tree') as TreeFreeReason,
			treeKeptForDisplay: Boolean(treeFree.data?.treeKeptForDisplay)
		};
	}
	const source = diagnosis.summary.treeSource as string | null | undefined;
	if (source === 'embedded') return { kind: 'embedded' };
	if (source === 'user') return { kind: 'user' };
	return { kind: 'none' };
}

/** The tree source a run with this diagnosis will record (api.ts `TreeSource`). */
export function plannedTreeSource(diagnosis: DiagnosisSnapshot | null): 'user' | 'embedded' | 'tn93' | null {
	const plan = treePlan(diagnosis);
	if (plan.kind === 'tree-free') return 'tn93';
	if (plan.kind === 'user' || plan.kind === 'embedded') return plan.kind;
	return null;
}

/** How many pairs came back at the saturation sentinel, when the library counted them. */
export function saturatedPairs(diagnosis: DiagnosisSnapshot | null): number | null {
	const row = diagnosis?.warnings.find((w) => w.code === TN93_SATURATED_CODE);
	if (!row) return null;
	const n = row.data?.pairs;
	return typeof n === 'number' ? n : null;
}

/** The variant the diagnostics suggest: `viral` on a shallow tree (SHALLOW_TREE), else `general`. */
export function suggestVariant(diagnosis: DiagnosisSnapshot | null): {
	variant: Variant;
	reason: string | null;
} {
	if (!diagnosis) return { variant: 'general', reason: null };
	const shallow = diagnosis.warnings.find((w) => w.code === 'SHALLOW_TREE');
	if (shallow) {
		const median = shallow.data.medianPatristic;
		return {
			variant: 'viral',
			reason:
				typeof median === 'number'
					? `median patristic distance ${median.toPrecision(2)} substitutions/site is shallow; the viral variant was trained on this regime`
					: 'the tree is shallow; the viral variant was trained on this regime'
		};
	}
	const median = diagnosis.summary.medianPatristic;
	if (typeof median === 'number') {
		return {
			variant: 'general',
			reason: `median patristic distance ${median.toPrecision(2)} substitutions/site is not shallow; the general (cross-species) variant applies`
		};
	}
	return { variant: 'general', reason: null };
}

/** One line naming the regime the run falls in (PLAN.md §2 items 3, 5, 6). */
export function regimeLine(diagnosis: DiagnosisSnapshot | null): string | null {
	if (!diagnosis) return null;
	const s = diagnosis.summary;
	const codes = new Set(diagnosis.warnings.map((w) => w.code));
	const parts: string[] = [];
	const taxa = (s.taxaUsed ?? s.uniqueHaplotypes ?? s.taxaInAlignment) as number | null | undefined;
	if (typeof taxa === 'number') parts.push(`${taxa} taxa`);
	if (typeof s.codons === 'number') parts.push(`${(s.codons as number).toLocaleString()} codons`);
	if (typeof s.uniqueHaplotypes === 'number' && s.uniqueHaplotypes !== s.taxaInAlignment) {
		parts.push(`${s.uniqueHaplotypes} unique haplotypes`);
	}
	if (typeof s.medianPatristic === 'number') {
		parts.push(`median patristic ${(s.medianPatristic as number).toPrecision(2)}`);
	}
	let label: string;
	if (codes.has('STAR_LIKE')) label = 'star-like panel, outside the evaluated regime';
	else if (codes.has('DEEP_LARGE_TREE')) label = 'deep tree with many taxa, elevated false-positive rate';
	else if (codes.has('SHALLOW_TREE')) label = 'shallow tree, the viral variant’s regime';
	else if (typeof s.medianPatristic === 'number') label = 'cross-species regime';
	else if (codes.has(TREE_FREE_CODE)) label = 'depth judged on TN93 distances';
	else label = 'regime not assessed';
	return parts.length ? `${parts.join(' · ')} — ${label}` : label;
}

/**
 * Browser cost from the COST_ESTIMATE row's L and N_used. The low bound uses the variable-site
 * count when the diagnosis knows it (it does not yet; `variableSites` is null until the runtime
 * reports it), the high bound assumes every site is scored.
 */
export function costEstimate(diagnosis: DiagnosisSnapshot | null, variableSites: number | null = null): CostEstimate | null {
	if (!diagnosis) return null;
	const row = diagnosis.warnings.find((w) => w.code === 'COST_ESTIMATE');
	if (!row) return null;
	const L = Number(row.data.L);
	const N = Number(row.data.N_used);
	if (!Number.isFinite(L) || !Number.isFinite(N)) return null;
	const perSite = (sites: number) =>
		WASM_SESSION_SECONDS + sites * WASM_SECONDS_PER_SITE + (sites * N * N) / WASM_WORK_PER_SECOND;
	const caps = (row.data.exceedsCaps as { codons?: boolean; work?: boolean } | undefined) ?? {};
	return {
		L,
		N,
		variableSites,
		secondsLow: perSite(variableSites ?? Math.round(L * 0.5)),
		secondsHigh: perSite(L),
		exceedsCaps: { codons: Boolean(caps.codons), work: Boolean(caps.work) },
		firstRunDownloadBytes: FIRST_RUN_DOWNLOAD_BYTES
	};
}

/** "about 2 s", "about 1.5 min": one human number for the panel. */
export function formatSeconds(seconds: number): string {
	if (!Number.isFinite(seconds)) return '?';
	if (seconds < 1) return '< 1 s';
	if (seconds < 90) return `${Math.round(seconds)} s`;
	const minutes = seconds / 60;
	if (minutes < 60) return `${minutes < 10 ? minutes.toFixed(1) : Math.round(minutes)} min`;
	return `${(minutes / 60).toFixed(1)} h`;
}

/**
 * Everything the panel renders. Rows are sorted refusals → warnings → info; recoverable
 * refusals are marked `handled` when the tree tools exist and do not block.
 */
export function panelModel(diagnosis: DiagnosisSnapshot | null): PanelModel {
	const plan = treePlan(diagnosis);
	const suggestion = suggestVariant(diagnosis);
	const rows: PanelRow[] = [];
	if (diagnosis) {
		for (const w of diagnosis.warnings) {
			if (QUIET_CODES.has(w.code)) continue;
			rows.push({
				code: w.code,
				severity: w.severity,
				// Tree-free mode is a thing the pipeline DOES, not a finding to act on.
				handled: w.code === TREE_FREE_CODE,
				message: w.message,
				data: w.data ?? {}
			});
		}
		rows.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
	}
	const blocking = rows.filter((r) => r.severity === 'refuse' && !r.handled);
	return {
		rows,
		blocking,
		canRun: diagnosis !== null && blocking.length === 0,
		treePlan: plan,
		saturatedPairs: saturatedPairs(diagnosis),
		suggestedVariant: suggestion.variant,
		suggestionReason: suggestion.reason,
		regime: regimeLine(diagnosis),
		cost: costEstimate(diagnosis)
	};
}

/** One sentence for the panel and the report strip, from a TreePlan. */
export function treePlanText(plan: TreePlan): string {
	switch (plan.kind) {
		case 'user':
			return 'Uploaded tree with branch lengths, used as given.';
		case 'embedded':
			return 'Tree embedded in the alignment, with branch lengths, used as given.';
		case 'tree-free':
			return plan.reason === 'no_branch_lengths'
				? `Tree-free: the tree has no usable branch lengths, so pairwise TN93 distances feed the MDS instead${plan.treeKeptForDisplay ? '; the report draws a neighbour-joining tree built from those distances, and the model sees neither topology' : ''}.`
				: plan.reason === 'requested'
					? 'Tree-free: TN93 distances were requested, so they feed the MDS directly.'
					: 'Tree-free: no tree was supplied, so pairwise TN93 distances feed the MDS and a neighbour-joining tree is built from them for display only.';
		default:
			return 'No usable tree yet.';
	}
}

/** The prescreen's four statuses (runtime/src/prescreen/hitLikelihood.js). */
export type PrescreenStatus = 'ok' | 'not-applicable' | 'cannot-assess' | 'error';

export interface PrescreenResult {
	status: PrescreenStatus;
	reason: string | null;
	detail: string | null;
	level: 'likely' | 'uncertain' | 'unlikely' | null;
	hit_probability: number | null;
	recommend_run: boolean | null;
	caveat: string;
	basis: string;
	recommendation: { headline?: string; body?: string; [k: string]: unknown } | string | null;
	num_seqs: number | null;
	num_sites: number | null;
	median_pos_dist: number | null;
	tree_source: string;
	tree_source_caveat: string | null;
	[k: string]: unknown;
}

/** Band copy for the advisory line; the rates are DM3's observed frequencies (recommendation.js). */
export const PRESCREEN_BAND: Record<NonNullable<PrescreenResult['level']>, { label: string; lead: string }> = {
	likely: {
		label: 'MEME likely reports sites',
		lead: 'Alignments that scored like this one reported at least one selected site in about nine of ten full MEME runs.'
	},
	uncertain: {
		label: 'MEME may or may not report sites',
		lead: 'Alignments that scored like this one reported a selected site in about half of full MEME runs.'
	},
	unlikely: {
		label: 'MEME unlikely to report sites',
		lead: 'Alignments that scored like this one reported a selected site in about one of twenty full MEME runs; there may be too few substitutions to fit.'
	}
};
