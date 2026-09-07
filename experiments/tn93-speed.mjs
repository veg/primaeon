/**
 * tn93-speed.mjs — what does the library's TN93 matrix cost in JavaScript?
 *
 * WHY THIS FILE EXISTS. The question behind "replace the tree with TN93" is partly whether the app
 * would need a WebAssembly build of veg/tn93. This times `tn93DistanceMatrix` from
 * @veg/hyphaeon-js, which mirrors the tn93 1.2.2 package bit for bit, against the native binary on
 * the same alignments. Measured here (tn93 1.0.15 native, darwin/x64 Node 22): HIV1_RT, the
 * largest FASTA at 476 sequences x 1005 nt, is 821 ms in JavaScript against 240 ms native, and
 * every smaller example is under 60 ms. Both are noise beside the model pass, which is seconds.
 *
 * USAGE: node experiments/tn93-speed.mjs
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { tn93DistanceMatrix } from '@veg/hyphaeon-js';
const EX = '/Users/sweaver/Programming/_bioinformatics/HyphAeon/examples';
function readFasta(file) {
  const names = [], seqs = [];
  let cur = null;
  for (const line of readFileSync(join(EX, file), 'utf8').split('\n')) {
    if (line.startsWith('>')) { names.push(line.slice(1).trim()); seqs.push(cur = []); }
    else if (cur && line.trim()) cur.push(line.trim());
  }
  const sequences = {};
  names.forEach((n, i) => { sequences[n] = seqs[i].join(''); });
  return { names, sequences };
}
for (const file of ['bat_oas1.fasta', 'Smc6.fasta', 'camelid.fasta', 'HIV1_RT.fasta']) {
  const { names, sequences } = readFasta(file);
  if (!names.length) { console.log(`${file}: not FASTA, skipped`); continue; }
  const t0 = performance.now();
  const d = tn93DistanceMatrix(sequences, names);
  const ms = performance.now() - t0;
  const pairs = (names.length * (names.length - 1)) / 2;
  console.log(
    `${file.padEnd(16)} ${String(names.length).padStart(4)} seqs x ${String(sequences[names[0]].length).padStart(5)} nt  ` +
    `JS TN93 ${ms.toFixed(0).padStart(6)} ms  (${pairs} pairs, ${(ms * 1000 / pairs).toFixed(1)} us/pair)`
  );
}
