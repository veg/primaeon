/* NJ.bf - neighbour-joining tree from TN93 (nucleotide) or p-distances (amino acid).

   WHY THIS FILE EXISTS. Copied verbatim (below this header) from
   datamonkey3/src/data/shared/NJ.bf at main@fac1330, the file DataMonkey 3 mounts next to its
   datareader.bf and runs for every upload to offer an NJ tree (+page.svelte:929,
   datareader.bf:207 `ExecuteAFile("./NJ.bf")`, :662-663). PLAN.md D5: no tree -> NJ in HyPhy
   WASM by default. nj_driver.bf in this directory is the caller; index.js writes both to the
   virtual file system.

   Semantics worth knowing before trusting the output (documented in runtime/src/treeSanitation.js,
   which is the place the app inspects the result):
     - ComputeDistanceFormula returns the SATURATION SENTINEL 1000 for a pair whose TN93 (or K2P
       fallback) logarithm is undefined; it is not a distance and reaches the tree.
     - the two- and three-taxon closed forms (below, "filteredData.species == 3") subtract
       distances with no Max(0, ...), so a triangle-inequality violation yields a negative
       length. For four or more taxa `distanceMatrix > methodIndex` is HyPhy's built-in
       _Matrix::NeighborJoin (hyphy src/core/matrix.cpp:1835-1836 dispatches `>` to
       NeighborJoin(!CheckEqual(arg0, 0)); the C++ likewise does not clamp.
     - `methodIndex` is never assigned by DataMonkey 3 (grep of src/data at fac1330 finds only
       this use); HyPhy reads an unassigned identifier as 0. Measured on examples/bat_oas1
       through WASM 2.5.98: unassigned, 0 and 1 produce byte-identical trees.
     - `verbFlag` is accepted and unused; TreeMatrix2TreeString(1) (lengths) is what the
       driver calls, as datareader.bf:663 does. Output is unrooted and has no trailing ';'.
   Nothing after this comment is modified. */

/* ________________________________________________________________________________________________*/

function InitializeDistancesAA (dummy)
{
	tracingVector = {20,20}["_MATRIX_ELEMENT_ROW_ == _MATRIX_ELEMENT_COLUMN_"];
	return 0;
}

/* ________________________________________________________________________________________________*/

function ComputeDistanceFormulaAA (s1,s2)
{
	GetDataInfo 		 (siteDifferenceCount, filteredData, s1, s2, DIST);
	totalSitesCompared = +siteDifferenceCount;
	totalDifference    = +(siteDifferenceCount$tracingVector);
	
	if (totalSitesCompared == 0) {
	    return 0.;
	}
	
	return totalDifference/totalSitesCompared;
}

/* ________________________________________________________________________________________________*/


function InitializeDistances (dummy)
{
	HarvestFrequencies (_dNucFreq,filteredData,1,1,0);
	_d_fR = _dNucFreq[0]+_dNucFreq[2];
	_d_fY = _dNucFreq[1]+_dNucFreq[3];
	
	if (_dNucFreq[0] == 0 || _dNucFreq[1] == 0 || _dNucFreq[2] == 0 || _dNucFreq[3] == 0)
	{
		_useK2P = 1;
	}
	else
	{
		_d_TN_K1 = 2*_dNucFreq[0]*_dNucFreq[2]/_d_fR;
		_d_TN_K2 = 2*_dNucFreq[1]*_dNucFreq[3]/_d_fY;
		_d_TN_K3 = 2*(_d_fR*_d_fY-_dNucFreq[0]*_dNucFreq[2]*_d_fY/_d_fR-_dNucFreq[1]*_dNucFreq[3]*_d_fR/_d_fY);
		_useK2P = 0;
	}
	
	
	return 0;
}

/* ________________________________________________________________________________________________*/

function ComputeDistanceFormula (s1,s2)
{
	GetDataInfo (siteDifferenceCount, filteredData, s1, s2, DIST);
	
	totalSitesCompared = +siteDifferenceCount;
	
	if (_useK2P)
	{
		_dTransitionCounts 	 =    siteDifferenceCount[0][2]+siteDifferenceCount[2][0]  /* A-G and G-A */
								 +siteDifferenceCount[1][3]+siteDifferenceCount[3][1]; /* C-T and T-C */
							
		_dTransversionCounts = (siteDifferenceCount[0][0]+siteDifferenceCount[1][1]+siteDifferenceCount[2][2]+siteDifferenceCount[3][3])+_dTransitionCounts;
		
		_dTransitionCounts	 = _dTransitionCounts/totalSitesCompared;
		_dTransversionCounts = 1-_dTransversionCounts/totalSitesCompared;
		
		_d1C = 1-2*_dTransitionCounts-_dTransversionCounts;
		_d2C = 1-2*_dTransversionCounts;
		
		if (_d1C>0 && _d2C>0)
		{
			return -(0.5*Log(_d1C)+.25*Log(_d2C));	
		}
	}
	else
	{
		_dAGCounts 	 =    siteDifferenceCount[0][2]+siteDifferenceCount[2][0]  /* A-G and G-A */;
		_dCTCounts	 = 	  siteDifferenceCount[1][3]+siteDifferenceCount[3][1]; /* C-T and T-C */
							
		_dTransversionCounts = (siteDifferenceCount[0][0]+siteDifferenceCount[1][1]+siteDifferenceCount[2][2]+
								siteDifferenceCount[3][3])+_dAGCounts+_dCTCounts;
		
		_dAGCounts	 = _dAGCounts/totalSitesCompared;
		_dCTCounts	 = _dCTCounts/totalSitesCompared;
		
		_dTransversionCounts = 1-_dTransversionCounts/totalSitesCompared;
		
		_d1C = 1-_dAGCounts/_d_TN_K1-0.5*_dTransversionCounts/_d_fR;
		_d2C = 1-_dCTCounts/_d_TN_K2-0.5*_dTransversionCounts/_d_fY;
		_d3C = 1-0.5*_dTransversionCounts/_d_fY/_d_fR;
		
		if ((_d1C>0)&&(_d2C>0)&&(_d3C>0))
		{
			return -_d_TN_K1*Log(_d1C)-_d_TN_K2*Log(_d2C)-_d_TN_K3*Log(_d3C);
		}
	}
	
	return 1000;
}

