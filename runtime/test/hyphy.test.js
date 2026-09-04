/**
 * hyphy.test.js - HyPhy WASM under Node: the real binary on the real examples.
 *
 * WHY THIS FILE EXISTS. runtime/src/hyphy/index.js exists so the app's tree tools run on every
 * surface, and Node is the one the build was not compiled for (ENVIRONMENT=web,worker). This
 * suite is the proof that the evaluate-with-shadowed-globals path works end to end: the vendored
 * build reports its version, fits HKY85 branch lengths on examples/camelid (212 taxa, a
 * topology-only tree, the case PLAN.md D6 is about), builds an NJ tree for examples/bat_oas1
 * (18 taxa), converts a NEXUS block back to FASTA, and fails loudly on a bad tree.
 *
 * The HKY85 result is compared with native HyPhy when a `hyphy` binary is on PATH, running the
 * reference's own script (hyphaeon/dataset.py:224-287, which prints Format(T, 0, 1)); the
 * comparison is printed, not asserted, because the WASM build (2.5.98) and the machine's binary
 * (2.5.65 here, the version fixtures/e2e/meme_camelid.json records) are different releases of
 * the optimiser. Measured on this machine: patristic max 0.53817 (WASM) vs 0.53825 (native),
 * max |delta| over all pairs 3.7e-4, mean 6.6e-5; both trees have 73 branches of exactly 0 on
 * the same tips.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	readNewick,
	findClades,
	getTerminals,
	treeTaxa,
	needsBranchLengths,
	computeFastDistMatrix,
	parseAlignmentSequences
} from '@veg/hyphaeon-js';
import {
	createHyPhy,
	evaluateGlue,
	hyphyErrorMessage,
	HyPhyError,
	HYPHY_ASSETS,
	HYPHY_VERSION_STRING,
	HYPHY_WASM_VERSION
} from '../src/hyphy/index.js';
import { HBL_FILES, HKY85_BF, NJ_BF } from '../src/hyphy/hbl.js';
import { inspectBranchLengths } from '../src/treeSanitation.js';

const here = dirname(fileURLToPath(import.meta.url));
const runtimeDir = resolve(here, '..');
const engineDir = resolve(runtimeDir, '..', '..', 'HyphAeon');
const examples = join(engineDir, 'examples');
const vendorDir = join(runtimeDir, 'vendor', 'hyphy', HYPHY_WASM_VERSION);

const read = (p) => readFileSync(p, 'utf8');
const haveExamples = existsSync(join(examples, 'camelid.fasta'));

/** Non-root branch lengths of a library tree, in preorder. */
function branchLengthsOf(tree) {
	return findClades(tree)
		.filter((n) => n !== tree.root)
		.map((n) => tree.branchLength[n]);
}

/** Native `hyphy` on PATH, or null. */
function nativeHyphy() {
	try {
		const out = execFileSync('hyphy', ['--version'], { encoding: 'utf8', timeout: 20_000 });
		return out.trim().split('\n')[0];
	} catch {
		return null;
	}
}

describe('hbl.js mirrors hbl/*.bf', () => {
	it('every exported script is byte-identical to its .bf file', () => {
		for (const [file, text] of Object.entries(HBL_FILES)) {
			expect(text, file).toBe(read(join(runtimeDir, 'src', 'hyphy', 'hbl', file)));
		}
	});

	it('the copies of record end with the upstream text unchanged', () => {
		// The axomeme3 HKY85 script, minus the header, is the model block through the fprintf.
		expect(HKY85_BF).toContain('HarvestFrequencies(freqs, df, 1, 1, 1);');
		expect(HKY85_BF).toContain('Tree T = "${cleanTreeStr}";');
		expect(HKY85_BF.trimEnd().endsWith('fprintf("/output.nwk", Format(T, 1, 1));')).toBe(true);
		// DataMonkey 3's NJ.bf body, when the checkout is beside this repository.
		const dm3 = resolve(runtimeDir, '..', '..', 'datamonkey3', 'src', 'data', 'shared', 'NJ.bf');
		if (existsSync(dm3)) {
			const upstream = read(dm3);
			expect(NJ_BF.endsWith(upstream)).toBe(true);
		}
	});
});

