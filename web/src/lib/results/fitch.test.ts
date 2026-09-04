import { describe, expect, it } from 'vitest';
import { fitchReconstruct, type FitchNode } from './fitch';

function node(name: string, children?: FitchNode[]): FitchNode {
	const n: FitchNode = { data: { name }, children: children ?? null, parent: null };
	for (const c of children ?? []) c.parent = n;
	return n;
}

describe('fitchReconstruct', () => {
	it('counts one change for a single derived tip', () => {
		const root = node('root', [node('a'), node('b'), node('c')]);
		const states: Record<string, string> = { a: 'A', b: 'A', c: 'K' };
		const r = fitchReconstruct(root, (n) => states[n]);
		expect(r.substitutions).toBe(1);
		expect(root.state).toBe('A');
	});

	it('counts one change on the internal branch of a clade sweep', () => {
		const root = node('root', [node('x', [node('a'), node('b')]), node('y', [node('c'), node('d')])]);
		const states: Record<string, string> = { a: 'V', b: 'V', c: 'K', d: 'K' };
		const r = fitchReconstruct(root, (n) => states[n]);
		expect(r.substitutions).toBe(1);
		// Both clades have nothing changing inside them and so collapse.
		expect(root.children![0].collapsed).toBe(true);
		expect(root.children![1].collapsed).toBe(true);
	});

	it('never counts a change into or out of an unknown state', () => {
		const root = node('root', [node('a'), node('b'), node('c')]);
		const states: Record<string, string> = { a: 'A', b: 'A', c: '?' };
		expect(fitchReconstruct(root, (n) => states[n]).substitutions).toBe(0);
	});
});
