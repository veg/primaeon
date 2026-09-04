<!--
	+page.svelte (/mcp) — how to use HyphAeon from Claude, skeleton.

	WHY THIS FILE EXISTS. PLAN.md §4.1: "/mcp — install lines for stdio and the remote connector,
	tool list, example transcript." Install lines and the tool list come from PLAN.md §3.6. The
	remote host is decision D1 and is shown as a placeholder until it is made; the transcript is
	recorded once the stdio server answers.
-->
<script lang="ts">
	const tools = [
		['hyphaeon_validate', 'Diagnostics for an alignment and tree; same warning codes as the browser.'],
		['hyphaeon_meme', 'Per-site selection. Answers inline under the caps, otherwise returns a job id.'],
		['hyphaeon_busted', 'Gene-level omnibus test.'],
		['hyphaeon_epistasis', 'Co-selection network and sectors.'],
		['hyphaeon_dms', 'Digital deep mutational scan.'],
		['hyphaeon_phenotype', 'Trait association.'],
		['hyphaeon_evaluate', 'Concordance against HyPhy MEME JSON.'],
		['job_status', 'Progress and warnings for a queued job.'],
		['get_results', 'Result JSON with fields, top and summary_only selectors.'],
		['cancel_job', 'Cancel a queued job.'],
		['list_models', 'The weights manifest: variants, hashes, caps.']
	];
</script>

<svelte:head>
	<title>MCP · HyphAeon</title>
</svelte:head>

<div class="container container--narrow">
	<p class="eyebrow">MCP</p>
	<h1>Use HyphAeon from Claude</h1>
	<p class="intro">
		The same analyses, as a Model Context Protocol server. Locally it runs on your machine with the
		vendored model and nothing leaves it; remotely it is a claude.ai connector on this site's origin.
	</p>

	<section>
		<h2>Local, over stdio</h2>
		<p>For Claude Code:</p>
		<pre><code>claude mcp add hyphaeon -- npx @veg/hyphaeon-mcp</code></pre>
		<p>Or start the server yourself and point any MCP client at its stdio:</p>
		<pre><code>npx @veg/hyphaeon-mcp</code></pre>
		<p class="todo">
			<code>@veg/hyphaeon-mcp</code> is published with the first tagged release (Phase 1). Until then
			run it from a checkout of <code>veg/hyphaeon-app</code>.
		</p>
	</section>

	<section>
		<h2>Remote, as a claude.ai connector</h2>
		<p>
			Add a custom connector with the URL below. Authorization uses OAuth 2.1 with dynamic client
			registration and PKCE, auto-approved the way Datamonkey's connector is.
		</p>
		<pre><code>https://&lt;host&gt;/mcp</code></pre>
		<p class="todo">The host is decision D1 in the plan; the endpoint ships with the Node server in Phase 2.</p>
	</section>

	<section>
		<h2>Tools</h2>
		<table>
			<thead>
				<tr><th>Tool</th><th>Purpose</th></tr>
			</thead>
			<tbody>
				{#each tools as [name, purpose] (name)}
					<tr>
						<td><code>{name}</code></td>
						<td>{purpose}</td>
					</tr>
				{/each}
			</tbody>
		</table>
		<p>
			Resources: <code>hyphaeon://models</code>, <code>hyphaeon://methods/requirements</code>,
			<code>hyphaeon://caveats</code>, <code>hyphaeon://examples/&lbrace;name&rbrace;</code>. One
			interpretation prompt per pillar.
		</p>
	</section>

	<section>
		<h2>Example transcript</h2>
		<p class="todo">To be recorded against the stdio server on the Smc6 example.</p>
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
	.todo {
		font-size: var(--text-sm);
		color: var(--text-faint);
		font-style: italic;
	}
	table {
		margin-bottom: var(--space-4);
	}
</style>
