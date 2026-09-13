/**
 * alignment.js — everything the dating path does to a reader's sequences BEFORE a distance is
 * computed, and the one rule it applies to the taxon set afterwards.
 *
 * WHY THIS FILE EXISTS. Three steps stand between an uploaded FASTA and the divergence vector the
 * library's estimators consume, and all three are the application's by CLAUDE.md's own test — each
 * one knows about a reader's data, produces a sentence, or decides what a run is allowed to do:
 *
 *   1. `verifyCodingAlignment` mirrors `hyphaeon/dating.py:135-222`: the length-uniformity check,
 *      the `L % 3` trim and the internal-stop audit. The reference RAISES; this returns a refusal,
 *      because a page shows a refusal and an MCP classifies one as the reader's fault.
 *   2. `starsToGaps` is the `'*' → '-'` rewrite, and it is the single most consequential line in
 *      this directory. See below.
 *   3. `coverageHoldout` is `dating.py:2698-2709`: the fraction of upper-case `ACGT`, a hard 0.50
 *      cut, and the "only if at least three training rows survive" guard that keeps a mostly-empty
 *      upload from reserving everything.
 *
 * =============================== THE ASTERISK RULE, AND WHY IT IS HERE ===============================
 *
 * `dataset.py` rewrites `*` to `-` in ONE place only: the branch that writes FASTA for the COMPILED
 * `tn93` binary (dataset.py:840, 844). The pure-Python fallback passes `*` straight through to
 * `tn93.get_counts(..., "resolve")`, where it lands in the catch-all unknown slot. So the reference's
 * two distance engines disagree on any alignment containing an asterisk, and NOTHING IN ITS OUTPUT
 * SAYS WHICH ONE RAN.
 *
 * MEASURED on `examples/korber_env_gp160.fasta` (2389 asterisks across 18 of 143 sequences):
 *
 *   | `*` treated as            | divergences differing from the published run | worst taxon        |
 *   |---------------------------|----------------------------------------------|--------------------|
 *   | unknown (package branch)  | 18 of 142, worst \|Δ\| 4.98e-2               | Z59ZR.ZHU 0.0608 → 0.1106 |
 *   | gap (binary branch)       | 0 of 142 — EXACT after float32 rounding      | —                  |
 *
 * and through the fit that is t_MRCA 1893.911 against 1893.814, with the lower Fieller bound moving
 * 0.285 years. The published numbers — the ones this phase's acceptance test reproduces — came from
 * a machine with `/usr/local/bin/tn93` on PATH, so THE GAP CONVENTION IS THE PILLAR'S
 * REFERENCE-OF-RECORD and this module applies it.
 *
 * IT IS NOT THE SAME RULE THE SELECTION PIPELINE USES, AND THAT IS DELIBERATE. `tn93-wasm.js`
 * (commit 92f0cda) rewrites `*` to `?` instead, because the compiled WASM engine rejects the
 * character outright and `?` is the slot the library already puts it in — and because every
 * selection fixture and the whole parity surface were generated with the binary forced OFF PATH,
 * i.e. against the package branch. Two rewrites of one character in one application is a trap, so:
 * the LIBRARY mirrors both reference branches faithfully and rewrites nothing, and each PILLAR
 * states which convention its reference-of-record used. This one uses the gap; the run records it
 * in `provenance.star_convention` and `DATING_STARS_REWRITTEN` says so on the page. That commit's
 * note also undercounts the example — it says "four asterisks in one of its 143 sequences"; the
 * measurement above is 2389 across 18.
 *
 * WHY THE TRIM IS NOT SILENT HERE. `verify_coding_alignment` MUTATES the caller's dict in place
 * (dating.py:167-169) and prints a notice nobody keeps. It fires on `H1N1_2009_pandemic.fasta`
 * (2 nt) and not on korber (0), and without it every one of H1N1's 95 divergences is wrong. This
 * returns a NEW map, leaves the caller's alone, and raises `DATING_ALIGNMENT_TRIMMED`.
 */

import { DATING_MESSAGES, DATING_REFUSALS, DATING_THRESHOLDS, datingWarning, fillMessage, nameSample } from './codes.js';

/** `dating.py:196`'s set. */
const STOP_CODONS = new Set(['TAA', 'TAG', 'TGA']);

/** `dating.py:2700`'s `list('ACGT')`, upper case only — which is why the parse must upper-case. */
const CALIBRATING = new Set(['A', 'C', 'G', 'T']);

/** Accept a Map or a plain object of taxon -> sequence; always hand back a Map in the same order. */
function asMap(sequences) {
	return sequences instanceof Map ? new Map(sequences) : new Map(Object.entries(sequences));
}

