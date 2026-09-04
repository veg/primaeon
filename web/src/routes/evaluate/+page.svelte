<!--
	+page.svelte (/evaluate) — skeleton for MEME concordance.

	WHY THIS FILE EXISTS. PLAN.md §4.1: "/evaluate — meme CSV + HyPhy MEME JSON → metrics +
	scatter." The evaluate port (PLAN.md §5.2 order 3) runs without the model, so this page needs
	only the library; until it lands the inputs are shown disabled and the result panels are named.
-->
<svelte:head>
	<title>Evaluate · HyphAeon</title>
</svelte:head>

<div class="container container--narrow">
	<p class="eyebrow">Evaluate</p>
	<h1>Compare a run against HyPhy MEME</h1>
	<p class="intro">
		Load a HyphAeon site-selection CSV and the MEME JSON for the same alignment. Sites are matched
		by position, pooled across genes when several pairs are given, and scored the way
		<code>hyphaeon evaluate</code> scores them.
	</p>

	<form class="card" onsubmit={(e) => e.preventDefault()}>
		<label class="field">
			<span>HyphAeon results (CSV)</span>
			<input type="file" accept=".csv" disabled />
		</label>
		<label class="field">
			<span>HyPhy MEME results (JSON)</span>
			<input type="file" accept=".json" disabled />
		</label>
		<div class="run">
			<button class="button" type="submit" disabled>Evaluate</button>
			<p class="hint">Inputs are enabled when the evaluate port lands (Phase 1).</p>
		</div>
	</form>

	<section class="panels" aria-label="Result panels">
		<h2>Metrics at p ≤ 0.05 and p ≤ 0.10</h2>
		<p class="todo">Pearson r, Spearman ρ, ROC-AUC, PPV, FPR, matched genes and evaluated sites.</p>
		<h2>Confusion matrices</h2>
		<p class="todo">MEME call against HyphAeon call at each threshold.</p>
		<h2>LRT scatter</h2>
		<p class="todo">HyphAeon LRT against MEME LRT per site, with the regression slope shown.</p>
	</section>
</div>

<style>
	.intro {
		color: var(--text-muted);
		margin-bottom: var(--space-5);
	}
	.card {
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
		background: var(--surface);
		box-shadow: var(--shadow);
		padding: var(--space-5);
		display: grid;
		gap: var(--space-4);
		margin-bottom: var(--space-6);
	}
	.field {
		display: grid;
		gap: var(--space-1);
	}
	.field span {
		font-weight: 600;
		font-size: var(--text-sm);
	}
	.run {
		display: flex;
		gap: var(--space-4);
		align-items: center;
		flex-wrap: wrap;
	}
	.hint,
	.todo {
		font-size: var(--text-sm);
		color: var(--text-muted);
		margin: 0 0 var(--space-4);
	}
	.panels h2 {
		margin-top: var(--space-4);
	}
</style>
