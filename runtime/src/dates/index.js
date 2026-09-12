/**
 * index.js — the barrel of the date ingestion layer.
 *
 * WHY THIS FILE EXISTS. `runtime/src/index.js` gains ONE additive line, `export * from
 * './dates/index.js'`, and `runtime/package.json` gains a `./dates` subpath so a surface that only
 * reviews dates — the `/time` route, which must never load ORT or a graph — imports this directory
 * and nothing else. Every other module here is reachable through it, so no caller has to know
 * which leaf owns which step.
 *
 * THE ONE CALL MOST SURFACES MAKE IS `ingestDates`. The leaves are exported beside it because the
 * `/time` page drives them one at a time as the reader edits: `sniffDelimiter` and
 * `discoverStrainColumn`/`discoverDateColumn` fill the two column selects and their "why" labels,
 * `compileDateRegex` validates the pattern field as it is typed, and `archival1959Candidates` names
 * what the 1959 checkbox would claim before it is ticked.
 *
 * NOTHING HERE OPENS A FILE. Every entry point takes TEXT the caller already read, so one function
 * serves a browser File, an MCP argument and a server upload, and this directory imports nothing
 * from `node:fs` or `node:path`. That is asserted, not merely intended: `date-ingestion.test.js`
 * scans these sources for a filesystem import and for a second date parser.
 */

export * from './codes.js';
export {
	isAuspiceJson,
	walkAuspiceDates,
	readJsonDateMap
} from './auspice.js';
export {
	sniffDelimiter,
	delimiterFromExtension,
	discoverStrainColumn,
	discoverDateColumn,
	readDateTable,
	tableDateMap,
	STRAIN_COLUMNS_TEMPORAL,
	DATE_COLUMNS_TEMPORAL,
	STRAIN_COLUMNS_DATING,
	DATE_COLUMNS_DATING,
	NON_CALENDAR_DATE_COLUMNS,
	ALL_DATE_COLUMN_CANDIDATES
} from './table.js';
export { compileDateRegex, applyDateRegex, applyDateRegexAll } from './regex.js';
export { datesFromHeaders, archival1959Candidates, archival1959Changes } from './headers.js';
export { matchDateNames, normalizeForTier, nameFields, usedFuzzyTier } from './match.js';
export {
	ingestDates,
	detectDateSourceKind,
	inferTimeUnits,
	dateSpan,
	datesVector,
	alignDatesToRun,
	datesPreprocessing,
	taxaForDates
} from './ingest.js';
export { hasDateLayer, missingDateExports } from './library.js';
