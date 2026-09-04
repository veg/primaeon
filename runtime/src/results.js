/**
 * results.js — one serialisation of a run, for the UI, the MCP and the parity runner alike.
 *
 * WHY THIS FILE EXISTS. `runMeme` / `runBusted` return a rich object: Python-shaped site records
 * PLUS the app's columns, typed arrays for the writers, a non-enumerable `loaded`, a Map of
 * attribution records. Three consumers need three flatter things out of it and none of them
 * should re-derive the Python document:
 *
 *   - the Python CLI's own files, byte for byte, for downloads and for parity
 *     (`memeJsonText`, `memeCsvText`, `bustedJsonText`, `bustedCsvText`, `evaluateJsonText`)
 *     — the library's writers (js/src/writers.js, `json.dump(indent=2)` and pandas `to_csv`
 *     equal) over `memeResult` / `memeSiteRecords` / the busted record;
 *   - a JSON-safe record of the WHOLE result (`toResultRecord`) for IndexedDB, `get_results`
 *     and a results page: typed arrays become plain arrays, Maps become objects, the loaded
 *     tensors are dropped;
 *   - the download list a results page offers (`downloadsFor`).
 *
 * The `memeDocument` mirrors cli.py:298-311 key for key (`alignment`, `tree`, `taxa_count`,
 * `codon_count`, `runtime_sec`, `filter_enabled`, `artifacts_masked`, `attribution_enabled`,
 * `attributions` keyed by the 1-indexed site, `sites`); the CSV mirrors cli.py:313-327 with the
 * four attribution columns when `--attribute` ran. The busted document is the record of
 * cli.py:486-505 as `cmd_busted` writes it for a single alignment (a bare object, not a list).
 * Extra keys — `provenance` — are appended AFTER the Python's, so a reader of the Python
 * document sees the same prefix; PARITY.md says extra keys are ignored.
 */

import {
	memeResult,
	memeSiteRecords,
	memeJson,
	memeCsv,
	bustedJson,
	bustedCsv,
	evaluateJson,
	resultJson
} from '@veg/hyphaeon-js';

/** The Python-key site records of a meme result (cli.py:280-296), from its typed arrays. */
export function memeSites(result) {
	const a = result.arrays;
	return memeSiteRecords(a.lrt, a.p_value, a.q_value, a.invariable, result.attributionRecords ?? null);
}

/**
 * The `hyphaeon meme` JSON document (cli.py:298-311) as an object, plus `provenance`.
 * @param {object} result from runMeme
 * @param {{alignment?: string, tree?: string|null, provenance?: boolean}} [options] labels for the
 *   document's `alignment` / `tree` when the run recorded none; `provenance: false` omits the block
 */
export function memeDocument(result, options = {}) {
	const inputs = result.provenance?.inputs ?? {};
	const alignment = options.alignment ?? inputs.alignment ?? 'alignment.fasta';
	const tree = options.tree !== undefined ? options.tree : inputs.tree === 'embedded_in_alignment' ? null : inputs.tree;
	const doc = memeResult({
		alignment,
		tree,
		taxaCount: result.taxa_count,
		codonCount: result.codon_count,
		runtimeSec: result.runtime_sec,
		filterEnabled: result.filter_enabled,
		artifactsMasked: result.artifacts_masked,
		attributionEnabled: result.attribution_enabled,
		attributions: result.attributionRecords ?? null,
		sites: memeSites(result)
	});
	if (options.provenance !== false && result.provenance) doc.provenance = jsonSafe(result.provenance);
	return doc;
}

/** `hyphaeon meme -o` text. */
export function memeJsonText(result, options = {}) {
	return memeJson(memeDocument(result, options));
}

/** `hyphaeon meme --csv` text (cli.py:313-327). */
export function memeCsvText(result) {
	return memeCsv(memeSites(result), { attribution: result.attribution_enabled || undefined });
}

/** The `hyphaeon busted` record (cli.py:486-505), plus `provenance`. */
export function bustedDocument(result, options = {}) {
	const doc = { ...result.record };
	if (options.alignment !== undefined) doc.alignment = options.alignment;
	if (options.gene !== undefined) doc.gene = options.gene;
	if (options.provenance !== false && result.provenance) doc.provenance = jsonSafe(result.provenance);
	return doc;
}

