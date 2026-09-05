/**
 * phenotype.spec.ts — the pillar that cannot run unasked, running in the browser.
 *
 * WHY THIS FILE EXISTS. PLAN.md §4.0 row 8 (D21): every other section of the report runs the moment
 * a dataset arrives, and phenotype cannot, because the trait belongs to the reader; PLAN.md §5's
 * Phase 3 line makes it JavaScript in the same worker as the rest ("No Python and no HyPhy at
 * runtime anywhere in the product"), which is what this spec exists to demonstrate — the Python
 * bridge that answered `hyphaeon_phenotype` in Phase 2 is deleted, and this run is the replacement.
 *
 * WHAT IS DRIVEN. The prebaked RHO report (`/report/gallery/RHO/`, 256 of 710 mammalian rhodopsins,
 * tree embedded in the NEXUS), because it is the dataset the reference's own phenotype fixture uses
 * and the one whose taxa a curated preset matches. The panel is used exactly as a reader would:
 * pick the marine preset, read the preview, run, and read the association plot, the PARS signature
 * and the gene card. Then the same panel is driven a second time with the reference's own inline
 * foreground — `-fg turTru,balMus,…`, the eleven names in
 * fixtures/e2e/phenotype_RHO_marine_n_permutations_0.json's argv — and the section's own JSON
 * download is written to parity/browser/RHO.phenotype.json (PLAN.md §5.4's browser leg).
 *
 * WHAT THE PARITY COMPARISON CAN AND CANNOT SAY. The reference ran `hyphaeon phenotype -a RHO.fasta`
 * with no `--max-species`, which is 655 taxa after duplicate collapse; the model's own taxon cap is
 * 512 (manifest `taxon_cap`, runtime `MAX_SPECIES_CAP`) and this report was baked at the app's
 * default 256, so the app's phenotype pass is over a Faith's-PD subsample and NOT the reference's
 * taxon set. Attribution rows, and therefore every ρ and every p, are functions of that set, so an
 * element-wise 1e-6 comparison against this fixture is not a tolerance question but a category
 * error — no browser run can reach 655 taxa. What is asserted here is what does not depend on the
 * subsample: the document's shape (phenotype.py:624-646's 21 keys, in its own key order), the
 * reference's own trait resolution (`phenotype_meta.description` is the reference's sentence, built
 * from the same eleven patterns), its ordering rule (by score, descending) and its internal
 * consistency (q from p by BH, called sites at q ≤ α with ρ > 0). The element-wise agreement over
 * the sites the two runs share is measured and ANNOTATED, with the taxon counts beside it, so the
 * gap is visible in the report rather than hidden behind a skipped test. `comparePhenotype` makes
 * the assertion automatically as soon as the two runs are over the same taxa and codons — which is
 * what a future uncapped surface (the node parity runner already does it) would produce.
 */

import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import {
	HYPHY_ANY,
	PHENOTYPE_RECORD_KEYS,
	comparePhenotype,
	downloadText,
	referencePhenotype,
	section,
	trackRequests,
	writeBrowserParityFile,
	type CliPhenotype,
	type RequestLog
} from './helpers';

/** The reference's argv foreground (fixtures/e2e/phenotype_RHO_marine_n_permutations_0.json). */
const REFERENCE_FOREGROUND = 'turTru,balMus,balPhys,orcOrc,delDelp,phyCat,phoVit,halGryp,mirLeo,zalCali,odoRos';

/**
 * Fill the options and press Run; resolves when THIS run's result is on screen.
 *
 * `expectDescription` is how the second run is distinguished from the first: the result block stays
 * mounted between runs (the panel's "Run again"), so waiting for `.result` alone would return the
 * previous trait's numbers the moment the button was clicked. The result's own lede prints
 * `phenotype_meta.description`, which is the reference's sentence for the trait that was resolved,
 * so waiting for it is waiting for this trait's run.
 */
async function runPhenotype(page: Page, expectDescription: RegExp, { alpha = 0.05, seed = 42, permulations = 0 }: { alpha?: number; seed?: number; permulations?: number } = {}) {
	const panel = section(page, 'phenotype');
	await panel.getByLabel('BH level α').fill(String(alpha));
	await panel.getByLabel('Seed').fill(String(seed));
	const perms = panel.getByLabel('Permulations B');
	if (await perms.isEnabled()) await perms.fill(String(permulations));
	await panel.getByRole('button', { name: /^Run phenotype association$|^Run again$/ }).click();
	await expect(panel.locator('.result .lede')).toContainText(expectDescription, { timeout: 240_000 });
	// And the run is over, not merely started: the Cancel button lives only while it is running.
	await expect(panel.getByRole('button', { name: 'Cancel' })).toHaveCount(0, { timeout: 240_000 });
	await expect(panel.locator('.note--danger')).toHaveCount(0);
}

