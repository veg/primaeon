/**
 * report.test.js — the ReportRecord and its downloads, without a model.
 *
 * WHY THIS FILE EXISTS. analyze.test.js proves the report is produced correctly; this file
 * proves the record itself behaves: sections are named and refused by name, timings accumulate,
 * a serialised record is JSON-safe, and every download is the file the Python CLI writes for the
 * same numbers — the meme document from a section that no longer carries typed arrays
 * (PHASE1.md gap 7, the reason a stored browser record could not take the CLI path), the
 * epistasis JSON/CSV, and the GraphML of `hyphaeon epistasis --graphml` (cli.py:821-833) through
 * the library's writer. The section payloads here are lifted from fixtures/e2e so the expected
 * bytes are the reference's, not this test's invention.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
	createReport,
	setSection,
	addTiming,
	toReportRecord,
	reportRecordText,
	downloadsForReport,
	memeDocumentFromSection,
	epistasisDocument,
	epistasisJsonText,
	epistasisCsvText,
	epistasisGraphmlText,
	dmsDocument,
	dmsCsvText,
	geneJsonText,
	REPORT_SCHEMA_VERSION,
	SECTION_ORDER,
	REPORT_PHASES
} from '../src/report.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, '..', '..', '..', 'HyphAeon', 'fixtures');
const have = existsSync(join(FIXTURES, 'e2e', 'meme_Smc6.json'));
const fixture = (rel) => JSON.parse(readFileSync(join(FIXTURES, rel), 'utf8'));

describe('the record', () => {
	it('starts empty, in the plan\'s section order, with an id and a timestamp', () => {
		const r = createReport({ inputs: { alignmentName: 'x.fasta' }, options: { seed: 42 } });
		expect(r.schema_version).toBe(REPORT_SCHEMA_VERSION);
		expect(r.kind).toBe('report');
		expect(Object.keys(r.sections)).toEqual([...SECTION_ORDER]);
		expect(Object.values(r.sections).every((v) => v === null)).toBe(true);
		expect(r.id).toMatch(/^[0-9a-f-]{32,36}$/);
		expect(Date.parse(r.createdAt)).toBeGreaterThan(0);
		expect(r.timings).toEqual({});
		expect(REPORT_PHASES[0]).toBe('parse');
		expect(REPORT_PHASES[REPORT_PHASES.length - 1]).toBe('postprocess');
	});

	it('refuses a section it does not have, and accumulates timings per phase', () => {
		const r = createReport();
		expect(() => setSection(r, 'sectors', {})).toThrow(/unknown section/);
		setSection(r, 'gene', { record: { gene: 'x' }, statistics: {} });
		expect(r.sections.gene.record.gene).toBe('x');
		addTiming(r, 'dms', 1.5);
		addTiming(r, 'dms', 0.25);
		expect(r.timings.dms).toBe(1.75);
	});

	it('serialises typed arrays, Maps and nested records to plain JSON', () => {
		const r = createReport();
		setSection(r, 'sites', {
			sites: [{ site: 1, hyphaeon_lrt: 0 }],
			arrays: { lrt: Float32Array.from([0, 1.5]) },
			attention: { data: Float32Array.from([1, 2]), dims: [1, 2] },
			attributionRecords: new Map([[0, { taxon: 'a' }]])
		});
		const rec = toReportRecord(r);
		expect(rec.sections.sites.attention).toBeUndefined();
		expect(rec.sections.sites.attributionRecords).toBeUndefined();
		expect(rec.sections.sites.arrays.lrt).toEqual([0, 1.5]);
		expect(() => JSON.parse(reportRecordText(r))).not.toThrow();
		expect(toReportRecord(r, { includeArrays: false }).sections.sites.arrays).toBeUndefined();
	});
});

describe.skipIf(!have)('downloads are the Python CLI\'s files', () => {
	const memeRef = have ? fixture('e2e/meme_Smc6.json')[0].outputs : null;
	const epiRef = have ? fixture('e2e/epistasis_Smc6_n_permutations_1000.json')[0].outputs : null;

	/** A report in the shape a stored (serialised) one has: site records, no typed arrays. */
	function storedReport() {
		const r = createReport({ inputs: { alignmentName: 'Smc6.fasta', treeName: 'Smc6.nwk' } });
		setSection(r, 'sites', {
			taxa_count: memeRef.taxa_count,
			codon_count: memeRef.codon_count,
			runtime_sec: memeRef.runtime_sec,
			filter_enabled: memeRef.filter_enabled,
			artifacts_masked: memeRef.artifacts_masked,
			attribution_enabled: memeRef.attribution_enabled,
			attributions: memeRef.attributions,
			sites: memeRef.sites,
			provenance: { inputs: { alignment: 'Smc6.fasta', tree: 'Smc6.nwk' } }
		});
		setSection(r, 'epistasis', epiRef);
		setSection(r, 'dms', {
			alignment: 'Smc6.fasta',
			tree: 'Smc6.nwk',
			taxa_count: epiRef.taxa_count,
			codon_count: epiRef.codon_count,
			focal_taxon: 'S_cerevisiae',
			total_mutations: 19 * epiRef.codon_count,
			plasticity: epiRef.plasticity
		});
		return r;
	}

	it('rebuilds `hyphaeon meme -o`\'s document from a section with no typed arrays (PHASE1.md gap 7)', () => {
		const doc = memeDocumentFromSection(storedReport().sections.sites, { provenance: false });
		expect(Object.keys(doc)).toEqual(Object.keys(memeRef));
		expect(doc.sites[0]).toEqual(memeRef.sites[0]);
		expect(doc.taxa_count).toBe(memeRef.taxa_count);
		expect(doc.tree).toBe('Smc6.nwk');
	});

	it('writes `hyphaeon epistasis`\'s JSON, CSV and GraphML', () => {
		const section = storedReport().sections.epistasis;
		const doc = epistasisDocument(section);
		expect(Object.keys(doc)).toEqual(Object.keys(epiRef));
		expect(doc.edges).toBe(section.edges);
		expect(doc.selection_dms_plasticity).toBe(doc.plasticity);
		expect(JSON.parse(epistasisJsonText(section)).sectors[0].sites).toEqual(epiRef.sectors[0].sites);
		// cli.py:808-819 writes the EDGES table when there are edges.
		const csv = epistasisCsvText(section).split('\n');
		expect(csv[0]).toBe('site_u,site_v,ref_u,ref_v,lrt_u,lrt_v,similarity,shared_taxa,shared_branches,p_val,hyper_p,fdr_q,cesi');
		expect(csv.length).toBe(section.edges.length + 2); // header + edges + trailing newline
		// cli.py:821-833 through nx.write_graphml (lxml layout, keys in reverse first-appearance order).
		const xml = epistasisGraphmlText(section);
		expect(xml.startsWith("<?xml version='1.0' encoding='utf-8'?>\n<graphml ")).toBe(true);
		expect(xml).toContain('<key id="d0" for="edge" attr.name="weight" attr.type="double"/>');
		expect(xml).toContain('<key id="d2" for="edge" attr.name="shared" attr.type="long"/>');
		expect(xml).toContain('<graph edgedefault="undirected">');
		// nx emits an edge from whichever endpoint it reached first (adjacency order), which is not
		// the record's (site_u, site_v) order, so the pair is compared unordered.
		const pairs = new Set([...xml.matchAll(/<edge source="(\d+)" target="(\d+)">/g)].map((m) => [Number(m[1]), Number(m[2])].sort((a, b) => a - b).join('-')));
		expect(pairs).toEqual(new Set(section.edges.map((e) => [e.site_u, e.site_v].sort((a, b) => a - b).join('-'))));
		// Only the endpoints are registered as nodes, as cli.py's G does.
		const nodes = [...xml.matchAll(/<node id="(\d+)"\/>/g)].map((m) => Number(m[1]));
		expect(new Set(nodes)).toEqual(new Set(section.edges.flatMap((e) => [e.site_u, e.site_v])));
		expect(xml.endsWith('</graph></graphml>')).toBe(true);
	});

	it('writes `hyphaeon dms`\'s document and its CSV without the mutant_deltas column', () => {
		const section = storedReport().sections.dms;
		expect(Object.keys(dmsDocument(section))).toEqual([
			'alignment',
			'tree',
			'taxa_count',
			'codon_count',
			'focal_taxon',
			'total_mutations',
			'plasticity',
			'selection_dms_plasticity'
		]);
		const csv = dmsCsvText(section).split('\n');
		expect(csv[0]).toBe('site,wt_aa,baseline_lrt,p_value,intrinsic_plasticity,mean_delta_lrt,max_delta_lrt,min_delta_lrt');
		expect(csv.length).toBe(section.plasticity.length + 2);
	});

	it('offers one set of files per section that ran, and the record itself last', () => {
		const r = storedReport();
		const files = downloadsForReport(r);
		expect(files.map((f) => f.name)).toEqual([
			'Smc6.meme.json',
			'Smc6.meme.csv',
			'Smc6.epistasis.json',
			'Smc6.epistasis.csv',
			'Smc6.epistasis.graphml',
			'Smc6.dms.json',
			'Smc6.dms.csv',
			'Smc6.report.json'
		]);
		expect(files.every((f) => f.text.length > 0)).toBe(true);
		expect(downloadsForReport(r, { only: ['epistasis'] }).map((f) => f.section)).toEqual(['epistasis', 'epistasis', 'epistasis', 'report']);
		expect(downloadsForReport(r, { stem: 'run-1' })[0].name).toBe('run-1.meme.json');
		// A gene section adds the busted pair.
		setSection(r, 'gene', { record: { alignment: 'Smc6.fasta', gene: 'Smc6', taxa: 20, sites: 1097, p_value_acat: 0.1, p_value_simes: 0.2, omnibus_lrt: 3.3, predicted_gene_lrt: null, selection_probability: null, synonymous_rate_variation: null, total_selection_energy: 84.8, sig_sites_p05: 5, sig_sites_p10: 12, rate_distributions: { omega_1: 0.1, proportion_1: null, omega_2: 1, proportion_2: null, omega_3: null, proportion_3: null }, positive_selection_detected: false, elapsed_seconds: null }, statistics: {} });
		expect(JSON.parse(geneJsonText(r.sections.gene)).gene).toBe('Smc6');
		expect(downloadsForReport(r).map((f) => f.name)).toContain('Smc6.busted.csv');
	});
});
