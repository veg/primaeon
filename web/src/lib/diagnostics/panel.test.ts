/**
 * panel.test.ts — the app semantics over the library's diagnostic codes.
 *
 * WHY THIS FILE EXISTS. The rules in panel.ts decide whether Run is enabled and which variant is
 * suggested; the library's own tests pin the codes, so these pin what the app does with them: a
 * recoverable refusal (no tree) becomes an NJ step when the tree tools exist and stays a block
 * when they do not; SHALLOW_TREE suggests `viral`; the cost estimate grows with L and N².
 */

import { describe, expect, it } from 'vitest';
import type { DiagnosisSnapshot } from '$lib/api';
import {
	costEstimate,
	formatSeconds,
	panelModel,
	regimeLine,
	suggestVariant,
	treePlan
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

describe('treePlan', () => {
	it('uses the user tree when nothing is missing', () => {
		expect(treePlan(diag([COST], { treeSource: 'user' }), true)).toEqual({ kind: 'user' });
		expect(treePlan(diag([COST], { treeSource: 'embedded' }), true)).toEqual({ kind: 'embedded' });
	});

	it('infers NJ when the tree is missing and the tools exist', () => {
		const d = diag([
			{ code: 'TREE_MISSING', severity: 'refuse', message: '', data: { recoverable: true } },
			COST
		]);
		expect(treePlan(d, true)).toEqual({ kind: 'infer', via: 'nj' });
		expect(treePlan(d, false)).toEqual({ kind: 'none' });
	});

	it('estimates branch lengths when the tree has none', () => {
		const d = diag(
			[{ code: 'BRANCH_LENGTHS_MISSING', severity: 'warn', message: '', data: { recoverable: true } }, COST],
			{ treeSource: 'user' }
		);
		expect(treePlan(d, true)).toEqual({ kind: 'estimate-branch-lengths', via: 'hyphy-hky85' });
		expect(treePlan(d, false)).toEqual({ kind: 'user' });
	});
});

describe('panelModel', () => {
	it('blocks on an unrecoverable refusal and orders rows by severity', () => {
		const d = diag([
			{ code: 'STAR_LIKE', severity: 'warn', message: 'star', data: {} },
			{ code: 'TOO_FEW_TAXA', severity: 'refuse', message: 'two taxa', data: {} },
			{ code: 'ALPHABET_U_TO_T', severity: 'info', message: 'u', data: {} },
			COST
		]);
		const m = panelModel(d, true);
		expect(m.canRun).toBe(false);
		expect(m.blocking.map((r) => r.code)).toEqual(['TOO_FEW_TAXA']);
		expect(m.rows.map((r) => r.code)).toEqual(['TOO_FEW_TAXA', 'STAR_LIKE', 'ALPHABET_U_TO_T']);
	});

	it('does not block on a missing tree when the tree tools exist', () => {
		const d = diag([
			{ code: 'TREE_MISSING', severity: 'refuse', message: 'no tree', data: { recoverable: true } },
			COST
		]);
		expect(panelModel(d, true).canRun).toBe(true);
		expect(panelModel(d, true).rows[0].handled).toBe(true);
		expect(panelModel(d, false).canRun).toBe(false);
	});

	it('cannot run without a diagnosis', () => {
		expect(panelModel(null, true).canRun).toBe(false);
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
