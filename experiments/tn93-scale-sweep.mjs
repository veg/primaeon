/**
 * tn93-scale-sweep.mjs — is TN93's deficit at depth a SCALE effect?
 *
 * WHY THIS FILE EXISTS. On RHO (655 taxa) the model calls 25 sites from the tree's patristic
 * distances and 18 from TN93 (experiments/tn93-vs-patristic.mjs). The two matrices are strongly
 * correlated (Pearson 0.77) but TN93's median pair is 0.099 against the tree's 0.681 — pairwise
 * divergence saturates where a path through a fitted tree keeps accumulating. This sweep asks
 * whether the model simply reads magnitude as evidence: it multiplies the TN93 matrix by k,
 * recomputes the MDS from the scaled matrix (the model takes both), and re-scores.
 *
 * Result at this commit: 18 calls at k=1, 19 at k=4, 20 at k=6.9 (the median patristic/TN93 ratio),
 * 24 of 25 shared at k=10, and 42 calls at k=20 — the model over-calls once the distances exceed
 * the tree's. So the deficit IS a scale effect, and the correction is not a constant: k is a
 * property of the alignment's depth and rate heterogeneity, which is what the tree was measuring.
 *
 * USAGE: node experiments/tn93-scale-sweep.mjs   (HYPHAEON_ENGINE_DIR, default ../HyphAeon)
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createSession, prepareRun, inferSites } from '@veg/hyphaeon-runtime';
import { releaseSessions } from '@veg/hyphaeon-runtime/node';
import { computeMdsCoordinates, memeSitePq } from '@veg/hyphaeon-js';
const ENGINE = '/Users/sweaver/Programming/_bioinformatics/HyphAeon';
const alignmentText = readFileSync(join(ENGINE, 'examples', 'RHO.fasta'), 'utf8');
const s = await createSession({ modelsBase: join(ENGINE, 'models'), runtime: 'node', variant: 'general', threads: 4 });
const opts = { maxSpecies: Infinity };
const prepTree = await prepareRun({ alignmentText, options: opts });
const prepTn = await prepareRun({ alignmentText, options: { ...opts, useTn93: true } });
const score = async (loaded, label) => {
  const inf = await inferSites(loaded, s.backbone, { outputs: ['lrt'] });
  const { pvals } = memeSitePq(inf.lrt);
  const variable = Array.from(loaded.invariable, (v) => !v);
  const calls = pvals.reduce((n, p, i) => n + (variable[i] && p <= 0.05 ? 1 : 0), 0);
  return { label, lrt: inf.lrt, pvals, variable, calls };
};
const base = await score(prepTree.loaded, 'patristic');
const ranks = (xs) => { const o = xs.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]); const r = new Array(xs.length);
  for (let i = 0; i < o.length;) { let j = i; while (j + 1 < o.length && o[j+1][0] === o[i][0]) j++;
    const rk = (i + j) / 2 + 1; for (let k = i; k <= j; k++) r[o[k][1]] = rk; i = j + 1; } return r; };
const spearman = (a, b) => { const ra = ranks(a), rb = ranks(b), n = a.length, m = (v) => v.reduce((s, x) => s + x, 0) / n;
  const ma = m(ra), mb = m(rb); let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { const x = ra[i] - ma, y = rb[i] - mb; num += x * y; da += x * x; db += y * y; }
  return num / Math.sqrt(da * db); };
console.log(`patristic baseline: ${base.calls} sites at p <= 0.05`);
for (const k of [1, 2, 4, 6.9, 10, 20]) {
  const N = prepTn.loaded.N;
  const d = Float32Array.from(prepTn.loaded.d, (x) => x * k);
  const z = computeMdsCoordinates(d, N, 4);
  const got = await score({ ...prepTn.loaded, d, z }, `tn93 x ${k}`);
  const idx = [];
  for (let i = 0; i < got.lrt.length; i++) if (got.variable[i] && base.variable[i]) idx.push(i);
  const rho = spearman(idx.map((i) => got.lrt[i]), idx.map((i) => base.lrt[i]));
  const shared = idx.filter((i) => got.pvals[i] <= 0.05 && base.pvals[i] <= 0.05).length;
  console.log(
    `tn93 x ${String(k).padStart(4)}: ${String(got.calls).padStart(3)} calls  ` +
    `rho vs patristic ${rho.toFixed(4)}  shared calls ${shared}/${base.calls}`
  );
}
await releaseSessions();
