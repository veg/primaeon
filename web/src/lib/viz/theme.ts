/**
 * theme.ts — the app's CSS tokens as strings a canvas or an Observable Plot can use.
 *
 * WHY THIS FILE EXISTS. Scoped CSS reaches SVG through class names, but a canvas fill and a Plot
 * `fill` channel take colour strings. This resolves the tokens declared in web/src/app.css
 * (--tier-strong / --tier-moderate / --tier-none for the call tiers, --brand, --accent, --ok, the
 * surface and text colours) from the document at draw time, so both plots follow the OS colour
 * scheme without a second palette. Fallbacks are the light-scheme values from app.css, used only
 * before the stylesheet has applied (never in a rendered page).
 */

const FALLBACK: Record<string, string> = {
	'--surface': '#ffffff',
	'--bg-subtle': '#f7f5fb',
	'--border': '#dcd7e8',
	'--text': '#1f1b2e',
	'--text-muted': '#5c5670',
	'--text-faint': '#8a839c',
	'--brand': '#5b3fa0',
	'--accent': '#d9721b',
	'--ok': '#2f7d4f',
	'--tier-strong': '#b3261e',
	'--tier-moderate': '#d9721b',
	'--tier-weak': '#c9a227',
	'--tier-none': '#8a839c',
	'--font-mono': "'JetBrains Mono', ui-monospace, Menlo, monospace"
};

export function token(name: string, element: Element | null = null): string {
	if (typeof window === 'undefined' || typeof getComputedStyle !== 'function') return FALLBACK[name] ?? '';
	const el = element ?? document.documentElement;
	const value = getComputedStyle(el).getPropertyValue(name).trim();
	// A token defined as `var(--accent)` resolves through getPropertyValue on the root, but a
	// nested reference can come back unresolved in some engines; fall through to the literal.
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
		tier1: token('--tier-strong', element),
		tier2: token('--tier-moderate', element),
		neutral: token('--brand', element),
		unscored: token('--tier-none', element)
	};
}