describe('vendored build', () => {
	it('has the three Emscripten files', () => {
		for (const name of HYPHY_ASSETS) expect(existsSync(join(vendorDir, name)), name).toBe(true);
	});

	it('is a MODULARIZE classic script compiled for web,worker only', () => {
		const glue = read(join(vendorDir, 'hyphy.js'));
		expect(glue.startsWith('var Module=(()=>{')).toBe(true);
		expect(glue).toContain('not compiled for this environment');
		expect(glue).toContain('node environment detected but not enabled at build time');
		expect(glue).toContain('postMessage({type:"biowasm"');
		expect(glue).not.toContain('export default');
	});

	it('evaluateGlue hides Node from it and returns the factory', () => {
		const factory = evaluateGlue(read(join(vendorDir, 'hyphy.js')), {
			postMessage: () => {},
			hideNode: true,
			scriptUrl: 'file:///x/hyphy.js'
		});
		expect(typeof factory).toBe('function');
	});
});

describe('hyphyErrorMessage', () => {
	it("lifts HyPhy's Error: block from stdout", () => {
		const stdout = 'Error:\nCould not find source dataset file "/x.fa"\nPath stack:\n\t/res/\n\nFunction call stack\n1 :  DataSet ds = ReadDataFile("/x.fa");\n-------';
		expect(hyphyErrorMessage(stdout, 'Check errors.log for execution error details.', 1)).toBe(
			'HyPhy: Could not find source dataset file "/x.fa"\nPath stack:\n\t/res/\n\nFunction call stack\n1 :  DataSet ds = ReadDataFile("/x.fa");'
		);
	});
	it('falls back to the last line, then the status', () => {
		expect(hyphyErrorMessage('', 'boom\nCheck errors.log', 2)).toBe('HyPhy exited with status 2: boom');
		expect(hyphyErrorMessage('', '', 3)).toBe('HyPhy exited with status 3');
	});
});