/** `hyphaeon busted -o` text for one alignment (a bare record, cli.py:549-550). */
export function bustedJsonText(result, options = {}) {
	return bustedJson([bustedDocument(result, options)], { batch: false });
}

/** `hyphaeon busted --csv` text (cli.py:552-568). */
export function bustedCsvText(result) {
	return bustedCsv([result.record]);
}

/** `hyphaeon evaluate -o` text (evaluation.py:641, with the trailing newline the file form writes). */
export function evaluateJsonText(result) {
	return evaluateJson(result.result ?? result) + '\n';
}

/**
 * A JSON-safe copy: typed arrays → arrays, BigInt → Number, Map → object (insertion order),
 * `{data, dims}` tensors kept as such with `data` flattened, non-enumerable properties dropped.
 */
export function jsonSafe(value) {
	if (value === null || value === undefined) return value;
	if (typeof value === 'bigint') return Number(value);
	if (typeof value !== 'object') return value;
	if (ArrayBuffer.isView(value)) return Array.from(value, (v) => (typeof v === 'bigint' ? Number(v) : v));
	if (value instanceof Map) {
		const out = {};
		for (const [k, v] of value) out[String(k)] = jsonSafe(v);
		return out;
	}
	if (Array.isArray(value)) return value.map(jsonSafe);
	const out = {};
	for (const [k, v] of Object.entries(value)) {
		if (typeof v === 'function') continue;
		out[k] = jsonSafe(v);
	}
	return out;
}

/**
 * The whole result as a plain JSON record — what a results page stores in IndexedDB and what
 * `get_results` returns. The loaded tensors (non-enumerable) are not included; `attention` and
 * `root_repr`, when present, are (as `{data: number[], dims}`), and `arrays.raw` too.
 *
 * @param {object} result from runMeme / runBusted / runEvaluate
 * @param {{includeArrays?: boolean, includeHeads?: boolean}} [options] `includeArrays: false` drops
 *   `arrays` (the sites carry the same numbers); `includeHeads: false` drops attention / root_repr
 */
export function toResultRecord(result, options = {}) {
	const copy = { ...result };
	if (options.includeArrays === false) delete copy.arrays;
	if (options.includeHeads === false) {
		delete copy.attention;
		delete copy.root_repr;
	}
	// attributionRecords (a Map keyed 0-indexed) duplicates `attributions` (1-indexed object).
	delete copy.attributionRecords;
	return jsonSafe(copy);
}

/** JSON text of `toResultRecord`. */
export function resultRecordText(result, options = {}) {
	return JSON.stringify(toResultRecord(result, options), null, 2);
}

/**
 * The downloads a results page offers for a run: the Python CLI's files and the app record.
 *
 * @param {object} result
 * @param {{stem?: string}} [options] file-name stem; default from the recorded alignment name
 * @returns {Array<{name: string, type: string, text: string}>}
 */
export function downloadsFor(result, options = {}) {
	const inputs = result.provenance?.inputs ?? {};
	const stem =
		options.stem ??
		(inputs.alignment ? String(inputs.alignment).replace(/^.*[\\/]/, '').replace(/\.[^.]*$/, '') : 'hyphaeon');
	const out = [];
	if (result.method === 'meme') {
		out.push({ name: `${stem}.meme.json`, type: 'application/json', text: memeJsonText(result) });
		out.push({ name: `${stem}.meme.csv`, type: 'text/csv', text: memeCsvText(result) });
		if (result.filter?.cleaned_fasta) {
			out.push({ name: `${stem}.cleaned.fasta`, type: 'text/plain', text: result.filter.cleaned_fasta });
		}
	} else if (result.method === 'busted') {
		out.push({ name: `${stem}.busted.json`, type: 'application/json', text: bustedJsonText(result) });
		out.push({ name: `${stem}.busted.csv`, type: 'text/csv', text: bustedCsvText(result) });
	} else if (result.method === 'evaluate') {
		out.push({ name: `${stem}.evaluate.json`, type: 'application/json', text: evaluateJsonText(result) });
		out.push({ name: `${stem}.evaluate.txt`, type: 'text/plain', text: result.text ?? '' });
	}
	out.push({ name: `${stem}.hyphaeon.json`, type: 'application/json', text: resultRecordText(result, { includeArrays: false }) });
	return out;
}

/** Any CLI result dict as `json.dump(indent=2)` text (writers.js `resultJson`). */
export { resultJson };
