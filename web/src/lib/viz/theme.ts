/**
 * theme.ts — the app's CSS tokens as strings a canvas or an Observable Plot can use.
 *
 * WHY THIS FILE EXISTS. Scoped CSS reaches SVG through class names, but a canvas fill and a Plot
 * `fill` channel take colour strings. This resolves the tokens declared in web/src/app.css (the
 * `--plot-*` family for marks, axes and thresholds; the greys and the two signal colours for
 * everything else) from the document at draw time, so every plot follows the colour scheme
 * without a second palette. No plot may hard-code a colour (DESIGN.md §2.1): the only colours a
 * plot can draw are the ones this file hands it.
 *
 * Fallbacks are the light-scheme values from DESIGN.md §2.1, used only before the stylesheet has
 * applied (never in a rendered page).
 *
 * `tierPalette()` keeps its shape so its callers do not change, and its two tiers resolve to the
 * same colour on purpose: called / not called is the only distinction the surrogate score
 * supports; the tier LABEL ("Top 2 %" against "Top 5 %") carries the grade (DESIGN.md §2.3).
 */

const FALLBACK: Record<string, string> = {
	'--font-text': "'Helvetica Neue', Helvetica, Arial, 'Liberation Sans', sans-serif",
	'--font-mono': "ui-monospace, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace",
	'--bg': '#ffffff',
	'--surface-2': '#f4f4f4',
	'--hair': '#e6e6e6',
	'--rule': '#d0d0d0',
	'--text-faint': '#6e6e6e',
	'--text-muted': '#555555',
	'--text': '#111111',
	'--brand': '#5b3fa0',
	'--on-brand': '#ffffff',
	'--warn': '#a85200',
	'--warn-mark': '#d9721b',
	'--plot-neutral': '#b4b4b4',
	'--focus': '#5b3fa0',
	'--plot-axis': '#d0d0d0',
	'--plot-tick': '#555555',
	'--plot-called': '#5b3fa0',
	'--plot-uncalled': '#b4b4b4',
	'--plot-threshold': '#6e6e6e',
	'--plot-null-band': '#f4f4f4',
	'--plot-hatch': '#d0d0d0',
	'--dms-positive': '#5b3fa0',
	'--dms-zero': '#ffffff',
	'--dms-negative': '#555555'
};

export function token(name: string, element: Element | null = null): string {
	if (typeof window === 'undefined' || typeof getComputedStyle !== 'function') return FALLBACK[name] ?? '';
	const el = element ?? document.documentElement;
	const value = getComputedStyle(el).getPropertyValue(name).trim();
	// A token defined as `var(--rule)` resolves through getPropertyValue on the root, but a nested
	// reference can come back unresolved in some engines; fall through to the literal.
	if (!value || value.startsWith('var(')) return FALLBACK[name] ?? '';
	return value;
}

export interface TierPalette {
	tier1: string;
	tier2: string;
	neutral: string;
	unscored: string;
}

export function tierPalette(element: Element | null = null): TierPalette {
	return {
		tier1: token('--plot-called', element),
		tier2: token('--plot-called', element),
		neutral: token('--plot-uncalled', element),
		unscored: token('--hair', element)
	};
}

/**
 * Call `redraw` whenever the resolved tokens can change: the OS scheme flips, or `data-theme` is
 * set on `<html>`. A canvas keeps whatever palette it was painted with, so every canvas and Plot
 * component re-resolves through this (DESIGN.md §3 "Dark scheme notes" (b)). Returns the disposer.
 */
export function onSchemeChange(redraw: () => void): () => void {
	if (typeof window === 'undefined') return () => {};
	const mq = window.matchMedia('(prefers-color-scheme: dark)');
	mq.addEventListener('change', redraw);
	const observer =
		typeof MutationObserver === 'function'
			? new MutationObserver((mutations) => {
					if (mutations.some((m) => m.attributeName === 'data-theme')) redraw();
				})
			: null;
	observer?.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
	return () => {
		mq.removeEventListener('change', redraw);
		observer?.disconnect();
	};
}

/** Thousands-separated integer, the way a caption prints a count ("1,097"). */
export function formatCount(n: number): string {
	return Number.isFinite(n) ? n.toLocaleString('en-US') : '—';
}

/** "D697": the residue-prefixed site label a reader writes in her notes. */
export function siteLabel(refAa: string | null | undefined, site: number): string {
	const aa = refAa && refAa !== '?' ? refAa : '';
	return `${aa}${site}`;
}
