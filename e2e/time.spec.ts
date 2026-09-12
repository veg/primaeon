/**
 * time.spec.ts — the /time route against the built site: the date review, the three ways of
 * supplying dates, and the claim that none of it costs a model byte.
 *
 * WHY THIS FILE EXISTS. Three flows, each proving something no unit test can:
 *
 *   1. THE FLAGSHIP, `korber_env_gp160.fasta`. 143 LANL names that `temporal.extract_date_from_string`
 *      reads NONE of and `dating.parse_header_timestamp` reads 142 of. The page takes the union —
 *      which is D31's whole point — and must show it, name the rule, open the span at 1959.5, offer
 *      the hard-coded archival anchor without applying it, and do all of that having requested no
 *      `*.onnx`, no ORT WASM and nothing off-origin. The date stage is supposed to cost nothing.
 *   2. THE CONTROL, `H5N1_HA_geo.fasta` + `H5N1_HA_metadata.csv`. The table's names and the
 *      alignment's names are identical, so the page must discover the two columns, report 98 of 98,
 *      and agree with the headers. MEASURED: they do.
 *   1b. THE ESTIMATE, on that same load (phase 3). The gate goes green, one button starts the
 *      model-free ancestor-date run in its own worker, and the section reproduces the numbers the
 *      phase was measured against — 1893.9 [1850.9, 1916.8], rate 1.169 × 10⁻³, R² 0.231, n = 141,
 *      the spline preferred at p = 0.0234 and quoted anyway with no interval, zero sequences
 *      flagged and Z59ZR.ZHU held out with a predicted date of 1965.6. It is asserted INSIDE flow 1
 *      on purpose: the "no heavy assets" check at the end of that test then covers the run as well,
 *      which is the only way to prove that dating an alignment here costs no model byte.
 *   1c. THE MODEL-BASED ESTIMATE (phase 4), in a test of its own for the same reason 1b is inside
 *      flow 1: this is the run that DOES load a graph, and it must load exactly one. It presses the
 *      second button, waits for a full forward pass over all 981 codons, and checks that the page
 *      shows all three fits the reference publishes, says that divergence stopped being a sequence
 *      distance, and names the size of the move the ordinary fit made because of it. The request
 *      log is checked from the other side here: one `*.onnx` and it is `general_taxa.onnx`, the ORT
 *      runtime, and nothing off-origin.
 *   4. TEMPORAL SELECTION (phase 5), on the H5N1 load: the second thing on this route that loads a
 *      graph, and the one that must say out loud what it cannot reproduce. It asserts the offer's
 *      cost paragraph before the button, the figure NUMBERING (the one thing a CSS counter can break
 *      silently: 3 figures with the section un-run, 7 after it lands), the three sentences about the
 *      permutation generator and the wave-sign convention, the sites CSV's 27 reference columns in
 *      site order, the reproduction line, and — from the other side — that exactly one graph was
 *      fetched and it is `general.onnx`. A fifth test stops the run during the model pass and checks
 *      that the section goes back to offering rather than claiming a partial answer.
 *   3. THE TRAP, and the reason this page exists. The same alignment with the table rewritten
 *      accession-style. The reference would match zero rows and say nothing; the page must show
 *      both name sets side by side and say plainly that the dates came from the headers instead.
 *
 * The trap table is built in the test as a buffer (`setInputFiles({name, mimeType, buffer})`), so
 * nothing is written to disk.
 */

import { expect, test } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ENGINE_DIR, HEAVY_ASSET, HYPHY_ANY, ONNX, ORT_FORBIDDEN, trackRequests } from './helpers';

const EXAMPLES = resolve(ENGINE_DIR, 'examples');
const KORBER = resolve(EXAMPLES, 'korber_env_gp160.fasta');
const H5N1 = resolve(EXAMPLES, 'H5N1_HA_geo.fasta');
const H5N1_META = resolve(EXAMPLES, 'H5N1_HA_metadata.csv');
const H5N1_TREE = resolve(EXAMPLES, 'H5N1_HA.nwk');

const haveExamples = existsSync(KORBER) && existsSync(H5N1) && existsSync(H5N1_META) && existsSync(H5N1_TREE);

