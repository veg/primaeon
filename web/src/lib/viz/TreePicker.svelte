<!--
	TreePicker.svelte — pick the foreground by clicking tips on the tree the report drew.

	WHY THIS FILE EXISTS. PLAN.md §4.0 row 8 names this as the first way to give the pillar a trait:
	"Mark foreground taxa on the tree or paste a list". For a mammalian alignment of 256 tips the
	list is the harder interface — the reader knows the clade, not the assembly abbreviations — so
	the tree is where the foreground is chosen and the list is what falls out of it.

	CLICKING AN INTERNAL NODE TAKES ITS WHOLE CLADE, which is the affordance that makes this worth
	building: "the pinnipeds" is one click on their ancestor and not eleven on their tips. The
	toggle is all-or-nothing per clade — if every leaf below the node is already in the foreground
	the click removes them, otherwise it adds them all — so a second click always undoes the first.

	WHICH TREE THIS IS, AND WHY IT SAYS SO. Under D22 a report that ran tree-free has no tree of the
	model's own: the runtime builds a neighbour-joining tree on the same TN93 distances FOR DISPLAY,
	and the model never sees it. Choosing a foreground on it is legitimate — it is a picture of the
	distances, and the trait is about the taxa, not about the topology — but a reader must not
	mistake it for the tree the numbers came from, so the source is stated above the canvas
	whenever it is not the reader's own tree.

	THE SELECTION IS RESTYLED IN PLACE, NOT RE-RENDERED. phylotree lays out a 256-tip tree in tens
	of milliseconds and re-rendering on every click would throw away the reader's zoom and pan; the
	effect that follows `selected` only toggles classes, exactly as SiteTreeModal's post-render pass
	styles what phylotree drew.
-->
<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import * as d3 from 'd3';
	import 'phylotree/dist/phylotree.css';

	interface PickerNode {
		data: { name: string };
		children?: PickerNode[];
		parent?: PickerNode | null;
	}

	interface Props {
		/** Newick of the tree to draw. */
		newick: string;
		/** The taxa the model used; a tip not in this list cannot be part of the trait. */
		taxa: readonly string[];
		/** Currently selected foreground names. */
		selected: string[];
		onChange: (names: string[]) => void;
		/** 'user' | 'embedded' | 'nj'; anything but the first two is labelled as display-only. */
		treeSource?: string | null;
	}
	let { newick, taxa, selected, onChange, treeSource = null }: Props = $props();

	let container = $state<HTMLDivElement | null>(null);
	let error = $state<string | null>(null);
	let layout = $state<'linear' | 'radial'>('linear');
	let rendered = $state(0);

	const known = $derived(new Set(taxa));
	const chosen = $derived(new Set(selected));
	const displayOnly = $derived(treeSource !== 'user' && treeSource !== 'embedded');

	/** Every leaf name below a node (the node itself when it is a leaf). */
	function leavesOf(node: PickerNode): string[] {
		if (!node.children || node.children.length === 0) return node.data?.name ? [node.data.name] : [];
		const out: string[] = [];
		for (const child of node.children) out.push(...leavesOf(child));
		return out;
	}

	function toggle(node: PickerNode) {
		const leaves = leavesOf(node).filter((n) => known.has(n));
		if (leaves.length === 0) return;
		const next = new Set(chosen);
		const allIn = leaves.every((n) => next.has(n));
		for (const n of leaves) {
			if (allIn) next.delete(n);
			else next.add(n);
		}
		// Keep the model's taxon order, so the list the reader sees is stable across clicks.
		onChange(taxa.filter((n) => next.has(n)));
	}

	async function render() {
		if (!container || !newick.trim()) return;
		container.innerHTML = '';
		error = null;
		try {
			const { phylotree } = await import('phylotree');
			const tips = taxa.length || 20;
			const width = Math.max(420, container.clientWidth - 24);
			const height = layout === 'radial' ? Math.max(520, Math.min(900, width)) : Math.max(320, Math.min(2400, 16 * tips + 60));
			const tree = new phylotree(newick);
			const display = tree.render({
				container,
				width,
				height,
				'is-radial': layout === 'radial',
				'left-right-spacing': 'fit-to-size',
				'top-bottom-spacing': 'fit-to-size',
				'max-radius': Math.min(width, height) / 2 - 40,
				zoom: true,
				'show-scale': false,
				'draw-size-bubbles': false,
				transitions: false,
				'show-menu': false,
				selectable: false
			});
			display.nodeLabel((node: PickerNode) => (!node.children || node.children.length === 0 ? node.data.name : ''));
			container.appendChild(display.show());
			d3.select(container)
				.selectAll<SVGGElement, PickerNode>('g.node')
				.each(function (node) {
					if (!node) return;
					const leaf = !node.children || node.children.length === 0;
					const pickable = leavesOf(node).some((n) => known.has(n));
					d3.select(this)
						.classed('pick', pickable)
						.classed('pick--leaf', leaf)
						.classed('pick--absent', leaf && !known.has(node.data?.name))
						.on('click', (event: MouseEvent) => {
							event.stopPropagation();
							toggle(node);
						});
				});
			rendered++;
		} catch (e) {
			error = (e as Error).message;
		}
	}

	// Redraw only when the tree or the layout changes; a click restyles instead (see the header).
	$effect(() => {
		void newick;
		void layout;
		void render();
	});

	$effect(() => {
		void rendered;
		const names = chosen;
		if (!container) return;
		d3.select(container)
			.selectAll<SVGGElement, PickerNode>('g.node')
			.each(function (node) {
				if (!node) return;
				const leaves = leavesOf(node).filter((n) => known.has(n));
				const all = leaves.length > 0 && leaves.every((n) => names.has(n));
				const some = !all && leaves.some((n) => names.has(n));
				d3.select(this).classed('pick--on', all).classed('pick--partial', some);
			});
	});

	onMount(() => {
		const ro = new ResizeObserver(() => untrack(() => void render()));
		if (container) ro.observe(container);
		return () => ro.disconnect();
	});
