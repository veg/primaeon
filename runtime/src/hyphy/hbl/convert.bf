/* convert.bf - read any alignment format HyPhy understands and write it back as FASTA.

   WHY THIS FILE EXISTS. Copied verbatim from axomeme3/index.html (the `hblScript` template
   literal inside convertAlignmentToFastaUsingHyphy, lines 3262-3267), the fallback axomeme3
   uses when its own FASTA parser fails on an upload (PLAN.md section 4.2, "HyPhy WASM
   auto-conversion fallback"). DataMonkey 3 does the same in datareader.bf:648-659 with the
   same DATA_FILE_PRINT_FORMAT = 9, which is "FASTA sequential" in HyPhy's ConvertDataFile.bf.

   `${inputPath}` is the placeholder of the JavaScript template this was copied from, kept for
   a clean diff; runtime/src/hyphy/index.js substitutes `/input_align.<ext>` where <ext> is the
   lower-cased extension of the uploaded file name, or "phy" when there is none (axomeme3's
   rule: HyPhy's ReadDataFile sniffs the content, but the extension helps it choose between
   the PHYLIP variants). The result is read from /output_align.fa.

   Measured on a NEXUS DATA block of examples/bat_oas1 through HyPhy WASM 2.5.98: sequences
   come back byte-identical, sequence NAMES come back upper-cased (HyPhy's NEXUS reader folds
   case even with NORMALIZE_SEQUENCE_NAMES=0); sequential PHYLIP (name on its own line) comes
   back identical in both. The library's three-tier taxon matching (exact, quote-stripped,
   case-insensitive) absorbs the NEXUS case fold when the tree still has the original names. */

DATA_FILE_PRINT_FORMAT = 9;
DataSet ds = ReadDataFile("${inputPath}");
DataSetFilter dsf = CreateFilter(ds, 1);
fprintf("/output_align.fa", CLEAR_FILE, dsf);
