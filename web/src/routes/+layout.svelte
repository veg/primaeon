<!--
	+layout.svelte — the app shell: masthead with navigation, the page, and a footer that carries the
	one promise every page makes (sequences stay in this browser).

	WHY THIS FILE EXISTS. Every route in PLAN.md §4.1 shares this frame. Phase 2 (D21) folds
	/analyze and /gallery into the landing page and /report/gallery/…, so the primary navigation is
	Methods, Evaluate and MCP; the brand link is the way back to the drop zone. Links go through `base`
	from $app/paths so the same build works at the origin root and under a sub-path (see
	svelte.config.js). Route hrefs end in '/' to match `trailingSlash = 'always'` in +layout.ts;
	a link without the slash would cost a redirect on the static host.

	LOOK. web/DESIGN.md §3 "Page frame": one left-aligned column; the masthead is a single row under
	a hairline — a 10 px purple square (the DataMonkey mark reduced to its colour) beside the
	wordmark, then the three links with the current page underlined. The footer is a hairline above
	one sentence and four links. The mark is the only purple on a page with nothing to signal.
-->
<script lang="ts">
	import '../app.css';
	import { base } from '$app/paths';
	import { page } from '$app/state';

	let { children } = $props();

	const links = [
		{ href: '/methods/', label: 'Methods' },
		{ href: '/evaluate/', label: 'Evaluate' },
		{ href: '/mcp/', label: 'MCP' }
	];

	function isCurrent(href: string): boolean {
		return page.url.pathname.startsWith(`${base}${href}`);
	}
</script>

<svelte:head>
	<link rel="icon" href="{base}/favicon.svg" type="image/svg+xml" />
</svelte:head>

<div class="shell">
	<header class="header">
		<div class="container header__inner">
			<a class="brand" href="{base}/">
				<span class="brand__mark" aria-hidden="true"></span>
				<span class="brand__name">HyphAeon</span>
			</a>
			<nav aria-label="Primary">
				<ul>
					{#each links as link (link.href)}
						<li>
							<a href="{base}{link.href}" aria-current={isCurrent(link.href) ? 'page' : undefined}>
								{link.label}
							</a>
						</li>
					{/each}
				</ul>
			</nav>
		</div>
	</header>

	<main class="main">
		{@render children?.()}
	</main>

	<footer class="footer">
		<div class="container footer__inner">
			<p class="footer__promise">
				<strong>Your sequences stay in this browser.</strong> Every analysis on this site runs
				locally; nothing is uploaded unless you choose a server run and confirm what will be sent.
			</p>
			<ul class="footer__links">
				<li><a href="https://github.com/veg/HyphAeon">veg/HyphAeon</a></li>
				<li><a href="https://huggingface.co/datamonkey/hyphaeon">Model weights</a></li>
				<li><a href="{base}/mcp/">MCP</a></li>
				<li><a href="https://www.datamonkey.org/">Datamonkey</a></li>
			</ul>
		</div>
	</footer>
</div>

<style>
	.shell {
		min-height: 100dvh;
		display: flex;
		flex-direction: column;
	}

	.header {
		border-bottom: 1px solid var(--rule);
	}
	.header__inner {
		display: flex;
		align-items: baseline;
		gap: var(--space-5);
		padding-block: var(--space-4);
		flex-wrap: wrap;
	}

	.brand {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		text-decoration: none;
		color: var(--text);
		margin-right: var(--space-4);
	}
	.brand:hover {
		text-decoration: none;
	}
	.brand__mark {
		width: 10px;
		height: 10px;
		background: var(--brand);
		flex: none;
	}
	.brand__name {
		font-size: var(--text-base);
		font-weight: 700;
		line-height: var(--leading-tight);
	}

	nav ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		gap: var(--space-5);
		flex-wrap: wrap;
	}
	nav a {
		display: inline-block;
		text-decoration: none;
		color: var(--text-muted);
		font-size: var(--text-md);
		line-height: var(--leading-tight);
		padding-bottom: 1px;
	}
	nav a:hover {
		color: var(--text);
		text-decoration: underline;
		text-decoration-thickness: 1px;
		text-underline-offset: 0.16em;
	}
	nav a[aria-current='page'] {
		color: var(--text);
		text-decoration: underline;
		text-decoration-thickness: 1px;
		text-underline-offset: 0.16em;
	}

	.main {
		flex: 1;
		padding-block: var(--space-8) var(--space-10);
	}

	.footer {
		border-top: 1px solid var(--rule);
		font-size: var(--text-md);
		color: var(--text-muted);
	}
	.footer__inner {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: var(--space-5);
		padding-block: var(--space-5);
		flex-wrap: wrap;
	}
	.footer__promise {
		margin: 0;
		max-width: 38rem;
		flex: 1 1 24rem;
	}
	.footer__promise strong {
		color: var(--text);
	}
	.footer__links {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		gap: var(--space-4);
		flex-wrap: wrap;
		flex: none;
	}
</style>
