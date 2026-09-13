/**
 * datingDownloads.ts — the two files a finished dating run writes, and the one sentence the page
 * says about how they differ from the two files section 1 already offers.
 *
 * WHY THIS FILE EXISTS, AND WHY IT IS THIN. The writers themselves are
 * `@veg/hyphaeon-runtime/dating` (`datingJsonText`, `datingCsvText`), which mirror
 * `dating.py:3145-3186` key for key and format numbers with Python's own `repr` rules — that is
 * result semantics and it belongs where the MCP and the server can reach it. What is here is the
 * page's part: the file names, the column constant a test can assert, and the note that tells a
 * reader which convention each file follows.
 *
 * TWO CLASSES OF FILE ON ONE PAGE, AND THE NOTE MUST SAY WHICH IS WHICH.
 *
 *   dates.csv / dates.json   PrimAeon's own. The CSV writes the rows THE READER IS LOOKING AT, in
 *                            the order the review table is showing them, and neither file claims to
 *                            be a command-line input.
 *   dating.json / dating.csv Reference-shaped. The JSON carries `hyphaeon dating -o out.json`'s own
 *                            22 top-level keys in its own order (the unported estimators `null`,
 *                            exactly as `--method ols` leaves them) plus ONE added key, `primaeon`,
 *                            which the reference does not use and so cannot collide with. The CSV
 *                            carries `taxa_summary`'s ten columns under the reference's own header
 *                            names, in ALIGNMENT ORDER — the opposite convention to `dates.csv`,
 *                            which is exactly why the note names it.
 *
 * MEASURED, so the claim can be made at all: with `{ includeProvenance: false }` the JSON has the
 * same 1821 lines as a CLI run's `out.json`, the same key order at every level, and no structural
 * difference — the values differ only in the last bits of the floats (worst 4.5e-10 years on a
 * Fieller endpoint, 1.1e-8 on the spline's date). Byte equality of the SHAPE is claimed; byte
 * equality of the NUMBERS across two language runtimes is not.
 *
 * `prediction_method` — the column that says which rows came from a different model — travels in
 * BOTH files here, because a reader who downloads from this page is reading it here, not diffing
 * it. The runtime's default is the other way round (off, so a diff is clean), so the choice is
 * made at this call site and stated in the note.
 */

import {
	datingCsvText,
	datingDownloadNotes,
	datingJsonText,
	datingReferenceCommand,
	TAXON_COLUMNS
} from '@veg/hyphaeon-runtime/dating';
import type { DatingResult, TaxonDatingRow } from './types';

/** The reference's ten `taxa_summary` columns, in its order. The eleventh is ours. */
export const DATING_CSV_COLUMNS = [...TAXON_COLUMNS] as string[];
export const DATING_EXTRA_COLUMN = 'prediction_method';

export const DATING_JSON_NAME = 'dating.json';
export const DATING_CSV_NAME = 'dating.csv';

/** `hyphaeon dating -o out.json`'s document, plus `primaeon` and our per-row column. */
export function datingJson(run: DatingResult): string {
	return datingJsonText(run.record, { includeProvenance: true, predictionMethod: true });
}

/** `hyphaeon dating`'s per-taxon CSV, in alignment order, plus our per-row column. */
export function datingCsv(rows: readonly TaxonDatingRow[]): string {
	return datingCsvText(rows as TaxonDatingRow[], { predictionMethod: true });
}

/**
 * The sentence under the two buttons, BUILT FROM THE RUN rather than written once.
 *
 * WHY IT CHANGED. The constant this replaces opened "Both files reproduce `hyphaeon dating`'s own
 * outputs" and closed "The CSV is in ALIGNMENT order, so it diffs against a command-line run",
 * unconditionally — while the MCP, on the same run, was answering `reproduces: false`, most often
 * because this build's date layer reads headers the reference's parser cannot and the two runs are
 * therefore not over the same sequences at all. Phase 5 fixed exactly this sentence for the
 * temporal pillar (`temporalReferenceCommand`); this is that fix. The runtime had no
 * `datingReferenceCommand` at all, which is why the claim had to be hard-coded here in the first
 * place, so the function now lives beside `temporalReferenceCommand` in
 * `runtime/src/dating/results.js` and both this page and the MCP call it.
 *
 * The notes themselves are `datingDownloadNotes(run, options)` — the same options this file passes
 * to the writers, so the note describes the files the reader will actually get rather than the
 * runtime's defaults — and the reproduction clause is appended only when `reproduces` is true.
 */
export function datingDownloadNote(run: DatingResult | null): string {
	const written = { includeProvenance: true, predictionMethod: true };
	const notes = run ? (datingDownloadNotes(run as never, written) as string[]) : [];
	if (!run) {
		return (
			`${DATING_JSON_NAME} carries \`hyphaeon dating -o out.json\`'s own top-level keys in its order and ` +
			`${DATING_CSV_NAME} carries the ten \`taxa_summary\` columns under the reference's own header names, in ` +
			`ALIGNMENT order — the opposite convention to the dates CSV in section 6, which is in the order you are ` +
			`reading it.`
		);
	}
	const { reproduces, caveats } = datingReferenceCommand(run as never, {}, {}) as {
		reproduces: boolean;
		caveats: string[];
	};
	notes.push(
		reproduces
			? 'Run the command this section prints and a command-line run produces the same numbers, so these files ' +
				'diff against it once the two added keys are dropped.'
			: `These files do NOT reproduce a command-line run as they stand: ${caveats[1] ?? caveats[0]}`
	);
	return notes.join(' ');
}
