/**
 * tn93-wasm.test.js — the compiled TN93 answers what the library's JavaScript answers.
 *
 * WHY THIS FILE EXISTS. `runtime/src/tn93-wasm.js` swaps veg/tn93's own compiled code in for the
 * library's port of the tn93 package on the tree-free path (PLAN.md D22). The two must agree
 * ENTRY FOR ENTRY, because every downstream number — the MDS, the model's distance input, every
 * call the report makes — is a function of that matrix, and the parity surface is measured against
 * the port. What is checked here:
 *
 *   1. Identity on real alignments, at every size the app sees, on the FULL matrix rather than on
 *      the raw distances, so the sentinel, the float32 rounding and dataset.py's imputation are
 *      inside the comparison.
 *   2. The imputation is still the LIBRARY's: a matrix built from provider numbers gets the same
 *      1e-4 for a zero-distance pair of distinct sequences as one built in JavaScript.
 *   3. Saturation refuses rather than scoring. The compiled tool omits a pair at its 1.0
 *      threshold; the port raises. The loader turns the omission back into the port's own
 *      `tn93:`-prefixed error, which is what `prepareRun` converts to TN93_UNCOMPUTABLE.
 *   4. The bytes are verified before the module is created, and a failed verification is not
 *      memoised — the rule the ONNX sessions follow, for the same reason.
 *
 * The alignments come from the engine checkout (HYPHAEON_ENGINE_DIR, default ../../HyphAeon), so
 * the suite skips rather than fails where that checkout is absent.
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { tn93DistanceMatrix } from '@veg/hyphaeon-js';
import {
	libraryHonoursProvider,
	loadTn93Wasm,
	resetTn93Wasm,
	tn93Provider,
	tn93WasmOptions,
	TN93_ARGV
} from '../src/tn93-wasm.js';

const HERE = resolve(fileURLToPath(import.meta.url), '..');
const ENGINE = process.env.HYPHAEON_ENGINE_DIR ?? resolve(HERE, '..', '..', '..', 'HyphAeon');
const EXAMPLES = join(ENGINE, 'examples');
const ready = existsSync(join(EXAMPLES, 'bat_oas1.fasta'));
if (!ready) console.warn(`\n[tn93-wasm] examples not found at ${EXAMPLES}; identity cases skipped.\n`);

/** The bundled FASTA examples, smallest first. RHO is NEXUS and has no place here. */
const EXAMPLE_FILES = ['bat_oas1.fasta', 'Smc6.fasta', 'camelid.fasta', 'HIV1_RT.fasta'];

function readFasta(file) {
	const names = [];
	const sequences = {};
	let current = null;
	for (const line of readFileSync(join(EXAMPLES, file), 'utf8').split('\n')) {
		if (line.startsWith('>')) {
			current = line.slice(1).trim();
			names.push(current);
			sequences[current] = '';
		} else if (current && line.trim()) {
			sequences[current] += line.trim();
		}
	}
	return { names, sequences };
}

afterEach(() => {
	resetTn93Wasm();
});

describe('the vendored tn93 build', () => {
	it('verifies its bytes against MANIFEST.json and refuses a mismatch without memoising it', async () => {
		const vendor = resolve(HERE, '..', 'vendor', 'tn93');
		const manifest = JSON.parse(readFileSync(join(vendor, 'MANIFEST.json'), 'utf8'));
		expect(manifest.version).toMatch(/^v\d+\.\d+\.\d+$/);
		expect(manifest.files['tn93.wasm'].sha256).toMatch(/^[0-9a-f]{64}$/);

		// A directory holding the real glue and a manifest that names the wrong hash.
		const bad = join(HERE, 'fixtures-tn93-bad');
		const fs = await import('node:fs/promises');
		await fs.mkdir(bad, { recursive: true });
		await fs.copyFile(join(vendor, 'tn93.cjs'), join(bad, 'tn93.cjs'));
		await fs.copyFile(join(vendor, 'tn93.wasm'), join(bad, 'tn93.wasm'));
		const wrong = { ...manifest, files: { ...manifest.files, 'tn93.wasm': { ...manifest.files['tn93.wasm'], sha256: 'f'.repeat(64) } } };
		await fs.writeFile(join(bad, 'MANIFEST.json'), JSON.stringify(wrong));
		try {
			await expect(loadTn93Wasm({ vendorDir: bad })).rejects.toThrow(/integrity check failed/);
			// Not memoised: the second call must fail the same way rather than return a bad module.
			await expect(loadTn93Wasm({ vendorDir: bad })).rejects.toThrow(/integrity check failed/);
		} finally {
			await fs.rm(bad, { recursive: true, force: true });
		}
	});

	it('checks that the linked library honours the provider hook, rather than assuming it', () => {
		// A library without the hook ignores it silently and the run would report an engine it did
		// not use; tn93WasmOptions refuses in that case rather than mislabelling the provenance.
		expect(libraryHonoursProvider()).toBe(true);
	});

	it("runs the reference's own argv", () => {
		expect(TN93_ARGV).toEqual(['-t', '1.0', '-l', '1', '-q']);
	});
});

describe.skipIf(!ready)('the compiled engine against the library JavaScript', () => {
	let wasm;
	beforeAll(async () => {
		wasm = await tn93WasmOptions();
	}, 120000);

	for (const file of EXAMPLE_FILES) {
		it(`${file}: every matrix entry identical`, () => {
			const { names, sequences } = readFasta(file);
			const js = tn93DistanceMatrix(sequences, names);
			const compiled = tn93DistanceMatrix(sequences, names, wasm);
			expect(compiled.length).toBe(js.length);
			let differing = 0;
			let worst = 0;
			for (let i = 0; i < js.length; i++) {
				if (js[i] !== compiled[i]) {
					differing++;
					worst = Math.max(worst, Math.abs(js[i] - compiled[i]));
				}
			}
			expect({ differing, worst }).toEqual({ differing: 0, worst: 0 });
		}, 120000);
	}

	it("keeps the library's imputation: a zero distance between distinct sequences becomes 1e-4", async () => {
		// Two sequences that differ only outside any position TN93 can score (trailing gaps), so the
		// tool reports 0 for a pair whose raw strings are not equal — dataset.py:559-568's first case.
		const sequences = { a: 'ACGTACGTAC---', b: 'ACGTACGTAC--A', c: 'ACGTACGTTTGGA' };
		const names = ['a', 'b', 'c'];
		const js = tn93DistanceMatrix(sequences, names);
		const compiled = tn93DistanceMatrix(sequences, names, await tn93WasmOptions());
		expect(Array.from(compiled)).toEqual(Array.from(js));
	}, 120000);
});

describe.skipIf(!ready)('saturation', () => {
	it('refuses with the port\'s own error rather than scoring an omitted pair', async () => {
		// Four sequences with no shared history: every pair reaches the tool's 1.0 threshold, so it
		// writes nothing, and the port raises inside math.log for the same pairs.
		// The same four sequences pipeline.test.js uses for this: ATG / TTT / GGG / CCC repeated.
		const codons = ['ATG', 'TTT', 'GGG', 'CCC'];
		const sequences = Object.fromEntries(['a', 'b', 'c', 'd'].map((n, i) => [n, codons[i].repeat(7)]));
		const names = ['a', 'b', 'c', 'd'];
		expect(() => tn93DistanceMatrix(sequences, names)).toThrow(/^tn93:/);
		const module = await loadTn93Wasm();
		const provider = tn93Provider(module);
		expect(() => provider(names.map((n) => sequences[n]), names)).toThrow(/^tn93:/);
	}, 120000);
});
