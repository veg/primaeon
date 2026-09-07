/**
 * distance-matrices.mjs — how far apart ARE the two distance matrices?
 *
 * WHY THIS FILE EXISTS. Before asking what the model does with TN93 distances, this measures the
 * input itself: for every example whose tree carries branch lengths, it prepares the run both ways
 * and compares the two matrices entry by entry — medians, spread, Pearson correlation and the
 * per-pair ratio — plus the wall time of each prepare. The headline at this commit is RHO: the
 * ratio's median is 0.145, so the tree's paths are about seven times the pairwise divergence.
 *
 * USAGE: node experiments/distance-matrices.mjs
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { prepareRun } from '@veg/hyphaeon-runtime';
const ENGINE = '/Users/sweaver/Programming/_bioinformatics/HyphAeon';
const EX = join(ENGINE, 'examples');
const cases = [
  { name: 'bat_oas1', aln: 'bat_oas1.fasta', tree: 'bat_oas1.nwk' },
  { name: 'Smc6', aln: 'Smc6.fasta', tree: 'Smc6.nwk' },
  { name: 'RHO', aln: 'RHO.fasta', tree: null }
];
const pearson = (a, b) => {
  const n = a.length, ma = a.reduce((s, x) => s + x, 0) / n, mb = b.reduce((s, x) => s + x, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; num += x * y; da += x * x; db += y * y; }
  return num / Math.sqrt(da * db);
};
const maxOf = (xs) => { let m = -Infinity; for (const x of xs) if (x > m) m = x; return m; };
const quant = (xs, q) => { const s = [...xs].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
for (const c of cases) {
  const alignmentText = readFileSync(join(EX, c.aln), 'utf8');
  const treeText = c.tree ? readFileSync(join(EX, c.tree), 'utf8') : undefined;
  const common = { alignmentText, treeText, options: { maxSpecies: Infinity } };
  const t0 = performance.now();
  const withTree = await prepareRun({ ...common });
  const tTree = performance.now() - t0;
  const t1 = performance.now();
  const withTn93 = await prepareRun({ ...common, options: { maxSpecies: Infinity, useTn93: true } });
  const tTn93 = performance.now() - t1;
  const dTree = withTree.loaded.d, dTn = withTn93.loaded.d, N = withTree.loaded.N;
  if (withTree.treeSource === 'tn93') { console.log(`${c.name}: default is already tree-free, skipped`); continue; }
  const a = [], b = [], ratio = [];
  for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) {
    const x = dTree[i * N + j], y = dTn[i * N + j];
    a.push(x); b.push(y);
    if (x > 1e-9) ratio.push(y / x);
  }
  console.log(
    `${c.name} (${N} taxa, source ${withTree.treeSource} vs ${withTn93.treeSource})\n` +
    `  patristic: median ${quant(a, 0.5).toFixed(4)}  p95 ${quant(a, 0.95).toFixed(4)}  max ${maxOf(a).toFixed(4)}\n` +
    `  tn93     : median ${quant(b, 0.5).toFixed(4)}  p95 ${quant(b, 0.95).toFixed(4)}  max ${maxOf(b).toFixed(4)}\n` +
    `  pearson ${pearson(a, b).toFixed(4)}   tn93/patristic ratio: median ${quant(ratio, 0.5).toFixed(3)}, p05 ${quant(ratio, 0.05).toFixed(3)}, p95 ${quant(ratio, 0.95).toFixed(3)}\n` +
    `  prepare wall: tree ${tTree.toFixed(0)} ms, tn93 ${tTn93.toFixed(0)} ms`
  );
}
