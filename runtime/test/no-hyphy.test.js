/**
 * no-hyphy.test.js — HyPhy is gone from the runtime, and the report still runs without it.
 *
 * WHY THIS FILE EXISTS. PLAN.md D22 removed HyPhy from the product, and the whole point of the
 * decision is that nothing depends on it any more: `runtime/src/hyphy/`, `runtime/vendor/hyphy/`
 * (a 6.4 MB tracked WebAssembly build) and the `./hyphy` subpath export were deleted, and
 * `scripts/copy-assets.mjs` no longer serves it. A deletion is easy to make and easy to
 * half-undo — one `import` reintroduces the dependency and nothing else fails — so it is pinned
 * two ways:
 *
 *   1. STATICALLY. No file under `src/` or `scripts/` mentions HyPhy outside a comment, no
 *      directory it lived in exists, `package.json` exports no `./hyphy` and ships no `vendor`,
 *      and importing the old subpath fails the way Node fails an unexported path. The word is
 *      allowed in prose — every one of these files explains WHY the tree policy is what it is,
 *      and PLAN.md D22 is a decision about HyPhy — so the check strips comments first.
 *   2. DYNAMICALLY. `runEverything` on camelid, the example whose tree has no branch lengths and
 *      which therefore used to be the app's HyPhy case. It must now produce a complete report by
 *      itself, on TN93 distances, with a display-only NJ tree — and then answer the phenotype
 *      offer on demand, which is the other half of this phase.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

import { runEverything, runPhenotypeForReport } from '../src/analyze.js';
import { createSession } from '../src/createSession.js';
import { SECTION_ORDER, downloadsForReport, toReportRecord } from '../src/report.js';
import { PERMULATION_SKIP_REASONS } from '../src/phenotype.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNTIME = join(HERE, '..');
const ENGINE = join(RUNTIME, '..', '..', 'HyphAeon');
const MODELS = join(ENGINE, 'models');
const EXAMPLES = join(ENGINE, 'examples');

const ready = existsSync(join(MODELS, 'general.onnx')) && existsSync(join(EXAMPLES, 'camelid.fasta'));
if (!ready) console.warn(`\n[no-hyphy] REAL-GRAPH RUN SKIPPED — needs ${MODELS}/general.onnx and ${EXAMPLES}/camelid.fasta.\n`);

/** Every .js / .mjs file under a directory, recursively. */
function sources(dir, out = []) {
	if (!existsSync(dir)) return out;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, entry.name);
		if (entry.isDirectory()) sources(p, out);
		else if (/\.(js|mjs|cjs)$/.test(entry.name)) out.push(p);
	}
	return out;
}

/**
 * The file with its comments removed, so a search sees CODE only. Crude on purpose: a `//` inside
 * a string literal would be cut too, which can only make this check stricter, never laxer.
 */
