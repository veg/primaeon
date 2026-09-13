/**
 * dated.test.ts — the /time example catalogue is a claim, and this is what makes it one.
 *
 * WHY THIS FILE EXISTS. `examples.json`'s `dated` array tells a reader, in a tooltip, which rule
 * each bundled example's dates are read by and what the review should say. Nothing enforced that
 * until this file: the first draft of the catalogue named `header_year_suffix` for H5N1, which is
 * not a rule the runtime has — the real one is `header_trailing_year` — and the page happily showed
 * the wrong claim in a title attribute where no reader would catch it.
 *
 * So the two things a catalogue row can lie about are pinned here. `date_rule` must be a rule the
 * runtime actually defines (RULE_LABELS is the app's own map over the library's `rule` field), and
 * every file a row names must exist under `static/gallery/inputs/` — the directory the route
 * fetches from, which is tracked precisely so /time has something to click without the engine
 * checkout beside it.
 *
 * What this deliberately does NOT do is run the ingest. That would be the stronger test and it
 * belongs in the route's own suite, where the page's fetch and classification are already driven;
 * here the point is that a row cannot name a rule or a file that does not exist, which is cheap and
 * catches the mistake that actually happened.
 */

import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import catalogue from './examples.json';
import { RULE_LABELS } from '$lib/time/ruleLabel';
import type { DatedExample } from './types';

const DATED = catalogue.dated as DatedExample[];
const INPUTS = join(process.cwd(), 'static', 'gallery', 'inputs');

describe('the /time dated example catalogue', () => {
	it('is not empty — /time shipped once with nothing to click', () => {
		expect(DATED.length).toBeGreaterThan(0);
	});

	it.each(DATED.map((e) => [e.id, e] as const))(
		'%s names a rule the runtime defines',
		(_id, example) => {
			expect(
				Object.keys(RULE_LABELS),
				`${example.id} claims rule '${example.date_rule}', which no rule table defines`
			).toContain(example.date_rule);
		}
	);

	it.each(DATED.map((e) => [e.id, e] as const))('%s names files that exist', (_id, example) => {
		expect(existsSync(join(INPUTS, example.alignment)), `${example.alignment} is missing`).toBe(
			true
		);
		if (example.tree) {
			expect(existsSync(join(INPUTS, example.tree)), `${example.tree} is missing`).toBe(true);
		}
	});

	it('carries one example per rule, which is the reason there are three', () => {
		const rules = DATED.map((e) => e.date_rule);
		expect(new Set(rules).size).toBe(rules.length);
	});
});