test.describe('the /time route', () => {
	test('is cross-origin isolated and requests nothing off-origin', async ({ page, baseURL }) => {
		const requests = trackRequests(page);
		const response = await page.goto('/time/');
		expect(response!.status()).toBe(200);
		expect(response!.headers()['cross-origin-opener-policy']).toBe('same-origin');
		expect(response!.headers()['cross-origin-embedder-policy']).toBe('require-corp');
		expect(await page.evaluate(() => globalThis.crossOriginIsolated)).toBe(true);
		await page.waitForLoadState('networkidle');
		expect(requests.offOrigin(new URL(baseURL!).origin)).toEqual([]);
		const heavy = requests.matching(HEAVY_ASSET);
		expect(heavy, `heavy assets on /time/: ${heavy.join(', ')}`).toEqual([]);
	});

	test('does not join the primary navigation, and is reachable from the landing page', async ({ page }) => {
		await page.goto('/');
		const labels = (await page.locator('nav[aria-label="Primary"] a').allInnerTexts()).map((s) => s.trim());
		expect(labels).toEqual(['Methods', 'Evaluate', 'MCP']);
		await expect(page.locator('p.examples a.chip')).toHaveCount(5);
		const link = page.getByRole('link', { name: /Review the dates on the time page/i });
		await expect(link).toBeVisible();
		await link.click();
		await expect(page).toHaveURL(/\/time\/$/);
	});

	test('starts empty, with the drop zone and nothing claimed', async ({ page }) => {
		await page.goto('/time/');
		await expect(page.getByRole('heading', { level: 1, name: 'Dates' })).toBeVisible();
		await expect(page.locator('#dates .review')).toHaveAttribute('data-state', 'empty');
		await expect(page.getByText(/drop dated sequences here/i)).toBeVisible();
		// Six numbered sections now; each says what it is with nothing loaded.
		await expect(page.locator('section.section')).toHaveCount(6);
		await expect(page.locator('#dating')).toContainText('Nothing is loaded yet, so there is nothing to date.');
		await expect(page.locator('#temporal')).toContainText('Nothing is loaded yet.');
		// A pending section renders no figcaption (web/DESIGN.md §3), so the counter cannot drift.
		await expect(page.locator('figcaption')).toHaveCount(0);
		const body = await page.locator('body').innerText();
		expect(body).not.toMatch(/to be written|TODO|coming soon|lorem ipsum/i);
		// No control on this page is labelled exactly "Run" (web/DESIGN.md §6).
		await expect(page.getByRole('button', { name: 'Run', exact: true })).toHaveCount(0);
	});
});

test.describe.configure({ mode: 'serial' });

