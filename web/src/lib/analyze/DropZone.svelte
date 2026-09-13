<!--
	DropZone.svelte — the dashed rectangle a dataset is dropped on, lifted out of routes/+page.svelte
	so `/` and `/time` share one implementation.

	WHY THIS FILE EXISTS. Phase 2 of PLAN-TEMPORAL adds a second page that takes the same files, and
	a second copy of the markup would be a second thing to keep in step with web/DESIGN.md and with
	`e2e/smoke.spec.ts`, which asserts `.dropzone` and the text /drop your alignment here/i on the
	landing route. The markup, the class names and the styles here are the landing page's VERBATIM:
	the hidden overlaid file input, `.dropzone--active` on drag-over, `.dropzone--busy` while a file
	is being read, and a `1px dashed var(--rule)` border that darkens to `--text` on hover and drag.
	Nothing about the landing page's DOM changed when it moved.

	LOOK. web/DESIGN.md §3 "Landing": no fill, no tint, no scale, no shadow, left-aligned, a 20/700
	title and a 14 px `--text-muted` hint. The busy state is one word in the title ("Reading…"), not
	a spinner (§3 "Progress", §"Motion").
-->
<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		/** The 20/700 line; swapped for `busyTitle` while a file is being read. */
		title: string;
		busyTitle?: string;
		/** The 14 px line under it, as a snippet so a route can put a `<u>` in it. */
		hint: Snippet;
		accept: string;
		multiple?: boolean;
		busy?: boolean;
		onFiles: (files: FileList | File[] | null | undefined) => void;
	}
	let { title, busyTitle = 'Reading…', hint, accept, multiple = false, busy = false, onFiles }: Props = $props();

	let dragging = $state(false);

	function onDrop(event: DragEvent) {
		event.preventDefault();
		dragging = false;
		onFiles(event.dataTransfer?.files);
	}

	function onPick(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		onFiles(input.files);
		input.value = '';
	}
</script>

<label
	class="dropzone"
	class:dropzone--active={dragging}
	class:dropzone--busy={busy}
	ondragover={(e) => {
		e.preventDefault();
		dragging = true;
	}}
	ondragleave={() => (dragging = false)}
	ondrop={onDrop}
>
	<input type="file" {multiple} {accept} onchange={onPick} disabled={busy} />
	<span class="dropzone__title">{busy ? busyTitle : title}</span>
	<span class="dropzone__hint">{@render hint()}</span>
</label>

<style>
	.dropzone {
		position: relative;
		display: grid;
		gap: var(--space-2);
		justify-items: start;
		text-align: left;
		padding: var(--space-6) var(--space-5);
		border: 1px dashed var(--rule);
		cursor: pointer;
	}
	.dropzone:hover,
	.dropzone--active {
		border-color: var(--text);
	}
	.dropzone--busy {
		opacity: 0.45;
		cursor: progress;
	}
	.dropzone input {
		position: absolute;
		inset: 0;
		opacity: 0;
		cursor: pointer;
	}
	.dropzone__title {
		font-size: var(--text-lg);
		font-weight: 700;
		line-height: var(--leading-tight);
	}
	.dropzone__hint {
		font-size: var(--text-md);
		color: var(--text-muted);
		max-width: var(--measure);
	}
	.dropzone__hint :global(u) {
		color: var(--text);
		text-underline-offset: 0.16em;
	}
</style>
