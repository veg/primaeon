<!--
	EpistasisNetwork.svelte — the co-selection network as a d3-force layout: node size by LRT,
	edge width by CESI, colour by sector.

	WHY THIS FILE EXISTS. PLAN.md §4.5 "epistasis — Force network (node size LRT, edge width CESI,
	colour by sector)". The graph the reference builds has every site as a node
	(`CoselectionGraph`), but only sites with degree > 0 mean anything in a picture, so the nodes
	drawn are the endpoints of `edges` (cli.py:821-833's GraphML draws the same set). Sizes come
	from `lrt_u` / `lrt_v` on the edges (the same numbers the pair table shows), widths from `cesi`,
	and colour from sector membership (`sectors[].sites`); a node in no sector is neutral.
	d3-force runs in the component for a fixed number of ticks and then renders once, so the layout
	is deterministic for a given edge list (d3's default initial positions are a phyllotaxis
	arrangement, not random) and the page never animates a simulation nobody asked for. Drag is
	supported; a click hands the site to the parent (the site tree modal).
-->
<script lang="ts">
	import * as d3 from 'd3';
	import type { EpistasisEdge, EpistaticSector } from '$lib/report/types';
	import { token } from './theme';

	interface Props {
		edges: EpistasisEdge[];
		sectors: EpistaticSector[];
		onSelect?: (site: number) => void;
		height?: number;
	}
	let { edges, sectors, onSelect, height = 420 }: Props = $props();

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

	const SECTOR_PALETTE = ['#5b3fa0', '#d9721b', '#2f7d4f', '#b3261e', '#1f6f8b', '#8a6d1f', '#7a3e9d', '#3d7a3d'];

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
		const h = height;
		const nodesCopy: Node[] = nodes.map((n) => ({ ...n }));
		const linksCopy: Link[] = links.map((l) => ({ ...l }));
		const rScale = d3.scaleSqrt().domain([0, d3.max(nodesCopy, (n) => n.lrt) || 1]).range([6, 22]);
		const sim = d3
			.forceSimulation(nodesCopy)
			.force('link', d3.forceLink<Node, Link>(linksCopy).id((n) => n.id).distance((l) => 90 - 20 * Math.min(2, l.cesi / 3)).strength(0.6))
			.force('charge', d3.forceManyBody().strength(-220))
			.force('collide', d3.forceCollide<Node>((n) => rScale(n.lrt) + 10))
			.force('center', d3.forceCenter(w / 2, h / 2))
			.stop();
		for (let i = 0; i < 300; i++) sim.tick();
		for (const n of nodesCopy) {
			n.x = Math.max(24, Math.min(w - 24, n.x ?? w / 2));
			n.y = Math.max(24, Math.min(h - 24, n.y ?? h / 2));
		}
		return { nodes: nodesCopy, links: linksCopy, rScale };
	});

	const rScale = $derived(laidOut.rScale ?? d3.scaleSqrt().range([6, 22]));
	const wScale = $derived(d3.scaleLinear().domain([0, d3.max(edges, (e) => e.cesi) || 1]).range([1, 7]));

	$effect(() => {
		if (!container) return;
		const ro = new ResizeObserver((entries) => {
			for (const e of entries) width = Math.max(320, Math.floor(e.contentRect.width));
		});
		ro.observe(container);
		return () => ro.disconnect();
	});

	function color(n: Node): string {
		if (n.sector == null) return token('--tier-none');
		return SECTOR_PALETTE[(n.sector - 1) % SECTOR_PALETTE.length];
	}
	function endpoint(l: Link, which: 'source' | 'target'): Node {
		return l[which] as Node;
	}
</script>

<div class="network" bind:this={container}>
	{#if laidOut.nodes.length === 0}
		<p class="empty">No co-selection edge passed the thresholds (cosine ≥ 0.30, FDR q ≤ 0.05, CESI ≥ 2.0, both LRTs ≥ 1.0), so there is no network to draw.</p>
	{:else}
		<svg {width} {height} viewBox="0 0 {width} {height}" role="img" aria-label="Co-selection network: {laidOut.nodes.length} sites, {laidOut.links.length} edges">
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
						transform="translate({n.x},{n.y})"
						role="button"
						tabindex="0"
						aria-label="Site {n.id} ({n.ref}), LRT {n.lrt.toFixed(2)}{n.sector != null ? `, sector ${n.sector}` : ''}"
						onclick={() => onSelect?.(n.id)}
						onkeydown={(ev) => {
							if (ev.key === 'Enter' || ev.key === ' ') onSelect?.(n.id);
						}}
						onpointerenter={(ev) => (hover = { x: ev.offsetX, y: ev.offsetY, text: `${n.ref}${n.id} · LRT ${n.lrt.toFixed(2)}${n.sector != null ? ` · sector ${n.sector}` : ''}` })}
						onpointerleave={() => (hover = null)}
					>
						<circle r={rScale(n.lrt)} fill={color(n)} />
						<text dy="0.35em" text-anchor="middle" font-size={rScale(n.lrt) > 12 ? 11 : 9}>{n.ref}{n.id}</text>
					</g>
				{/each}
			</g>
		</svg>
		{#if hover}
			<div class="tip" style="left: {hover.x + 12}px; top: {hover.y + 12}px">{hover.text}</div>
		{/if}
		<ul class="legend">
			<li><span class="swatch" style="background: {token('--tier-none')}"></span>no sector</li>
			{#each sectors as s (s.sector_id)}
				<li><span class="swatch" style="background: {SECTOR_PALETTE[(s.sector_id - 1) % SECTOR_PALETTE.length]}"></span>sector {s.sector_id} ({s.size} sites)</li>
			{/each}
			<li class="key">node size ∝ LRT · edge width ∝ CESI</li>
		</ul>
	{/if}
</div>

<style>
	.network {
		position: relative;
		width: 100%;
	}
	svg {
		display: block;
		width: 100%;
		height: auto;
		background: var(--bg-subtle);
		border-radius: var(--radius);
		border: 1px solid var(--border);
	}
	.link {
		stroke: var(--text-faint);
		stroke-opacity: 0.6;
		stroke-linecap: round;
	}
	.link:hover {
		stroke: var(--accent);
		stroke-opacity: 1;
	}
	.node {
		cursor: pointer;
	}
	.node circle {
		stroke: var(--surface);
		stroke-width: 1.5;
	}
	.node:hover circle,
	.node:focus-visible circle {
		stroke: var(--accent);
		stroke-width: 2.5;
	}
	.node text {
		fill: var(--text);
		font-family: var(--font-mono);
		pointer-events: none;
		paint-order: stroke;
		stroke: var(--surface);
		stroke-width: 2.5px;
	}
	.tip {
		position: absolute;
		pointer-events: none;
		background: var(--text);
		color: var(--bg);
		font-size: var(--text-xs);
		font-family: var(--font-mono);
		padding: 0.25rem 0.5rem;
		border-radius: var(--radius-sm);
		white-space: nowrap;
		z-index: 2;
	}
	.legend {
		list-style: none;
		margin: var(--space-2) 0 0;
		padding: 0;
		display: flex;
		gap: var(--space-4);
		flex-wrap: wrap;
		font-size: var(--text-xs);
		color: var(--text-muted);
	}
	.swatch {
		display: inline-block;
		width: 0.75rem;
		height: 0.75rem;
		border-radius: 50%;
		margin-right: 0.35rem;
		vertical-align: -1px;
	}
	.key {
		margin-left: auto;
		font-style: italic;
	}
	.empty {
		margin: 0;
		font-size: var(--text-sm);
		color: var(--text-muted);
	}
</style>
