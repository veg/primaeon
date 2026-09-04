<!--
	+page.svelte (/) — the landing page.

	WHY THIS FILE EXISTS. PLAN.md §4.1: "What HyphAeon is in three sentences, the surrogate caveat,
	'your sequences stay in this browser', demo buttons, links to paper, package, MCP." The caveat
	is not decoration: PLAN.md §2.1–2.2 record that HyphAeon is a MEME surrogate evaluated against
	MEME, that rank is strong and scale is compressed (HIV-1 RT: ρ = 0.53, regression slope 0.16;
	literature aggregate ROC-AUC 0.914), so the page says so before anyone runs anything.

	DELIVERY. This route must request nothing beyond its own HTML, CSS, JS and favicon: no model,
	no ORT WASM, no fonts from a CDN (PLAN.md §4.4). ../../e2e/smoke.spec.ts asserts it.
-->
<script lang="ts">
	import { base } from '$app/paths';
</script>

<svelte:head>
	<title>HyphAeon</title>
	<meta
		name="description"
		content="HyphAeon predicts per-site episodic diversifying selection, epistatic sectors, digital deep mutational scans and phenotype associations from a codon alignment and a tree, entirely in your browser."
	/>
</svelte:head>

<section class="hero container">
	<p class="eyebrow">Phylogenetic deep learning, in your browser</p>
	<h1>HyphAeon</h1>
	<p class="lede">
		HyphAeon is a 1.9-million-parameter axial transformer that reads a codon alignment and its
		phylogenetic tree and predicts, for every site, the likelihood-ratio statistic that HyPhy's MEME
		would report for episodic diversifying selection. On that per-site score it builds a gene-level
		omnibus test, a co-evolution network with epistatic sectors, a digital deep mutational scan, and
		a phenotype–genotype association map. It runs here through ONNX Runtime, in seconds, on the same
		JavaScript methods that the MCP server and the Node worker use.
	</p>
	<div class="actions">
		<a class="button" href="{base}/gallery/">Try a bundled example</a>
		<a class="button button--secondary" href="{base}/analyze/">Analyze your alignment</a>
	</div>
</section>

<section class="container grid">
	<article class="card card--caveat">
		<h2>A surrogate for MEME, not a replacement</h2>
		<p>
			HyphAeon is evaluated against MEME, not against truth. Its site ranking is strong (ROC-AUC 0.91
			across the literature benchmark) but its scale is compressed (regression slope 0.16 on HIV-1
			RT), and its false-positive rate depends on the regime: about 5–7% for 20–50 taxa, far higher
			on deep trees with 100 or more taxa. Sort by LRT, read rank and percentile, treat p and q as
			one view among several, and confirm anything you intend to publish with MEME on Datamonkey.
			Every result carries <code>is_surrogate</code> and a link to do exactly that.
		</p>
	</article>

	<article class="card card--privacy">
		<h2>Your sequences stay in this browser</h2>
		<p>
			Parsing, tree handling, distance and MDS embedding, inference and every downstream test run in
			Web Workers on your machine. Nothing is uploaded. A server run is offered only when an input
			exceeds the browser caps, and it says what would be sent before sending it.
		</p>
	</article>
</section>

<section class="container links">
	<h2>Paper, package, MCP</h2>
	<ul>
		<li>
			<strong>Paper.</strong> Manuscript in preparation; the methods page summarises each analysis
			and its measured behaviour. <a href="{base}/methods/">Read the methods</a>.
		</li>
		<li>
			<strong>Package.</strong> The methods are one JavaScript library, <code>@veg/hyphaeon-js</code>,
			ported from and checked against the Python reference in
			<a href="https://github.com/veg/HyphAeon">veg/HyphAeon</a>. The model weights are on
			<a href="https://huggingface.co/datamonkey/hyphaeon">Hugging Face</a>.
		</li>
		<li>
			<strong>MCP.</strong> The same analyses are available to Claude Code and to claude.ai as an
			MCP server, locally over stdio or remotely over HTTP. <a href="{base}/mcp/">Set it up</a>.
		</li>
	</ul>
</section>

<style>
	.hero {
		max-width: var(--container-narrow);
		margin-bottom: var(--space-8);
	}
	.lede {
		font-size: var(--text-lg);
		color: var(--text-muted);
		margin-bottom: var(--space-5);
	}
	.actions {
		display: flex;
		gap: var(--space-3);
		flex-wrap: wrap;
	}

	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(18rem, 1fr));
		gap: var(--space-4);
		margin-bottom: var(--space-8);
	}
	.card {
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
		padding: var(--space-5);
		background: var(--surface);
		box-shadow: var(--shadow);
	}
	.card p:last-child {
		margin-bottom: 0;
	}
	.card--caveat {
		border-top: 4px solid var(--accent);
	}
	.card--privacy {
		border-top: 4px solid var(--brand);
	}

	.links {
		max-width: var(--container-narrow);
	}
	.links ul {
		padding-left: 1.2rem;
		margin: 0;
	}
	.links li {
		margin-bottom: var(--space-3);
	}
</style>
