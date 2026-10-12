import { describe, it, expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertLegacyMapMatchesTree,
  legacyMapFromJournal,
  loadLegacyMap,
  predictedFolderName,
  validateLegacyMap,
  type LegacyMigration,
} from '../db/legacy-migrations';
import type { TreeMigration } from '../db/migrate-tree';

/**
 * The legacy map is how the v1 migrator recognises history applied before the
 * cutover: tracking rows written by the old migrator carry the journal `when`
 * in ms and no name, while `drizzle-kit up` names folders to the second. Every
 * rule here guards one way that recognition could go wrong in silence.
 */

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

const T0 = Date.UTC(2026, 0, 1, 0, 0, 0) + 123;
const T1 = Date.UTC(2026, 0, 2, 0, 0, 0) + 456;

function entry(tag: string, when: number, sql: string, baseline = false): LegacyMigration {
  return { name: predictedFolderName(tag, when), tag, when, hash: sha(sql), ...(baseline ? { baseline } : {}) };
}

describe('predictedFolderName', () => {
  it('is UTC-second(when) + the tag without its NNNN_ index (what drizzle-kit up produces)', () => {
    expect(predictedFolderName('0007_brave_otter', T0)).toBe('20260101000000_brave_otter');
  });
});

describe('legacyMapFromJournal', () => {
  const journal = {
    entries: [
      { idx: 1, when: T1, tag: '0001_next' },
      { idx: 0, when: T0, tag: '0000_baseline', baseline: true },
    ],
  };
  const sql: Record<string, string> = { '0000_baseline': 'CREATE TABLE a ();', '0001_next': 'ALTER TABLE a ADD COLUMN b int;' };

  it('emits journal order with ms when, sha256, baseline flag and predicted name', () => {
    expect(legacyMapFromJournal(journal, (t) => sql[t]!)).toEqual([
      entry('0000_baseline', T0, sql['0000_baseline']!, true),
      entry('0001_next', T1, sql['0001_next']!),
    ]);
  });

  it('refuses two entries in the same second: up would give both the same folder prefix', () => {
    const clash = { entries: [{ idx: 0, when: T0, tag: '0000_a' }, { idx: 1, when: T0 + 1, tag: '0001_b' }] };
    expect(() => legacyMapFromJournal(clash, () => 'SELECT 1;')).toThrow(/same second/);
  });
});

describe('validateLegacyMap', () => {
  const good = [entry('0000_baseline', T0, 'x', true), entry('0001_next', T1, 'y')];

  it('accepts a well-formed map, and an empty one (a tree with no legacy history)', () => {
    expect(validateLegacyMap(good)).toEqual(good);
    expect(validateLegacyMap([])).toEqual([]);
  });

  it('refuses a baseline that is not the first entry', () => {
    expect(() => validateLegacyMap([good[1], good[0]])).toThrow(/baseline/);
  });

  it('refuses duplicate names or whens', () => {
    expect(() => validateLegacyMap([good[1], good[1]])).toThrow(/duplicate name/);
    const sameWhen = { ...entry('0002_other', T1, 'z') };
    expect(() => validateLegacyMap([good[1], sameWhen])).toThrow(/duplicate when/);
  });

  it('refuses a name whose prefix does not match its when (the exact-ms lookup would key the wrong folder)', () => {
    expect(() => validateLegacyMap([{ ...good[1]!, when: T1 + 5_000 }])).toThrow(/prefix/);
  });

  it('refuses a malformed entry', () => {
    expect(() => validateLegacyMap([{ name: 'x' }])).toThrow();
    expect(() => validateLegacyMap({})).toThrow(/array/);
  });
});

describe('loadLegacyMap', () => {
  it('refuses a missing file instead of reading it as "no legacy history" (that would replay every legacy folder)', () => {
    expect(() => loadLegacyMap('/nonexistent/legacy-migrations.json')).toThrow(/legacy migration map/);
  });

  it('loads and validates', () => {
    const dir = mkdtempSync(join(tmpdir(), 'legacy-map-'));
    try {
      const path = join(dir, 'legacy-migrations.json');
      const map = [entry('0000_baseline', T0, 'x', true)];
      writeFileSync(path, JSON.stringify(map));
      expect(loadLegacyMap(path)).toEqual(map);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('assertLegacyMapMatchesTree', () => {
  const sqlText = 'CREATE TABLE a ();';
  const legacy = [entry('0000_baseline', T0, sqlText, true)];
  const tree: TreeMigration[] = [{ name: legacy[0]!.name, hash: sha(sqlText), folderMillis: 0, sql: [sqlText] }];

  it('passes when every legacy entry has its folder with identical bytes', () => {
    expect(() => assertLegacyMapMatchesTree(legacy, tree)).not.toThrow();
  });

  it('refuses a legacy entry whose folder is missing', () => {
    expect(() => assertLegacyMapMatchesTree(legacy, [])).toThrow(/no folder/);
  });

  it('refuses a legacy folder whose SQL was edited after the cutover', () => {
    expect(() => assertLegacyMapMatchesTree(legacy, [{ ...tree[0]!, hash: sha('changed') }])).toThrow(/hash/);
  });
});
