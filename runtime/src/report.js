/**
 * report.js — the ReportRecord: what one upload produces, how a section is attached to it, and
 * every file it can be downloaded as.
 *
 * WHY THIS FILE EXISTS. PLAN.md §4.0 (D21) makes the report the unit of work: one upload, one
 * record, sections filling in as they finish. Phase 1's `results.js` serialises ONE analysis
 * (`runMeme` / `runBusted` / `runEvaluate`) into the Python CLI's own files; this module is the
 * layer above it — the record that holds every section of a run, in the shape the orchestrator
 * contract fixes, plus the download list for a report rather than for an analysis. The two do
 * not overlap: everything here that produces Python bytes calls the library's writers
 * (js/src/writers.js) or `results.js`, so there is still exactly one implementation of each
 * document.
 *
 *   ReportRecord = {
 *     schema_version: 2, kind: 'report', id, createdAt,
 *     inputs, options, diagnostics,
 *     sections: { sites, gene, epistasis, attribution, filter, dms, phenotype },
 *     provenance, timings: { <phase>: seconds }
 *   }
 *
 * `schema_version: 2` is the RECORD's version, not the provenance block's (`SCHEMA_VERSION` 1 in
 * pipeline.js, PLAN.md §3.5): a phase-1 `MemeRecord` is schema 1 / `kind: 'meme'` and a reader
 * tells them apart by `kind` before `schema_version`.
 *
 * SECTION PAYLOADS ARE THE PYTHON'S KEY NAMES, per the contract every surface codes against:
 *   sites        runMeme's `{sites, summary, arrays?, ...}`   (cli.py:298-311 fields)
 *   gene         `{record, statistics}`                       (cli.py:486-505)
 *   epistasis    `{edges, sectors, plasticity?, graph?}`       (epistasis.py:717-731)
 *   attribution  `{attributions, attribution_enabled}`         (cli.py:257-277)
 *   filter       `{artifacts_masked, filter_enabled, cleaned?}` (cli.py:111-218)
 *   dms          `{plasticity, focal_taxon, total_mutations, progress, cancelled?}` (epistasis.py:759-768)
 *   phenotype    null until Phase 3 — the report renders the OFFER, not the analysis
 *
 * DOWNLOADS. `downloadsForReport` returns the same CLI files a per-analysis page offers, one set
 * per section that ran, plus the GraphML `hyphaeon epistasis --graphml` writes (cli.py:821-833,
 * the library's `graphml`) and the whole record as JSON. A section that did not run contributes
 * nothing rather than an empty file. Text is produced eagerly and is byte-equal to the Python's
 * for the same numbers; a caller that wants only one file passes `only`.
 */

import { memeResult, memeJson, memeCsv, bustedJson, bustedCsv, epistasisCsv, dmsCsv, graphml, resultJson } from '@veg/hyphaeon-js';

import { jsonSafe, memeJsonText, memeCsvText, bustedJsonText, bustedCsvText, resultRecordText } from './results.js';

/** The ReportRecord's own schema version (PLAN.md §4.0; the provenance block's is SCHEMA_VERSION). */
export const REPORT_SCHEMA_VERSION = 2;

/** Section names, in the order PLAN.md §4.0 runs them and the report renders them. */
export const SECTION_ORDER = Object.freeze(['sites', 'gene', 'epistasis', 'attribution', 'filter', 'dms', 'phenotype']);

/** Progress phases the orchestrator reports, in order (PLAN.md §4.0 / the contract). */
export const REPORT_PHASES = Object.freeze([
	'parse',
	'prepare',
	'infer',
	'stats',
	'gene',
	'epistasis',
	'attribute',
	'filter',
	'dms',
	'postprocess'
]);

