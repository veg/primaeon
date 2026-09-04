/**
 * results-evaluate.test.js — results.js (one serialisation for every surface) and evaluate.js
 * (`hyphaeon evaluate` on a prediction CSV + a MEME JSON), on small synthetic inputs so they run
 * without a model. The byte-equality of the writers themselves is the library's
 * (js/test/writers.test.js); what is checked here is that the runtime hands them the right
 * pieces in the right order and that a round trip through the CSV feeds `runEvaluate`.
 */
import { describe, it, expect } from 'vitest';

import {
	memeDocument,
	memeJsonText,
	memeCsvText,
	bustedJsonText,
	bustedCsvText,
	evaluateJsonText,
	toResultRecord,
	resultRecordText,
	downloadsFor,
	jsonSafe
} from '../src/results.js';
import { runEvaluate } from '../src/evaluate.js';

/** A meme result the way runMeme shapes it, without a model: three sites, one attributed. */
function memeResultFixture() {
	const lrt = Float32Array.from([0, 5.5, 1.25]);
	const p = Float32Array.from([2 / 3, 0.02, 0.4]);
	const q = Float32Array.from([2 / 3, 0.06, 0.6]);
	const invariable = Uint8Array.from([1, 0, 0]);
	const rec = {
		site_0indexed: 1,
		site_1indexed: 2,
		predicted_lrt: 5.5,
		consensus_codon: 'ATG',
		consensus_aa: 'M',
		num_mutated_taxa: 1,
		driving_species: [
			{ taxon: 'b', taxon_index: 1, observed_codon: 'TTT', observed_aa: 'F', consensus_codon: 'ATG', consensus_aa: 'M', delta_lrt: 2.0, pct_signal_explained: 36.4, mean_patristic_depth: 0.2 }
		],
		when_selection_occurred: { evolutionary_epoch: 'Recent Terminal / Tip Sweep', mode_of_adaptation: 'Single-Lineage Clade Sweep', weighted_patristic_depth: 0.2, tree_depth_ratio: 0.7 }
	};
	const attributionRecords = new Map([[1, rec]]);
	const result = {
		schema_version: 1,
		method: 'meme',
		is_surrogate: true,
		surrogate_for: 'MEME',
		taxa_count: 4,
		codon_count: 3,
		runtime_sec: 0.5,
		filter_enabled: true,
		artifacts_masked: [{ start: 2, end: 3, span: 2, outlier_taxon: 'b', consecutive_mismatches: 2, oci: 0.5 }],
		attribution_enabled: true,
		attributions: { 2: rec },
		sites: [],
		arrays: { lrt, p_value: p, q_value: q, invariable, raw: null },
		attributionRecords,
		attention: { data: Float32Array.from([1, 2, 3, 4]), dims: [2, 2] },
		summary: { totalSites: 3 },
		provenance: { schema_version: 1, surface: 'browser', inputs: { alignment: 'gene.fasta', tree: 'gene.nwk' }, warnings: [] }
	};
	Object.defineProperty(result, 'loaded', { value: { c: new Int32Array(12) }, enumerable: false });
	return result;
}