test.describe('flow 1 — korber_env_gp160.fasta, the flagship', () => {
	test.skip(!haveExamples, 'the engine examples are not checked out beside this repository');

	test('dates 142 of 143, names the rule, opens at 1959.5, and costs no model byte', async ({ page, baseURL }) => {
		const requests = trackRequests(page);
		await page.goto('/time/');
		await page.locator('#dates input[type="file"]').first().setInputFiles(KORBER);

		const review = page.locator('#dates .review');
		await expect(review).toHaveAttribute('data-state', /review|ready/, { timeout: 20_000 });

		// The count line, and the word is sequences, never sites.
		const count = page.locator('.table .count');
		await expect(count).toHaveCount(1);
		await expect(count).toHaveText('143 of 143 sequences');

		// 142 dated, the one miss named. Review order puts it first.
		const strip = page.locator('details.strip summary');
		await expect(strip).toContainText('What we read from your files.');
		await expect(strip).toContainText('143 sequences, 142 dated');
		const firstRow = page.locator('#dates .table table tbody tr').first();
		await expect(firstRow).toContainText('CONSENSUS');
		await expect(firstRow).toContainText('no pattern matched');

		// The rule column names the LANL two-digit-year rule.
		await page.locator('input[aria-label="Search sequences"]').fill('Z59ZR');
		await expect(page.locator('#dates .table table tbody tr')).toHaveCount(1);
		await expect(page.locator('#dates .table table tbody tr').first()).toContainText('LANL two-digit year');
		await expect(page.locator('#dates .table table tbody tr').first()).toContainText('1959.5000');
		await page.locator('input[aria-label="Search sequences"]').fill('');

		// The archival anchor is offered, off, and named — and on THIS file it changes nothing,
		// which is measured, not claimed (runtime and web unit tests pin the same fact).
		const disclosure = page.locator('details.supply');
		await disclosure.locator('summary').click();
		const anchor = page.getByRole('checkbox', { name: /Z59.*ZR59.*1959.*mid-1959/is });
		await expect(anchor).not.toBeChecked();
		const before = await page.locator('#dates .table table tbody tr').allInnerTexts();
		await anchor.check();
		await expect(page.locator('.table .count')).toHaveText('143 of 143 sequences');
		expect(await page.locator('#dates .table table tbody tr').allInnerTexts()).toEqual(before);
		await anchor.uncheck();

		// The span opens at 1959.5 and section 2 says so.
		await expect(page.locator('#coverage figcaption').first()).toContainText('1959.50');

		// The gate: 1 undated sequence, so the page is not ready until the reader says to drop it.
		await expect(review).toHaveAttribute('data-state', 'review');
		await page.getByRole('checkbox', { name: /Continue without the 1 undated sequence/i }).check();
		await expect(review).toHaveAttribute('data-state', 'ready');

		// The download, and its columns.
		const download = page.waitForEvent('download');
		await page.getByRole('button', { name: 'Dates (CSV)' }).click();
		const file = await download;
		const text = readFileSync(await file.path(), 'utf8');
		const lines = text.trimEnd().split('\n');
		expect(lines[0]).toBe('sequence,date,reads_as,source,rule,read_from,imputed,name_match');
		expect(lines.length).toBe(144); // header + 143 sequences, the undated one included
		const dataLines = lines.slice(1);
		expect(dataLines.filter((l) => l.split(',')[1] !== '').length).toBe(142);
		expect(dataLines.filter((l) => l.split(',')[1] === '').length).toBe(1);
		expect(text).not.toMatch(/NaN/);

		// ---- phase 3: the ancestor date, on this same load ---------------------------------------

		const dating = page.locator('#dating');
		await expect(dating.getByRole('heading', { level: 2, name: 'Ancestor date' })).toBeVisible();
		// The root is a choice and the page says so before it offers the action.
		await expect(dating).toContainText('The root is a choice, not a datum');
		await dating.getByLabel('Root for divergence').selectOption('taxon:CONSENSUS');
		await dating.getByRole('button', { name: /^Estimate the ancestor date$/ }).click();

		// The estimate, with the numbers reproduced from the reference run.
		const verdict = dating.locator('.verdict');
		await expect(verdict).toContainText('1893.9', { timeout: 120_000 });
		await expect(verdict).toContainText('141 sequences');
		await expect(verdict).toContainText('1850.9');
		await expect(verdict).toContainText('1916.8');
		await expect(verdict).toContainText('1.169 × 10⁻³');
		await expect(verdict).toContainText('0.231');
		await expect(verdict).toContainText('CONSENSUS');

		// The three counts, and the holdout that IS the result on this dataset.
		await expect(dating).toContainText('143 sequences in the file, 142 dated, 141 in the fit.');
		await expect(dating).toContainText('Z59ZR.ZHU');
		await expect(dating).toContainText('1965.6');

		// The curvature test prefers the spline; the page quotes the straight line and says why.
		await expect(dating).toContainText('p = 0.0234');
		await expect(dating).toContainText('ΔAIC = +3.27');
		await expect(dating).toContainText('1938.8');
		await expect(dating).toContainText('Restricted spline clock');
		await expect(dating).toContainText('not computed');
		// The estimators that are not built are rows saying so, never a promise.
		await expect(dating).toContainText('Attention PGLS');
		await expect(dating).toContainText('Latent root search');
		await expect(dating.locator('svg[aria-label="TN93 divergence from the root against sampling date"]')).toBeVisible();

		// Section 4: every sequence, zero flagged, the 1959 isolate held out.
		const taxa = page.locator('#taxa');
		await expect(taxa.getByRole('heading', { level: 2, name: 'Per-sequence dates' })).toBeVisible();
		await expect(taxa.locator('table tbody tr').first()).toContainText('Z59ZR.ZHU');
		await expect(taxa.locator('table tbody tr').first()).toContainText('held out');
		expect(await taxa.locator('table tbody td', { hasText: /^flagged$/ }).count()).toBe(0);
		// `.table .count` is a page singleton (web/DESIGN.md §6); the new table uses `.table__foot`.
		await expect(page.locator('.table .count')).toHaveCount(1);

		// The reference-shaped CSV: the reference's ten columns plus ours, in alignment order.
		const datingCsv = page.waitForEvent('download');
		await taxa.getByRole('button', { name: 'Dating (CSV)' }).click();
		const csvFile = await datingCsv;
		const csv = readFileSync(await csvFile.path(), 'utf8').trimEnd().split('\n');
		expect(csv[0]).toBe(
			'taxon,sampling_date,root_divergence,fitted_divergence,predicted_date,divergence_residual,temporal_residual,z_score,is_outlier,is_holdout,prediction_method'
		);
		expect(csv.length).toBe(143);
		expect(csv[1]).toContain('A92UG.037');

		// The predicted-date column under a curved clock is not presented as dates.
		await expect(taxa.locator('.note--warn')).toContainText('The predicted dates are not dates here.');
		await expect(taxa.locator('.note--warn')).toContainText('running out of curve');

		// Nothing heavy, on the whole flow — the estimate included, which is the claim.
		expect(requests.offOrigin(new URL(baseURL!).origin)).toEqual([]);
		const heavy = requests.matching(HEAVY_ASSET);
		expect(heavy, `heavy assets during the korber flow: ${heavy.join(', ')}`).toEqual([]);
	});
});

