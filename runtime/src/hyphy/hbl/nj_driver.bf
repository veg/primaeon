/* nj_driver.bf - the DataMonkey 3 datareader's NJ call, cut down to the tree.

   WHY THIS FILE EXISTS. datamonkey3/src/data/datareader.bf (main@fac1330) reads an upload,
   builds a nucleotide filter and, when the caller asked for one, an NJ tree:
       :207   ExecuteAFile ("./NJ.bf");
       :649   DataSetFilter filteredData = CreateFilter (ds,1);
       :662   InferTreeTopology(1.0);
       :663   treeString = TreeMatrix2TreeString (1);
   The rest of datareader.bf (MEGA/NEXUS sniffing, genetic-code choice, partition handling,
   the JSON record) is DataMonkey's upload pipeline and is not wanted here; the four lines
   above are, verbatim except for the paths: NJ.bf is written by index.js to /NJ.bf, the
   alignment to /temp_align.fa, and the tree goes to /output.nwk instead of a JSON field.
   NJ.bf's InferTreeTopology reads the globals `filteredData` and `methodIndex`; the latter is
   left unassigned exactly as datareader.bf leaves it (see the NJ.bf header). The filter is
   nucleotide (unit 1), as DM3's, even for a codon alignment: NJ.bf switches to amino-acid
   p-distances only when the filter's alphabet has >= 20 characters. */

ExecuteAFile("/NJ.bf");
DataSet ds = ReadDataFile("/temp_align.fa");
DataSetFilter filteredData = CreateFilter(ds, 1);
InferTreeTopology(1.0);
treeString = TreeMatrix2TreeString(1);
fprintf("/output.nwk", CLEAR_FILE, treeString);
