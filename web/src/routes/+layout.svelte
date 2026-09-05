<!--
	+layout.svelte — the app shell: header with navigation, the page, and a footer that carries the
	one promise every page makes (sequences stay in this browser).

	WHY THIS FILE EXISTS. Every route in PLAN.md §4.1 shares this frame. Phase 2 (D21) folds
	/analyze and /gallery into the landing page and /report/gallery/…, so the primary navigation is
	Methods, Evaluate and MCP; the brand link is the way back to the drop zone. Links go through `base`
	from $app/paths so the same build works at the origin root and under a sub-path (see
	svelte.config.js). Route hrefs end in '/' to match `trailingSlash = 'always'` in +layout.ts;
	a link without the slash would cost a redirect on the static host.
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
		border-bottom: 1px solid var(--border);
		background: var(--surface);
	}
	.header__inner {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-4);
		padding-block: var(--space-3);
		flex-wrap: wrap;
	}

	.brand {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		text-decoration: none;
		color: var(--text);
	}
	.brand__mark {
		width: 1.4rem;
		height: 1.4rem;
		border-radius: 6px;
		background: var(--brand);
		position: relative;
	}
	.brand__mark::after {
		content: '';
		position: absolute;
		inset: 35%;
		border-radius: 50%;
		background: var(--accent);
	}
	.brand__name {
		font-family: var(--font-display);
		font-size: var(--text-lg);
		letter-spacing: -0.01em;
	}

	nav ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		gap: var(--space-1);
		flex-wrap: wrap;
	}
	nav a {
		display: inline-block;
		padding: 0.35rem 0.7rem;
		border-radius: var(--radius-sm);
		text-decoration: none;
		color: var(--text-muted);
		font-weight: 600;
		font-size: var(--text-sm);
	}
	nav a:hover {
		color: var(--text);
		background: var(--bg-subtle);
	}
	nav a[aria-current='page'] {
		color: var(--brand);
		background: var(--brand-soft);
	}

	.main {
		flex: 1;
		padding-block: var(--space-8) var(--space-10);
	}

	.footer {
		border-top: 1px solid var(--border);
		background: var(--bg-subtle);
		font-size: var(--text-sm);
		color: var(--text-muted);
	}
	.footer__inner {
		display: flex;
		justify-content: space-between;
		gap: var(--space-5);
		padding-block: var(--space-5);
		flex-wrap: wrap;
	}
	.footer__promise {
		margin: 0;
		max-width: 38rem;
	}
	.footer__links {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		gap: var(--space-4);
		flex-wrap: wrap;
	}
</style>