test.describe('flow 1c — the same file, with the model', () => {
	test.skip(!haveExamples, 'the engine examples are not checked out beside this repository');

	/**
	 * THE ONLY TEST IN THIS FILE THAT EXPECTS A GRAPH TO BE FETCHED, and the assertions at the end
	 * are the point of it: exactly one `*.onnx`, and it is `general_taxa.onnx` — not the backbone,
	 * which this route has no use for, and not both.
	 *
	 * THE NUMBERS ARE THE REFERENCE'S, from `hyphaeon dating -a examples/korber_env_gp160.fasta
	 * --root-taxon CONSENSUS --no-tree --method all --cpu --distance-mode latent`
	 * (../HyphAeon/fixtures/dating/run_mrca_dating_model.json, case 001_korber_latent):
	 *
	 *     ols    1926.81  mu 5.551e-4  R² 0.140     ← the headline: the reference selects it
	 *     pgls   1633.07  [-inf, 1836.71]  g 1.72   ← slope not distinguishable from zero
	 *     spline -1974.64  interval [x, x]          ← the dead bootstrap, still in the table
	 *     latent root  α 0.05407  R +0.374  anchors led by B85US.ALA1
	 *
	 * They are quoted to the precision the page prints (one decimal on a date, four significant
	 * figures on a rate) and the chain's measured sensitivity is four to six decades below that, so
	 * a digit moving here is a real change and not float noise. The browser's ORT is a different
	 * build from the one the runtime suite measured against; if these ever part, the runtime suite's
	 * element-wise comparison against `splits.py` is where to look first.
	 */
	test('runs the two model-based estimators, loads one graph, and says what changed', async ({ page, baseURL }) => {
		test.setTimeout(360_000);
		const requests = trackRequests(page);
		await page.goto('/time/');
		await page.locator('#dates input[type="file"]').first().setInputFiles(KORBER);
		const review = page.locator('#dates .review');
		await expect(review).toHaveAttribute('data-state', /review|ready/, { timeout: 20_000 });
		await page.getByRole('checkbox', { name: /Continue without the 1 undated sequence/i }).check();
		await expect(review).toHaveAttribute('data-state', 'ready');

		const dating = page.locator('#dating');
		await dating.getByLabel('Root for divergence').selectOption('taxon:CONSENSUS');

		// The model-free estimate first, so the page has both runs to compare — and so the shift the
		// model makes to the ORDINARY fit can be asserted rather than described.
		await dating.getByRole('button', { name: /^Estimate the ancestor date$/ }).click();
		await expect(dating.locator('.verdict')).toContainText('1893.9', { timeout: 120_000 });
		// Nothing heavy yet. This is the phase-3 claim, still true after the section grew.
		expect(requests.matching(HEAVY_ASSET), 'a heavy asset before the model was asked for').toEqual([]);

		// The offer states its cost before the reader waits for it, and names the graph.
		const model = dating.locator('.model');
		await expect(model).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
		await expect(model).toContainText('7.3 MB');
		await expect(model).toContainText('981 codons');
		await expect(model).toContainText('general_taxa.onnx');

		await model.getByRole('button', { name: 'Estimate with the model as well' }).click();

		// ---- the three estimates -----------------------------------------------------------------
		const verdict = dating.locator('.verdict');
		await expect(verdict).toContainText('1926.8', { timeout: 300_000 });
		await expect(verdict).toContainText('5.551 × 10⁻⁴');
		await expect(verdict).toContainText('141 sequences');

		// Divergence stopped being a sequence distance, and the page says so in place.
		const divergence = dating.locator('.divergence');
		await expect(divergence).toContainText('not a sequence distance');
		await expect(divergence).toContainText('the ordinary one included');
		await expect(divergence).toContainText('5.407 × 10⁻²');

		// The ordinary fit moved 32.9 years without its arithmetic changing.
		await expect(dating).toContainText('1893.9 to 1926.8');
		await expect(dating).toContainText('32.9 years');
		await expect(dating).toContainText('its arithmetic did not change');

		// The disagreement is explained, not averaged.
		const agreement = dating.locator('.agreement');
		await expect(agreement).toContainText('does not average them');
		await expect(agreement).toContainText('Pagel');
		await expect(agreement).toContainText('clade-attenuation');

		// All three fits are rows, with the generalised one's half-infinite interval as a clause.
		const rows = dating.locator('table tbody tr');
		await expect(rows.filter({ hasText: 'Attention PGLS' })).toContainText('1633.1');
		await expect(rows.filter({ hasText: 'Attention PGLS' })).toContainText('no lower bound');
		await expect(rows.filter({ hasText: 'Attention PGLS' })).toContainText('Pagel λ* = 0.8591');
		// THE ONE NUMBER ON THIS PAGE THAT IS NOT ASSERTED TO A DECIMAL, and the reason is the
		// reference's conditioning rather than the port's. The latent spline's date is −beta_0/beta_1
		// on an uncentred calendar axis with beta_1 = 9.09e-6, a lever arm of about 2,000 years per
		// unit relative error in the slope; the runtime suite measured the port landing 0.38 years
		// from the reference's −1974.64 and pinning lambda* to the reference's own value moved it only
		// to 0.43, so the residual is the kernel's float32 floor. The browser lands at −1974.2. The
		// rate it is built from, which is well conditioned, IS asserted exactly.
		const splineRow = rows.filter({ hasText: 'Restricted spline clock' });
		await expect(splineRow).toContainText(/-197\d\.\d/);
		await expect(splineRow).toContainText('9.088 × 10⁻⁶');
		await expect(splineRow).toContainText('model’s covariance');
		// And "not built" no longer names them.
		await expect(dating).not.toContainText('Not built. Needs the dating graph');

		// The latent root's own table, in the reference's order.
		await expect(dating).toContainText('The root the model placed');
		await expect(dating.locator('table').last().locator('tbody tr').first()).toContainText('B85US.ALA1');

		// The provenance names the graph the session verified.
		await expect(page.locator('#data')).toContainText('general_taxa.onnx');
		await expect(page.locator('#data')).toContainText('eb44892de607');

		// The page never claims the estimate is model-free once it is not.
		await expect(dating).not.toContainText('it loaded nothing');
		await expect(dating).toContainText('Three fits, one dataset');

		// ---- exactly one graph, and the right one --------------------------------------------------
		const onnx = requests.matching(ONNX).map((u) => new URL(u).pathname);
		expect(onnx, `graphs fetched: ${onnx.join(', ')}`).toHaveLength(1);
		expect(onnx[0]).toMatch(/\/models\/general_taxa\.onnx$/);
		expect(requests.matching(ORT_FORBIDDEN)).toEqual([]);
		expect(requests.matching(HYPHY_ANY)).toEqual([]);
		expect(requests.offOrigin(new URL(baseURL!).origin)).toEqual([]);
		expect(requests.failed()).toEqual([]);

		// The words reserved for the analysis are still absent, with the model on.
		const body = await page.locator('body').innerText();
		for (const word of [/TMRCA/i, /calibrated/i, /confidence interval/i, /molecular clock estimate/i]) {
			expect(body, `the page said ${word}`).not.toMatch(word);
		}
	});
});