</script>

<div class="picker">
	<div class="picker__bar">
		<span class="count"><strong>{selected.length}</strong> of {taxa.length} taxa in the foreground</span>
		<span class="toggle-group" role="group" aria-label="Layout">
			<button type="button" class:active={layout === 'linear'} onclick={() => (layout = 'linear')}>Linear</button>
			<button type="button" class:active={layout === 'radial'} onclick={() => (layout = 'radial')}>Radial</button>
		</span>
		<button type="button" class="clear" onclick={() => onChange([])} disabled={selected.length === 0}>Clear</button>
	</div>
	<p class="hint">
		Click a tip to add or remove it; click an internal node to take or drop its whole clade.
		{#if treeSource === 'user-topology'}
			<strong>This tree is display only: your topology, drawn with unit branch lengths</strong> — the run was tree-free,
			so the model was given TN93 distances from the alignment; the lengths here are a convention, not a fit.
		{:else if displayOnly}
			<strong>This tree is display only, built from the TN93 distances</strong> — the run was tree-free, so the model
			was given those distances and never a topology.
		{/if}
	</p>
	{#if error}
		<p class="error">Could not draw the tree: {error}</p>
	{/if}
	<div class="picker__canvas" bind:this={container}></div>
</div>

<style>
	.picker {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}
	.picker__bar {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		flex-wrap: wrap;
		font-size: var(--text-sm);
	}
	.count {
		color: var(--text-muted);
	}
	.toggle-group {
		display: inline-flex;
		gap: 2px;
		background: var(--border);
		padding: 2px;
		border-radius: 6px;
	}
	.toggle-group button {
		border: none;
		background: transparent;
		border-radius: 4px;
		padding: 0.2rem 0.55rem;
		font-size: var(--text-xs);
		font-weight: 600;
		color: var(--text-muted);
		cursor: pointer;
	}
	.toggle-group button.active {
		background: var(--surface);
		color: var(--brand);
	}
	.clear {
		margin-left: auto;
		background: none;
		border: 0;
		color: var(--link);
		text-decoration: underline;
		cursor: pointer;
		font-size: var(--text-sm);
		padding: 0;
	}
	.clear:disabled {
		color: var(--text-faint);
		text-decoration: none;
		cursor: default;
	}
	.hint {
		margin: 0;
		font-size: var(--text-xs);
		color: var(--text-muted);
	}
	.error {
		margin: 0;
		font-size: var(--text-sm);
		color: var(--danger);
	}
	.picker__canvas {
		min-height: 18rem;
		max-height: 32rem;
		overflow: auto;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: var(--space-2);
		background: var(--surface);
	}
	.picker__canvas :global(svg) {
		max-width: none;
	}
	.picker__canvas :global(.branch) {
		stroke: var(--text-muted);
		stroke-width: 1.4px;
		fill: none;
	}
	.picker__canvas :global(.node text) {
		font-family: var(--font-mono);
		font-size: 10px;
		fill: var(--text);
	}
	.picker__canvas :global(.node circle) {
		display: none;
	}
	.picker__canvas :global(.pick) {
		cursor: pointer;
	}
	.picker__canvas :global(.pick--leaf circle) {
		display: inline;
		fill: var(--surface);
		stroke: var(--text-faint);
		stroke-width: 1.2px;
		r: 3.5px;
	}
	.picker__canvas :global(.pick:hover text) {
		fill: var(--brand);
		font-weight: 700;
	}
	.picker__canvas :global(.pick--on circle) {
		display: inline;
		fill: var(--tier-strong);
		stroke: var(--surface);
		r: 4.5px;
	}
	.picker__canvas :global(.pick--on text) {
		fill: var(--tier-strong);
		font-weight: 700;
	}
	.picker__canvas :global(.pick--partial circle) {
		display: inline;
		fill: var(--surface);
		stroke: var(--tier-strong);
		stroke-width: 2px;
		r: 4px;
	}
	.picker__canvas :global(.pick--absent text) {
		fill: var(--text-faint);
		font-style: italic;
	}
</style>