function codeOnly(text) {
	return text
		.replace(/\/\*[\s\S]*?\*\//g, ' ')
		.split('\n')
		.map((line) => {
			const i = line.indexOf('//');
			return i === -1 ? line : line.slice(0, i);
		})
		.join('\n');
}

describe('HyPhy is not in this package', () => {
	it('is mentioned only in prose, never in code', () => {
		const files = [...sources(join(RUNTIME, 'src')), ...sources(join(RUNTIME, 'scripts'))];
		expect(files.length).toBeGreaterThan(10);
		const offenders = [];
		for (const file of files) {
			const code = codeOnly(readFileSync(file, 'utf8'));
			for (const [i, line] of code.split('\n').entries()) {
				if (/hyphy/i.test(line)) offenders.push(`${relative(RUNTIME, file)}:${i + 1}: ${line.trim()}`);
			}
		}
		expect(offenders, `HyPhy reached the code again:\n${offenders.join('\n')}`).toEqual([]);
	});

	it('has no hyphy source, no vendored build, and no ./hyphy export', async () => {
		expect(existsSync(join(RUNTIME, 'src', 'hyphy'))).toBe(false);
		expect(existsSync(join(RUNTIME, 'vendor'))).toBe(false);
		const pkg = JSON.parse(readFileSync(join(RUNTIME, 'package.json'), 'utf8'));
		expect(Object.keys(pkg.exports)).toEqual(['.', './web', './node', './prescreen', './prescreen/scope', './package.json']);
		expect(pkg.files).toEqual(['src']);
		// The old subpath fails the way Node fails any unexported path, not with a module-not-found
		// from inside a file that still exists. `require.resolve` rather than `import()`, because
		// Vite resolves a literal dynamic import at transform time and would fail the whole file
		// instead of this assertion.
		const require = createRequire(import.meta.url);
		let err = null;
		try {
			require.resolve('@veg/hyphaeon-runtime/hyphy');
		} catch (e) {
			err = e;
		}
		expect(err, 'the ./hyphy subpath still resolves').not.toBe(null);
		expect(err.code).toBe('ERR_PACKAGE_PATH_NOT_EXPORTED');
		// The two subpaths that remain still resolve, so this is not passing for the wrong reason.
		expect(require.resolve('@veg/hyphaeon-runtime/node')).toContain('session-node.js');
	});

	it('ships no WebAssembly of its own (onnxruntime brings its own, and is a dependency)', () => {
		const wasm = [];
		const walk = (dir) => {
			if (!existsSync(dir)) return;
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const p = join(dir, entry.name);
				if (entry.isDirectory()) walk(p);
				else if (/\.(wasm|data)$/.test(entry.name)) wasm.push(relative(RUNTIME, p));
			}
		};
		walk(join(RUNTIME, 'src'));
		walk(join(RUNTIME, 'scripts'));
		expect(wasm).toEqual([]);
		// And nothing tracked is anywhere near the 6.4 MB the vendored build used to weigh.
		const big = sources(join(RUNTIME, 'src')).filter((f) => statSync(f).size > 1_000_000);
		expect(big.map((f) => relative(RUNTIME, f))).toEqual([]);
	});
});