/**
 * `dating.py:135-222`, returning instead of raising.
 *
 * @param {Map<string,string>|Record<string,string>} sequences upper-cased, U→T, as
 *   `parseAlignmentSequences` produces them.
 * @param {{allowStopCodons?: boolean, autoTrimTrailing?: boolean}} [options]
 * @returns {{ok: boolean, refusal: string|null, sequences: Map<string,string>, nTaxa: number,
 *   nCodons: number, length: number, trimmedBy: number,
 *   stops: {total: number, taxa: string[]}, warnings: Array<object>}}
 */
export function verifyCodingAlignment(sequences, options = {}) {
	const allowStopCodons = options.allowStopCodons !== false;
	const autoTrimTrailing = options.autoTrimTrailing !== false;
	const seqs = asMap(sequences);
	const taxa = [...seqs.keys()];
	const warnings = [];
	const empty = {
		ok: false,
		refusal: null,
		sequences: seqs,
		nTaxa: taxa.length,
		nCodons: 0,
		length: 0,
		trimmedBy: 0,
		stops: { total: 0, taxa: [] },
		warnings
	};

	// dating.py:153-154 and :161-162 — an empty alignment and a zero-length first sequence.
	if (taxa.length === 0 || seqs.get(taxa[0]).length === 0) {
		warnings.push(datingWarning(DATING_REFUSALS.ALIGNMENT_EMPTY, 'refuse', DATING_MESSAGES.ALIGNMENT_EMPTY));
		return { ...empty, refusal: DATING_REFUSALS.ALIGNMENT_EMPTY };
	}

	// dating.py:163-174 — the silent in-place trim, made explicit and non-destructive.
	let length = seqs.get(taxa[0]).length;
	let trimmedBy = 0;
	let trimmed = seqs;
	const rem = length % 3;
	if (rem !== 0) {
		if (!autoTrimTrailing) {
			warnings.push(
				datingWarning(
					DATING_REFUSALS.ALIGNMENT_NOT_CODING,
					'refuse',
					fillMessage(DATING_MESSAGES.ALIGNMENT_NOT_CODING, { length, rem }),
					{ length, rem }
				)
			);
			return { ...empty, length, refusal: DATING_REFUSALS.ALIGNMENT_NOT_CODING };
		}
		trimmedBy = rem;
		trimmed = new Map([...seqs].map(([t, s]) => [t, s.slice(0, s.length - rem)]));
		warnings.push(
			datingWarning('DATING_ALIGNMENT_TRIMMED', 'warn', fillMessage(DATING_MESSAGES.ALIGNMENT_TRIMMED, { length, rem }), {
				length,
				rem
			})
		);
		length = trimmed.get(taxa[0]).length;
	}

	// dating.py:178-194 — uniformity, reported with up to five examples as the reference does.
	const mismatched = [];
	for (const [t, s] of trimmed) {
		if (s.length !== length) {
			mismatched.push([t, s.length]);
			if (mismatched.length >= 5) break;
		}
	}
	if (mismatched.length > 0) {
		const details = mismatched.map(([t, l]) => `'${t}': ${l} nt`).join(', ');
		warnings.push(
			datingWarning(
				DATING_REFUSALS.ALIGNMENT_RAGGED,
				'refuse',
				fillMessage(DATING_MESSAGES.ALIGNMENT_RAGGED, { length, details }),
				{ length, mismatched: mismatched.map(([t, l]) => ({ taxon: t, length: l })) }
			)
		);
		return { ...empty, sequences: trimmed, length, trimmedBy, refusal: DATING_REFUSALS.ALIGNMENT_RAGGED };
	}

	// dating.py:196-218 — the stop audit. `num_codons - 1` is the reference's own range: the final
	// codon is allowed to be a terminator, every earlier one is "internal".
	const nCodons = Math.trunc(length / 3);
	const stopTaxa = [];
	let totalStops = 0;
	for (const [t, s] of trimmed) {
		let flagged = false;
		for (let c = 0; c < nCodons - 1; c++) {
			if (STOP_CODONS.has(s.slice(c * 3, c * 3 + 3))) {
				totalStops++;
				if (!flagged) {
					stopTaxa.push(t);
					flagged = true;
				}
			}
		}
	}
	if (stopTaxa.length > 0) {
		const severity = allowStopCodons ? 'note' : 'refuse';
		warnings.push(
			datingWarning(
				'DATING_STOP_CODONS',
				severity,
				fillMessage(DATING_MESSAGES.STOP_CODONS, { total: totalStops, taxa: stopTaxa.length, all: taxa.length }),
				{ total: totalStops, taxa: stopTaxa.slice(0, DATING_THRESHOLDS.sampleNames) }
			)
		);
		if (!allowStopCodons) {
			return {
				...empty,
				sequences: trimmed,
				length,
				trimmedBy,
				nCodons,
				stops: { total: totalStops, taxa: stopTaxa },
				refusal: 'DATING_STOP_CODONS'
			};
		}
	}

	return {
		ok: true,
		refusal: null,
		sequences: trimmed,
		nTaxa: taxa.length,
		nCodons,
		length,
		trimmedBy,
		stops: { total: totalStops, taxa: stopTaxa },
		warnings
	};
}

