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

	SETTING (DESIGN.md §3 "Site-tree modal"). The one floating layer on the site, so the one
	element allowed a shadow. Branches are the text colour at 1 px; a branch carrying a parsimony
	substitution, the node where the state changes and the substitution count are the purple — the
	one signal in the dialog. A refusal ("the tree could not be drawn") is black with a black rule,
	not orange: it has already stopped and needs no alarm.
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

	/**
	 * axomeme3's post-render pass: style what phylotree drew, by the parsimony states. phylotree v2
	 * classes a tip `g.node` and an ancestor `g.internal-node`, so both are selected: the node where
	 * the state changes is always an ancestor.
	 */
	function restyle() {
		if (!container) return;
		d3.select(container)
			.selectAll<SVGPathElement, { source: FitchNode; target: FitchNode }>('path.branch')
			.each(function (edge) {
				if (!edge?.source || !edge?.target) return;
				d3.select(this).classed('branch--substitution', isSubstitution(edge.source.state, edge.target.state));
			});
		d3.select(container)
			.selectAll<SVGGElement, FitchNode>('g.node, g.internal-node')
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

		<dl class="facts">
			<dt>Codon site</dt>
			<dd class="num">{row.site}</dd>
			<dt>Reference</dt>
			<dd><span class="mono">{row.refCodon || '—'}</span> ({row.refAa || '?'})</dd>
			<dt>Predicted LRT</dt>
			{#if row.isVariable}
				<dd class="num">{row.lrt.toFixed(4)}</dd>
			{:else}
				<dd class="muted">not scored (invariable)</dd>
			{/if}
			<dt>Parsimony substitutions</dt>
			<dd class="num signal">{substitutions ?? '—'}</dd>
			{#if composition}
				<dt>Amino-acid composition</dt>
				<dd><SparkBar counts={composition.aaCounts} total={composition.total} wide /></dd>
			{/if}
		</dl>
		{#if treeLabel}
			<p class="treesource">{treeLabel}</p>
		{/if}

		<div class="toggles">
			<span class="toggle-group" role="group" aria-label="Labels">
				<span class="toggle-label">Labels</span>
				<button type="button" aria-pressed={labelType === 'codon'} class:active={labelType === 'codon'} onclick={() => (labelType = 'codon')}>Codons</button>
				<button type="button" aria-pressed={labelType === 'aa'} class:active={labelType === 'aa'} onclick={() => (labelType = 'aa')}>Amino acids</button>
			</span>
			<span class="toggle-group" role="group" aria-label="Layout">
				<span class="toggle-label">Layout</span>
				<button type="button" aria-pressed={layout === 'linear'} class:active={layout === 'linear'} onclick={() => (layout = 'linear')}>Linear</button>
				<button type="button" aria-pressed={layout === 'radial'} class:active={layout === 'radial'} onclick={() => (layout = 'radial')}>Radial</button>
			</span>
			<span class="toggle-group">
				<button type="button" class="toggle-single" aria-pressed={alignTips} class:active={alignTips} onclick={() => (alignTips = !alignTips)}>
					Align tips
				</button>
			</span>
			<span class="toggle-group">
				<button
					type="button"
					class="toggle-single"
					aria-pressed={collapse}
					class:active={collapse}
					onclick={() => (collapse = !collapse)}
					title="Collapse clades with no parsimony substitution below them"
				>
					Collapse unchanged clades
				</button>
			</span>
		</div>

		{#if !canDraw}
			<p class="notice">
				This record does not carry the tree and the sequences the model saw, so the site tree cannot be
				drawn. Results stored by a browser run include both; a bare CLI document does not.
			</p>
		{:else if error}
			<p class="notice notice--error"><strong>The tree could not be drawn.</strong> {error}</p>
		{/if}
		<div class="tree" bind:this={container}></div>
		<p class="legend">
			<span><i class="swatch swatch--sub"></i> branch with a parsimony substitution</span>
			<span><svg class="swatch--node" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><circle cx="5" cy="5" r="4" /></svg> node where the state changes</span>
			{#if collapse}<span>Clades without a change are collapsed.</span>{/if}
		</p>
	</div>
</div>

<style>
	.backdrop {
		position: fixed;
		inset: 0;
		z-index: 50;
		background: rgb(0 0 0 / 0.4);
		display: flex;
		align-items: center;
		justify-content: center;
		padding: var(--space-4);
	}
	.modal {
		background: var(--bg);
		color: var(--text);
		border: 1px solid var(--rule);
		box-shadow:
			0 0 0 1px var(--rule),
			0 12px 32px rgb(0 0 0 / 0.28);
		width: min(100%, 64rem);
		max-height: calc(100dvh - 2 * var(--space-4));
		overflow: auto;
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
		padding: var(--space-5);
		outline: none;
	}
	.modal:focus-visible {
		outline: 2px solid var(--focus);
		outline-offset: 2px;
	}
	.modal__header {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		border-bottom: 1px solid var(--rule);
		padding-bottom: var(--space-2);
	}
	.modal__header h2 {
		margin: 0;
		font-size: var(--text-lg);
		font-weight: 700;
		line-height: var(--leading-tight);
	}
	.close {
		all: unset;
		cursor: pointer;
		font-size: var(--text-lg);
		line-height: 1;
		padding: 0.2rem 0.4rem;
		color: var(--text-muted);
	}
	.close:hover {
		color: var(--text);
	}
	.close:focus-visible {
		outline: 2px solid var(--focus);
		outline-offset: 2px;
	}
	.facts {
		margin: 0;
		display: grid;
		grid-template-columns: max-content 1fr;
		column-gap: var(--space-4);
		font-size: var(--text-md);
		line-height: var(--leading-normal);
	}
	.facts dt {
		color: var(--text-muted);
		padding: 0.15rem 0;
	}
	.facts dd {
		margin: 0;
		padding: 0.15rem 0;
		text-align: left;
		color: var(--text);
	}
	.mono {
		font-family: var(--font-mono);
		font-size: var(--text-sm);
	}
	.num {
		font-variant-numeric: tabular-nums;
	}
	.signal {
		color: var(--brand);
		font-weight: 700;
	}
	.muted {
		color: var(--text-faint);
	}
	.treesource {
		margin: 0;
		max-width: var(--measure);
		font-size: var(--text-md);
		line-height: var(--leading-normal);
		color: var(--text-muted);
	}
	.toggles {
		display: flex;
		gap: var(--space-4);
		flex-wrap: wrap;
		align-items: center;
	}
	.toggle-group {
		display: inline-flex;
		align-items: stretch;
		border: 1px solid var(--rule);
		height: 2rem;
	}
	.toggle-label {
		display: inline-flex;
		align-items: center;
		padding: 0 0.6rem;
		font-size: var(--text-sm);
		color: var(--text-muted);
		border-right: 1px solid var(--rule);
	}
	.toggles button {
		all: unset;
		cursor: pointer;
		display: inline-flex;
		align-items: center;
		padding: 0 0.75rem;
		font-family: var(--font-text);
		font-size: var(--text-md);
		color: var(--text-muted);
		text-decoration: underline transparent;
		text-decoration-thickness: 2px;
		text-underline-offset: 0.3em;
	}
	.toggles button + button {
		border-left: 1px solid var(--rule);
	}
	.toggles button:hover {
		color: var(--text);
	}
	.toggles button.active {
		color: var(--text);
		text-decoration-color: var(--text);
	}
	.toggles button:focus-visible {
		outline: 2px solid var(--focus);
		outline-offset: -2px;
	}
	.notice {
		margin: 0;
		max-width: var(--measure);
		font-size: var(--text-md);
		line-height: var(--leading-normal);
		color: var(--text-muted);
	}
	.notice--error {
		border-left: 2px solid var(--text);
		padding-left: var(--space-3);
	}
	.notice--error strong {
		color: var(--text);
		font-weight: 700;
	}
	.tree {
		min-height: 24rem;
		border: 1px solid var(--rule);
		padding: var(--space-3);
		overflow: auto;
		background: var(--bg);
	}
	.tree :global(svg) {
		max-width: none;
	}
	.tree :global(.branch) {
		stroke: var(--text);
		stroke-width: 1px;
		fill: none;
	}
	.tree :global(.branch--substitution) {
		stroke: var(--brand);
		stroke-width: 2px;
	}
	.tree :global(.node text) {
		font-family: var(--font-text);
		font-size: 11px;
		fill: var(--text);
	}
	.tree :global(.node circle),
	.tree :global(.internal-node circle) {
		display: none;
	}
	.tree :global(.node--substitution circle) {
		display: inline;
		fill: var(--brand);
		stroke: var(--bg);
		stroke-width: 1px;
		r: 4px;
	}
	.tree :global(.node-collapsed path),
	.tree :global(.node-collapsed polygon) {
		fill: var(--plot-uncalled);
		stroke: none;
	}
	.tree :global(.tree-scale-bar text) {
		fill: var(--plot-tick);
		font-family: var(--font-text);
		font-size: 11px;
	}
	.tree :global(.tree-scale-bar line),
	.tree :global(.tree-scale-bar path) {
		stroke: var(--plot-axis);
	}
	.legend {
		margin: 0;
		display: flex;
		gap: var(--space-4);
		flex-wrap: wrap;
		font-size: var(--text-sm);
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
		height: 2px;
		background: var(--brand);
	}
	.swatch--node {
		display: inline-block;
		fill: var(--brand);
	}
</style>
