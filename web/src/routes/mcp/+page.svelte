<!--
	+page.svelte (/mcp) — using HyphAeon from Claude: install lines, the tools, a recorded
	transcript, and the reproduction-snippet convention.

	WHY THIS FILE EXISTS. PLAN.md §4.1: "/mcp — install lines for stdio and the remote connector,
	tool list, example transcript. The MCP mirrors the product with a hyphaeon_analyze tool that
	runs everything and returns the report, alongside the per-pillar tools." §3.6 gives the two
	transports and the tool set; every analysis tool is in-process since Phase 3 (mcp/src/caps.js
	NATIVE_ANALYSES; the Python bridge is deleted, PLAN.md D16 / §8 phase 3) and the
	provenance.surface values are the ones the server writes. The transcript is data in
	./transcript.ts, recorded against the stdio server. The snippet
	convention is the one web/src/lib/results/mcpSnippet.ts implements for the report's
	"Reproduce" panel: the install line, then {tool, arguments} with file:// placeholders and the
	CLI's option names in snake_case.
-->
<script lang="ts">
	import { base } from '$app/paths';
	import { RECORDED, TRANSCRIPT } from './transcript';

	const INSTALL = 'claude mcp add hyphaeon -- npx @veg/hyphaeon-mcp';

	type Runs = 'native' | 'control';
	interface Tool {
		name: string;
		returns: string;
		runs: Runs;
		note?: string;
	}

	/** hyphaeon_analyze first (it is the product); then the per-pillar tools in report order. */
	const tools: readonly Tool[] = [
		{
			name: 'hyphaeon_analyze',
			returns:
				'The whole report: diagnostics, sites, gene, epistasis and sectors, attribution, filter, DMS (progressive, capped), phenotype when a trait is given, provenance and timings, in the schema the web report reads.',
			runs: 'native',
			note: 'The same options as the report\'s "Re-run with": model_variant, max_species, reference_sequence, call_mode, seed, permutations, dms; plus phenotype / phenotype_file for the trait, and use_tn93 (a tree is optional).'
		},
		{ name: 'hyphaeon_validate', returns: 'Diagnostics with the same warning codes as the browser, the run mode (inline or job) and a cost estimate.', runs: 'native' },
		{ name: 'hyphaeon_meme', returns: 'Per-site LRT, p, q, invariable flag and the report\'s rank columns; --filter and --attribute as options.', runs: 'native' },
		{ name: 'hyphaeon_busted', returns: 'p_ACAT, p_Simes, omnibus LRT, selection energy, significant-site counts, and the neural head\'s fields.', runs: 'native' },
		{ name: 'hyphaeon_epistasis', returns: 'Co-selection edges with CESI and q, sectors with coherence and p_perm, optional per-sector DMS, GraphML.', runs: 'native' },
		{ name: 'hyphaeon_dms', returns: '19-substitution scan per site with intrinsic plasticity and the ΔLRT map.', runs: 'native' },
		{ name: 'hyphaeon_phenotype', returns: 'Trait association per site, PARS signature, trait sectors, permulation p.', runs: 'native', note: 'The trait is a preset, a foreground list or pattern, or an inline trait table (phenotype_file); permulations need a tree with branch lengths.' },
		{ name: 'hyphaeon_evaluate', returns: 'Concordance of a meme CSV with a HyPhy MEME JSON: correlations, ROC-AUC, PPV, FPR, confusion matrices.', runs: 'native' },
		{ name: 'job_status', returns: 'Phase, progress and warnings of a queued run.', runs: 'control' },
		{ name: 'get_results', returns: 'A completed job\'s result, shaped with fields, top or summary_only.', runs: 'control' },
		{ name: 'cancel_job', returns: 'Cancels a queued or running job.', runs: 'control' },
		{ name: 'list_models', returns: 'The weights manifest and the engine\'s status.', runs: 'control' }
	];

	const RUNS_LABEL: Record<Runs, string> = {
		native: 'in-process',
		control: '—'
	};

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
	<title>MCP · HyphAeon</title>
	<meta
		name="description"
		content="Run HyphAeon from Claude: the stdio server for Claude Code, the remote connector, the tool list, a recorded transcript, and how a report is reproduced with one tool call."
	/>
</svelte:head>

<div class="container container--narrow">
	<p class="eyebrow">MCP</p>
	<h1>Use HyphAeon from Claude</h1>
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
			<strong>In-process</strong> means the JavaScript port runs inside the MCP process and the
			result matches the reference at the published parity classes. Since Phase 3 that is every
			analysis tool: the Python bridge that used to answer <code>hyphaeon_phenotype</code> is
			deleted, and no tool result carries <code>provenance.surface: "python-reference"</code>.
		</p>
		<div class="scroll">
			<table class="tools">
				<thead>
					<tr><th>Tool</th><th>Returns</th><th>Runs</th></tr>
				</thead>
				<tbody>
					{#each tools as t (t.name)}
						<tr class:tools--first={t.name === 'hyphaeon_analyze'}>
							<td><code>{t.name}</code></td>
							<td>
								{t.returns}
								{#if t.note}<span class="note">{t.note}</span>{/if}
							</td>
							<td class="runs runs--{t.runs}">{RUNS_LABEL[t.runs]}</td>
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
	.intro {
		color: var(--text-muted);
		margin-bottom: var(--space-5);
	}
	section {
		border-top: 1px solid var(--border);
		padding-top: var(--space-5);
		margin-bottom: var(--space-6);
	}
	.env {
		display: grid;
		grid-template-columns: max-content 1fr;
		gap: var(--space-1) var(--space-4);
		font-size: var(--text-sm);
		margin: 0 0 var(--space-4);
	}
	.env dd {
		margin: 0;
		color: var(--text-muted);
	}
	.scroll {
		overflow-x: auto;
		margin-bottom: var(--space-4);
	}
	.tools {
		min-width: 36rem;
		font-size: var(--text-sm);
	}
	.tools td:first-child {
		white-space: nowrap;
	}
	.tools--first td {
		background: var(--brand-soft);
	}
	.note {
		display: block;
		color: var(--text-muted);
		font-size: var(--text-xs);
		margin-top: var(--space-1);
	}
	.runs {
		white-space: nowrap;
		font-size: var(--text-xs);
		font-weight: 600;
	}
	.runs--native {
		color: var(--ok);
	}
	.runs--control {
		color: var(--text-faint);
	}
	.recorded {
		font-size: var(--text-sm);
		color: var(--text-muted);
	}
	.transcript {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: var(--space-3);
	}
	.turn {
		border-radius: var(--radius);
		padding: var(--space-3) var(--space-4);
		border: 1px solid var(--border);
		background: var(--surface);
	}
	.turn p {
		margin: 0;
	}
	.turn__who {
		display: block;
		font-size: var(--text-xs);
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--text-muted);
		margin-bottom: var(--space-1);
	}
	.turn--user {
		background: var(--bg-subtle);
	}
	.turn--assistant {
		border-color: var(--brand);
	}
	.turn--tool {
		font-size: var(--text-sm);
	}
	.turn--tool .turn__who {
		text-transform: none;
		letter-spacing: 0;
	}
	.turn--tool pre {
		margin: 0;
		font-size: var(--text-xs);
	}
	.turn--tool .args {
		margin-bottom: var(--space-2);
	}
	.turn--tool summary {
		cursor: pointer;
		font-size: var(--text-xs);
		color: var(--link);
		margin-bottom: var(--space-2);
	}
	.convention {
		font-size: var(--text-sm);
		padding-left: 1.2rem;
	}
	.convention li {
		margin-bottom: var(--space-1);
	}
</style>