/* ________________________________________________________________________________________________*/

function TreeMatrix2TreeString (doLengths)
{
	treeString = "";
	p = 0;
	k = 0;
	m = treeNodes[0][1];
	n = treeNodes[0][0];
	d = treeString*(Rows(treeNodes)*25);

	while (m)
	{	
		if (m>p)
		{
			if (p)
			{
				d = treeString*",";
			}
			for (j=p;j<m;j=j+1)
			{
				d = treeString*"(";
			}
		}
		else
		{
			if (m<p)
			{
				for (j=m;j<p;j=j+1)
				{
					d = treeString*")";
				}
			}	
			else
			{
				d = treeString*",";
			}	
		}
		if (n<filteredData.species)
		{
			GetString (nodeName, filteredData, n);
			d = treeString*nodeName;
		}
		if (doLengths>.5)
		{
			nodeName = ":"+treeNodes[k][2];
			d = treeString*nodeName;
		}
		k=k+1;
		p=m;
		n=treeNodes[k][0];
		m=treeNodes[k][1];
	}

	for (j=m;j<p;j=j+1)
	{
		d = treeString*")";
	}
	
	d=treeString*0;
	return treeString;
}

/* ________________________________________________________________________________________________*/

function InferTreeTopology(verbFlag)
{
	distanceMatrix = {filteredData.species,filteredData.species};
	
	
	GetDataInfo (charInfo, filteredData, "CHARACTERS");
	if (Columns(charInfo) < 20)
	{
		InitializeDistances (0);	
		for (i = 0; i<filteredData.species; i=i+1)
		{
			for (j = i+1; j<filteredData.species; j = j+1)
			{
				distanceMatrix[i][j] = ComputeDistanceFormula (i,j);
			}
		}
	}
	else
	{
		InitializeDistancesAA (0);	
		for (i = 0; i<filteredData.species; i=i+1)
		{
			for (j = i+1; j<filteredData.species; j = j+1)
			{
				distanceMatrix[i][j] = ComputeDistanceFormulaAA (i,j);
			}
		}
	}
	

	MESSAGE_LOGGING 		 	= 1;
	cladesMade 					= 1;
	

	if (filteredData.species == 2)
	{
		d1 = distanceMatrix[0][1]/2;
		treeNodes = {{0,1,d1__},
					 {1,1,d1__},
					 {2,0,0}};
					 
		cladesInfo = {{2,0}};
	}
	else
	{
		if (filteredData.species == 3)
		{
			d1 = (distanceMatrix[0][1]+distanceMatrix[0][2]-distanceMatrix[1][2])/2;
			d2 = (distanceMatrix[0][1]-distanceMatrix[0][2]+distanceMatrix[1][2])/2;
			d3 = (distanceMatrix[1][2]+distanceMatrix[0][2]-distanceMatrix[0][1])/2;
			treeNodes = {{0,1,d1__},
						 {1,1,d2__},
						 {2,1,d3__}
						 {3,0,0}};
						 
			cladesInfo = {{3,0}};		
		}
		else
		{	
			njm = (distanceMatrix > methodIndex)>=filteredData.species;
				
			treeNodes 		= {2*(filteredData.species+1),3};
			cladesInfo	    = {filteredData.species-1,2};
			
			for (i=Rows(treeNodes)-1; i>=0; i=i-1)
			{
				treeNodes[i][0] = njm[i][0];
				treeNodes[i][1] = njm[i][1];
				treeNodes[i][2] = njm[i][2];
			}

			for (i=Rows(cladesInfo)-1; i>=0; i=i-1)
			{
				cladesInfo[i][0] = njm[i][3];
				cladesInfo[i][1] = njm[i][4];
			}
			
			njm = 0;
		}
	}
	distanceMatrix = 0;
	return TreeMatrix2TreeString(0);
}
