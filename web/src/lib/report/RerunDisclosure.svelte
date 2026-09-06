<!--
	RerunDisclosure.svelte — the one place advanced settings live: "Re-run with…".

	WHY THIS FILE EXISTS. PLAN.md §4.0: "Advanced settings (variant, taxon cap, call mode, seed,
	reference sequence) live behind one disclosure on the report, 'Re-run with…', and re-run
	everything. Defaults come from diagnostics." Plus the two Phase 2 knobs: permutations B (the
	sector null; the CLI's 1,000 vs the 10,000 the parity class wants) and the DMS switch with its
	work budget. Submitting starts a NEW report on the same inputs (the record keeps the alignment
	and the tree the model was given, lengths included, or nothing at all when the run was tree-free) and navigates to
	it; the original report is untouched. A record without input texts (a Phase 1 run, a gallery
	record, a server job) cannot be re-run here and the disclosure says so.

	Set as a plain disclosure (web/DESIGN.md §3): a muted summary with the native marker, no box;
	the form is a grid of labelled inputs and the section's one primary button, "Re-run everything".
-->
<script lang="ts">
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import type { CallMode, ReportOptions, ReportRecord, Variant } from '$lib/api';
	import { reportPath } from '$lib/api';
	import { startReport } from './run.svelte';

	interface Props {
		record: ReportRecord;
	}
	let { record }: Props = $props();

	/** A bundled example carries `inputs.alignment.path` under static/gallery/; its text can be fetched. */
	const galleryPath = $derived((record.inputs.alignment as { path?: string }).path ?? null);
	const canRerun = $derived(Boolean(record.inputs.alignmentText) || Boolean(galleryPath && record.inputs.treeText !== undefined));
	const names = $derived(record.sections.sites?.alignment?.names ?? []);

	let variant = $state<Variant>('general');
	let maxSpecies = $state(256);
	let callMode = $state<CallMode>('percentile');
	let seed = $state(42);
	let reference = $state('');
	let permutations = $state(1000);
	let dmsEnabled = $state(true);
	let dmsBudget = $state(2.5e9);
	let busy = $state(false);
	let error = $state<string | null>(null);

	// Seed the form from the record each time a different record is shown.
	$effect(() => {
		const o = record.options;
		variant = o.variant;
		maxSpecies = o.maxSpecies;
		callMode = o.callMode;
		seed = o.seed;
		reference = o.referenceSequence ?? '';
		permutations = o.permutations;
		dmsEnabled = o.dms.enabled;
		dmsBudget = o.dms.workBudget;
	});

	async function rerun(e: SubmitEvent) {
		e.preventDefault();
		if (!canRerun || busy) return;
		busy = true;
		error = null;
		const options: ReportOptions = {
			variant,
			maxSpecies: Math.min(512, Math.max(3, Math.round(maxSpecies) || 256)),
			referenceSequence: reference || null,
			callMode,
			seed: Math.round(seed) || 42,
			dms: { enabled: dmsEnabled, workBudget: Number(dmsBudget) || 2.5e9 },
			permutations: Math.min(10000, Math.max(0, Math.round(permutations)))
		};
		try {
			let alignmentText = record.inputs.alignmentText ?? null;
			if (!alignmentText && galleryPath) {
				const r = await fetch(`${base}/gallery/${galleryPath}`);
				if (!r.ok) throw new Error(`The bundled input could not be fetched (HTTP ${r.status}).`);
				alignmentText = await r.text();
			}
			if (!alignmentText) throw new Error('This record has no input text to re-run.');
			const id = await startReport({
				alignmentText,
				alignmentName: record.inputs.alignmentName,
				uploadedTreeText: record.inputs.tree ? (record.inputs.treeText ?? null) : null,
				treeName: record.inputs.treeName,
				tree: { treeText: record.inputs.treeText ?? '', treeSource: record.inputs.treeSource },
				options,
				diagnosis: record.diagnostics,
				demo: record.inputs.demo,
				base
			});
			await goto(`${base}${reportPath(id)}`);
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			busy = false;
		}
	}
</script>

