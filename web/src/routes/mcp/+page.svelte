<!--
	+page.svelte (/mcp) — using HyphAeon from Claude: install lines, the tools, a recorded
	transcript, and the reproduction-snippet convention.

	WHY THIS FILE EXISTS. PLAN.md §4.1: "/mcp — install lines for stdio and the remote connector,
	tool list, example transcript. The MCP mirrors the product with a hyphaeon_analyze tool that
	runs everything and returns the report, alongside the per-pillar tools." §3.6 gives the two
	transports and the tool set; every analysis tool is in-process since Phase 3 (mcp/src/caps.js
	NATIVE_ANALYSES; the Python bridge is deleted, PLAN.md D16 / §8 phase 3) and the
	provenance.surface values are the ones the server writes.

	WHAT IS READ AND WHAT IS WRITTEN HERE. The server's VERSION and the TOOL NAMES come from the
	mcp/ workspace at build (./+page.server.ts: mcp/package.json and mcp/src/tools.js TOOL_NAMES),
	so this page cannot quote a release the package does not ship — Phase 3 integration found it a
	release behind. The one-line descriptions are page copy in ./tools.ts, held against the names by
	./page.test.ts. The transcript is data in ./transcript.ts, recorded against the stdio server. The
	snippet convention is the one web/src/lib/results/mcpSnippet.ts implements for the report's
	"Reproduce" panel: the install line, then {tool, arguments} with file:// placeholders and the
	CLI's option names in snake_case.

	LOOK. web/DESIGN.md §3 "/mcp": h1, a metadata line, numbered h2 by CSS counter, install lines
	as <pre> on --surface-2, the tool table under the table rule with group rows in muted 700, and
	the transcript as a hairline-ruled list rather than a stack of cards.
-->
<script lang="ts">
	import { base } from '$app/paths';
	import type { PageData } from './$types';
	import { RECORDED, TRANSCRIPT } from './transcript';
	import { toolTable } from './tools';

	let { data }: { data: PageData } = $props();

	const INSTALL = 'claude mcp add hyphaeon -- npx @veg/hyphaeon-mcp';

	/** The server's tools with this page's copy, hyphaeon_analyze first (it is the product). */
	const table = $derived(toolTable(data.mcp.toolNames));
	const analysisTools = $derived(table.rows.filter((r) => r.kind === 'analysis'));
	const controlTools = $derived(table.rows.filter((r) => r.kind === 'control'));

	const analyzeSnippet = JSON.stringify(
		{
			tool: 'hyphaeon_analyze',
			arguments: {
				alignment: 'file:///path/to/Smc6.fasta',
				tree: 'file:///path/to/Smc6.nwk',
				model_variant: 'general',
				seed: 42
			}
		},
		null,
		2
	);

	function argsOf(args: Record<string, unknown>): string {
		return JSON.stringify(args, null, 2);
	}
</script>

<svelte:head>
	<title>MCP · PrimAeon</title>
	<meta
		name="description"
		content="Run HyphAeon from Claude: the stdio server for Claude Code, the remote connector, the tool list, a recorded transcript, and how a report is reproduced with one tool call."
	/>
</svelte:head>

