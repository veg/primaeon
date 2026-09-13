import { describe, expect, it } from 'vitest';
import { DATE_RULES } from '@veg/hyphaeon-js';
import { RULE_LABELS, RULE_NOTES, imputationLabel, matchTierLabel, ruleLabel, sourceLabel } from './ruleLabel';
import { DATE_MATCH_TIERS, DATE_SOURCES } from '@veg/hyphaeon-runtime/dates';

describe('the rule map is total', () => {
	// The same contract lib/diagnostics/panel.ts holds for diagnostic codes: a library that gains a
	// rule must gain a sentence in the same change, or the page prints a bare identifier at a reader.
	it('has a label and a note for every DATE_RULES member', () => {
		for (const id of Object.values(DATE_RULES) as string[]) {
			expect(RULE_LABELS[id], `no label for rule ${id}`).toBeTruthy();
			expect(RULE_NOTES[id], `no note for rule ${id}`).toBeTruthy();
			expect(RULE_NOTES[id].length, `the note for ${id} is not a sentence`).toBeGreaterThan(20);
		}
	});

	it('has a label for every DATE_SOURCES member', () => {
		for (const source of DATE_SOURCES) expect(sourceLabel(source)).toBeTruthy();
	});

	it('has a label for every DATE_MATCH_TIERS member, none of them the raw id', () => {
		for (const tier of DATE_MATCH_TIERS) {
			const label = matchTierLabel(tier, true);
			expect(label).toBeTruthy();
			if (tier !== 'exact') expect(label, `tier ${tier} printed its raw id`).not.toBe(tier);
		}
	});
});

describe('the two ids that carry a claim', () => {
	// Library Q6: `out_of_range` is not `unparsed`. Losing that distinction would put "your date is
	// fine, the gate rejected it" back in the same bucket as "nothing matched".
	it('says an out-of-range year was rejected, not that no date was found', () => {
		expect(ruleLabel('out_of_range')).toBe('outside 1800–2100');
		expect(ruleLabel('unparsed')).toBe('no pattern matched');
		expect(RULE_NOTES.out_of_range).toMatch(/rejected/i);
		expect(RULE_NOTES.out_of_range).not.toMatch(/unreadable string/i);
	});

	// Library Q1: the archival anchor is a calibration, not a reading of the name.
	it('says the 1959 anchor is a hard-coded calibration', () => {
		expect(RULE_NOTES.archival_1959).toMatch(/hard-code/i);
		expect(RULE_NOTES.archival_1959).toMatch(/not a reading/i);
	});

	// Library Q2: a bare four-digit year is 1 January, not mid-year, whatever the docstring says.
	it('says a bare year is read as 1 January', () => {
		expect(RULE_NOTES.decimal_year).toMatch(/1 January/);
		expect(RULE_NOTES.header_trailing_year).toMatch(/1 January/);
	});

	// Library Q8: the Korber half-year is invented.
	it('says the LANL half-year is invented rather than read', () => {
		expect(RULE_NOTES.korber_isolate).toMatch(/invented rather than read/);
	});
});

describe('the source and imputation columns', () => {
	it('marks a header row as a fallback only when a table is loaded', () => {
		expect(sourceLabel('header', false)).toBe('header');
		expect(sourceLabel('header', true)).toBe('header (fallback)');
	});

	it('spells the three imputations the library reports', () => {
		const none = { imputed: false, imputations: { month: false, day: false, dayClamped: false } };
		expect(imputationLabel(none)).toBe('—');
		expect(imputationLabel({ imputed: true, imputations: { month: false, day: true, dayClamped: false } })).toBe('day');
		expect(imputationLabel({ imputed: true, imputations: { month: true, day: true, dayClamped: false } })).toBe('month and day');
		expect(imputationLabel({ imputed: true, imputations: { month: false, day: false, dayClamped: true } })).toBe('day clamped to 30');
		expect(imputationLabel({ imputed: true, imputations: { month: true, day: true, dayClamped: true } })).toBe(
			'month and day, day clamped to 30'
		);
	});

	it('says "not in table" for an unmatched row only while a table is loaded', () => {
		expect(matchTierLabel(null, true)).toBe('not in table');
		expect(matchTierLabel(null, false)).toBe('—');
	});
});