<details class="rerun">
	<summary>Re-run with…</summary>
	{#if !canRerun}
		<p class="hint">
			This record does not carry its input texts (a bundled example, a Phase 1 run, or a server job), so it cannot
			be re-run from here. Drop the same file on the landing page to run it with different settings.
		</p>
	{:else}
		<form class="grid" onsubmit={rerun}>
			<div class="field" role="radiogroup" aria-labelledby="rr-variant">
				<span id="rr-variant">Model variant</span>
				<label class="radio"><input type="radio" name="rr-variant" value="general" bind:group={variant} /> <span>General, for deep, cross-species trees</span></label>
				<label class="radio"><input type="radio" name="rr-variant" value="viral" bind:group={variant} /> <span>Viral, for shallow trees</span></label>
			</div>
			<label class="field">
				<span>Taxon cap</span>
				<input type="number" min="3" max="512" step="1" bind:value={maxSpecies} />
				<small>3–512; larger alignments are reduced by Faith's PD after duplicates collapse.</small>
			</label>
			<label class="field">
				<span>Call mode</span>
				<select bind:value={callMode}>
					<option value="percentile">Percentile (top 2 % / 5 % of variable sites)</option>
					<option value="zscore">Z-score (Z ≥ 2.5 / 2.0)</option>
					<option value="pvalue">p-value / q (the reference's gates)</option>
				</select>
			</label>
			<label class="field">
				<span>Reference sequence</span>
				{#if names.length}
					<select bind:value={reference}>
						{#each names as n (n)}<option value={n}>{n}</option>{/each}
					</select>
				{:else}
					<input type="text" bind:value={reference} placeholder="sequence name" />
				{/if}
			</label>
			<label class="field">
				<span>Seed</span>
				<input type="number" step="1" bind:value={seed} />
				<small>Sector permutation null (<code>--seed</code>); site selection draws no random numbers.</small>
			</label>
			<label class="field">
				<span>Permutations B</span>
				<input type="number" min="0" max="10000" step="1" bind:value={permutations} />
				<small>0 disables the test; 1,000 is the CLI default; 10,000 is the parity class's setting (slower).</small>
			</label>
			<div class="field">
				<span>Digital DMS</span>
				<label class="check"><input type="checkbox" bind:checked={dmsEnabled} /> <span>Run the 19·L in-silico scan (last, progressive, cancellable)</span></label>
				<label class="sub">
					<span>Work budget (19·L·N²)</span>
					<input type="number" min="1e6" step="any" bind:value={dmsBudget} disabled={!dmsEnabled} />
				</label>
			</div>
			<div class="actions">
				<button type="submit" class="button" disabled={busy}>{busy ? 'Starting…' : 'Re-run everything'}</button>
				<span class="hint">Runs on the same alignment and tree (branch lengths kept) into a new report; this one stays.</span>
			</div>
			{#if error}<p class="note note--danger" role="alert"><strong>The run could not start.</strong> {error}</p>{/if}
		</form>
	{/if}
</details>

<style>
	.rerun {
		margin-top: var(--space-5);
		font-size: var(--text-md);
	}
	.grid {
		margin-top: var(--space-4);
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
		gap: var(--space-4) var(--space-6);
		max-width: 52rem;
	}
	.field {
		display: grid;
		gap: var(--space-1);
		align-content: start;
	}
	.field > span {
		color: var(--text);
	}
	.field small {
		color: var(--text-faint);
		font-size: var(--text-sm);
	}
	.radio,
	.check {
		display: flex;
		gap: var(--space-2);
		align-items: flex-start;
		font-weight: 400;
		cursor: pointer;
	}
	.radio > span,
	.check > span {
		color: var(--text-muted);
	}
	.sub {
		display: grid;
		gap: var(--space-1);
		font-size: var(--text-sm);
		color: var(--text-muted);
		margin-top: var(--space-1);
	}
	input[type='number'],
	input[type='text'],
	select {
		width: 100%;
		max-width: 16rem;
	}
	.actions {
		grid-column: 1 / -1;
		display: flex;
		gap: var(--space-4);
		align-items: center;
		flex-wrap: wrap;
		border-top: 1px solid var(--hair);
		padding-top: var(--space-4);
	}
	.hint {
		margin: 0;
	}
	.note {
		grid-column: 1 / -1;
		margin: 0;
	}
</style>