/** A random 128-bit id in the shape PLAN.md §3.5 gives job ids, without needing node:crypto. */
export function reportId() {
	if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
	const bytes = new Uint8Array(16);
	if (typeof globalThis.crypto?.getRandomValues === 'function') globalThis.crypto.getRandomValues(bytes);
	else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * An empty ReportRecord. Every section is null until it is attached, so a consumer can tell "not
 * run yet" from "ran and found nothing" (an empty `edges` array is a finding).
 *
 * @param {{id?: string, createdAt?: string, inputs?: object, options?: object,
 *   diagnostics?: object|null, provenance?: object|null}} [args]
 * @returns {object}
 */
export function createReport({ id, createdAt, inputs = {}, options = {}, diagnostics = null, provenance = null } = {}) {
	return {
		schema_version: REPORT_SCHEMA_VERSION,
		kind: 'report',
		id: id ?? reportId(),
		createdAt: createdAt ?? new Date().toISOString(),
		inputs,
		options,
		diagnostics,
		sections: {
			sites: null,
			gene: null,
			epistasis: null,
			attribution: null,
			filter: null,
			dms: null,
			phenotype: null
		},
		provenance,
		timings: {}
	};
}

/**
 * Attach a section, in place, and return the record. An unknown name is refused rather than
 * silently stored: a typo would produce a report whose section never renders.
 *
 * @param {object} report
 * @param {string} name
 * @param {object|null} payload
 */
export function setSection(report, name, payload) {
	if (!SECTION_ORDER.includes(name)) {
		throw new Error(`setSection: unknown section "${name}" (one of ${SECTION_ORDER.join(', ')})`);
	}
	report.sections[name] = payload;
	return report;
}

/** Record `seconds` against a phase, accumulating when a phase runs more than once. */
export function addTiming(report, phase, seconds) {
	report.timings[phase] = (report.timings[phase] ?? 0) + seconds;
	return report;
}

/**
 * A JSON-safe copy of the whole record: typed arrays become arrays, Maps become objects, the
 * non-enumerable `loaded` / `inference` handles of a section payload are dropped by construction.
 *
 * @param {object} report
 * @param {{includeArrays?: boolean, includeHeads?: boolean}} [options] `includeArrays: false`
 *   drops the sites section's typed-array block (the site records carry the same numbers);
 *   `includeHeads: false` drops the [L, N] attention and [L, 384] representation
 */
export function toReportRecord(report, options = {}) {
	const copy = { ...report, sections: { ...report.sections } };
	const sites = copy.sections.sites;
	if (sites) {
		const s = { ...sites };
		if (options.includeArrays === false) delete s.arrays;
		if (options.includeHeads !== true) {
			delete s.attention;
			delete s.root_repr;
		}
		delete s.attributionRecords;
		copy.sections.sites = s;
	}
	return jsonSafe(copy);
}

/** JSON text of `toReportRecord`. */
export function reportRecordText(report, options = {}) {
	return JSON.stringify(toReportRecord(report, options), null, 2);
}

/**
 * The `hyphaeon meme` document from a report's sites section, whether or not it kept `arrays`
 * (a stored record drops them; the site records are the Python's own dicts either way).
 * PHASE1.md gap 7 — the browser record could not take the CLI path for exactly this reason.
 *
 * @param {object} section runMeme's result or its serialised form
 * @param {{alignment?: string, tree?: string|null, provenance?: boolean}} [options]
 */
export function memeDocumentFromSection(section, options = {}) {
	const inputs = section.provenance?.inputs ?? {};
	const doc = memeResult({
		alignment: options.alignment ?? inputs.alignment ?? 'alignment.fasta',
		tree: options.tree !== undefined ? options.tree : inputs.tree === 'embedded_in_alignment' ? null : (inputs.tree ?? null),
		taxaCount: section.taxa_count,
		codonCount: section.codon_count,
		runtimeSec: section.runtime_sec,
		filterEnabled: section.filter_enabled,
		artifactsMasked: section.artifacts_masked ?? [],
		attributionEnabled: section.attribution_enabled,
		attributions: section.attributions ?? null,
		sites: section.sites.map((s) => pythonSiteKeys(s))
	});
	if (options.provenance !== false && section.provenance) doc.provenance = jsonSafe(section.provenance);
	return doc;
}

/** The Python keys of one site record, dropping the app's own columns (z, percentile, call, ...). */
function pythonSiteKeys(site) {
	const out = {
		site: site.site,
		hyphaeon_lrt: site.hyphaeon_lrt,
		p_value: site.p_value,
		q_value: site.q_value,
		is_invariable: site.is_invariable
	};
	if (site.attribution_details !== undefined) {
		out.evolutionary_epoch = site.evolutionary_epoch;
		out.adaptation_mode = site.adaptation_mode;
		out.top_driver = site.top_driver;
		out.top_mutation = site.top_mutation;
		out.attribution_details = site.attribution_details;
	}
	return out;
}

/**
 * The `hyphaeon epistasis` JSON document (epistasis.py:717-731 through `write_json`), from the
 * epistasis section. App-only keys (`graph`, `permutations`, `options`, ...) are dropped so the
 * file is the CLI's; pass `{extras: true}` to keep them.
 *
 * @param {object} section
 * @param {{extras?: boolean}} [options]
 */
export function epistasisDocument(section, { extras = false } = {}) {
	const doc = {
		alignment: section.alignment ?? null,
		tree: section.tree ?? null,
		taxa_count: section.taxa_count,
		codon_count: section.codon_count,
		evaluated_taxa: section.evaluated_taxa ?? section.taxa_count,
		coselection_edges_count: section.coselection_edges_count ?? section.edges.length,
		discovered_sectors_count: section.discovered_sectors_count ?? section.sectors.length,
		edges: section.edges,
		sectors: section.sectors,
		plasticity: section.plasticity ?? [],
		coselection_edges: section.edges,
		epistatic_sectors: section.sectors,
		selection_dms_plasticity: section.plasticity ?? []
	};
	if (extras) {
		if (section.graph) doc.graph = section.graph;
		if (section.permutations) doc.permutations = section.permutations;
		if (section.options) doc.options = section.options;
	}
	return doc;
}

/** `hyphaeon epistasis -o` text. */
export function epistasisJsonText(section, options = {}) {
	return resultJson(epistasisDocument(section, options));
}

/** `hyphaeon epistasis --csv` text (cli.py:808-819: the edges table when there are edges). */
export function epistasisCsvText(section) {
	return epistasisCsv(epistasisDocument(section));
}

/** `hyphaeon epistasis --graphml` text (cli.py:821-833 through nx.write_graphml). */
export function epistasisGraphmlText(section) {
	return graphml(section.edges ?? []);
}

/** The `hyphaeon dms` JSON document (epistasis.py:759-768), from the dms section. */
export function dmsDocument(section) {
	return {
		alignment: section.alignment ?? null,
		tree: section.tree ?? null,
		taxa_count: section.taxa_count,
		codon_count: section.codon_count,
		focal_taxon: section.focal_taxon,
		total_mutations: section.total_mutations,
		plasticity: section.plasticity,
		selection_dms_plasticity: section.plasticity
	};
}

/** `hyphaeon dms -o` text. */
export function dmsJsonText(section) {
	return resultJson(dmsDocument(section));
}

/** `hyphaeon dms --csv` text (cli.py:898-902: the plasticity table without `mutant_deltas`). */
export function dmsCsvText(section) {
	return dmsCsv(section.plasticity ?? []);
}

/** `hyphaeon busted -o` / `--csv` text from a gene section (`{record, statistics}`). */
export function geneJsonText(section) {
	return bustedJson([section.record], { batch: false });
}
export function geneCsvText(section) {
	return bustedCsv([section.record]);
}

/**
 * Every file this report offers, in the order the report renders its sections.
 *
 * @param {object} report a ReportRecord (live or deserialised)
 * @param {{stem?: string, only?: string[]}} [options] `stem` names the files (default: the
 *   uploaded alignment's stem); `only` limits the list to those section names
 * @returns {Array<{name: string, type: string, section: string, text: string}>}
 */
export function downloadsForReport(report, options = {}) {
	const inputs = report.inputs ?? {};
	const stem =
		options.stem ??
		(inputs.alignmentName
			? String(inputs.alignmentName)
					.replace(/^.*[\\/]/, '')
					.replace(/\.[^.]*$/, '')
			: 'hyphaeon');
	const want = (name) => !options.only || options.only.includes(name);
	const out = [];
	const s = report.sections ?? {};

	if (s.sites && want('sites')) {
		// A live runMeme result still carries `arrays` and `attributionRecords`: results.js is the
		// one that knows how to write it. A deserialised section takes the site records instead.
		const live = Boolean(s.sites.arrays && s.sites.arrays.lrt);
		out.push({
			name: `${stem}.meme.json`,
			type: 'application/json',
			section: 'sites',
			text: live ? memeJsonText(s.sites) : memeJson(memeDocumentFromSection(s.sites))
		});
		out.push({
			name: `${stem}.meme.csv`,
			type: 'text/csv',
			section: 'sites',
			text: live ? memeCsvText(s.sites) : memeCsv(s.sites.sites.map(pythonSiteKeys), { attribution: s.sites.attribution_enabled || undefined })
		});
	}
	if (s.gene && want('gene')) {
		out.push({ name: `${stem}.busted.json`, type: 'application/json', section: 'gene', text: geneJsonText(s.gene) });
		out.push({ name: `${stem}.busted.csv`, type: 'text/csv', section: 'gene', text: geneCsvText(s.gene) });
	}
	if (s.epistasis && want('epistasis')) {
		out.push({ name: `${stem}.epistasis.json`, type: 'application/json', section: 'epistasis', text: epistasisJsonText(s.epistasis) });
		out.push({ name: `${stem}.epistasis.csv`, type: 'text/csv', section: 'epistasis', text: epistasisCsvText(s.epistasis) });
		out.push({ name: `${stem}.epistasis.graphml`, type: 'application/xml', section: 'epistasis', text: epistasisGraphmlText(s.epistasis) });
	}
	if (s.filter && want('filter') && s.filter.cleaned_fasta) {
		out.push({ name: `${stem}.cleaned.fasta`, type: 'text/plain', section: 'filter', text: s.filter.cleaned_fasta });
	}
	if (s.dms && want('dms') && (s.dms.plasticity ?? []).length > 0) {
		out.push({ name: `${stem}.dms.json`, type: 'application/json', section: 'dms', text: dmsJsonText(s.dms) });
		out.push({ name: `${stem}.dms.csv`, type: 'text/csv', section: 'dms', text: dmsCsvText(s.dms) });
	}
	out.push({
		name: `${stem}.report.json`,
		type: 'application/json',
		section: 'report',
		text: reportRecordText(report, { includeArrays: false })
	});
	return out;
}

/** `results.js`'s single-analysis serialiser, re-exported so a caller has one import site. */
export { jsonSafe, resultRecordText };