<div class="container container--narrow mcp">
	<h1>HyphAeon from Claude</h1>
	<p class="meta">
		Model Context Protocol server · <code>@veg/hyphaeon-mcp</code> · stdio and remote
	</p>
	<p class="intro">
		The same analyses as a Model Context Protocol server. Locally it runs on your machine with the
		vendored model, reads files by path, and sends nothing anywhere; remotely it is a claude.ai
		connector on this site's origin. One tool, <code>hyphaeon_analyze</code>, does what dropping a
		file on the front page does and returns the report; the per-pillar tools are there for a
		single question.
	</p>

	<section>
		<h2>Local, over stdio</h2>
		<p>For Claude Code, one line:</p>
		<pre><code>{INSTALL}</code></pre>
		<p>Or start the server yourself and point any MCP client at its stdio:</p>
		<pre><code>npx @veg/hyphaeon-mcp</code></pre>
		<p class="version">
			Current release: <code>@veg/hyphaeon-mcp {data.mcp.version}</code>
			{#if data.mcp.source === 'workspace'}
				— read from the package at build, with the {data.mcp.toolNames.length} tools listed below.
			{:else}
				— the version the transcript below was recorded against (this page was built without the server's sources).
			{/if}
		</p>
		<p>
			The server runs the ONNX graphs under Node with <code>onnxruntime-node</code>; the model files
			ship with the package and the hash of each graph is verified before it scores. Over stdio,
			<code>alignment</code>, <code>tree</code> and the other file inputs accept a
			<code>file://</code> URL, so a transcript never carries the sequences. Results write
			<code>provenance.surface: "mcp-stdio"</code>.
		</p>
		<dl class="env">
			<dt><code>HYPHAEON_MCP_THREADS</code></dt>
			<dd>onnxruntime intra-op threads (default 1; 4 to 8 on a laptop).</dd>
			<dt><code>HYPHAEON_MODELS_DIR</code></dt>
			<dd>a directory with <code>manifest.json</code> and the graphs, to use a different build of the model.</dd>
		</dl>
		<p>
			Nothing else is needed on the host: no Python, no HyPhy. Every pillar, phenotype included,
			runs in this process, and a tree is optional — without one, or without branch lengths,
			the run takes pairwise TN93 distances (the reference's <code>--use-tn93</code>).
		</p>
	</section>

	<section>
		<h2>Remote, as a claude.ai connector</h2>
		<p>
			Add a custom connector with this site's <code>/mcp</code> endpoint. Authorization is OAuth
			2.1 with dynamic client registration, PKCE, and an out-of-band redirect for headless clients,
			auto-approved the way the Datamonkey connector is, so the ceremony completes without an
			account.
		</p>
		<pre><code>https://&lt;host&gt;/mcp</code></pre>
		<p>
			The remote server is the same code under the same caps as the Node server: your sequences
			are sent to it, it says so in the tool description, keeps nothing in logs, expires each job
			after 7 days, and refuses <code>file://</code> inputs. Results write
			<code>provenance.surface: "mcp-http"</code>. The endpoint ships with the Node server; the
			host is the deployment decision the plan records as D1.
		</p>
	</section>

	<section>
		<h2>Tools</h2>
		<p>
			Every analysis tool runs in-process: the JavaScript port runs inside the MCP
			process and the result matches the reference at the published parity classes. That has been
			true of all eight since Phase 3 — <code>hyphaeon_phenotype</code> included, which was the last
			tool to answer through a Python subprocess — so nothing here is marked "bridged" and no tool
			result carries <code>provenance.surface: "python-reference"</code>. The names below are the
			ones <code>@veg/hyphaeon-mcp {data.mcp.version}</code> registers.
		</p>
		<div class="scroll">
			<table class="tools">
				<caption><b>Tools.</b> One row per tool the server registers, <code>hyphaeon_analyze</code> first; what each returns.</caption>
				<thead>
					<tr><th>Tool</th><th>Returns</th></tr>
				</thead>
				<tbody>
					{#each analysisTools as t (t.name)}
						<tr>
							<td><code>{t.name}</code></td>
							<td>
								{t.returns}
								{#if t.note}<span class="note">{t.note}</span>{/if}
							</td>
						</tr>
					{/each}
				</tbody>
				<tbody>
					<tr class="tools__group"><th colspan="2">Job control</th></tr>
					{#each controlTools as t (t.name)}
						<tr>
							<td><code>{t.name}</code></td>
							<td>
								{t.returns}
								{#if t.note}<span class="note">{t.note}</span>{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		<p>
			Every analysis tool accepts <code>fields</code>, <code>top</code> and
			<code>summary_only</code> to shape its result, and answers inside the call when the
			alignment is at most 12,000 codons and the work term sites × taxa² is at most 2.5 × 10⁹
			(× 19 for DMS); above that, or with <code>run_async</code>, it returns a job id for
			<code>job_status</code> and <code>get_results</code>. Errors are
			<code>{'{'}error, kind, hint{'}'}</code> with <code>kind</code> either <code>input</code>
			(your alignment, tree or options) or <code>server</code> (the model files or the
			runtime).
		</p>
		<p>
			Resources: <code>hyphaeon://models</code>, <code>hyphaeon://methods/requirements</code>,
			<code>hyphaeon://caveats</code> (the same numbers as the
			<a href="{base}/methods/">methods page</a>), <code>hyphaeon://examples/&lbrace;name&rbrace;</code>,
			<code>hyphaeon://gallery</code>. Prompts: one interpretation guide per pillar, which is
			how the closing turn of the transcript below knows what to say.
		</p>
	</section>

	<section>
		<h2>Example transcript</h2>
		<p class="recorded">
			Recorded {RECORDED.date} against {RECORDED.server} over {RECORDED.transport}, on {RECORDED.dataset}.
			Tool results are abridged to what a reader needs; the numbers are the server's.
		</p>
		<ol class="transcript">
			{#each TRANSCRIPT as turn, i (i)}
				{#if turn.role === 'user'}
					<li class="turn turn--user">
						<span class="turn__who">You</span>
						<p>{turn.text}</p>
					</li>
				{:else if turn.role === 'assistant'}
					<li class="turn turn--assistant">
						<span class="turn__who">Claude</span>
						<p>{turn.text}</p>
					</li>
				{:else}
					<li class="turn turn--tool">
						<span class="turn__who"><code>{turn.tool}</code> · {turn.elapsedMs} ms</span>
						<pre class="args"><code>{argsOf(turn.args)}</code></pre>
						<details>
							<summary>Result</summary>
							<pre><code>{turn.result}</code></pre>
						</details>
					</li>
				{/if}
			{/each}
		</ol>
	</section>

	<section>
		<h2>Reproducing a report</h2>
		<p>
			Every report page and every MCP result end with the same two things: the install line
			above, and the tool call that reproduces the run. The convention is fixed so a snippet can
			be pasted into Claude Code as it stands:
		</p>
		<ul class="convention">
			<li>Files are <code>file:///path/to/&lt;name&gt;</code> placeholders carrying the file names the run had, never the sequences.</li>
			<li>Option names are the CLI's flags in snake_case (<code>model_variant</code>, <code>max_species</code>, <code>filter_p_thresh</code>, <code>n_permutations</code>); a browser run's options are mapped to them one to one, and the presentation-only ones are dropped.</li>
			<li>A run with no usable tree is <code>use_tn93: true</code> in the snippet, not a tree path: under D22 the app takes pairwise TN93 distances into the MDS, which is the reference's own <code>--use-tn93</code>.</li>
			<li>The reference command that reproduces the same run with the Python package is in <code>provenance.reference_command</code> of every result.</li>
		</ul>
		<pre><code>{INSTALL}

{analyzeSnippet}</code></pre>
	</section>
</div>

<style>
	.mcp {
		counter-reset: section;
	}
	h1 {
		margin-bottom: var(--space-1);
	}
	.meta {
		font-size: var(--text-md);
		color: var(--text-muted);
		margin: 0 0 var(--space-5);
		padding-bottom: var(--space-3);
		border-bottom: 1px solid var(--text);
		max-width: none;
	}
	.intro {
		margin-bottom: var(--space-8);
	}
	section {
		margin-bottom: var(--space-10);
	}
	section h2 {
		position: relative;
		padding: 0 0 var(--space-2) 2.5rem;
		margin-bottom: var(--space-4);
		border-bottom: 1px solid var(--rule);
	}
	section h2::before {
		counter-increment: section;
		content: counter(section);
		position: absolute;
		left: 0;
		color: var(--text-muted);
		font-weight: 400;
	}
	.env {
		display: grid;
		grid-template-columns: max-content 1fr;
		gap: var(--space-1) var(--space-4);
		font-size: var(--text-md);
		margin: 0 0 var(--space-4);
	}
	.env dd {
		margin: 0;
		color: var(--text-muted);
	}
	.scroll {
		overflow-x: auto;
		margin-bottom: var(--space-5);
	}
	.tools {
		min-width: 36rem;
	}
	.tools td:first-child {
		white-space: nowrap;
	}
	.note {
		display: block;
		color: var(--text-muted);
		font-size: var(--text-sm);
		margin-top: var(--space-1);
	}
	.tools__group th {
		text-align: left;
		font-weight: 700;
		color: var(--text-muted);
		padding-top: var(--space-4);
		border-bottom: 1px solid var(--hair);
	}
	.version {
		font-size: var(--text-md);
		color: var(--text-muted);
	}
	.recorded {
		font-size: var(--text-md);
		color: var(--text-muted);
	}
	.transcript {
		list-style: none;
		margin: 0;
		padding: 0;
		border-top: 1px solid var(--hair);
	}
	.turn {
		display: grid;
		grid-template-columns: 10rem minmax(0, 1fr);
		gap: var(--space-1) var(--space-4);
		padding: var(--space-3) 0;
		border-bottom: 1px solid var(--hair);
	}
	.turn p {
		margin: 0;
	}
	.turn__who {
		font-size: var(--text-sm);
		font-weight: 700;
		color: var(--text-muted);
		line-height: var(--leading-normal);
	}
	.turn--assistant .turn__who {
		color: var(--text);
	}
	.turn--tool {
		font-size: var(--text-md);
	}
	.turn--tool .turn__who {
		font-weight: 400;
	}
	.turn--tool .turn__who code {
		font-size: var(--text-sm);
		overflow-wrap: anywhere;
	}
	.turn--tool pre {
		margin: 0;
		font-size: var(--text-sm);
	}
	.turn--tool .args {
		margin-bottom: var(--space-2);
	}
	.turn--tool details {
		grid-column: 2;
	}
	.turn--tool summary {
		cursor: pointer;
		font-size: var(--text-sm);
		color: var(--text-muted);
		margin-bottom: var(--space-2);
	}
	.convention {
		font-size: var(--text-md);
		padding-left: 1.2rem;
		max-width: var(--measure);
	}
	.convention li {
		margin-bottom: var(--space-1);
	}
	@media (max-width: 40em) {
		.turn {
			grid-template-columns: 1fr;
		}
		.turn--tool details {
			grid-column: 1;
		}
	}
</style>
