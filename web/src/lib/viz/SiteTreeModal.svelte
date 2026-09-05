<!--
	SiteTreeModal.svelte — the site-specific phylogenetic tree with parsimony substitutions.

	WHY THIS FILE EXISTS. Ported from axomeme3/index.html's tree popup (`openTreePopup`,
	`updatePopupTree`, `setupPopupTreeModal`; lines 3840-4290): the tree the model was given,
	drawn by phylotree.js with each tip labelled "taxon (state)" where the state is the codon or
	the amino acid at the chosen site; Fitch parsimony (results/fitch.ts) colours the branches on
	which the state changes and counts them; clades with no change collapse; the header carries
	the reference state, the substitution count and the amino-acid composition bar; toggles switch
	codon/AA labels, linear/radial layout and tip alignment. Two departures from the original:
	the layout is `fit-to-size` rather than phylotree's fixed step, so the tree fills the modal
	instead of sitting in a corner of it; and collapsing the unchanged clades is a toggle, on by
	default only above COLLAPSE_ABOVE_TIPS tips, because on a 20-taxon tree the collapse hid most of
	the states the modal exists to show. The tree is re-rendered on every toggle, as the original does, because phylotree v2's in-place updates do not restyle edges
	reliably — the original's post-render `d3.selectAll(...)` restyling is kept for the same reason,
	scoped to this modal's container rather than the document.

	REQUIRES a tree and `record.alignment` (the selected taxa's sequences): without both there is
	nothing to label, and the modal says so instead of drawing a bare topology.

	WHICH TREE, AND WHETHER THE MODEL SAW IT (D22). The tree now comes in as a prop rather than off
	the record, because the two are no longer the same thing: a tree-free run gave the model pairwise
	TN93 distances and never a topology, and what is drawn here is then the neighbour-joining tree
	the runtime built on those distances FOR DISPLAY (lib/report/displayTree.ts decides which).
	Parsimony substitutions on such a tree are still worth showing — the states are the alignment's
	and the topology is a faithful summary of the distances the model did see — but the caption says
	which tree it is every time, so no reader takes an inferred topology for a supplied one.
-->
<script lang="ts">
	import { onMount, tick, untrack } from 'svelte';
	import * as d3 from 'd3';
	import 'phylotree/dist/phylotree.css';
	import type { MemeRecord } from '$lib/results/types';
	import type { DisplayTree } from '$lib/report/displayTree';
	import type { SiteRow } from '$lib/results/derive';
	import { fitchReconstruct, isSubstitution, type FitchNode } from '$lib/results/fitch';
	import { siteColumn, translateCodon, type SiteComposition } from '$lib/results/entropy';
	import SparkBar from './SparkBar.svelte';

	interface Props {
		record: MemeRecord;
		row: SiteRow;
		composition: SiteComposition | null;
		/** Which Newick to draw and what to call it (lib/report/displayTree.ts). */
		tree?: DisplayTree | null;
		onClose: () => void;
	}
	let { record, row, composition, tree = null, onClose }: Props = $props();

	/** The tree prop when the report supplied one; otherwise the record's own, as before Phase 3. */
	const newick = $derived(tree?.newick ?? record.tree ?? null);
	const treeLabel = $derived(tree?.label ?? null);

	let labelType = $state<'codon' | 'aa'>('codon');
	let layout = $state<'linear' | 'radial'>('linear');
	let alignTips = $state(false);
	/** Above this many tips, unchanged clades collapse by default (the original always collapsed). */
	const COLLAPSE_ABOVE_TIPS = 40;
	let collapse = $state(untrack(() => (record.alignment?.names.length ?? 0) > COLLAPSE_ABOVE_TIPS));
	let container = $state<HTMLDivElement | null>(null);
	let dialog = $state<HTMLDivElement | null>(null);
	let substitutions = $state<number | null>(null);
	let error = $state<string | null>(null);

	const canDraw = $derived(Boolean(newick && record.alignment && record.alignment.sequences.length > 0));

	/** Codon (or amino acid) of a taxon at this site, '?' when the taxon is not in the alignment. */
	function stateOf(name: string): string {
		const alignment = record.alignment!;
		let idx = alignment.names.indexOf(name);
		if (idx < 0) idx = alignment.names.findIndex((n) => n.replace(/^['"]|['"]$/g, '') === name);
		if (idx < 0) return '?';
		const codon = siteColumn([alignment.sequences[idx]], row.site)[0];
		if (labelType === 'codon') return codon.length === 3 ? codon : '?';
		return translateCodon(codon);
	}

	async function render() {
		if (!container || !canDraw) return;
		container.innerHTML = '';
		error = null;
		try {
			const { phylotree } = await import('phylotree');
			const tips = record.alignment?.names.length ?? 20;
			const width = Math.max(480, container.clientWidth - 24);
			const height = layout === 'radial' ? Math.max(520, Math.min(900, width)) : Math.max(320, Math.min(900, 18 * tips + 60));
			const drawn = new phylotree(newick!);
			const root = drawn.nodes as unknown as FitchNode;
			const result = fitchReconstruct(root, stateOf, collapse);
			substitutions = result.substitutions;

			const display = drawn.render({
				container,
				width,
				height,
				'is-radial': layout === 'radial',
				'align-tips': alignTips,
				'left-right-spacing': 'fit-to-size',
				'top-bottom-spacing': 'fit-to-size',
				'max-radius': Math.min(width, height) / 2 - 40,
				zoom: true,
				'show-scale': true,
				'draw-size-bubbles': false,
				transitions: false,
				'show-menu': false,
				selectable: false
			});
			display.nodeLabel((node) => {
				const n = node as unknown as FitchNode;
				return !n.children || n.children.length === 0 ? `${n.data.name} (${n.leafState ?? '?'})` : '';
			});
			display.style_edges((element, edge) => {
				const s = edge.source as unknown as FitchNode;
				const t = edge.target as unknown as FitchNode;
				if (isSubstitution(s.state, t.state)) element.classed('branch--substitution', true);
			});
			container.appendChild(display.show());
			await tick();
			restyle();
		} catch (e) {
			error = (e as Error).message;
			substitutions = null;
		}
	}

	/** axomeme3's post-render pass: style what phylotree drew, by the parsimony states. */
	function restyle() {
		if (!container) return;
		d3.select(container)
			.selectAll<SVGPathElement, { source: FitchNode; target: FitchNode }>('path.branch')
			.each(function (edge) {
				if (!edge?.source || !edge?.target) return;
				d3.select(this).classed('branch--substitution', isSubstitution(edge.source.state, edge.target.state));
			});
		d3.select(container)
			.selectAll<SVGGElement, FitchNode>('g.node')
			.each(function (node) {
				if (!node) return;
				const leaf = !node.children || node.children.length === 0;
				const changed = !leaf && node.parent && isSubstitution(node.parent.state, node.state);
				d3.select(this).classed('node--leaf', leaf).classed('node--substitution', Boolean(changed));
			});
	}

	$effect(() => {
		void labelType;
		void layout;
		void alignTips;
		void collapse;
		void row.site;
		void newick;
		void render();
	});

	onMount(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') onClose();
		};
		window.addEventListener('keydown', onKey);
		dialog?.focus();
		return () => window.removeEventListener('keydown', onKey);
	});
</script>

<div
	class="backdrop"
	role="presentation"
	onclick={(e) => {
		if (e.target === e.currentTarget) onClose();
	}}
>
	<div class="modal" role="dialog" aria-modal="true" aria-labelledby="site-tree-title" tabindex="-1" bind:this={dialog}>
		<header class="modal__header">
			<h2 id="site-tree-title">Site {row.site} tree</h2>
			<button type="button" class="close" aria-label="Close" onclick={onClose}>×</button>
		</header>

		<div class="facts">
			<div class="facts__row">
				<span><strong>Codon site</strong> <span class="mono brand">{row.site}</span></span>
				<span><strong>Reference</strong> <span class="mono">{row.refCodon || '—'} ({row.refAa || '?'})</span></span>
				{#if row.isVariable}
					<span><strong>Predicted LRT</strong> <span class="mono">{row.lrt.toFixed(4)}</span></span>
				{:else}
					<span><strong>Predicted LRT</strong> <span class="muted">not scored (invariable)</span></span>
				{/if}
				<span>
					<strong>Parsimony substitutions</strong>
					<span class="mono danger">{substitutions ?? '—'}</span>
				</span>
			</div>
			{#if treeLabel}
				<p class="treesource">{treeLabel}</p>
			{/if}
			{#if composition}
				<div class="facts__row facts__row--composition">
					<span class="eyebrow-sm">Amino-acid composition at site</span>
					<SparkBar counts={composition.aaCounts} total={composition.total} wide />
				</div>
			{/if}
			<div class="toggles">
				<span class="toggle-group" role="group" aria-label="Labels">
					<span class="toggle-label">Labels</span>
					<button type="button" class:active={labelType === 'codon'} onclick={() => (labelType = 'codon')}>Codons</button>
					<button type="button" class:active={labelType === 'aa'} onclick={() => (labelType = 'aa')}>Amino acids</button>
				</span>
				<span class="toggle-group" role="group" aria-label="Layout">
					<span class="toggle-label">Layout</span>
					<button type="button" class:active={layout === 'linear'} onclick={() => (layout = 'linear')}>Linear</button>
					<button type="button" class:active={layout === 'radial'} onclick={() => (layout = 'radial')}>Radial</button>
				</span>
				<button type="button" class="toggle-single" class:active={alignTips} onclick={() => (alignTips = !alignTips)}>
					Align tips
				</button>
				<button type="button" class="toggle-single" class:active={collapse} onclick={() => (collapse = !collapse)}
					title="Collapse clades with no parsimony substitution below them">
					Collapse unchanged clades
				</button>
			</div>
		</div>

		{#if !canDraw}
			<p class="notice">
				This record does not carry the tree and the sequences the model saw, so the site tree cannot be
				drawn. Results stored by a browser run include both; a bare CLI document does not.
			</p>
		{:else if error}
			<p class="notice notice--error">Could not render the tree: {error}</p>
		{/if}
		<div class="tree" bind:this={container}></div>
		<p class="legend">
			<span><i class="swatch swatch--sub"></i> branch with a parsimony substitution</span>
			<span><i class="swatch swatch--node"></i> node where the state changes</span>
			{#if collapse}<span>Clades without a change are collapsed.</span>{/if}
		</p>
	</div>
</div>

<style>
	.backdrop {
		position: fixed;
		inset: 0;
		z-index: 50;
		background: rgb(20 17 31 / 0.55);
		display: flex;
		align-items: center;
		justify-content: center;
		padding: var(--space-4);
	}
	.modal {
		background: var(--surface);
		color: var(--text);
		border-radius: var(--radius-lg);
		box-shadow: var(--shadow);
		width: min(100%, 64rem);
		max-height: calc(100dvh - 2 * var(--space-4));
		overflow: auto;
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
		padding: var(--space-5);
		outline: none;
	}
	.modal__header {
		display: flex;
		justify-content: space-between;
		align-items: center;
	}
	.modal__header h2 {
		margin: 0;
	}
	.close {
		all: unset;
		cursor: pointer;
		font-size: 1.6rem;
		line-height: 1;
		padding: 0.2rem 0.5rem;
		border-radius: var(--radius-sm);
		color: var(--text-muted);
	}
	.close:hover {
		background: var(--bg-subtle);
		color: var(--text);
	}
	.facts {
		background: var(--bg-subtle);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: var(--space-3) var(--space-4);
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		font-size: var(--text-sm);
	}
	.facts__row {
		display: flex;
		gap: var(--space-4);
		flex-wrap: wrap;
	}
	.facts__row--composition {
		flex-direction: column;
		gap: 0.2rem;
		padding-top: var(--space-2);
		border-top: 1px dotted var(--border);
	}
	.eyebrow-sm {
		font-size: 0.7rem;
		font-weight: 700;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--text-muted);
	}
	.mono {
		font-family: var(--font-mono);
	}
	.brand {
		color: var(--brand);
		font-weight: 700;
	}
	.danger {
		color: var(--tier-strong);
		font-weight: 700;
	}
	.muted {
		color: var(--text-faint);
		font-style: italic;
	}
	.toggles {
		display: flex;
		gap: var(--space-4);
		flex-wrap: wrap;
		align-items: center;
		padding-top: var(--space-2);
		border-top: 1px dotted var(--border);
	}
	.toggle-group {
		display: inline-flex;
		align-items: center;
		gap: 2px;
		background: var(--border);
		padding: 2px;
		border-radius: 6px;
	}
	.toggle-label {
		font-size: var(--text-xs);
		font-weight: 600;
		color: var(--text-muted);
		padding-inline: 0.4rem;
	}
	.toggles button {
		border: none;
		background: transparent;
		border-radius: 4px;
		padding: 0.25rem 0.55rem;
		font-size: var(--text-xs);
		font-weight: 600;
		color: var(--text-muted);
		cursor: pointer;
	}
	.toggles button.active {
		background: var(--surface);
		color: var(--brand);
		box-shadow: var(--shadow);
	}
	.toggle-single {
		border: 1px solid var(--border-strong) !important;
	}
	.notice {
		margin: 0;
		padding: var(--space-3);
		border-radius: var(--radius);
		background: var(--warn-soft);
		color: var(--warn);
		font-size: var(--text-sm);
	}
	.notice--error {
		background: var(--danger-soft);
		color: var(--danger);
	}
	.tree {
		min-height: 24rem;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: var(--space-3);
		overflow: auto;
		background: var(--surface);
	}
	.tree :global(svg) {
		max-width: none;
	}
	.tree :global(.branch) {
		stroke: var(--text-muted);
		stroke-width: 1.5px;
		fill: none;
	}
	.tree :global(.branch--substitution) {
		stroke: var(--tier-strong);
		stroke-width: 3.5px;
	}
	.tree :global(.node text) {
		font-family: var(--font-mono);
		font-size: 11px;
		fill: var(--text);
	}
	.tree :global(.node circle) {
		display: none;
	}
	.tree :global(.node--leaf circle) {
		display: inline;
		fill: var(--brand);
		stroke: var(--surface);
		stroke-width: 1px;
		r: 3.5px;
	}
	.tree :global(.node--substitution circle) {
		display: inline;
		fill: var(--tier-strong);
		stroke: var(--surface);
		stroke-width: 1px;
		r: 5px;
	}
	.tree :global(.node-collapsed path),
	.tree :global(.node-collapsed polygon) {
		fill: var(--tier-none);
		opacity: 0.5;
	}
	.tree :global(.tree-scale-bar text) {
		fill: var(--text-muted);
		font-size: 10px;
	}
	.tree :global(.tree-scale-bar line),
	.tree :global(.tree-scale-bar path) {
		stroke: var(--text-muted);
	}
	.treesource {
		margin: 0;
		font-size: var(--text-xs);
		color: var(--text-muted);
	}
	.legend {
		margin: 0;
		display: flex;
		gap: var(--space-4);
		flex-wrap: wrap;
		font-size: var(--text-xs);
		color: var(--text-muted);
	}
	.legend span {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
	}
	.swatch {
		display: inline-block;
		width: 1rem;
		height: 3px;
		background: var(--tier-strong);
	}
	.swatch--node {
		width: 9px;
		height: 9px;
		border-radius: 50%;
	}
</style>
