import { describe, expect, it } from 'vitest';
import { DATE_RULES } from '@veg/hyphaeon-js';
import { RULE_LABELS, RULE_NOTES, SOURCE_LABELS, imputationLabel, matchTierLabel, ruleLabel, sourceLabel } from './ruleLabel';
import { BEAST_DATE_RULE_IDS, BEAST_MATCH_TIERS, DATE_MATCH_TIERS, DATE_SOURCES } from '@veg/hyphaeon-runtime/dates';

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

	// The three ids that are NOT the library's: a BEAST date is converted by the reference's own
	// `_parse_numeric_or_calendar_date` (dataset.py:62-81), so `DATE_RULES` will never name them and
	// the totality test above cannot see them. They need the same contract.
	it('has a label and a note for every BEAST rule id', () => {
		expect(BEAST_DATE_RULE_IDS.length).toBe(3);
		for (const id of BEAST_DATE_RULE_IDS) {
			expect(RULE_LABELS[id], `no label for rule ${id}`).toBeTruthy();
			expect(RULE_NOTES[id], `no note for rule ${id}`).toBeTruthy();
			expect(RULE_NOTES[id].length, `the note for ${id} is not a sentence`).toBeGreaterThan(20);
			// Each one says BEAST out loud, because the whole point of the id is which parser produced
			// the number the reader is looking at.
			expect(RULE_LABELS[id]).toMatch(/BEAST/);
		}
	});

	// `sourceLabel` falls back to the id, so "truthy" alone would pass for a source nobody has worded
	// yet (it did, for `beast`). The contract is an ENTRY in the map; `header` and `none` are their
	// own English words and are allowed to equal their ids.
	it('has an explicit entry in SOURCE_LABELS for every DATE_SOURCES member', () => {
		for (const source of DATE_SOURCES) {
			expect(SOURCE_LABELS[source], `no label for source ${source}`).toBeTruthy();
			expect(sourceLabel(source)).toBe(SOURCE_LABELS[source]);
		}
		expect(SOURCE_LABELS.beast).toBe('BEAST XML');
	});

	it('has a label for every BEAST_MATCH_TIERS member', () => {
		for (const tier of BEAST_MATCH_TIERS) {
			const label = matchTierLabel(tier, true);
			expect(label).toBeTruthy();
			if (tier !== 'exact') expect(label, `tier ${tier} printed its raw id`).not.toBe(tier);
		}
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

	// A BEAST run has no table; naming one would send a reader looking for a file they never dropped.
	it('names the loaded document in "not in …" rather than always saying table', () => {
		expect(matchTierLabel(null, true, 'the XML')).toBe('not in the XML');
		expect(matchTierLabel(null, false, 'the XML')).toBe('—');
	});

	it('spells the BEAST-only seq_ tier rather than printing its id', () => {
		expect(matchTierLabel('seq_prefix_stripped', true)).toBe('seq_ prefix stripped');
	});
});
