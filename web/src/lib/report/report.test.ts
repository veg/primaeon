/**
 * report.test.ts — the pure parts of the report layer: the v1 → v2 wrapper, the section-status
 * decision, the gallery/server record coercion, and the MCP snippet.
 *
 * WHY THIS FILE EXISTS. The worker, IndexedDB and the page are exercised by the Playwright drive
 * (the scratch script in the Phase 2 report); what can be pinned under Node is the logic those
 * depend on: a Phase 1 `ResultRecord` becomes a report whose only section is `sites` with the
 * Phase 2 option defaults filled in; a missing section reads as pending / running / unavailable /
 * interrupted / skipped according to the run's state; a bare `hyphaeon meme` document wraps as a
 * `sites`-only report; the `hyphaeon_analyze` snippet carries the report's options under the CLI's
 * names.
 */

import { describe, expect, it } from 'vitest';
import type { ReportRecord, ResultRecord } from '$lib/api';
import { reportPath } from '$lib/api';
import { wrapLegacyRun, DEFAULT_PERMUTATIONS, DEFAULT_SEED } from '$lib/storage/reports';
import { coerceReport } from './load';
import { analyzeToolArguments } from './mcp';
import { emptySections } from './types';
import { sectionStatus } from './status';

const provenance = {
	schema_version: 1,
	surface: 'browser',
	hyphaeon_js_version: '1.0.0',
	reference_version: '1.0.0',
	model_version: 'v1',
	model_variant: 'general',
	artifact_sha256: 'aa10e8e0'.padEnd(64, '0'),
	is_surrogate: true,
	surrogate_for: 'MEME',
	seed: null,
	elapsed_sec: 2.5,
	options: {},
	preprocessing: {
		taxa_in_alignment: 18,
		taxa_used: 18,
		dropped_taxa: [],
		duplicates_collapsed: 0,
		pd_subsampled: false,
		reference_sequence: 'hg38',
		tree_source: 'user',
		branch_lengths_estimated: false,
		distance_rescaled: true,
		codons_trimmed: 0,
		unknown_codon_fraction: 0,
		in_frame_stops: 0
	},
	warnings: []
};

const v1: ResultRecord = {
	id: 'run-1',
	createdAt: 1_700_000_000_000,
	createdAtIso: new Date(1_700_000_000_000).toISOString(),
	created_at: new Date(1_700_000_000_000).toISOString(),
	name: 'bat_oas1',
	method: 'meme',
	inputs: { alignment: { name: 'bat_oas1.fasta', size: 10, sha256: 'ab' }, tree: null, treeSource: 'user', demo: 'bat_oas1' },
	options: { variant: 'general', maxSpecies: 256, referenceSequence: 'hg38', callMode: 'percentile', filter: false, attribute: false },
	steps: [{ id: 'infer', label: 'x', status: 'done', message: null, elapsedMs: 1500 }],
	diagnostics: null,
	runtime: { numThreads: 4, crossOriginIsolated: true, hardwareConcurrency: 8, wallMs: 3000 },
	result: {
		schema_version: 1,
		method: 'meme',
		is_surrogate: true,
		surrogate_for: 'MEME',
		sites: [{ site: 1, hyphaeon_lrt: 1.5, p_value: 0.2, q_value: 0.5, is_invariable: false }],
		summary: { totalSites: 1, variableSites: 1, speciesUsed: 18, speciesInAlignment: 18 },
		provenance
	}
};

describe('wrapLegacyRun', () => {
	it('wraps a Phase 1 run as a done report whose only section is sites', () => {
		const r = wrapLegacyRun(v1);
		expect(r.schema_version).toBe(2);
		expect(r.kind).toBe('report');
		expect(r.id).toBe('run-1');
		expect(r.sections.sites?.sites).toHaveLength(1);
		expect(r.sections.gene).toBeNull();
		expect(r.sections.dms).toBeNull();
		expect(r.status.state).toBe('done');
		expect(r.status.completed).toEqual(['sites']);
		expect(r.options.seed).toBe(DEFAULT_SEED);
		expect(r.options.permutations).toBe(DEFAULT_PERMUTATIONS);
		expect(r.options.dms.enabled).toBe(false);
		expect(r.inputs.alignmentText).toBeUndefined();
		expect(r.inputs.demo).toBe('bat_oas1');
		expect(r.timings.infer).toBeCloseTo(1.5);
		expect(r.provenance?.surface).toBe('browser');
	});
});

function report(overrides: Partial<ReportRecord> = {}): ReportRecord {
	return {
		schema_version: 2,
		kind: 'report',
		id: 'r',
		createdAt: 0,
		createdAtIso: '',
		name: 'x',
		inputs: { alignment: { name: 'a', size: 0, sha256: null }, tree: null, treeSource: 'user', alignmentName: 'a', treeName: null },
		options: { variant: 'general', maxSpecies: 256, referenceSequence: null, callMode: 'percentile', seed: 42, dms: { enabled: true, workBudget: 2.5e9 }, permutations: 1000 },
		diagnostics: null,
		sections: emptySections(),
		provenance: null,
		timings: {},
		status: { state: 'running', phase: 'infer', done: 3, total: 10, message: null, completed: [] },
		...overrides
	};
}

