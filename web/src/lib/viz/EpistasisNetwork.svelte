<!--
	EpistasisNetwork.svelte — the co-selection network as a d3-force layout: node area by LRT,
	edge width by CESI, a called site filled.

	WHY THIS FILE EXISTS. PLAN.md §4.5 "epistasis — Force network (node size LRT, edge width
	CESI)". The graph the reference builds has every site as a node (`CoselectionGraph`), but only
	sites with degree > 0 mean anything in a picture, so the nodes drawn are the endpoints of
	`edges` (cli.py:821-833's GraphML draws the same set). Sizes come from `lrt_u` / `lrt_v` on the
	edges (the same numbers the pair table shows) and widths from `cesi`. d3-force runs in the
	component for a fixed number of ticks and then renders once, so the layout is deterministic for
	a given edge list (d3's default initial positions are a phyllotaxis arrangement, not random) and
	the page never animates a simulation nobody asked for. A click hands the site to the parent (the
	site tree modal).

	WHAT IS NOT DRAWN (DESIGN.md §3 "Epistasis network"). Sector membership is never a hue and never
	a ring: purple means "called" and only that, so a sector cannot borrow it. Membership is text —
	in the node's tooltip and accessible name here, and in each sector's block in SectorPanel. The
	only fill in the figure is a called site's node, and only when the parent passes the called set;
	otherwise every node is hollow and the caption does not claim otherwise.
-->
<script lang="ts">
	import * as d3 from 'd3';
	import type { EpistasisEdge, EpistaticSector } from '$lib/report/types';

	interface Props {
		edges: EpistasisEdge[];
		sectors: EpistaticSector[];
		/** Sites the sites section called; a called node is filled. Optional: without it no node is filled. */
		called?: ReadonlySet<number> | readonly number[] | null;
		onSelect?: (site: number) => void;
		height?: number;
	}
	let { edges, sectors, called = null, onSelect, height = 420 }: Props = $props();

	interface Node extends d3.SimulationNodeDatum {
		id: number;
		ref: string;
		lrt: number;
		sector: number | null;
	}
	interface Link extends d3.SimulationLinkDatum<Node> {
		cesi: number;
		similarity: number;
		fdr_q: number;
	}

	let container = $state<HTMLDivElement | null>(null);
	let width = $state(720);
	let hover = $state<{ x: number; y: number; text: string } | null>(null);

	const calledSet = $derived(called == null ? null : called instanceof Set ? (called as ReadonlySet<number>) : new Set(called as readonly number[]));
	const isCalled = (id: number) => calledSet?.has(id) ?? false;

	function sectorOf(site: number): number | null {
		for (const s of sectors) if (s.sites.includes(site)) return s.sector_id;
		return null;
	}

	const graph = $derived.by(() => {
		const nodes = new Map<number, Node>();
		const add = (id: number, ref: string, lrt: number) => {
			const n = nodes.get(id);
			if (n) n.lrt = Math.max(n.lrt, lrt);
			else nodes.set(id, { id, ref, lrt, sector: sectorOf(id) });
		};
		for (const e of edges) {
			add(e.site_u, e.ref_u, e.lrt_u);
			add(e.site_v, e.ref_v, e.lrt_v);
		}
		const links: Link[] = edges.map((e) => ({ source: e.site_u, target: e.site_v, cesi: e.cesi, similarity: e.similarity, fdr_q: e.fdr_q }));
		return { nodes: [...nodes.values()], links };
	});

	const laidOut = $derived.by(() => {
		const { nodes, links } = graph;
		if (nodes.length === 0) return { nodes: [] as Node[], links: [] as Link[] };
		const w = width;
		// A handful of nodes does not need the full height; the figure shrinks to its graph.
		const h = Math.min(height, Math.max(240, 36 * nodes.length + 120));
		const nodesCopy: Node[] = nodes.map((n) => ({ ...n }));
		const linksCopy: Link[] = links.map((l) => ({ ...l }));
		const rScale = d3.scaleSqrt().domain([0, d3.max(nodesCopy, (n) => n.lrt) || 1]).range([5, 20]);
		const sim = d3
			.forceSimulation(nodesCopy)
			.force('link', d3.forceLink<Node, Link>(linksCopy).id((n) => n.id).distance((l) => 90 - 20 * Math.min(2, l.cesi / 3)).strength(0.6))
			.force('charge', d3.forceManyBody().strength(-220))
			.force('collide', d3.forceCollide<Node>((n) => rScale(n.lrt) + 22))
			.force('center', d3.forceCenter(w / 2, h / 2))
			.stop();
		for (let i = 0; i < 300; i++) sim.tick();
		for (const n of nodesCopy) {
			n.x = Math.max(24, Math.min(w - 56, n.x ?? w / 2));
			n.y = Math.max(24, Math.min(h - 24, n.y ?? h / 2));
		}
		return { nodes: nodesCopy, links: linksCopy, rScale, height: h };
	});

	const rScale = $derived(laidOut.rScale ?? d3.scaleSqrt().range([5, 20]));
	const drawnHeight = $derived(laidOut.height ?? height);
	const wScale = $derived(d3.scaleLinear().domain([0, d3.max(edges, (e) => e.cesi) || 1]).range([1, 6]));

	$effect(() => {
		if (!container) return;
		const ro = new ResizeObserver((entries) => {
			for (const e of entries) width = Math.max(320, Math.floor(e.contentRect.width));
		});
		ro.observe(container);
		return () => ro.disconnect();
	});

	function endpoint(l: Link, which: 'source' | 'target'): Node {
		return l[which] as Node;
	}
	const sectorText = (n: Node) => (n.sector != null ? `, sector ${n.sector}` : '');
</script>

<div class="network" bind:this={container}>
	{#if laidOut.nodes.length === 0}
		<p class="empty">No co-selection edge passed the thresholds (cosine ≥ 0.30, FDR q ≤ 0.05, CESI ≥ 2.0, both LRTs ≥ 1.0), so there is no network to draw.</p>
	{:else}
		<figure>
			<svg {width} height={drawnHeight} viewBox="0 0 {width} {drawnHeight}" role="img" aria-label="Co-selection network: {laidOut.nodes.length} sites, {laidOut.links.length} edges">
				<g class="links">
					{#each laidOut.links as l, i (i)}
						{@const s = endpoint(l, 'source')}
						{@const t = endpoint(l, 'target')}
						<line
							x1={s.x}
							y1={s.y}
							x2={t.x}
							y2={t.y}
							stroke-width={wScale(l.cesi)}
							class="link"
							role="presentation"
							onpointerenter={(ev) => (hover = { x: ev.offsetX, y: ev.offsetY, text: `${s.ref}${s.id} – ${t.ref}${t.id} · CESI ${l.cesi.toFixed(2)} · cos ${l.similarity.toFixed(3)} · q ${l.fdr_q.toExponential(2)}` })}
							onpointerleave={() => (hover = null)}
						/>
					{/each}
				</g>
				<g class="nodes">
					{#each laidOut.nodes as n (n.id)}
						<g
							class="node"
							class:node--called={isCalled(n.id)}
							transform="translate({n.x},{n.y})"
							role="button"
							tabindex="0"
							aria-label="Site {n.id} ({n.ref}), LRT {n.lrt.toFixed(2)}{isCalled(n.id) ? ', called' : ''}{sectorText(n)}"
							onclick={() => onSelect?.(n.id)}
							onkeydown={(ev) => {
								if (ev.key === 'Enter' || ev.key === ' ') onSelect?.(n.id);
							}}
							onpointerenter={(ev) => (hover = { x: ev.offsetX, y: ev.offsetY, text: `${n.ref}${n.id} · LRT ${n.lrt.toFixed(2)}${isCalled(n.id) ? ' · called' : ''}${sectorText(n)}` })}
							onpointerleave={() => (hover = null)}
						>
							<circle r={rScale(n.lrt)} />
							<text x={rScale(n.lrt) + 4} dy="0.35em">{n.ref}{n.id}</text>
						</g>
					{/each}
				</g>
			</svg>
			{#if hover}
				<div class="tip" style="left: {hover.x + 12}px; top: {hover.y + 12}px">{hover.text}</div>
			{/if}
			<figcaption>
				<b>Co-selection network.</b>
				Node area is proportional to predicted LRT, edge width to CESI.
				{#if calledSet}Filled nodes are called sites.{/if}
				Sector membership is listed under Sectors, not drawn. The layout is d3-force run to a fixed
				tick count, so it is the same on every load. Hover an edge for its CESI, cosine and q; click
				a node to open its site tree.
			</figcaption>
		</figure>
	{/if}
</div>

<style>
	.network {
		position: relative;
		width: 100%;
	}
	figure {
		margin: 0;
		position: relative;
	}
	svg {
		display: block;
		width: 100%;
		height: auto;
		border-top: 1px solid var(--hair);
		border-bottom: 1px solid var(--hair);
	}
	.link {
		stroke: var(--plot-axis);
		stroke-linecap: butt;
	}
	.link:hover {
		stroke: var(--text-muted);
	}
	.node {
		cursor: pointer;
		outline: none;
	}
	.node circle {
		fill: var(--bg);
		stroke: var(--plot-uncalled);
		stroke-width: 1px;
	}
	.node--called circle {
		fill: var(--plot-called);
		stroke: var(--plot-called);
	}
	.node:hover circle {
		stroke: var(--text);
	}
	.node:focus-visible circle {
		stroke: var(--focus);
		stroke-width: 2px;
	}
	.node text {
		fill: var(--plot-tick);
		font-family: var(--font-text);
		font-size: var(--text-xs);
		pointer-events: none;
		paint-order: stroke;
		stroke: var(--bg);
		stroke-width: 3px;
	}
	.node--called text {
		fill: var(--plot-called);
		font-weight: 700;
	}
	.tip {
		position: absolute;
		pointer-events: none;
		background: var(--bg);
		color: var(--text);
		border: 1px solid var(--rule);
		font-size: var(--text-md);
		padding: 0.25rem 0.5rem;
		white-space: nowrap;
		z-index: 2;
	}
	figcaption {
		margin: var(--space-2) 0 0;
		max-width: var(--measure);
		font-size: var(--text-md);
		line-height: var(--leading-normal);
		color: var(--text-muted);
	}
	figcaption b {
		color: var(--text);
		font-weight: 700;
	}
	.empty {
		margin: 0;
		max-width: var(--measure);
		font-size: var(--text-md);
		color: var(--text-muted);
	}
</style>