describe('HyPhy WASM under Node', () => {
	/** @type {Awaited<ReturnType<typeof createHyPhy>>} */
	let hyphy;
	const loadProgress = [];

	beforeAll(async () => {
		hyphy = await createHyPhy({
			progress: (phase, done, total, message) => loadProgress.push({ phase, done, total, message })
		});
	});

	it('loads the vendored assets and reports its version string', async () => {
		expect(hyphy.version).toBe(HYPHY_WASM_VERSION);
		expect(hyphy.assets.glueStrategy).toBe('eval');
		expect(hyphy.assets.bytes.wasm).toBeGreaterThan(1_000_000);
		expect(hyphy.assets.bytes.data).toBeGreaterThan(4_000_000);
		expect(loadProgress.map((p) => p.phase)).toEqual(['load', 'load', 'load', 'load']);
		expect(loadProgress[3]).toMatchObject({ done: 3, total: 3 });

		const v = await hyphy.hyphyVersion();
		expect(v.result).toBe(HYPHY_VERSION_STRING);
		expect(v.elapsedMs).toBeGreaterThan(0);
		console.log(`[hyphy] ${v.result} (instantiate + --version ${v.elapsedMs.toFixed(0)} ms)`);
	});

	it.skipIf(!haveExamples)('estimateBranchLengths: HKY85 on camelid (212 taxa, topology only)', async () => {
		const fasta = read(join(examples, 'camelid.fasta'));
		const newick = read(join(examples, 'camelid.nwk'));
		expect(needsBranchLengths(readNewick(newick))).toBe(true);

		const phases = [];
		const { result, stderr, stdout, elapsedMs } = await hyphy.estimateBranchLengths(fasta, newick, {
			progress: (phase, _d, _t, message) => phases.push([phase, message])
		});
		expect(phases[0][0]).toBe('run');
		expect(phases[phases.length - 1][0]).toBe('done');
		expect(stderr).toBe('');
		expect(stdout).toBe('');
		expect(result.endsWith(';')).toBe(true);

		const tree = readNewick(result);
		const tips = treeTaxa(tree);
		expect(tips).toHaveLength(212);
		expect(new Set(tips)).toEqual(new Set(treeTaxa(readNewick(newick))));
		expect(needsBranchLengths(tree)).toBe(false);

		// HyPhy unroots: 2n - 3 = 421 branches, every one a finite non-negative length.
		const lengths = branchLengthsOf(tree);
		expect(lengths).toHaveLength(421);
		expect(lengths.every((b) => Number.isFinite(b) && b >= 0)).toBe(true);
		const zeros = lengths.filter((b) => b === 0).length;
		const positive = lengths.filter((b) => b > 0).length;
		expect(positive).toBeGreaterThan(300);
		const check = inspectBranchLengths(result);
		expect(check.negative).toBe(0);
		expect(check.saturated).toBe(0);

		const n = tips.length;
		const d = computeFastDistMatrix(tree, tips);
		let maxWasm = 0;
		for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) maxWasm = Math.max(maxWasm, d[i * n + j]);
		console.log(
			`[hyphy] camelid HKY85 (WASM ${HYPHY_WASM_VERSION}): ${elapsedMs.toFixed(0)} ms, ` +
				`${lengths.length} branches, ${positive} > 0, ${zeros} == 0, patristic max ${maxWasm.toFixed(5)}`
		);

		// Informational: the reference's own script through the native binary, when there is one.
		const native = nativeHyphy();
		if (!native) {
			console.log('[hyphy] no native hyphy on PATH; skipping the version comparison');
			return;
		}
		const dir = mkdtempSync(join(tmpdir(), 'hyphaeon-hky85-'));
		try {
			const fa = join(dir, 'align.fa');
			writeFileSync(fa, fasta);
			const clean = newick.trim().replace(/;$/, '');
			const bf = join(dir, 'est.bf');
			writeFileSync(
				bf,
				`
DataSet ds = ReadDataFile("${fa}");
DataSetFilter df = CreateFilter(ds, 1);
HarvestFrequencies(freqs, df, 1, 1, 1);
global kappa = 1.0;
HKY85RateMatrix = [
    [*, kappa*t, t, kappa*t]
    [kappa*t, *, kappa*t, t]
    [t, kappa*t, *, kappa*t]
    [kappa*t, t, kappa*t, *]
];
Model HKY85Model = (HKY85RateMatrix, freqs);
UseModel(HKY85Model);
Tree T = "${clean}";
LikelihoodFunction lf = (df, T);
Optimize(res, lf);
fprintf(stdout, Format(T, 0, 1));
`
			);
			const t0 = performance.now();
			const out = execFileSync('hyphy', [bf], { encoding: 'utf8', timeout: 600_000, maxBuffer: 64 << 20 });
			const nativeMs = performance.now() - t0;
			const s = out.indexOf('(');
			const e = out.lastIndexOf(')');
			const nativeTree = readNewick(out.slice(s, e + 1) + ';');
			const dn = computeFastDistMatrix(nativeTree, tips);
			let maxNative = 0;
			let maxDelta = 0;
			let sumDelta = 0;
			let pairs = 0;
			for (let i = 0; i < n; i++) {
				for (let j = i + 1; j < n; j++) {
					const a = d[i * n + j];
					const b = dn[i * n + j];
					maxNative = Math.max(maxNative, b);
					const delta = Math.abs(a - b);
					maxDelta = Math.max(maxDelta, delta);
					sumDelta += delta;
					pairs += 1;
				}
			}
			const nativeLengths = branchLengthsOf(nativeTree);
			const tipLen = (t, name) => {
				const node = getTerminals(t).find((k) => t.name[k] === name);
				return node === undefined ? NaN : t.branchLength[node];
			};
			const sample = ['LGL132362', 'LGL237315', 'AF000603', 'cvhp24vcod', 'cvhp22vcod', 'LGL131930']
				.map((name) => `${name} ${tipLen(tree, name).toFixed(5)} / ${tipLen(nativeTree, name).toFixed(5)}`)
				.join(', ');
			console.log(
				`[hyphy] native "${native}" (${nativeMs.toFixed(0)} ms): patristic max ${maxNative.toFixed(5)} ` +
					`vs WASM ${maxWasm.toFixed(5)}; max |delta| ${maxDelta.toExponential(2)}, mean ${(sumDelta / pairs).toExponential(2)} ` +
					`over ${pairs} pairs; zero branches native ${nativeLengths.filter((b) => b === 0).length} vs WASM ${zeros}; ` +
					`tip lengths WASM / native: ${sample}`
			);
			expect(treeTaxa(nativeTree)).toHaveLength(212);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it.skipIf(!haveExamples)('estimateBranchLengths keeps user lengths as starting values and re-fits', async () => {
		const fasta = read(join(examples, 'bat_oas1.fasta'));
		const newick = read(join(examples, 'bat_oas1.nwk'));
		const { result } = await hyphy.estimateBranchLengths(fasta, newick);
		const tree = readNewick(result);
		expect(treeTaxa(tree)).toHaveLength(18);
		const lengths = branchLengthsOf(tree);
		expect(lengths).toHaveLength(33);
		// bat_oas1.nwk is a chronogram in Mya (max patristic ~123); HKY85 substitutions/site are < 1.
		expect(Math.max(...lengths)).toBeLessThan(1);
		expect(lengths.every((b) => b >= 0)).toBe(true);
	});

	it.skipIf(!haveExamples)('njTree: 18 tips for bat_oas1, names as uploaded, lengths present', async () => {
		const fasta = read(join(examples, 'bat_oas1.fasta'));
		const { result, stderr, elapsedMs } = await hyphy.njTree(fasta);
		expect(stderr).toBe('');
		expect(result.endsWith(';')).toBe(true);
		const tree = readNewick(result);
		const tips = treeTaxa(tree);
		expect(tips).toHaveLength(18);
		const names = [...parseAlignmentSequences(fasta).keys()];
		expect(new Set(tips)).toEqual(new Set(names));
		const lengths = branchLengthsOf(tree);
		expect(lengths).toHaveLength(33);
		expect(lengths.every((b) => Number.isFinite(b))).toBe(true);
		const check = inspectBranchLengths(result);
		expect(check.hasLengths).toBe(true);
		expect(check.total).toBe(33);
		console.log(
			`[hyphy] bat_oas1 NJ: ${elapsedMs.toFixed(0)} ms, ${check.total} lengths, ${check.negative} negative, ` +
				`${check.saturated} saturated, min ${check.min}`
		);
	});

	it.skipIf(!haveExamples)('convertAlignment: NEXUS -> FASTA, sequences identical, names case-folded by HyPhy', async () => {
		const fasta = read(join(examples, 'bat_oas1.fasta'));
		const seqs = [...parseAlignmentSequences(fasta)];
		const nexus =
			`#NEXUS\nBEGIN DATA;\n  DIMENSIONS NTAX=${seqs.length} NCHAR=${seqs[0][1].length};\n` +
			`  FORMAT DATATYPE=DNA MISSING=? GAP=-;\n  MATRIX\n` +
			seqs.map(([n, s]) => `    ${n} ${s}`).join('\n') +
			'\n  ;\nEND;\n';
		const { result } = await hyphy.convertAlignment(nexus, { fileName: 'bat_oas1.nex' });
		expect(result.startsWith('>')).toBe(true);
		const back = [...parseAlignmentSequences(result)];
		expect(back).toHaveLength(18);
		expect(back.map(([n]) => n.toUpperCase())).toEqual(seqs.map(([n]) => n.toUpperCase()));
		expect(back.map(([, s]) => s)).toEqual(seqs.map(([, s]) => s));
	});

	it.skipIf(!haveExamples)('convertAlignment: sequential PHYLIP round-trips exactly (default extension)', async () => {
		const fasta = read(join(examples, 'bat_oas1.fasta'));
		const seqs = [...parseAlignmentSequences(fasta)];
		const phylip = `${seqs.length} ${seqs[0][1].length}\n` + seqs.map(([n, s]) => `${n}\n${s}`).join('\n') + '\n';
		const { result } = await hyphy.convertAlignment(phylip);
		expect([...parseAlignmentSequences(result)]).toEqual(seqs);
	});

	it.skipIf(!haveExamples)('a tree that does not match the alignment is a HyPhyError with HyPhy\'s text', async () => {
		const fasta = read(join(examples, 'bat_oas1.fasta'));
		let caught;
		try {
			await hyphy.estimateBranchLengths(fasta, '((A,B),(C,D));');
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(HyPhyError);
		expect(caught.exitCode).toBe(1);
		expect(caught.message).toMatch(/number of tree tips in 'T'\(4\) is not equal to the number of sequences/);
		expect(caught.stdout).toContain('Error:');
		expect(caught.stderr).toContain('errors.log');
	});

	it('a missing data file is a HyPhyError too, and the next run is unaffected', async () => {
		await expect(
			hyphy.run({ script: 'DataSet ds = ReadDataFile("/nowhere.fa");', outputs: [] })
		).rejects.toMatchObject({ name: 'HyPhyError', exitCode: 1, message: /Could not find source dataset file/ });
		const v = await hyphy.hyphyVersion();
		expect(v.result).toBe(HYPHY_VERSION_STRING);
	});

	it('rejects a tree with a double quote before touching HyPhy', async () => {
		await expect(hyphy.estimateBranchLengths('>a\nACG\n', '(("a",b),c);')).rejects.toThrow(/double quote/);
	});
});
