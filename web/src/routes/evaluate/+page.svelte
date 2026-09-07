<!--
	+page.svelte (/evaluate) — skeleton for MEME concordance.

	WHY THIS FILE EXISTS. PLAN.md §4.1: "/evaluate — meme CSV + HyPhy MEME JSON → metrics +
	scatter." The evaluate port (PLAN.md §5.2 order 3) runs without the model, so this page needs
	only the library; until it lands the inputs are shown disabled and the result panels are named
	as statements of what they will hold (web/DESIGN.md §3 "/evaluate").
-->
<svelte:head>
	<title>Evaluate · PrimAeon</title>
</svelte:head>

<div class="container container--narrow">
	<h1>Evaluate</h1>
	<p class="meta">Compare a run against HyPhy MEME · <code>hyphaeon evaluate</code></p>
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
		margin-bottom: var(--space-6);
	}
	.card {
		border-top: 1px solid var(--hair);
		border-bottom: 1px solid var(--hair);
		padding: var(--space-5) 0;
		display: grid;
		gap: var(--space-4);
		margin-bottom: var(--space-8);
	}
	.field {
		display: grid;
		grid-template-columns: minmax(0, 14rem) 1fr;
		gap: var(--space-1) var(--space-4);
		align-items: center;
		font-size: var(--text-md);
	}
	.field span {
		color: var(--text-muted);
	}
	.field input:disabled {
		opacity: 0.45;
	}
	.run {
		display: flex;
		gap: var(--space-4);
		align-items: center;
		flex-wrap: wrap;
		padding-top: var(--space-2);
	}
	.hint,
	.todo {
		font-size: var(--text-md);
		color: var(--text-muted);
		margin: 0 0 var(--space-4);
	}
	.panels {
		counter-reset: section;
	}
	.panels h2 {
		position: relative;
		padding: 0 0 var(--space-2) 2.5rem;
		margin: var(--space-6) 0 var(--space-3);
		border-bottom: 1px solid var(--rule);
	}
	.panels h2::before {
		counter-increment: section;
		content: counter(section);
		position: absolute;
		left: 0;
		color: var(--text-muted);
		font-weight: 400;
	}
	@media (max-width: 40em) {
		.field {
			grid-template-columns: 1fr;
		}
	}
</style>
