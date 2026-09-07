<!--
	+page.svelte (/gallery) — never rendered: +page.ts redirects to `/` before this component loads.

	WHY THIS FILE EXISTS. SvelteKit needs a +page.svelte for a route to exist at all, and the
	redirect lives in +page.ts (see its header). Should the redirect ever fail to fire (a user agent
	that ignores meta refresh on the prerendered page), this is the one line they see: where the
	examples went.
-->
<script lang="ts">
	import { base } from '$app/paths';
</script>

<svelte:head>
	<title>PrimAeon</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<div class="container container--narrow">
	<p>The examples are on the <a href="{base}/">front page</a>.</p>
</div>