describe('results.js', () => {
	it('builds the cmd_meme document key for key, with attributions keyed 1-indexed and the writers agreeing', () => {
		const r = memeResultFixture();
		const doc = memeDocument(r, { provenance: false });
		expect(Object.keys(doc)).toEqual(['alignment', 'tree', 'taxa_count', 'codon_count', 'runtime_sec', 'filter_enabled', 'artifacts_masked', 'attribution_enabled', 'attributions', 'sites']);
		expect(doc.alignment).toBe('gene.fasta');
		expect(doc.tree).toBe('gene.nwk');
		expect(doc.sites).toHaveLength(3);
		expect(doc.sites[0]).toEqual({ site: 1, hyphaeon_lrt: 0, p_value: Math.fround(2 / 3), q_value: Math.fround(2 / 3), is_invariable: true });
		expect(doc.sites[1].evolutionary_epoch).toBe('Recent Terminal / Tip Sweep');
		expect(doc.sites[1].top_driver).toBe('b');
		expect(doc.sites[1].top_mutation).toBe('M->F');
		expect(doc.sites[2].evolutionary_epoch).toBeUndefined();
		const text = memeJsonText(r, { provenance: false });
		const parsed = JSON.parse(text);
		expect(Object.keys(parsed.attributions)).toEqual(['2']);
		expect(parsed.sites[1].hyphaeon_lrt).toBe(5.5);
		// json.dump(indent=2) style: two-space indent, floats printed as Python repr (0.0, not 0).
		expect(text.startsWith('{\n  "alignment": "gene.fasta",\n  "tree": "gene.nwk",\n  "taxa_count": 4,')).toBe(true);
		expect(text).toContain('"hyphaeon_lrt": 0.0,');
		expect(text).toContain('"runtime_sec": 0.5,');
		// With provenance, it is appended AFTER the Python keys.
		const withProv = JSON.parse(memeJsonText(r));
		expect(Object.keys(withProv).at(-1)).toBe('provenance');
		expect(withProv.provenance.surface).toBe('browser');
	});

	it('writes the meme CSV with the attribution columns only when attribution ran', () => {
		const r = memeResultFixture();
		const lines = memeCsvText(r).split('\n');
		expect(lines[0]).toBe('site,hyphaeon_lrt,p_value,q_value,is_invariable,evolutionary_epoch,adaptation_mode,top_driver,top_mutation');
		expect(lines[1]).toBe('1,0.0,0.6666666865348816,0.6666666865348816,True,,,,');
		expect(lines[2]).toBe('2,5.5,0.019999999552965164,0.05999999865889549,False,Recent Terminal / Tip Sweep,Single-Lineage Clade Sweep,b,M->F');
		const plain = { ...r, attribution_enabled: false, attributionRecords: null, attributions: {} };
		expect(memeCsvText(plain).split('\n')[0]).toBe('site,hyphaeon_lrt,p_value,q_value,is_invariable');
	});

	it('writes the busted record as cmd_busted does, and its CSV summary', () => {
		const record = {
			alignment: 'g.fasta', gene: 'g', taxa: 4, sites: 3, p_value_acat: 0.2, p_value_simes: 1.0, omnibus_lrt: 1.5,
			predicted_gene_lrt: 2.0, selection_probability: 0.6, synonymous_rate_variation: 0.1,
			total_selection_energy: 6.75, sig_sites_p05: 1, sig_sites_p10: 1,
			rate_distributions: { omega_1: 0.1, proportion_1: 0.2, omega_2: 1.0, proportion_2: 0.5, omega_3: 3.0, proportion_3: 0.3 },
			positive_selection_detected: true, elapsed_seconds: 0.25
		};
		const result = { method: 'busted', record, provenance: { surface: 'node-server', inputs: { alignment: 'g.fasta' } } };
		const text = bustedJsonText(result, { provenance: false });
		const parsed = JSON.parse(text);
		expect(Array.isArray(parsed)).toBe(false);
		expect(Object.keys(parsed)).toEqual(Object.keys(record));
		expect(text).toContain('"p_value_simes": 1.0,');
		const csv = bustedCsvText(result).split('\n');
		expect(csv[0]).toBe('Gene,Taxa,Sites,p_ACAT,p_Simes,Selection_Prob,Pred_Gene_LRT,Omnibus_LRT,Omega_3,Prop_Positive,Sig_Sites_p05,Selected,Time_ms');
		expect(csv[1]).toBe('g,4,3,0.2,1.0,0.6,2.0,1.5,3.0,0.3,1,True,250.0');
	});

	it('toResultRecord is JSON-safe: typed arrays to arrays, Maps dropped in favour of the 1-indexed object, loaded omitted', () => {
		const r = memeResultFixture();
		const rec = toResultRecord(r);
		expect(rec.arrays.lrt).toEqual([0, 5.5, 1.25]);
		expect(rec.attention).toEqual({ data: [1, 2, 3, 4], dims: [2, 2] });
		expect(rec.attributionRecords).toBeUndefined();
		expect(rec.attributions['2'].driving_species[0].taxon).toBe('b');
		expect(rec.loaded).toBeUndefined();
		expect(() => JSON.stringify(rec)).not.toThrow();
		const slim = toResultRecord(r, { includeArrays: false, includeHeads: false });
		expect(slim.arrays).toBeUndefined();
		expect(slim.attention).toBeUndefined();
		expect(JSON.parse(resultRecordText(r)).taxa_count).toBe(4);
		expect(jsonSafe(new Map([[3, 4n]]))).toEqual({ 3: 4 });
	});

	it('lists the downloads a results page offers', () => {
		const r = memeResultFixture();
		r.filter = { cleaned_fasta: '>a\nNNN\n' };
		const names = downloadsFor(r).map((d) => d.name);
		expect(names).toEqual(['gene.meme.json', 'gene.meme.csv', 'gene.cleaned.fasta', 'gene.hyphaeon.json']);
		expect(downloadsFor(r, { stem: 'x' })[0].name).toBe('x.meme.json');
	});
});

