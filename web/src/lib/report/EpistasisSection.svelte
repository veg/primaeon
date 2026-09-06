<!--
	EpistasisSection.svelte — the epistasis section body: the force network, the pair table, the
	sector panel, and the GraphML download.

	WHY THIS FILE EXISTS. PLAN.md §4.5 "epistasis". Three visualisations over one payload
	(`edges`, `sectors`), plus the download `hyphaeon epistasis --graphml` writes. B and the seed
	for the sector panel's p_perm caveat come from the section when the runtime records them and
	from the report's options otherwise (they are the same numbers: the orchestrator ran with the
	report's options).

	The lede states the finding with the numbers inline (web/DESIGN.md §5); its first `strong` is
	the edge count, digits only, because the e2e reads it.
-->
<script lang="ts">
	import type { ReportRecord } from '$lib/api';
	import type { EpistasisSection } from '$lib/report/types';
	import EpistasisNetwork from '$lib/viz/EpistasisNetwork.svelte';
	import PairTable from '$lib/viz/PairTable.svelte';
	import SectorPanel from '$lib/viz/SectorPanel.svelte';

	interface Props {
		record: ReportRecord;
		epistasis: EpistasisSection;
		/** Sites the Sites section calls at the active cut; a called node is filled in the network. */
		called?: readonly number[] | null;
		onSelect: (site: number) => void;
	}
	let { record, epistasis, called = null, onSelect }: Props = $props();

	// runtime/src/epistasis.js records `permutations: {n, seed, rng, note}`; older payloads a number.
	const perm = $derived(epistasis.permutations as { n?: number; seed?: number } | number | undefined);
	const permutations = $derived(typeof perm === 'object' && perm ? (perm.n ?? null) : typeof perm === 'number' ? perm : (epistasis.n_permutations ?? record.options.permutations ?? null));
	const seed = $derived(typeof perm === 'object' && perm ? (perm.seed ?? record.options.seed ?? null) : (epistasis.seed ?? record.options.seed ?? null));
	const edges = $derived(epistasis.edges ?? []);
	const sectors = $derived(epistasis.sectors ?? []);
	const sites = $derived(new Set(edges.flatMap((e) => [e.site_u, e.site_v])).size);
</script>

<p class="lede">
	<strong>{edges.length}</strong> co-selected pair{edges.length === 1 ? '' : 's'} over {sites} site{sites === 1 ? '' : 's'},
	forming {sectors.length} sector{sectors.length === 1 ? '' : 's'}{permutations ? `, tested against ${permutations.toLocaleString()} permutations` : ''}.
	Edges are pairs of sites whose per-taxon attribution rows agree (cosine ≥ 0.30, BH q ≤ 0.05, CESI ≥ 2.0, both
	LRTs ≥ 1.0); the attribution rows come from the same forward pass that scored the sites. Sectors are modularity
	communities of that graph pruned to their dominant eigenvector.
</p>

<EpistasisNetwork {edges} {sectors} {called} {onSelect} />

<h3>Pairs</h3>
<PairTable {edges} {onSelect} />

<h3>Sectors</h3>
<SectorPanel {sectors} {permutations} {seed} {onSelect} />

<style>
	.lede {
		margin: 0;
	}
	h3 {
		margin: var(--space-2) 0 0;
	}
</style>
