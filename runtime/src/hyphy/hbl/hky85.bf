/* hky85.bf - fit HKY85 branch lengths to a fixed topology and print the tree with lengths.

   WHY THIS FILE EXISTS. Copied verbatim from axomeme3/index.html (the `hblScript` template
   literal inside runHyphyBranchEstimation, lines 3204-3221 of the checkout beside this
   repository), which is what the live site at data.hyphy.org/web/axomeme3 runs when a tree
   arrives without branch lengths (PLAN.md D6). The Python reference runs the same model with
   the same script (hyphaeon/dataset.py:224-287, estimate_tree_branch_lengths_hyphy); the two
   differ only in the output call: axomeme3 writes Format(T, 1, 1) to a file (internal nodes
   named "NodeN"), the reference prints Format(T, 0, 1) to stdout. This copy keeps axomeme3's.

   The two `${...}` tokens are NOT HBL: they are the placeholders of the JavaScript template
   they were copied from, kept so a diff against axomeme3 is clean. runtime/src/hyphy/index.js
   substitutes them: `${cleanTreeStr}` is the input newick with surrounding whitespace and the
   trailing ';' removed (axomeme3: inputNewickStr.trim().replace(/;$/, "")); the alignment is
   written to /temp_align.fa and the result read from /output.nwk, the paths this script names.

   `HarvestFrequencies(freqs, df, 1, 1, 1)` estimates the four nucleotide frequencies from the
   filter; `global kappa` is the transition/transversion ratio, shared across branches; `t` is
   the per-branch length parameter. The tree is unrooted by HyPhy on read, so a rooted binary
   input with n tips comes back with 2n-3 branches. Optimize() can and does return branches of
   exactly 0 (measured on examples/camelid: 73 of 421, identically under native HyPhy 2.5.65
   and this WASM 2.5.98); the reference raises those to 1e-4 afterwards
   (enforce_nonzero_branch_lengths), which the library's loadAlignmentAndTree reproduces. */

DataSet ds = ReadDataFile("/temp_align.fa");
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
Tree T = "${cleanTreeStr}";
LikelihoodFunction lf = (df, T);
Optimize(res, lf);
fprintf("/output.nwk", Format(T, 1, 1));
