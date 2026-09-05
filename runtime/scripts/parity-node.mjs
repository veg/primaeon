#!/usr/bin/env node
/**
 * parity-node.mjs — the `node` surface of ../HyphAeon/scripts/parity.py.
 *
 * WHY THIS FILE EXISTS. PARITY.md: "`parity.py` never produces a non-Python surface ... the app
 * repository's runner writes the files into the layout below and `parity.py` compares." This is
 * that runner for the surface `node`: `@veg/hyphaeon-js` + `runtime/` under Node with
 * onnxruntime-node, on every `examples/*.fasta` (with `examples/<name>.nwk` when it exists; RHO
 * carries its tree embedded and is run without one, exactly as parity.py does), writing
 * `parity/node/<example>.<analysis>.json` in the Python CLI's own schema through the library's
 * writers (results.js), plus a `provenance` key parity.py ignores.
 *
 * WHAT IT RUNS, mirroring parity.py's commands:
 *   meme      `hyphaeon meme -a <fasta> -t <nwk> --cpu -o ...`   -> runMeme with the CLI's defaults:
 *             NO taxon cap (cli.py:1025 `--max-species` default None -> `maxSpecies: Infinity`),
 *             duplicates pruned, no filter, no attribution.
 *   busted    `hyphaeon busted -a <fasta> -t <nwk> --cpu -o ...` -> runBusted with `--max-species`
 *             512 (cli.py:1108) and the busted head from the manifest.
 *   epistasis `hyphaeon epistasis -a <fasta> -t <nwk> --cpu --n-permutations B --seed S -o ...`
 *             -> runEpistasis with `cmd_epistasis`'s thresholds (min_sim 0.30, min_shared 2,
 *             max_fdr 0.05, min_lrt 1.0, min_cesi 2.0, min_clique_size 3, min_coherence 0.50)
 *             and the sector-site DMS the CLI runs unless `--no-dms`. It takes the REFERENCE's
 *             all-sites attention loop rather than the report's shared meme pass: the two give
 *             the same edges and sectors (runtime/test/epistasis.test.js), but a parity file
 *             should be produced the way the reference produces it.
 *   dms       `hyphaeon dms -a <fasta> -t <nwk> --cpu -o ...` -> runDms over every codon with no
 *             work budget. `parity.py` has no `dms` analysis (its ANALYSES are meme, busted,
 *             epistasis), so the file is written into the layout for a future comparator and for
 *             a by-hand diff against `hyphaeon dms -o`; only Smc6 is run by default, because
 *             19 x L forward passes on the larger examples is minutes, not seconds.
 *   phenotype `hyphaeon phenotype -a <fasta> -fg <list> --permulations 0 --n-permutations 0
 *             --seed 42 --cpu -o ...` -> runPhenotype on the meme pass's attention. `parity.py`
 *             has no `phenotype` analysis either; the file is written for the same reason, and
 *             for the by-hand comparison against
 *             fixtures/e2e/phenotype_RHO_marine_n_permutations_0.json, whose argv it reproduces.
 *             Only RHO by default. `--phenotype-fg` is the README Example 3 MARINE foreground —
 *             the explicit 11-species list the fixture pins, NOT `PRESETS.marine`'s 48 globs;
 *             `--phenotype-preset marine` runs the preset instead and will not match the fixture.
 *
 * WHERE TREE-FREE RUNS GO (PLAN.md D22, and the reason this script grew a second output
 * directory). PARITY.md's layout is `parity/<surface>/<example>.<analysis>.json`, compared field
 * by field against `parity/python/<example>.<analysis>.json` — the reference CLI run WITH the
 * example's tree. Under D22 this runtime no longer has HyPhy, so camelid and HIV1_RT (whose
 * `.nwk` files carry a topology and no branch lengths) can no longer be run the way those
 * reference files were produced: they take the tree-free TN93 path instead, which is a different
 * analysis of the same data and would show up as a wall of violations in the `node` column.
 *
 * So a run that went tree-free is written to a SUFFIXED SURFACE DIRECTORY beside the normal one:
 *
 *     <out>/<example>.<analysis>.json          the tree path (bat_oas1, Smc6, RHO)
 *     <out>-tn93/<example>.<analysis>.json     the tree-free path (camelid, HIV1_RT, and any
 *                                              input with no tree or no usable branch lengths)
 *
 * `<out>` defaults to `<engine>/parity/node`, so the second directory is `parity/node-tn93/`.
 * `parity.py` does not know that surface name (KNOWN_SURFACES is python, node, web, mcp) and will
 * not read it; its counterpart on the Python side is the `--use-tn93` fixture set,
 * `fixtures/e2e/{meme_camelid,meme_HIV1_RT,busted_Smc6,epistasis_Smc6}_tn93.json`, which
 * runtime/test/tree-free.test.js replays through the real graph. This header is the layout's
 * documentation because ../HyphAeon/PARITY.md is read-only from this repository; an integrator
 * adding a `node-tn93` surface upstream should point it at these files and at those fixtures.
 * `summary.json` records `tree_free` and the path for every run, so nothing has to be inferred
 * from the directory name.
 *
 * B AND THE STATISTICAL CLASS. `--permutations` defaults to 10,000 — `parity.py`'s own DEFAULT_B,
 * which is both what it passes to `hyphaeon epistasis --n-permutations` and the B its bound
 * `|dp| <= 3*sqrt(p(1-p)/B)` is computed with. Writing this surface at B = 1,000 against a
 * reference at B = 10,000 would fail that bound by construction (PHASE2A.md measures +/-0.03 of
 * Monte Carlo error per side at B = 1,000), so a smaller B here must be matched by
 * `parity.py --n-permutations`.
 *
 * BRANCH LENGTHS. examples/camelid.nwk and examples/HIV1_RT.nwk have no branch lengths. Phase 2
 * fitted them with HyPhy WASM here; Phase 3 deleted HyPhy from the repository (D22), so those two
 * examples now take the TN93 path and land in `<out>-tn93/` as described above. Nothing in this
 * script estimates branch lengths any more, and there is no `--no-hyphy` flag to turn off.
 *
 * Usage:
 *   node scripts/parity-node.mjs [--examples Smc6,bat_oas1] [--analyses meme,busted,epistasis]
 *        [--variant general] [--threads N] [--engine ../HyphAeon] [--out <engine>/parity/node]
 *        [--busted-examples Smc6,HIV1_RT] [--dms-examples Smc6] [--phenotype-examples RHO]
 *        [--phenotype-fg <list>] [--phenotype-preset marine] [--permulations 0]
 *        [--permutations 10000] [--seed 42]
 * Then, from the engine repository:
 *   python scripts/parity.py --examples Smc6,bat_oas1,RHO --surfaces python,node
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, basename } from 'node:path';
import { availableParallelism } from 'node:os';

import { createSession } from '../src/createSession.js';
import { runMeme, prepareRun } from '../src/pipeline.js';
import { runBusted } from '../src/busted.js';
import { runEpistasis } from '../src/epistasis.js';
import { runDms } from '../src/dms.js';
import { runPhenotype } from '../src/phenotype.js';
import { inferSites } from '../src/predict.js';
import { memeJsonText, bustedJsonText } from '../src/results.js';
import { epistasisJsonText, dmsJsonText, phenotypeJsonText } from '../src/report.js';

const HERE = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
	const args = {
		examples: 'all',
		analyses: 'meme,busted,epistasis',
		variant: 'general',
		threads: null,
		engine: null,
		out: null,
		bustedExamples: 'Smc6,HIV1_RT',
		dmsExamples: 'Smc6',
		phenotypeExamples: 'RHO',
		// The README Example 3 marine foreground, verbatim from the fixture's argv
		// (fixtures/e2e/phenotype_RHO_marine_n_permutations_0.json).
		phenotypeFg: 'turTru,balMus,balPhys,orcOrc,delDelp,phyCat,phoVit,halGryp,mirLeo,zalCali,odoRos',
		phenotypePreset: null,
		permulations: 0,
		permutations: 10000,
		seed: 42
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const next = () => argv[++i];
		if (a === '--examples') args.examples = next();
		else if (a === '--analyses') args.analyses = next();
		else if (a === '--variant') args.variant = next();
		else if (a === '--threads') args.threads = Number(next());
		else if (a === '--engine') args.engine = next();
		else if (a === '--out') args.out = next();
		else if (a === '--busted-examples') args.bustedExamples = next();
		else if (a === '--dms-examples') args.dmsExamples = next();
		else if (a === '--phenotype-examples') args.phenotypeExamples = next();
		else if (a === '--phenotype-fg' || a === '--phenotype-foreground') args.phenotypeFg = next();
		else if (a === '--phenotype-preset') args.phenotypePreset = next();
		else if (a === '--permulations') args.permulations = Number(next());
		else if (a === '--permutations' || a === '--n-permutations') args.permutations = Number(next());
		else if (a === '--seed') args.seed = Number(next());
		else if (a === '--help' || a === '-h') {
			console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]);
			process.exit(0);
		} else throw new Error(`unknown argument ${a}`);
	}
	return args;
}

function discoverExamples(examplesDir) {
	const out = {};
	for (const f of readdirSync(examplesDir).sort()) {
		if (!f.endsWith('.fasta')) continue;
		const name = basename(f, '.fasta');
		const nwk = join(examplesDir, `${name}.nwk`);
		out[name] = { alignment: join(examplesDir, f), tree: existsSync(nwk) ? nwk : null };
	}
	return out;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const engine = resolve(args.engine ?? join(HERE, '..', '..', '..', 'HyphAeon'));
	const outDir = resolve(args.out ?? join(engine, 'parity', 'node'));
	const modelsBase = join(engine, 'models');
	const examples = discoverExamples(join(engine, 'examples'));
	const wanted = args.examples === 'all' ? Object.keys(examples) : args.examples.split(',').map((s) => s.trim()).filter(Boolean);
	for (const ex of wanted) if (!examples[ex]) throw new Error(`unknown example ${ex} (have ${Object.keys(examples).join(', ')})`);
	const analyses = args.analyses.split(',').map((s) => s.trim()).filter(Boolean);
	const bustedExamples = new Set(args.bustedExamples === 'all' ? wanted : args.bustedExamples.split(',').map((s) => s.trim()));
	const dmsExamples = new Set(args.dmsExamples === 'all' ? wanted : args.dmsExamples.split(',').map((s) => s.trim()).filter(Boolean));
	const phenotypeExamples = new Set(args.phenotypeExamples === 'all' ? wanted : args.phenotypeExamples.split(',').map((s) => s.trim()).filter(Boolean));
	const threads = args.threads ?? Math.max(1, Math.min(8, Math.floor(availableParallelism() / 2)));
	// PLAN.md D22: a run that went tree-free is a different analysis from the reference file
	// parity.py holds, so it goes to the suffixed surface directory (see the header).
	const treeFreeDir = `${outDir}-tn93`;
	mkdirSync(outDir, { recursive: true });

	const t0 = Date.now();
	const s = await createSession({ modelsBase, variant: args.variant, threads, bustedHead: analyses.includes('busted') });
	console.log(`[parity-node] ${s.variant.name} ${s.backbone.sha256.slice(0, 12)} (${s.backbone.bytes} bytes), head ${s.head ? s.head.sha256.slice(0, 12) : 'none'}, ${threads} thread(s), library ${s.libraryVersion}, ${Date.now() - t0} ms`);
	console.log('[parity-node] tree policy: PLAN.md D22 — a tree with branch lengths is used as is; anything else takes TN93 distances (nothing here estimates branch lengths)');

	const summary = {
		generated_at: new Date().toISOString(),
		surface: 'node',
		tree_free_surface: 'node-tn93',
		tree_free_dir: treeFreeDir,
		variant: s.variant.name,
		artifact_sha256: s.backbone.sha256,
		threads,
		tree_policy: 'D22: user tree with branch lengths used as is; no tree or no usable branch lengths -> TN93 (tree-free)',
		n_permutations: args.permutations,
		permulations: args.permulations,
		seed: args.seed,
		runs: []
	};
	let failed = 0;
	for (const ex of wanted) {
		const spec = examples[ex];
		const alignmentText = readFileSync(spec.alignment, 'utf8');
		const treeText = spec.tree ? readFileSync(spec.tree, 'utf8') : null;
		for (const analysis of analyses) {
			if (analysis === 'busted' && !bustedExamples.has(ex)) continue;
			if (analysis === 'dms' && !dmsExamples.has(ex)) continue;
			if (analysis === 'phenotype' && !phenotypeExamples.has(ex)) continue;
			if (!['meme', 'busted', 'epistasis', 'dms', 'phenotype'].includes(analysis)) {
				console.log(`[parity-node] ${ex} ${analysis}: not implemented on this surface`);
				continue;
			}
			// The destination is decided AFTER the run, from what the tree policy actually did.
			const run = { example: ex, analysis, path: null, tree_free: null, status: 'ok', seconds: null, notes: [] };
			const tStart = Date.now();
			// One line per finished phase (the output is usually piped; no carriage-return games).
			const progress = (phase, done, total, message) => {
				if (done === total && total > 0) console.log(`[parity-node] ${ex} ${analysis}: ${phase} ${message ?? ''}`);
			};
			try {
				const common = {
					alignmentText,
					treeText,
					session: s.backbone,
					surface: 'node-server',
					progress,
					options: {
						alignmentName: `${ex}.fasta`,
						treeName: spec.tree ? `${ex}.nwk` : undefined,
						diagnose: false,
						// The display-only NJ tree is a UI decoration; a parity file does not need it
						// and on RHO (655 taxa) it is a second O(N^3) pass for nothing.
						displayTree: false
					}
				};
				let text;
				let result;
				let pp;
				if (analysis === 'meme') {
					result = await runMeme({ ...common, options: { ...common.options, maxSpecies: Infinity } });
					text = memeJsonText(result);
					pp = result.provenance.preprocessing;
				} else if (analysis === 'busted') {
					result = await runBusted({ ...common, head: s.head, options: { ...common.options, maxSpecies: 512, gene: ex } });
					text = bustedJsonText(result);
					pp = result.provenance.preprocessing;
				} else {
					// epistasis / dms: `run_epistatic_analysis` and `run_digital_dms_analysis` both call
					// `load_alignment_and_tree(prune_duplicates=True)` with NO max_species
					// (epistasis.py:660-663, 742-745), so the front half runs once with no cap.
					const prep = await prepareRun({
						alignmentText,
						treeText,
						options: { ...common.options, maxSpecies: Infinity },
						progress,
						defaultMaxSpecies: null
					});
					pp = {
						taxa_in_alignment: prep.preprocessing.taxa_in_alignment,
						taxa_used: prep.loaded.N,
						branch_lengths_missing: prep.preprocessing.branch_lengths_missing,
						tree_source: prep.treeSource,
						tree_free: prep.preprocessing.tree_free
					};
					const inputs = { alignment: `examples/${ex}.fasta`, tree: spec.tree ? `examples/${ex}.nwk` : null };
					if (analysis === 'phenotype') {
						// cmd_phenotype's own shape: the attention pass, then the association. The
						// fixture's argv is `-fg <list> --permulations 0 --n-permutations 0 --seed 42`.
						const inference = await inferSites(prep.loaded, s.backbone, { outputs: ['lrt', 'mean_root_attns'] });
						const trait = args.phenotypePreset ? { preset: args.phenotypePreset } : { foreground: args.phenotypeFg };
						result = await runPhenotype({
							prepared: prep,
							attention: inference.mean_root_attns,
							lrt: inference.lrt,
							phenotype: trait,
							options: {
								permulations: args.permulations,
								nPermutations: args.permutations,
								seed: args.seed
							},
							// The CLI writes the PATHS it was given: RHO is run without -t, so `tree` is
							// null in the fixture even though the alignment carries a tree.
							inputs: { alignment: `${ex}.fasta`, tree: spec.tree ? `${ex}.nwk` : null },
							progress
						});
						text = phenotypeJsonText(result);
						run.notes.push(
							`trait: ${args.phenotypePreset ? `preset ${args.phenotypePreset}` : 'inline foreground'}; ` +
								`permulations ${result.permulations.requested} (ran ${result.permulations.ran}` +
								`${result.permulations.reason ? `, ${result.permulations.reason}` : ''}), ` +
								`sector B = ${args.permutations}, seed ${args.seed}`
						);
						run.notes.push('parity.py has no phenotype comparator yet; compare by hand with fixtures/e2e/phenotype_RHO_marine_n_permutations_0.json');
						run.sites = result.sites.length;
						run.sectors = result.trait_sectors_count;
					} else if (analysis === 'epistasis') {
						result = await runEpistasis({
							loaded: prep.loaded,
							session: s.backbone,
							options: { nPermutations: args.permutations, seed: args.seed, dms: true },
							inputs,
							progress
						});
						text = epistasisJsonText(result);
						run.notes.push(`B = ${args.permutations}, seed ${args.seed}; p_perm and the null moments are statistical (PARITY.md)`);
						run.edges = result.edges.length;
						run.sectors = result.sectors.length;
					} else {
						result = await runDms({
							loaded: prep.loaded,
							session: s.backbone,
							options: { workBudget: Infinity },
							inputs,
							progress
						});
						text = dmsJsonText(result);
						run.notes.push('parity.py has no dms comparator yet; written for the layout');
						run.mutants = result.total_mutations;
					}
				}
				run.tree_free = pp.tree_free ?? null;
				if (run.tree_free) {
					run.notes.push(
						`TREE-FREE (D22, reason ${run.tree_free.reason}): TN93 distances, so this is NOT the analysis ` +
							`parity/python/${ex}.${analysis}.json holds. Written to ${basename(treeFreeDir)}/; compare with ` +
							'the CLI\'s own --use-tn93 fixtures.'
					);
				}
				if (pp.taxa_used > 500 && analysis !== 'busted') run.notes.push(`N = ${pp.taxa_used} > 500: the reference uses Lanczos MDS (dataset.py:360-381), the library runs dense`);
				if (analysis === 'busted' && s.head) run.notes.push('neural head fields come from busted_head.onnx (one seeded draw); the reference draws them unseeded, so they are expected to differ');
				const destDir = run.tree_free ? treeFreeDir : outDir;
				mkdirSync(destDir, { recursive: true });
				run.path = join(destDir, `${ex}.${analysis}.json`);
				writeFileSync(run.path, text);
				if (run.tree_free) {
					// A file left in <out>/ by a pre-D22 run of this script is the HyPhy-fitted analysis
					// this surface no longer produces. Leaving it there would let parity.py compare a
					// stale file and report a pass or a failure for a run that did not happen.
					const stale = join(outDir, `${ex}.${analysis}.json`);
					if (existsSync(stale)) {
						rmSync(stale);
						run.notes.push(`removed the stale ${basename(outDir)}/${ex}.${analysis}.json from a pre-D22 run`);
					}
				}
				run.seconds = (Date.now() - tStart) / 1000;
				run.taxa = pp.taxa_used;
				run.codons = analysis === 'busted' ? result.record.sites : result.codon_count;
				console.log(`[parity-node] ${ex.padEnd(10)} ${analysis.padEnd(9)} ok (${run.seconds.toFixed(1)} s, ${run.taxa} taxa, ${run.codons} codons)${run.notes.length ? ' -- ' + run.notes.join('; ') : ''}`);
			} catch (err) {
				run.status = 'failed';
				run.error = err?.stack ?? String(err);
				run.seconds = (Date.now() - tStart) / 1000;
				failed++;
				console.log(`[parity-node] ${ex.padEnd(10)} ${analysis.padEnd(9)} FAILED: ${err?.message ?? err}`);
			}
			summary.runs.push(run);
		}
	}
	writeFileSync(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
	const treeFreeRuns = summary.runs.filter((r) => r.tree_free);
	if (treeFreeRuns.length > 0) {
		writeFileSync(join(treeFreeDir, 'summary.json'), JSON.stringify({ ...summary, runs: treeFreeRuns }, null, 2) + '\n');
		console.log(`[parity-node] ${treeFreeRuns.length} tree-free file(s) in ${treeFreeDir} (${[...new Set(treeFreeRuns.map((r) => r.example))].join(', ')}) — compare with fixtures/e2e/*_tn93.json, NOT with parity/python`);
	}
	console.log(`[parity-node] wrote ${summary.runs.length} file(s) to ${outDir}; ${failed} failed. Next: cd ${engine} && python scripts/parity.py --no-run --surfaces python,node --examples ${wanted.join(',')}`);
	// Release the native sessions BEFORE the process ends: with intra-op threads > 1,
	// onnxruntime-node 1.23.2 aborts at exit ("mutex lock failed: Invalid argument" from libc++abi)
	// when a session is still alive on the thread pool, and `process.exit()` skips the release.
	await Promise.all([s.backbone, s.head].filter(Boolean).map((h) => h.session.release?.()));
	process.exitCode = failed ? 1 : 0;
}

main().catch((err) => {
	console.error(err);
	process.exit(2);
});