describe('sectionStatus', () => {
	it('is running for the current phase, pending for later phases, and running for earlier phases without a payload', () => {
		const r = report();
		expect(sectionStatus(r, 'running', 'sites').state).toBe('running');
		expect(sectionStatus(r, 'running', 'gene').state).toBe('pending');
		expect(sectionStatus(r, 'running', 'dms').state).toBe('pending');
		r.status.phase = 'dms';
		expect(sectionStatus(r, 'running', 'gene').state).toBe('running');
		expect(sectionStatus(r, 'running', 'dms').state).toBe('running');
	});
	it('reads sites as still running during the stats phase', () => {
		const r = report({ status: { state: 'running', phase: 'stats', done: 0, total: 1, message: null, completed: [] } });
		expect(sectionStatus(r, 'running', 'sites').state).toBe('running');
	});
	it('is interrupted after a reload mid-run and unavailable after a finished run without the section', () => {
		const r = report();
		expect(sectionStatus(r, 'interrupted', 'epistasis').state).toBe('interrupted');
		expect(sectionStatus(r, 'done', 'epistasis').state).toBe('unavailable');
		expect(sectionStatus(r, 'failed', 'gene').state).toBe('failed');
	});
	it('reports skipped with the reason, and partial / cancelled for DMS', () => {
		const r = report();
		r.sections.dms = { plasticity: [], focal_taxon: '', total_mutations: 0, progress: { done: 0, total: 0 }, skipped: { reason: 'over budget', work: 1, budget: 0 } };
		const s = sectionStatus(r, 'done', 'dms');
		expect(s.state).toBe('skipped');
		expect(s.reason).toBe('over budget');
		r.sections.dms = { plasticity: [], focal_taxon: 'a', total_mutations: 19, progress: { done: 3, total: 10 } };
		expect(sectionStatus(r, 'running', 'dms').state).toBe('partial');
		r.sections.dms.cancelled = true;
		expect(sectionStatus(r, 'done', 'dms').state).toBe('cancelled');
		r.sections.dms.cancelled = false;
		r.status.completed = ['dms'];
		expect(sectionStatus(r, 'done', 'dms').state).toBe('done');
	});
	// D22 / Phase 3: the pillar is live, and its shell always renders the panel — a trait to
	// describe while the rest of the report is still running, a result once it has run. It is
	// never `pending` (it is not queued behind a phase) and never `unavailable` (it is offered on
	// every report that carries an alignment); a failed run is shown by the panel itself.
	it('phenotype always renders its panel, whatever the run is doing', () => {
		expect(sectionStatus(report(), 'running', 'phenotype').state).toBe('done');
		expect(sectionStatus(report(), 'interrupted', 'phenotype').state).toBe('done');
		expect(sectionStatus(report(), 'failed', 'phenotype').state).toBe('done');
	});
});

describe('coerceReport', () => {
	it('passes a v2 report through and wraps a bare hyphaeon meme document', () => {
		const v2 = report({ id: 'given' });
		expect(coerceReport(v2 as unknown as Record<string, unknown>, 'gallery/x', 'x').id).toBe('given');
		const doc = {
			alignment: 'Smc6.fasta',
			tree: 'Smc6.nwk',
			taxa_count: 20,
			codon_count: 2,
			runtime_sec: 1.2,
			sites: [
				{ site: 1, hyphaeon_lrt: 0, p_value: 0.6667, q_value: 1, is_invariable: true },
				{ site: 2, hyphaeon_lrt: 2.1, p_value: 0.1, q_value: 0.2, is_invariable: false }
			]
		};
		const r = coerceReport(doc, 'gallery/Smc6', 'Smc6');
		expect(r.kind).toBe('report');
		expect(r.sections.sites?.sites).toHaveLength(2);
		expect(r.sections.sites?.provenance.surface).toBe('python-reference');
		expect(r.status.state).toBe('done');
		expect(r.status.completed).toEqual(['sites']);
		expect(r.timings.infer).toBeCloseTo(1.2);
	});
});

describe('analyzeToolArguments and reportPath', () => {
	it('uses the CLI option names on hyphaeon_analyze', () => {
		const r = report({ inputs: { alignment: { name: 'a.fasta', size: 0, sha256: null }, tree: { name: 't.nwk', size: 0, sha256: null }, treeSource: 'user', alignmentName: 'a.fasta', treeName: 't.nwk' } });
		const args = analyzeToolArguments(r);
		expect(args).toMatchObject({ alignment: 'file:///path/to/a.fasta', tree: 'file:///path/to/t.nwk', model_variant: 'general', max_species: 256, seed: 42, n_permutations: 1000, dms: true, call_mode: 'percentile' });
	});
	it('routes ids to the local shell and gallery names to their prerendered page', () => {
		expect(reportPath('abc')).toBe('/report/local/?id=abc');
		expect(reportPath('job:xyz')).toBe('/report/local/?id=job%3Axyz');
		expect(reportPath('gallery/Smc6')).toBe('/report/gallery/Smc6/');
	});
});