/**
 * The `'*' → '-'` rewrite this pillar's reference-of-record used. See the header for the
 * measurement and for why the selection pipeline rewrites the same character differently.
 *
 * @param {Map<string,string>|Record<string,string>} sequences
 * @returns {{sequences: Map<string,string>, stars: number, taxa: string[], warnings: Array<object>}}
 */
export function starsToGaps(sequences) {
	const seqs = asMap(sequences);
	const out = new Map();
	const taxa = [];
	let stars = 0;
	for (const [t, s] of seqs) {
		let n = 0;
		for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 42) n++;
		if (n > 0) {
			stars += n;
			taxa.push(t);
			out.set(t, s.split('*').join('-'));
		} else {
			out.set(t, s);
		}
	}
	const warnings =
		stars > 0
			? [
					datingWarning(
						'DATING_STARS_REWRITTEN',
						'note',
						fillMessage(DATING_MESSAGES.STARS_REWRITTEN, { stars, taxa: taxa.length }),
						{ stars, taxa: taxa.slice(0, DATING_THRESHOLDS.sampleNames) }
					)
				]
			: [];
	return { sequences: out, stars, taxa, warnings };
}

/**
 * `dating.py:2698-2709`. The fraction of a sequence that is upper-case `ACGT`, a hard cut at 0.50,
 * and the reference's own guard: a holdout is only reserved when at least three rows are left to
 * calibrate on, so a uniformly degraded upload fits on everything rather than on nothing.
 *
 * The denominator is the ALIGNMENT WIDTH (`char_mat.shape[1]`), not the sequence's own length, so a
 * short sequence is penalised for what it does not cover. That is the reference's choice and it is
 * the point of the rule.
 *
 * THE LABEL AND THE FIT CAN DISAGREE, UPSTREAM. `is_train` is the raw coverage boolean and the
 * per-taxon table reads `is_holdout = not is_train[i]` (dating.py:3046) — but `train_idx` only
 * narrows when at least three rows survive (dating.py:2706). Below that guard every low-coverage
 * sequence is IN the fit and still labelled `is_holdout: true`, and the label is then false. The
 * arrays are returned separately here, exactly as the reference computes them, and
 * `DATING_HOLDOUTS_IN_FIT` says so when it happens.
 *
 * @param {Map<string,string>|Record<string,string>} sequences
 * @param {readonly string[]} taxa the row order the fit will use
 * @returns {{coverage: Float64Array, isTrain: boolean[], trainIndices: number[], holdouts: string[],
 *   reserved: boolean, width: number, warnings: Array<object>}}
 */
export function coverageHoldout(sequences, taxa) {
	const seqs = asMap(sequences);
	const width = taxa.length > 0 ? seqs.get(taxa[0]).length : 0;
	const coverage = new Float64Array(taxa.length);
	const isTrain = new Array(taxa.length);
	const holdouts = [];
	for (let i = 0; i < taxa.length; i++) {
		const s = seqs.get(taxa[i]) ?? '';
		let c = 0;
		for (let k = 0; k < s.length; k++) if (CALIBRATING.has(s[k])) c++;
		coverage[i] = c / Math.max(1, width);
		isTrain[i] = coverage[i] >= DATING_THRESHOLDS.coverageTrain;
		if (!isTrain[i]) holdouts.push(taxa[i]);
	}
	const nTrain = isTrain.reduce((a, v) => a + (v ? 1 : 0), 0);
	const reserve = holdouts.length > 0 && nTrain >= DATING_THRESHOLDS.minTrainAfterHoldout;
	const trainIndices = reserve
		? isTrain.map((v, i) => (v ? i : -1)).filter((i) => i >= 0)
		: taxa.map((_, i) => i);

	const warnings = [];
	if (reserve) {
		warnings.push(
			datingWarning(
				'DATING_HOLDOUTS_RESERVED',
				'warn',
				fillMessage(DATING_MESSAGES.HOLDOUTS_RESERVED, { n: holdouts.length, names: nameSample(holdouts) }),
				{ taxa: holdouts.slice(0, DATING_THRESHOLDS.sampleNames), count: holdouts.length }
			)
		);
	} else if (holdouts.length > 0) {
		warnings.push(
			datingWarning(
				'DATING_HOLDOUTS_IN_FIT',
				'warn',
				fillMessage(DATING_MESSAGES.HOLDOUTS_IN_FIT, {
					n: holdouts.length,
					names: nameSample(holdouts),
					min: DATING_THRESHOLDS.minTrainAfterHoldout
				}),
				{ taxa: holdouts.slice(0, DATING_THRESHOLDS.sampleNames), count: holdouts.length }
			)
		);
	}

	return { coverage, isTrain, trainIndices, holdouts, reserved: reserve, width, warnings };
}