test.describe('flow 2 — a metadata table that agrees with the headers', () => {
	test.skip(!haveExamples, 'the engine examples are not checked out beside this repository');

	test('names the two columns it discovered and reports 98 of 98', async ({ page }) => {
		await page.goto('/time/');
		await page.locator('#dates input[type="file"]').first().setInputFiles([H5N1, H5N1_META, H5N1_TREE]);

		const review = page.locator('#dates .review');
		await expect(review).toHaveAttribute('data-state', /review|ready/, { timeout: 20_000 });
		await expect(page.locator('.table .count')).toHaveText('98 of 98 sequences');
		await expect(page.locator('details.strip summary')).toContainText('98 dated');
		await expect(page.locator('details.strip summary')).toContainText('from the metadata table');

		await page.locator('details.supply summary').click();
		await expect(page.locator('#id-column')).toHaveValue('taxon');
		await expect(page.locator('#date-column')).toHaveValue('date');

		// Every row matched exactly, so nothing in the Name match column is a warning.
		await expect(page.locator('#dates .table table tbody tr').first()).toContainText('exact');
		await expect(review).toHaveAttribute('data-state', 'ready');

		// The clock preview, off the tree that was dropped with them. MEASURED on this dataset: its
		// sampling dates span barely a year, so the fit slopes DOWN and the preview must say so
		// rather than print a rate — which is the honest answer and the one worth asserting.
		const coverage = page.locator('#coverage');
		await expect(coverage.getByRole('heading', { name: 'Clock signal' })).toBeVisible();
		await expect(coverage).toContainText('This is a diagnostic of the dates, not a dating analysis.');
		await expect(coverage).toContainText('carries no clock signal in this direction');
		await expect(coverage.locator('svg[aria-label="Root-to-tip divergence against sampling date"]')).toBeVisible();
		await expect(coverage).toContainText('the rate is per tree unit');
		// Sections 3 and 4 are present and state what they are before anything has been run.
		await expect(page.locator('#dating')).toContainText('hyphaeon dating --method all --no-tree');
		await expect(page.locator('#taxa')).toContainText('No estimate has been made yet.');

		// The words reserved for the analysis appear nowhere on the page — the two new sections
		// included, which is why this assertion is not narrowed to #coverage.
		const body = await page.locator('body').innerText();
		for (const word of [/TMRCA/i, /calibrated/i, /confidence interval/i, /molecular clock estimate/i]) {
			expect(body, `the page said ${word}`).not.toMatch(word);
		}
		expect(body).not.toMatch(/to be written|TODO|coming soon/i);
	});
});