describe('runEvaluate', () => {
	// A MEME JSON in HyPhy's layout, three sites, matching the CSV above.
	const memeJson = {
		'MLE': {
			headers: [['alpha;', ''], ['beta+;', ''], ['p-value', ''], ['LRT', '']],
			content: {
				'0': [
					[0.1, 0.2, 0.9, 0.0],
					[0.1, 2.5, 0.01, 6.0],
					[0.1, 0.3, 0.5, 1.0]
				]
			}
		},
		'data partitions': { '0': { coverage: [[0, 1, 2]] } }
	};
	const csv = 'site,hyphaeon_lrt,p_value,q_value,is_invariable\n1,0.0,0.6666666865348816,0.6666666865348816,True\n2,5.5,0.02,0.06,False\n3,1.25,0.4,0.6,False\n';

	it('evaluates bare texts under matching default gene names and returns the report and its text form', () => {
		const out = runEvaluate({ predictionCsv: csv, memeJson: JSON.stringify(memeJson), surface: 'mcp-stdio' });
		expect(out.method).toBe('evaluate');
		expect(out.result.matched_genes).toBe(1);
		expect(out.result.total_sites).toBe(3);
		expect(out.result.evaluated_sites).toBe(3);
		expect(typeof out.result.pearson_r).toBe('number');
		expect(out.result.thresholds['0.05']).toBeDefined();
		expect(out.result.thresholds['0.10']).toBeDefined();
		expect(out.text).toMatch(/^Matched genes: 1\nTotal sites: 3/);
		expect(out.provenance).toMatchObject({ surface: 'mcp-stdio', inputs: { prediction: 'gene.csv', meme_result: 'gene.MEME.json' } });
		expect(evaluateJsonText(out).endsWith('\n')).toBe(true);
		expect(JSON.parse(evaluateJsonText(out)).matched_genes).toBe(1);
	});

	it('accepts parsed MEME data, honours variableOnly, and refuses mismatched gene names', () => {
		const out = runEvaluate({ predictionCsv: { name: 'g.csv', text: csv }, memeJson: { name: 'g.MEME.json', data: memeJson }, options: { variableOnly: true } });
		expect(out.result.evaluated_sites).toBe(2);
		expect(out.result.total_sites).toBe(3);
		expect(() => runEvaluate({ predictionCsv: { name: 'a.csv', text: csv }, memeJson: { name: 'b.MEME.json', data: memeJson } })).toThrow(/do not match/);
		expect(() => runEvaluate({ predictionCsv: 42, memeJson })).toThrow(/predictionCsv/);
	});
});
