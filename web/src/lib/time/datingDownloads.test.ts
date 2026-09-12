/**
 * datingDownloads.test.ts — the two reference-shaped files, checked against the reference's own key
 * set and column order rather than against themselves.
 *
 * WHY THIS FILE EXISTS. The claim these downloads make is a strong one — that a browser run and a
 * command-line run are diffable — and it is exactly the kind of claim that rots silently. So the
 * assertions are against the runtime's `RECORD_KEYS` and `TAXON_COLUMNS`, which are transcriptions
 * of `dating.py:3150-3181` and `:3052-3062`, not against a snapshot of what this build happens to
 * emit today. If the port's key order drifts, this fails; if the reference's does, the runtime's
 * constants have to change first and this fails with them.
 */

import { describe, expect, it } from 'vitest';
import { RECORD_KEYS, TAXON_COLUMNS, runDating } from '@veg/hyphaeon-runtime/dating';
import { ingestDates, taxaForDates } from '@veg/hyphaeon-runtime/dates';
import {
	DATING_CSV_COLUMNS,
	DATING_CSV_NAME,
	DATING_DOWNLOAD_NOTE,
	DATING_EXTRA_COLUMN,
	DATING_JSON_NAME,
	datingCsv,
	datingJson
} from './datingDownloads';
import { available, example } from './fixtures';
import type { DatingResult } from './types';

function run(): DatingResult {
	const text = example('korber_env_gp160.fasta');
	const ingest = ingestDates({ taxa: taxaForDates(text), headerOf: null, timeUnits: 'years' });
	const r = runDating({
		alignmentText: text,
		alignmentName: 'korber_env_gp160.fasta',
		dates: { rows: ingest.rows.map((x) => ({ taxon: x.taxon, value: x.value })) },
		rootTaxon: 'CONSENSUS'
	});
	return {
		ok: r.ok,
		refusal: r.refusal,
		warnings: r.warnings,
		record: r.record,
		rows: r.rows,
		activeName: r.activeName,
		selectedClock: r.selectedClock,
		ensemble: r.ensemble,
		rootDescription: r.rootDescription,
		rootCase: r.rootCase,
		elapsedMs: 0,
		ranAtIso: '',
		options: { root: 'taxon', rootTaxon: 'CONSENSUS', clockModel: 'auto', ciMethod: 'fieller', excludedTaxa: [], units: 'years' }
	};
}

describe('the column constant', () => {
	it('is the reference’s ten, in the reference’s order, and ours is the eleventh', () => {
		expect(DATING_CSV_COLUMNS).toEqual([...TAXON_COLUMNS]);
		expect(DATING_CSV_COLUMNS).toEqual([
			'taxon',
			'sampling_date',
			'root_divergence',
			'fitted_divergence',
			'predicted_date',
			'divergence_residual',
			'temporal_residual',
			'z_score',
			'is_outlier',
			'is_holdout'
		]);
		expect(DATING_CSV_COLUMNS).not.toContain(DATING_EXTRA_COLUMN);
	});

	it('names the two files after the command that would write them', () => {
		expect(DATING_JSON_NAME).toBe('dating.json');
		expect(DATING_CSV_NAME).toBe('dating.csv');
	});

	it('tells the reader that the two CSVs on this page use opposite row orders', () => {
		expect(DATING_DOWNLOAD_NOTE).toMatch(/ALIGNMENT order/);
		expect(DATING_DOWNLOAD_NOTE).toMatch(/the order you are reading it/);
		expect(DATING_DOWNLOAD_NOTE).toMatch(/prediction_method/);
		expect(DATING_DOWNLOAD_NOTE).toMatch(/primaeon/);
	});
});

describe.runIf(available())('the files themselves', () => {
	const result = run();

	it('writes the reference’s 22 top-level keys in its order, plus one that cannot collide', () => {
		const doc = JSON.parse(datingJson(result));
		expect(Object.keys(doc)).toEqual([...RECORD_KEYS, 'primaeon']);
		// `--method ols` leaves these null; a diff against a CLI run must show nulls and nothing else.
		expect(doc.pgls).toBeNull();
		expect(doc.power).toBeNull();
		expect(doc.loocv).toBeNull();
		expect(doc.latent_root).toBeNull();
		expect(doc.tree).toBeNull();
		expect(doc.distance_mode).toBe('tn93');
		expect(doc.root_description).toBe('explicit_root_CONSENSUS');
	});

	it('carries the run’s own provenance under `primaeon`, including what it did not estimate', () => {
		const doc = JSON.parse(datingJson(result));
		expect(doc.primaeon.star_convention).toBe('gap');
		expect(doc.primaeon.stars_rewritten).toBeGreaterThan(0);
		expect(doc.primaeon.train_count).toBe(141);
		expect(doc.primaeon.holdouts).toEqual(['Z59ZR.ZHU']);
		expect(doc.primaeon.estimators_not_built.map((e: { name: string }) => e.name)).toContain('Attention PGLS');
	});

	it('writes the CSV in alignment order with the eleven columns, so it diffs against a CLI run', () => {
		const lines = datingCsv(result.rows).trimEnd().split('\n');
		expect(lines[0]).toBe([...DATING_CSV_COLUMNS, DATING_EXTRA_COLUMN].join(','));
		expect(lines).toHaveLength(143); // header + 142 dated sequences
		expect(lines[1].split(',')[0]).toBe(result.rows[0].taxon);
		expect(lines.at(-1)!.split(',')[0]).toBe(result.rows.at(-1)!.taxon);
		// Python's booleans, because this file is the reference's file.
		expect(lines[1]).toMatch(/,(True|False),(True|False),/);
		expect(datingCsv(result.rows)).not.toMatch(/NaN/);
	});
});