test.describe('flow 3 — the trap: a table that names no sequence', () => {
	test.skip(!haveExamples, 'the engine examples are not checked out beside this repository');

	test('shows both name sets and says the dates came from the headers instead', async ({ page }) => {
		// The same table, keyed on accessions nothing in the alignment carries.
		const rewritten = readFileSync(H5N1_META, 'utf8')
			.split('\n')
			.map((line, i) => (i === 0 || line.trim() === '' ? line : line.replace(/^[^,]+/, `EPI_ISL_${400000 + i}`)))
			.join('\n');

		await page.goto('/time/');
		await page.locator('#dates input[type="file"]').first().setInputFiles(H5N1);
		await expect(page.locator('#dates .review')).toHaveAttribute('data-state', /review|ready/, { timeout: 20_000 });

		await page.locator('details.supply summary').click();
		await page.locator('#metadata-file').setInputFiles({
			name: 'accessions.csv',
			mimeType: 'text/csv',
			buffer: Buffer.from(rewritten, 'utf8')
		});

		// The sentence the reference never prints.
		const line = page.locator('#dates .note--warn').first();
		await expect(line).toContainText(/rows in accessions\.csv name no sequence in this alignment/, { timeout: 20_000 });
		await expect(line).toContainText('EPI_ISL_');

		// The table contributed nothing; the per-taxon header fallback did, and every row says so.
		await expect(page.locator('.table .count')).toHaveText('98 of 98 sequences');
		await expect(page.locator('#dates .table table tbody tr').first()).toContainText('header (fallback)');

		// Turning the fallback off leaves every sequence undated — what the command line would do.
		await page.getByRole('checkbox', { name: /Fill sequences the table missed from their own headers/i }).uncheck();
		await expect(page.locator('#dates .review')).toHaveAttribute('data-state', 'undated');
	});
});

