/**
 * index.js — the barrel of the temporal-selection pillar.
 *
 * WHY THIS FILE EXISTS. `runtime/package.json` gains a `./temporal` subpath and `runtime/src/index.js`
 * gains ONE additive line, the same shape `./dates` and `./dating` already have. The difference from
 * those two is worth stating rather than leaving to be discovered: this pillar DOES need the model,
 * so `./temporal` reaches `predict.js` and therefore onnxruntime, and there is no import-boundary
 * assertion here of the kind `dating-port.test.js` makes. What the boundary buys elsewhere — "the
 * date-review page costs no model byte" — is not available to a pillar whose first step is a forward
 * pass over every codon.
 *
 * THE ONE CALL MOST SURFACES MAKE IS `runTemporal`. The leaves are exported beside it because a page
 * drives them one at a time: `temporalNullBudget` answers "what will the null cost" before the
 * button is pressed, `temporalDownloads` and `temporalReferenceCommand` are what leaves the page,
 * `siteRow` builds a table row out of the column store, and the whole `codes.js` vocabulary is what
 * a surface renders a warning with without importing an eigensolver.
 */

export {
	TEMPORAL_SCHEMA_VERSION,
	TEMPORAL_DIAGNOSTIC_CODES,
	TEMPORAL_REFUSALS,
	TEMPORAL_THRESHOLDS,
	TEMPORAL_MESSAGES,
	TEMPORAL_NULL_ASSUMPTION,
	TEMPORAL_REFERENCE_RULES,
	TEMPORAL_BEYOND_REFERENCE_RULES,
	temporalWarning,
	sortTemporalWarnings
} from './codes.js';

export {
	TEMPORAL_PERM_RATE,
	TEMPORAL_PERM_STAT_UNITS,
	TEMPORAL_PERM_ROUNDS,
	TEMPORAL_PERM_BUDGET_DEFAULT,
	TEMPORAL_PERM_CHUNK_TARGET_MS,
	TEMPORAL_PERM_CHUNK_MAX,
	candidateNnz,
	chunkFor,
	temporalNullWork,
	temporalNullBudget,
	temporalObservedStat,
	runTemporalNull
} from './null.js';

export {
	TEMPORAL_TAXON_CAPS,
	TEMPORAL_TAXON_CEILING,
	TEMPORAL_TAXON_COST,
	temporalInferSeconds,
	temporalScaleNote,
	temporalTaxonCap,
	temporalTaxonPlan
} from './caps.js';

export { TEMPORAL_SITE_COLUMNS, temporalRecord, siteRow, candidateSiteIndices } from './record.js';

export {
	TEMPORAL_FILE_SUFFIXES,
	TEMPORAL_SITES_COLUMNS,
	TEMPORAL_CURVES_COLUMNS,
	TEMPORAL_WAVES_COLUMNS,
	TEMPORAL_SUMMARY_KEYS,
	temporalSitesCsvText,
	temporalCurvesCsvText,
	temporalWavesCsvText,
	temporalSummaryJsonText,
	temporalReferenceCommand,
	temporalDownloadNotes,
	temporalPPermNote,
	temporalDownloads
} from './results.js';

export { runTemporal, resolveTemporalDates, TEMPORAL_SWEEP_MODES, TEMPORAL_TIME_UNITS } from './run.js';