describe.skipIf(!ready)('runEverything on camelid, the old HyPhy case', () => {
	let record = null;

	async function report() {
		if (record) return record;
		const s = await createSession({ modelsBase: MODELS, variant: 'general', threads: 2, bustedHead: true });
		record = await runEverything({
			alignmentText: readFileSync(join(EXAMPLES, 'camelid.fasta'), 'utf8'),
			// The topology-only tree the upload would carry: before D22 this went to HyPhy.
			treeText: readFileSync(join(EXAMPLES, 'camelid.nwk'), 'utf8'),
			inputs: { alignmentName: 'camelid.fasta', treeName: 'camelid.nwk', demo: 'camelid' },
			options: {
				maxSpecies: Infinity,
				seed: 42,
				permutations: 200,
				// The 19 x 96 x 212 sweep is not what this file is about.
				dms: { enabled: false }
			},
			session: s,
			surface: 'node-server'
		});
		return record;
	}

	it('produces a complete report from TN93 distances alone, drawing the uploaded topology for the UI', async () => {
		const r = await report();
		const pp = r.diagnostics.preprocessing;
		expect(pp.tree_source).toBe('tn93');
		expect(pp.tree_provided).toBe('user');
		expect(pp.tree_free.reason).toBe('no_branch_lengths');
		expect(pp.branch_lengths_estimated).toBe(false);
		expect(r.diagnostics.warnings.map((w) => w.code)).toContain('TREE_FREE_TN93');
		// The display tree (PLAN.md D6): camelid.nwk is a topology with no branch lengths, so the
		// reader's OWN topology is drawn — pruned to the taxa the model actually saw, unit lengths,
		// the runtime's caption — and it parses. NJ is only for an upload with no topology at all.
		const dt = r.diagnostics.display_tree;
		expect(dt.source).toBe('user-topology');
		expect(pp.display_tree_source).toBe('user-topology');
		expect(dt.from).toBe('tree-text');
		expect(dt.taxa).toBe(r.diagnostics.taxa_used);
		expect(dt.prunedTips).toBe(0);
		expect(dt.label).toMatch(/your topology; branch lengths not estimated/);
		expect(dt.newick.endsWith(');')).toBe(true);
		expect(dt.newick).toMatch(/:1[,)]/);
		expect(dt.newick).not.toMatch(/:0\.\d/);
		// Every automatic section ran; phenotype is the offer, not the analysis.
		expect(r.sections.sites.taxa_count).toBe(212);
		expect(r.sections.sites.codon_count).toBe(96);
		expect(r.sections.gene.record.p_value_acat).toBeGreaterThan(0);
		expect(Array.isArray(r.sections.epistasis.edges)).toBe(true);
		expect(r.sections.attribution.attribution_enabled).toBe(true);
		expect(r.sections.phenotype).toBe(null);
		expect(r.provenance.report.sections_failed).toEqual([]);
		expect(r.provenance.report.sections_run).toEqual(['sites', 'gene', 'epistasis', 'attribution', 'filter']);
	}, 300_000);

	it('answers the phenotype offer on demand, without a second forward pass', async () => {
		const r = await report();
		const before = { ...r.timings };
		const events = [];
		const section = await runPhenotypeForReport(
			r,
			// camelid's taxa are clone ids; `cvhp` names one family of them. The trait is a vector
			// here, not a hypothesis: what is under test is the plumbing.
			{ foreground: 'cvhp' },
			{ options: { permulations: 50, nPermutations: 200 }, onSection: (name, payload, meta) => events.push([name, meta.final]) }
		);
		expect(events).toEqual([['phenotype', true]]);
		expect(r.sections.phenotype).toBe(section);
		expect(section.attention_source).toBe('shared-pass'); // the meme pass, reused
		expect(section.taxa_count).toBe(r.sections.sites.taxa_count);
		expect(section.codon_count).toBe(r.sections.sites.codon_count);
		expect(section.phenotype_meta.foreground_count).toBeGreaterThan(1);
		expect(section.sites.length).toBeGreaterThan(0);
		// Tree-free, so no Brownian null — with the reason, not silently.
		expect(section.permulations).toMatchObject({ requested: 50, ran: 0, reason: PERMULATION_SKIP_REASONS.treeFree });
		expect(section.gene_p_value_perm).toBe(null);
		// The record grew a section, a timing and two downloads, and stayed serialisable.
		expect(r.timings.phenotype).toBeGreaterThanOrEqual(0);
		expect(Object.keys(before)).not.toContain('phenotype');
		expect(r.provenance.report.sections_run).toContain('phenotype');
		expect(SECTION_ORDER.indexOf('phenotype')).toBe(SECTION_ORDER.length - 1);
		const names = downloadsForReport(r).map((d) => d.name);
		expect(names).toContain('camelid.phenotype.json');
		expect(names).toContain('camelid.phenotype.csv');
		expect(() => JSON.stringify(toReportRecord(r, { includeArrays: false }))).not.toThrow();
	}, 300_000);

	it('attaches a failed trait to the section AND re-throws, because the user asked for it', async () => {
		const r = await report();
		await expect(runPhenotypeForReport(r, { foreground: 'no-such-taxon-anywhere' })).rejects.toThrow(/Insufficient foreground taxa/);
		expect(r.sections.phenotype.failed).toBe(true);
		expect(r.sections.phenotype.error).toMatch(/Insufficient foreground taxa/);
		expect(r.provenance.report.sections_failed).toEqual(['phenotype']);
		expect(downloadsForReport(r).map((d) => d.name)).not.toContain('camelid.phenotype.csv');
		// `runEverything.phenotype` is the same function, reachable from the orchestrator.
		expect(runEverything.phenotype).toBe(runPhenotypeForReport);
	}, 300_000);
});
