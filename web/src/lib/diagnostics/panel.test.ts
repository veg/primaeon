/**
 * panel.test.ts — the app semantics over the library's diagnostic codes.
 *
 * WHY THIS FILE EXISTS. The rules in panel.ts decide whether Run is enabled and which variant is
 * suggested; the library's own tests pin the codes, so these pin what the app does with them:
 * TREE_FREE_TN93 is a plan and never a block (D22), TN93_SATURATED_PAIRS at refuse level IS one,
 * SHALLOW_TREE suggests `viral`, and the cost estimate grows with L and N².
 */

import { describe, expect, it } from 'vitest';
import type { DiagnosisSnapshot } from '$lib/api';
import {
	costEstimate,
	formatSeconds,
	panelModel,
	plannedTreeSource,
	regimeLine,
	saturatedPairs,
	suggestVariant,
	treePlan,
	treePlanText
} from './panel';

function diag(warnings: DiagnosisSnapshot['warnings'], summary: Record<string, unknown> = {}): DiagnosisSnapshot {
	return { ok: !warnings.some((w) => w.severity === 'refuse'), warnings, summary };
}

const COST = {
	code: 'COST_ESTIMATE',
	severity: 'info' as const,
	message: '',
	data: { L: 351, N_used: 18, exceedsCaps: { codons: false, work: false } }
};

const treeFree = (reason: string, treeKeptForDisplay = false) => ({
	code: 'TREE_FREE_TN93',
	severity: 'info' as const,
	message: 'Tree-free TN93 mode will be used',
	data: { reason, taxaOrder: 'alignment', distances: 'tn93', treeKeptForDisplay }
});

describe('treePlan', () => {
	it('uses the tree as given when the library reports no tree-free notice', () => {
		expect(treePlan(diag([COST], { treeSource: 'user' }))).toEqual({ kind: 'user' });
		expect(treePlan(diag([COST], { treeSource: 'embedded' }))).toEqual({ kind: 'embedded' });
		expect(plannedTreeSource(diag([COST], { treeSource: 'user' }))).toBe('user');
	});

	it('goes tree-free when there is no tree, and says so', () => {
		const d = diag([treeFree('no_tree'), COST]);
		expect(treePlan(d)).toEqual({ kind: 'tree-free', reason: 'no_tree', treeKeptForDisplay: false });
		expect(plannedTreeSource(d)).toBe('tn93');
		expect(treePlanText(treePlan(d))).toMatch(/neighbour-joining tree is built from them for display only/);
	});

	it('goes tree-free when the tree has no usable branch lengths, keeping it for display', () => {
		const d = diag([treeFree('no_branch_lengths', true), COST], { treeSource: 'user' });
		expect(treePlan(d)).toEqual({ kind: 'tree-free', reason: 'no_branch_lengths', treeKeptForDisplay: true });
		expect(treePlanText(treePlan(d))).toMatch(/draws your topology with unit branch lengths, for display only, and the model sees distances, not the topology/);
	});
});

describe('saturatedPairs', () => {
	it('reads the pair count the library counted, and null when it did not', () => {
		const d = diag([
			treeFree('no_tree'),
			{ code: 'TN93_SATURATED_PAIRS', severity: 'warn', message: '', data: { pairs: 12, sentinel: 1 } },
			COST
		]);
		expect(saturatedPairs(d)).toBe(12);
		expect(saturatedPairs(diag([COST]))).toBeNull();
		expect(panelModel(d).saturatedPairs).toBe(12);
	});
});

describe('panelModel', () => {
	it('blocks on a refusal and orders rows by severity', () => {
		const d = diag([
			{ code: 'STAR_LIKE', severity: 'warn', message: 'star', data: {} },
			{ code: 'TOO_FEW_TAXA', severity: 'refuse', message: 'two taxa', data: {} },
			{ code: 'ALPHABET_U_TO_T', severity: 'info', message: 'u', data: {} },
			COST
		]);
		const m = panelModel(d);
		expect(m.canRun).toBe(false);
		expect(m.blocking.map((r) => r.code)).toEqual(['TOO_FEW_TAXA']);
		expect(m.rows.map((r) => r.code)).toEqual(['TOO_FEW_TAXA', 'STAR_LIKE', 'ALPHABET_U_TO_T']);
	});

	it('never blocks on a missing tree: it is the tree-free plan, marked handled', () => {
		const d = diag([treeFree('no_tree'), COST]);
		const m = panelModel(d);
		expect(m.canRun).toBe(true);
		expect(m.rows[0].code).toBe('TREE_FREE_TN93');
		expect(m.rows[0].handled).toBe(true);
	});

	it('blocks when the TN93 matrix could not be computed at all', () => {
		const d = diag([
			treeFree('no_tree'),
			{ code: 'TN93_SATURATED_PAIRS', severity: 'refuse', message: 'ZeroDivisionError', data: { pairs: null } },
			COST
		]);
		expect(panelModel(d).canRun).toBe(false);
		expect(panelModel(d).blocking.map((r) => r.code)).toEqual(['TN93_SATURATED_PAIRS']);
	});

	it('cannot run without a diagnosis', () => {
		expect(panelModel(null).canRun).toBe(false);
	});
});

describe('suggestVariant', () => {
	it('suggests viral on a shallow tree', () => {
		const d = diag([
			{ code: 'SHALLOW_TREE', severity: 'info', message: '', data: { medianPatristic: 0.024, suggestVariant: 'viral' } },
			COST
		]);
		expect(suggestVariant(d).variant).toBe('viral');
		expect(suggestVariant(d).reason).toMatch(/0\.024/);
	});

	it('suggests general otherwise', () => {
		expect(suggestVariant(diag([COST], { medianPatristic: 0.35 })).variant).toBe('general');
		expect(suggestVariant(null).variant).toBe('general');
	});
});

describe('regimeLine', () => {
	it('names the regime and the sizes', () => {
		const line = regimeLine(
			diag([{ code: 'DEEP_LARGE_TREE', severity: 'warn', message: '', data: {} }], {
				taxaUsed: 120,
				codons: 335,
				medianPatristic: 0.31
			})
		);
		expect(line).toBe('120 taxa · 335 codons · median patristic 0.31 — deep tree with many taxa, elevated false-positive rate');
	});
});

describe('costEstimate', () => {
	it('scales with the site count and N squared', () => {
		const small = costEstimate(diag([COST]))!;
		const big = costEstimate(
			diag([{ ...COST, data: { L: 335, N_used: 476, exceedsCaps: { codons: false, work: false } } }])
		)!;
		expect(small.secondsHigh).toBeGreaterThan(small.secondsLow);
		expect(big.secondsHigh).toBeGreaterThan(small.secondsHigh * 10);
		expect(costEstimate(null)).toBeNull();
	});

	it('formats seconds for people', () => {
		expect(formatSeconds(0.4)).toBe('< 1 s');
		expect(formatSeconds(12)).toBe('12 s');
		expect(formatSeconds(150)).toBe('2.5 min');
		expect(formatSeconds(7200)).toBe('2.0 h');
	});
});