test.describe('phenotype: the RHO report, marine trait, in the browser', () => {
	test.describe.configure({ mode: 'serial', timeout: 480_000 });

	let context: BrowserContext;
	let page: Page;
	let requests: RequestLog;

	test.beforeAll(async ({ browser }) => {
		context = await browser.newContext();
		page = await context.newPage();
		requests = trackRequests(page);
		await page.goto('/report/gallery/RHO/');
		await expect(page.getByRole('heading', { level: 1 })).toContainText(/RHO|Rhodopsin/i, { timeout: 30_000 });
		await expect(section(page, 'sites')).toHaveAttribute('data-state', 'done', { timeout: 60_000 });
	});

	test.afterAll(async () => {
		await context?.close();
	});

	test('the panel offers only the presets these taxa match, and previews the foreground', async () => {
		const panel = section(page, 'phenotype');
		await expect(panel.getByRole('tab', { name: /^Preset/ })).toBeVisible({ timeout: 60_000 });
		// Presets are filtered by this dataset (lib/report/phenotype.svelte.ts presetMatches).
		const presets = panel.locator('input[name="preset"]');
		await expect.poll(async () => presets.count(), { timeout: 60_000, message: 'the preset list is matched against these taxa' }).toBeGreaterThan(0);
		const marine = panel.locator('input[name="preset"][value="marine"]');
		await expect(marine, 'the marine preset matches this mammalian rhodopsin alignment').toHaveCount(1);
		await marine.check();
		await expect(panel.locator('.preset--on')).toContainText(/Marine Mammal/i);
		await expect(panel.locator('.preview__line')).toContainText(/\d+ foreground taxa/, { timeout: 30_000 });
		const preview = await panel.locator('.preview__line').innerText();
		const matched = Number(/(\d+) foreground taxa/.exec(preview)?.[1] ?? 0);
		expect(matched, 'the preset resolves to a non-empty foreground').toBeGreaterThan(0);
		test.info().annotations.push({ type: 'marine preset', description: `${matched} of the report's taxa are foreground` });
	});

	test('Run produces the association plot, the PARS signature and the gene card', async () => {
		const panel = section(page, 'phenotype');
		await runPhenotype(page, /Marine Mammal Transition/);

		// The gene card (viz/PhenotypeGeneCard.svelte): a verdict and the length-adjusted EVD p.
		await expect(panel.locator('.card .verdict')).toBeVisible();
		await expect(panel.locator('.card dl.stats dd.num').first()).toHaveText(/^\d\.\d{4}$|e[-+]\d/);
		// The association plot (viz/PhenotypePlot.svelte draws Observable Plot into .plot__canvas;
		// a Plot figure holds the plot's own <svg> plus one per legend swatch, so this is the first).
		const plot = panel.locator('.plot__canvas > figure, .plot__canvas > svg').first();
		await expect(plot).toBeVisible();
		await panel.locator('.plot__bar select').selectOption('pars');
		await expect(plot).toBeVisible();
		await expect(panel.locator('.plot__canvas'), 'the plot rendered rather than reporting an error').not.toContainText(/Could not render/i);
		// The PARS signature is printed even when the bracket is empty, and the panel says why.
		await expect(panel.locator('p.pars')).toBeVisible();
		// The top-sites table is the reference's own ordering: by score, descending.
		const scores = await panel.locator('.result table tbody tr td:nth-child(4)').allInnerTexts();
		expect(scores.length, 'the top-sites table has rows').toBeGreaterThan(0);
		const numbers = scores.map((t) => Number(t)).filter((n) => Number.isFinite(n));
		for (let i = 1; i < numbers.length; i++) expect(numbers[i], `row ${i} is not above row ${i - 1} in score`).toBeLessThanOrEqual(numbers[i - 1] + 1e-9);
		// A gallery record is not this browser's to store into, and the panel says so rather than
		// pretending the result was kept.
		await expect(panel.locator('.result .lede')).toContainText(/not stored: this report is not one this browser owns/i);
	});

	test('no model, ORT or HyPhy surprise: the pillar ran on the graphs the report already needed', async () => {
		const hyphy = requests.matching(HYPHY_ANY);
		expect(hyphy, `HyPhy URLs requested by the phenotype run: ${hyphy.join(', ')}`).toEqual([]);
		const onnx = [...new Set(requests.matching(/\.onnx(\?|$)/i).map((u) => new URL(u).pathname))].sort();
		expect(onnx, `onnx requests: ${onnx.join(', ')}`).toEqual(['/models/general.onnx']);
	});

	test('parity: the reference’s own foreground, written to parity/browser/RHO.phenotype.json', async () => {
		const reference = referencePhenotype('RHO', 'marine', 0);
		test.skip(reference === null, 'fixtures/e2e/phenotype_RHO_marine_n_permutations_0.json not found in the engine checkout');
		const panel = section(page, 'phenotype');

		// The reference resolved its trait from an inline list, so the panel's list tab is the tab.
		await panel.getByRole('tab', { name: 'Paste a list' }).click();
		await panel.locator('textarea').fill(REFERENCE_FOREGROUND);
		await expect(panel.locator('.preview__line')).toContainText(/\d+ foreground taxa/, { timeout: 30_000 });
		await runPhenotype(page, /User-specified foreground patterns/, { permulations: 0, seed: 42, alpha: 0.05 });

		const { filename, text } = await downloadText(page, 'Phenotype (JSON)', { within: section(page, 'phenotype') });
		expect(filename).toMatch(/hyphaeon_phenotype\.json$/);
		const got = JSON.parse(text) as CliPhenotype;

		// The document is the reference's: its 21 keys, in its order, before anything the app adds.
		expect(Object.keys(got).slice(0, PHENOTYPE_RECORD_KEYS.length)).toEqual([...PHENOTYPE_RECORD_KEYS]);
		expect(got.phenotype_meta.mode).toBe('discrete');
		// resolve_phenotype_vector's own sentence, from the same eleven patterns (phenotype.py:264).
		expect(got.phenotype_meta.description).toBe(reference!.phenotype_meta.description);
		expect(got.permulations_count, 'B = 0: no permulations were run').toBe(0);
		expect(got.gene_p_value_perm).toBeNull();
		for (const row of got.sites) expect(row.p_assoc_perm, `site ${row.site} carries no permutation p at B = 0`).toBeNull();

		// Internal consistency, which does not depend on which taxa were scored.
		expect(got.sites.length).toBeGreaterThan(0);
		expect(got.sites.length).toBeLessThanOrEqual(got.codon_count);
		const called = got.sites.filter((r) => r.q_value <= 0.05 && r.association_rho > 0).length;
		expect(got.significant_sites_count, 'significant_sites_count is q ≤ α with ρ > 0').toBe(called);
		for (let i = 1; i < got.sites.length; i++) expect(got.sites[i].score).toBeLessThanOrEqual(got.sites[i - 1].score + 1e-12);

		const cmp = comparePhenotype(got, reference!);
		test.info().annotations.push({
			type: 'browser-vs-python',
			description:
				`taxa ${cmp.taxa[0]} vs ${cmp.taxa[1]} (the app caps at ${512}; the reference ran uncapped), codons ${cmp.codons[0]} vs ${cmp.codons[1]}; ` +
				`${cmp.sharedSites} shared scored sites, ρ(association_rho) ${Number.isFinite(cmp.rhoAgreement) ? cmp.rhoAgreement.toFixed(4) : 'n/a'}; ` +
				`max |Δ| lrt ${(cmp.maxAbs.hyphaeon_lrt ?? NaN).toExponential(2)}, rho ${(cmp.maxAbs.association_rho ?? NaN).toExponential(2)}, ` +
				`max_assoc ${(cmp.maxAbs.max_assoc ?? NaN).toExponential(2)}` +
				(cmp.comparable ? '; SAME taxon set, so the element-wise comparison is asserted' : '; different taxon sets, so the element-wise comparison is reported, not asserted')
		});
		// Asserted the moment the two runs are over the same taxa and codons; see the header.
		expect(cmp.violations.slice(0, 5), `per-site violations: ${cmp.violations.slice(0, 5).join(' | ')}`).toEqual([]);
		expect(cmp.geneViolations, `gene-level violations: ${cmp.geneViolations.join(' | ')}`).toEqual([]);

		const path = writeBrowserParityFile('RHO.phenotype.json', text);
		test.info().annotations.push({ type: 'parity-file', description: path });
	});

	test('the sites CSV downloads with a row per scored codon', async () => {
		// Scoped: the report's own downloads block offers a "Sites (CSV)" for the site table too.
		const { filename, text } = await downloadText(page, 'Sites (CSV)', { within: section(page, 'phenotype') });
		expect(filename).toMatch(/hyphaeon_phenotype\.csv$/);
		const lines = text.trim().split('\n');
		expect(lines[0]).toContain('site,ref_aa,derived_aa');
		expect(lines.length).toBeGreaterThan(1);
	});
});
