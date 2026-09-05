/**
 * index.test.ts — the caveats module resolves every reference in web/caveats.json.
 *
 * WHY THIS FILE EXISTS. scripts/check-caveats.mjs guards the build; this guards the module's
 * contract from inside vitest, where the report and methods page consume it: the pillar key list
 * here and in the script agree, every pillar with a section has caveats, every caveat's table and
 * source resolve, and the newest set is the manifest's model_version when a manifest is present.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	CAVEAT_SETS,
	MODEL_VERSIONS,
	PILLAR_KEYS,
	caveatById,
	caveatsFor,
	caveatsForModel,
	latestCaveats,
	sourceLabel,
	tableFor
} from './index';

const manifestPath = resolve(__dirname, '../../../static/models/manifest.json');

describe('caveats.json through the module', () => {
	it('has at least one model version and the latest is a complete set', () => {
		expect(MODEL_VERSIONS.length).toBeGreaterThan(0);
		const set = latestCaveats();
		expect(set.model_version).toBe(MODEL_VERSIONS[MODEL_VERSIONS.length - 1]);
		expect(set.caveats.length).toBeGreaterThan(0);
		expect(Object.keys(set.tables).length).toBeGreaterThan(0);
		expect(set.model_card.is_surrogate).toBe(true);
		expect(set.model_card.surrogate_for).toBe('MEME');
	});

	it('tags every caveat with known pillars and a resolving source', () => {
		for (const set of Object.values(CAVEAT_SETS)) {
			for (const c of set.caveats) {
				expect(c.pillars.length).toBeGreaterThan(0);
				for (const p of c.pillars) expect(PILLAR_KEYS).toContain(p);
				expect(set.sources[c.source], `${c.id} source`).toBeTypeOf('string');
				expect(sourceLabel(c, set)).not.toBe(c.source);
				if (c.table) expect(tableFor(c, set), `${c.id} table`).not.toBeNull();
			}
		}
	});

	it('leaves no rendered pillar without caveats', () => {
		for (const p of PILLAR_KEYS) {
			if (p === 'general') continue;
			expect(caveatsFor(p).length, p).toBeGreaterThan(0);
		}
	});

	it('keeps table rows as wide as their columns', () => {
		for (const set of Object.values(CAVEAT_SETS)) {
			for (const [name, t] of Object.entries(set.tables)) {
				for (const row of t.rows) expect(row.length, name).toBe(t.columns.length);
			}
		}
	});

	it('finds the load-bearing caveats by id', () => {
		for (const id of ['surrogate', 'calibration-regime', 'mds-sign', 'busted-head-nondeterministic', 'p-perm-monte-carlo']) {
			expect(caveatById(id), id).not.toBeNull();
		}
		expect(caveatsForModel('no-such-version')).toBeNull();
		expect(caveatsForModel(null)).toBeNull();
	});

	it('matches the served manifest when one is present', () => {
		if (!existsSync(manifestPath)) return;
		const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
		const set = caveatsForModel(manifest.model_version);
		expect(set, `caveats for ${manifest.model_version}`).not.toBeNull();
		expect(set!.reference_version).toBe(manifest.reference_version);
		for (const [name, v] of Object.entries(manifest.variants as Record<string, { onnx_sha256: string }>)) {
			expect(v.onnx_sha256.startsWith(set!.model_card.variants[name].onnx_sha256_prefix), name).toBe(true);
		}
	});
});