test.describe('flow 4 — temporal selection', () => {
	test.skip(!haveExamples, 'the engine examples are not checked out beside this repository');

	/**
	 * THE SECOND TEST IN THIS FILE THAT EXPECTS A GRAPH TO BE FETCHED, and — as in flow 1c — the
	 * assertions at the end are half the point: exactly one `*.onnx`, and it is the BACKBONE
	 * `general.onnx`, not the dating graph, because this pillar reads `lrt` and `mean_root_attns`
	 * and the dating graph emits neither.
	 *
	 * H5N1 rather than the acceptance alignment, deliberately. `H1N1_2009_pandemic.fasta` is 4,384
	 * codons over 100 sequences and is where the runtime suite makes its element-wise comparison
	 * against `hyphaeon temporal`'s own four files, on the real graph, in Node. What a browser test
	 * can add to that is not more decimal places: it is that the section streams, that the figure
	 * counter lands where it should, that the honest sentences are printed, and that one graph is
	 * fetched. H5N1 is 566 codons over 98 sequences and exercises every one of those in a fraction
	 * of the time — and it takes the metadata-table ingestion path while it is at it.
	 *
	 * THE NUMBERS ASSERTED HERE ARE STRUCTURAL, NOT STATISTICAL. The confirmed-sweep count is
	 * thresholded on a permutation p drawn from this application's generator rather than numpy's, so
	 * it is a statistical-class quantity and asserting an exact count would be asserting a coin
	 * flip; the candidate count and the codon counts are deterministic and are asserted as numbers.
	 */
	test('streams in three payloads, numbers its figures, says what it cannot reproduce, and loads one graph', async ({ page, baseURL }) => {
		test.setTimeout(360_000);
		const requests = trackRequests(page);
		await page.goto('/time/');
		// The tree comes too, so section 2's clock preview draws and the figure counter starts at two
		// — which is what makes the assertion below about this section's four figures worth making.
		await page.locator('#dates input[type="file"]').first().setInputFiles([H5N1, H5N1_META, H5N1_TREE]);
		await expect(page.locator('#dates .review')).toHaveAttribute('data-state', 'ready', { timeout: 20_000 });

		const temporal = page.locator('#temporal');
		await expect(temporal.getByRole('heading', { level: 2, name: 'Temporal selection' })).toBeVisible();
		await expect(temporal.locator('.temporal')).toHaveAttribute('data-state', 'offered');

		// The offer states its cost as arithmetic, with both unknowable counts named as ceilings.
		await expect(temporal).toContainText('draws × candidate codons × dated sequences × grid points');
		await expect(temporal).toContainText('Both counts are ceilings');
		await expect(temporal).toContainText('temporal.py:512');
		// Two figures on the page so far — coverage and the clock preview — and neither is this
		// section's: a pending section renders no figcaption (web/DESIGN.md §3).
		await expect(page.locator('figcaption')).toHaveCount(2);
		// Nothing heavy has been fetched to make that offer.
		expect(requests.matching(HEAVY_ASSET), 'a heavy asset before the run was asked for').toEqual([]);

		// The settings disclosure names the command line's own defaults beside ours.
		await temporal.locator('details.settings summary').click();
		await expect(temporal).toContainText("the command line's own default");
		await expect(temporal).toContainText('α = 0.05');
		await temporal.getByLabel('Shuffles').selectOption('200');
		await temporal.getByLabel('Grid points').selectOption({ label: '60' });

		await temporal.getByRole('button', { name: 'Run temporal selection', exact: true }).click();
		await expect(temporal.locator('.temporal')).toHaveAttribute('data-state', 'running');

		// ---- the landed section ------------------------------------------------------------------
		const verdict = temporal.locator('.verdict');
		await expect(verdict).toBeVisible({ timeout: 300_000 });
		await expect(temporal.locator('.temporal')).toHaveAttribute('data-state', 'landed');
		// The lede states the finding and stops; which of its three forms it takes depends on how many
		// codons the null confirmed, which is a statistical-class quantity (this application's
		// generator is not numpy's), so what is asserted is that it names codons rather than a count.
		await expect(verdict).toContainText(/codon/);

		// What it actually cost replaces what it might have cost.
		await expect(temporal.locator('.measured')).toContainText(/codons scored over \d+ dated sequences/);
		await expect(temporal.locator('.measured')).toContainText('nonzero attribution entries');

		// The deterministic half, as numbers rather than as adjectives.
		const stats = temporal.locator('dl.stats');
		await expect(stats).toContainText('Sequences dated');
		await expect(stats).toContainText('Bandwidth');
		await expect(stats).toContainText('Candidates');

		// ---- figure numbering, the one thing a CSS counter breaks silently ------------------------
		const captions = page.locator('figcaption');
		await expect(captions).toHaveCount(6);
		// The number itself is CSS generated content (`.numbered figcaption b::before`, web/DESIGN.md
		// §3) and is therefore in neither `textContent` nor `getComputedStyle`, which returns the
		// unresolved `counter(figure)`. What CAN be asserted, and what actually breaks, is the thing
		// the counter counts: ONE `<b>` per figcaption. Three inline `<b>`s in one caption moved every
		// figure number after it while this suite was being written; every other emphasis inside a
		// caption is a `<strong>` for exactly that reason.
		await expect(page.locator('figcaption b')).toHaveCount(6);
		await expect(captions.nth(2)).toContainText('Selection trajectories');
		await expect(captions.nth(2)).toContainText('The y axis is not a frequency');
		await expect(captions.nth(2)).toContainText('not drawn at all');
		await expect(captions.nth(3)).toContainText('Sweep velocities, by peak date');
		await expect(captions.nth(3)).toContainText('positive part');
		await expect(captions.nth(4)).toContainText('Collective wave modes');
		await expect(captions.nth(4)).toContainText('A wave and its negative describe the same mode');
		await expect(captions.nth(5)).toContainText('What the dates add to the ordinary scan');
		await expect(captions.nth(5)).toContainText('The third gate cannot be drawn');

		// ---- the two things a reader comparing with a command-line run must be told ----------------
		const statements = temporal.locator('.statements');
		await expect(statements).toContainText('The permutation p-value comes from a different generator');
		await expect(statements).toContainText('Mersenne Twister');
		await expect(statements).toContainText('in distribution, not digit for digit');
		await expect(statements).toContainText('A wave and its negative are the same mode');
		await expect(statements).toContainText('canonical');

		// ---- the table ----------------------------------------------------------------------------
		// `.table .count` is a page singleton (web/DESIGN.md §6) and section 1's date table owns it.
		await expect(page.locator('.table .count')).toHaveCount(1);
		const table = temporal.locator('table');
		await expect(table.locator('caption')).toContainText('Every candidate codon');
		await expect(table.locator('caption')).toContainText('mean_intensity');
		// The candidate count is DETERMINISTIC — it is the energy floor over the smoothed velocities,
		// upstream of any shuffle — so it is asserted as a number. The sweep count on the same line is
		// not: it is thresholded on a permutation p drawn from this application's generator.
		await expect(temporal.locator('.table__foot')).toContainText('168 of 566 codons passed the');
		await temporal.getByRole('button', { name: 'All codons' }).click();
		await expect(temporal.locator('.table__foot')).toContainText('Showing 1–40');
		await temporal.getByRole('button', { name: 'Candidates' }).click();

		// ---- the four files are the reference's own -----------------------------------------------
		const download = page.waitForEvent('download');
		await temporal.locator('.downloads').getByRole('button', { name: 'Sites (CSV)' }).click();
		const file = await download;
		expect(file.suggestedFilename()).toBe('temporal_sites_summary.csv');
		const lines = readFileSync(await file.path(), 'utf8').trimEnd().split('\n');
		expect(lines[0]).toBe(
			'site,ref_aa,derived_aa,mutation_label,domain,cross_classification,classification,' +
				'is_confirmed_sweep,is_concordant_sweep,is_rescued_sweep,lrt,p_static,q_static,p_perm,q_perm,' +
				'r2_fpca,peak_date,peak_intensity,t_half_start,t_half_end,fwhm_years,mean_intensity,auc,' +
				'Wave_1_loading,Wave_2_loading,Wave_3_loading,Wave_4_loading'
		);
		// Every codon, in site order — the opposite convention to the table, and the note says so.
		expect(lines[1].split(',')[0]).toBe('1');
		expect(lines[lines.length - 1].split(',')[0]).toBe(String(lines.length - 1));
		await expect(temporal.locator('.downloads__note')).toContainText('byte for byte');
		await expect(temporal.locator('.downloads__note')).toContainText('selection_intensity');

		// ---- the reproduction line -----------------------------------------------------------------
		await expect(temporal.locator('pre.snippet')).toContainText('hyphaeon temporal');
		await expect(temporal.locator('pre.snippet')).toContainText('--time-points 60');
		await expect(temporal.locator('pre.snippet')).toContainText('-B 200');

		// ---- exactly one graph, and the right one ---------------------------------------------------
		const onnx = requests.matching(ONNX);
		expect(onnx, `graphs fetched: ${onnx.join(', ')}`).toHaveLength(1);
		expect(onnx[0]).toMatch(/\/models\/general\.onnx$/);
		expect(requests.matching(ORT_FORBIDDEN)).toEqual([]);
		expect(requests.matching(HYPHY_ANY)).toEqual([]);
		expect(requests.offOrigin(new URL(baseURL!).origin)).toEqual([]);
		expect(requests.failed()).toEqual([]);

		// The words reserved for the dating analysis are still absent, with the pillar run.
		const body = await page.locator('body').innerText();
		for (const word of [/TMRCA/i, /calibrated/i, /confidence interval/i, /molecular clock estimate/i]) {
			expect(body, `the page said ${word}`).not.toMatch(word);
		}
		expect(body).not.toMatch(/to be written|TODO|coming soon/i);
	});

	/**
	 * STOPPING DURING THE MODEL PASS KEEPS NOTHING, AND THE SECTION SAYS SO BY GOING BACK TO OFFERING.
	 * The other cancel — stopping the null — is the interesting one and is the runtime's contract
	 * (`runTemporalNull` catches its own abort, records the achieved count and the run finishes), but
	 * it cannot be driven reliably from a browser test here: on this alignment the whole null at 200
	 * draws is tens of milliseconds, so a click would land after it. `runtime/test/temporal-port.test.js`
	 * drives that path with an abort at a known draw and asserts what survives.
	 */
	test('stopping during the model pass leaves the section offering, not half-claiming', async ({ page }) => {
		test.setTimeout(180_000);
		await page.goto('/time/');
		await page.locator('#dates input[type="file"]').first().setInputFiles([H5N1, H5N1_META, H5N1_TREE]);
		await expect(page.locator('#dates .review')).toHaveAttribute('data-state', 'ready', { timeout: 20_000 });

		const temporal = page.locator('#temporal');
		await temporal.getByRole('button', { name: 'Run temporal selection', exact: true }).click();
		await expect(temporal.locator('.temporal')).toHaveAttribute('data-state', 'running');
		await temporal.getByRole('button', { name: 'Stop', exact: true }).click();

		await expect(temporal.locator('.temporal')).toHaveAttribute('data-state', 'offered', { timeout: 120_000 });
		await expect(temporal.locator('.verdict')).toHaveCount(0);
		await expect(page.locator('figcaption')).toHaveCount(2);
		await expect(temporal.getByRole('button', { name: 'Run temporal selection', exact: true })).toBeVisible();
	});
});
