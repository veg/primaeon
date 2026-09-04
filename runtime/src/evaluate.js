/**
 * evaluate.js — `hyphaeon evaluate` for one prediction CSV against one HyPhy MEME JSON.
 *
 * WHY THIS FILE EXISTS. The `/evaluate` route (PLAN.md §4.1) and the `hyphaeon_evaluate` MCP tool
 * both take a `meme` CSV and a HyPhy MEME JSON and want the metrics of hyphaeon/evaluation.py
 * (`evaluate_files`, evaluation.py:497-527, the single-gene path of its CLI's `--prediction` /
 * `--meme-result`). The library ports that as `evaluateFiles` over `{name, text}` pairs — it
 * reads no files — so the one thing left to do on the app side is to accept what a surface has
 * (a string the user pasted, a File's text, a path the MCP read) and give the pairs the names
 * the Python would print. The single-gene mode requires the two gene names to agree
 * (evaluation.py:503-506), so bare texts are named `gene.csv` / `gene.MEME.json` unless the
 * caller names them.
 *
 * Nothing runs a model here; the CSV is the output of a `meme` run (results.js `memeCsvText`)
 * or of the Python CLI.
 */

import { evaluateFiles, formatTextReport } from '@veg/hyphaeon-js';

import { SCHEMA_VERSION, SURFACES, submittedOptions } from './pipeline.js';

/** Turn a string, a `{name, text}` or a `{name, data}` into the library's NamedText. */
function namedText(input, defaultName, label) {
	if (typeof input === 'string') return { name: defaultName, text: input };
	if (input && typeof input === 'object') {
		const name = typeof input.name === 'string' && input.name ? input.name : defaultName;
		if (typeof input.text === 'string') return { name, text: input.text };
		if (input.data !== undefined) return { name, data: input.data };
	}
	throw new Error(`runEvaluate: ${label} must be a string or {name, text|data}`);
}

/**
 * Evaluate one HyphAeon prediction CSV against one HyPhy MEME result.
 *
 * @param {object} args
 * @param {string|{name?: string, text: string}} args.predictionCsv the `meme` CSV (site, hyphaeon_lrt, p_value, q_value, is_invariable, ...)
 * @param {string|{name?: string, text?: string, data?: object}} args.memeJson the HyPhy MEME JSON (text or parsed)
 * @param {{predictionSuffix?: string, memeSuffix?: string, allowSiteMismatch?: boolean,
 *   variableOnly?: boolean}} [args.options] evaluation.py's flags
 * @param {string} [args.surface]
 * @returns {{schema_version: number, method: 'evaluate', result: object, text: string, provenance: object}}
 *   `result` is evaluation.py's report (Appendix B: matched_genes, total_sites, evaluated_sites,
 *   pearson_r, spearman_rho, thresholds{"0.05","0.10"}, per_gene, warnings); `text` is
 *   `format_text_report`.
 */
export function runEvaluate({ predictionCsv, memeJson, options = {}, surface = 'browser' } = {}) {
	if (!SURFACES.includes(surface)) {
		throw new Error(`runEvaluate: unknown surface "${surface}" (one of ${SURFACES.join(', ')})`);
	}
	const predictionSuffix = options.predictionSuffix ?? '.csv';
	const memeSuffix = options.memeSuffix ?? '.MEME.json';
	const prediction = namedText(predictionCsv, `gene${predictionSuffix}`, 'predictionCsv');
	const meme = namedText(memeJson, `gene${memeSuffix}`, 'memeJson');
	const t0 = Date.now();
	const result = evaluateFiles(prediction, meme, {
		predictionSuffix,
		memeSuffix,
		allowSiteMismatch: Boolean(options.allowSiteMismatch),
		variableOnly: Boolean(options.variableOnly)
	});
	return {
		schema_version: SCHEMA_VERSION,
		method: 'evaluate',
		result,
		text: formatTextReport(result),
		provenance: {
			schema_version: SCHEMA_VERSION,
			surface,
			elapsed_sec: (Date.now() - t0) / 1000,
			options: submittedOptions(options),
			inputs: { prediction: prediction.name, meme_result: meme.name },
			warnings: []
		}
	};
}
