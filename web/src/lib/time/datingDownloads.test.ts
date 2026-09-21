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
import { RECORD_KEYS, TAXON_COLUMNS, datingReferenceCommand, runDating } from '@veg/hyphaeon-runtime/dating';
import { ingestDates, taxaForDates } from '@veg/hyphaeon-runtime/dates';
import { resolveTn93Options } from '@veg/hyphaeon-runtime/tn93-wasm';
import {
	DATING_CSV_COLUMNS,
	DATING_CSV_NAME,
	DATING_EXTRA_COLUMN,
	DATING_JSON_NAME,
	datingCsv,
	datingDownloadNote,
	datingJson
} from './datingDownloads';
import { available, example } from './fixtures';
import type { DatingResult } from './types';

/**
 * THE ENGINE, RESOLVED ONCE AT MODULE SCOPE. `runDating` is synchronous and the compiled TN93's
 * loader is not, so every caller resolves first and hands the options in — and since
 * @veg/hyphaeon-js's JavaScript TN93 was deleted (one implementation, veg/tn93, rather than two kept
 * in step by hand) a run without this object does not compute the same numbers more slowly, it
 * throws `Tn93EngineRequiredError`. Under Node the loader finds `runtime/vendor/tn93/` and verifies
 * its sha256; `'cross'` is the rectangular hook `computeTreeFreeDivergences` calls.
 *
 * The numbers below are therefore the COMPILED engine's, checked against the same reference values
 * this file has always asserted — which is a statement about veg/tn93 reproducing the reference on
 * a real alignment, not merely about this page's formatting.
 */
const TN93 = (await resolveTn93Options({ shape: 'cross' })).tn93Options;

function run(): DatingResult {
	const text = example('korber_env_gp160.fasta');
	const ingest = ingestDates({ taxa: taxaForDates(text), headerOf: null, timeUnits: 'years' });
	const r = runDating({
		alignmentText: text,
		alignmentName: 'korber_env_gp160.fasta',
		dates: { rows: ingest.rows.map((x) => ({ taxon: x.taxon, value: x.value })) },
		rootTaxon: 'CONSENSUS',
		tn93Options: TN93
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
		options: {
			root: 'taxon',
			rootTaxon: 'CONSENSUS',
			clockModel: 'auto',
			ciMethod: 'fieller',
			excludedTaxa: [],
			units: 'years',
			useModel: false,
			distanceMode: 'auto'
		}
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
		// With no run there is nothing to check a reproduction claim against, so the note states the
		// conventions and claims nothing.
		const note = datingDownloadNote(null);
		expect(note).toMatch(/ALIGNMENT order/);
		expect(note).toMatch(/the order you are reading it/);
		expect(note).not.toMatch(/reproduce/i);
	});
});

describe.runIf(available())('the download note is conditioned on the run (phase 6 review, X6)', () => {
	const result = run();

	it('names both added keys, because this page writes them into both files', () => {
		const note = datingDownloadNote(result);
		expect(note).toMatch(/prediction_method/);
		expect(note).toMatch(/primaeon/);
		expect(note).toMatch(/ALIGNMENT order/);
	});

	it('does not claim a reproduction the MCP answers false on for the same run', () => {
		// korber is dated by this build's own header ladder and not from a `-d` table, so
		// `datingReferenceCommand` answers `reproduces: false` — and the sentence that used to open
		// "Both files reproduce `hyphaeon dating`'s own outputs" unconditionally must now say so.
		const { reproduces } = datingReferenceCommand(result as never, {}, {}) as { reproduces: boolean };
		expect(reproduces).toBe(false);
		const note = datingDownloadNote(result);
		expect(note).toMatch(/do NOT reproduce a command-line run/);
		expect(note).not.toMatch(/Both files reproduce/);
	});

	/**
	 * B4: THE PAGE AND THE MCP MUST ANSWER THE SAME QUESTION THE SAME WAY.
	 *
	 * `datingReferenceCommand`'s `-d` branch needs the date file's NAME and the `DateIngest` that
	 * file produced. The page passed neither, so it took the no-`-d` branch and told a reader who
	 * had just dropped a BEAST XML that "the dates on this run were read from the sequence names by
	 * this build's own date layer" — while the MCP, which has always passed both, said the opposite
	 * about the same run.
	 */
	it('takes the `-d` branch when the reader supplied a date file, as the MCP does', () => {
		const text = example('korber_env_gp160.fasta');
		const dated = ingestDates({ taxa: taxaForDates(text), headerOf: null, timeUnits: 'years' });
		// A two-column CSV of exactly the dates this run used: the file that WOULD go on `-d`.
		const csv =
			'strain,date\n' +
			dated.rows
				.filter((r) => Number.isFinite(r.value))
				.map((r) => `${r.taxon},${r.value}`)
				.join('\n');
		const ingest = ingestDates({ taxa: taxaForDates(text), source: csv, sourceName: 'dates.csv' });
		const note = datingDownloadNote(result, { datesName: 'dates.csv', ingest });
		// The false sentence is gone: the dates did NOT come from the sequence names on this run.
		expect(note).not.toMatch(/were read from the sequence names by this build's own date layer/);
		// And it is the same answer `datingReferenceCommand` gives the MCP for the same four arguments.
		const mcp = datingReferenceCommand(result as never, {}, { dates: 'dates.csv' }, ingest) as {
			reproduces: boolean;
		};
		const claims = /do NOT reproduce a command-line run/.test(note);
		expect(claims).toBe(!mcp.reproduces);
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
