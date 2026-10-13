import { describe, it, expect } from 'bun:test';
import {
  PreBaselineDatabaseError,
  LAST_RELEASE_BEFORE_SQUASH,
  planMigrationsV1,
} from '../db/migrate-plan';
import { predictedFolderName, type LegacyMigration } from '../db/legacy-migrations';
import type { TreeMigration } from '../db/migrate-tree';

// ─── drizzle v1 folder layout ────────────────────────────────────────────────
//
// After the cutover a migration is applied iff a tracking row carries its
// folder name, or (legacy history only) a row's created_at equals its exact-ms
// journal `when` from the legacy map. Each case below is one way that rule can
// go wrong: replay (#1288 class) in one direction, silent skip (0067 class) in
// the other.

const sec = (s: number) => Date.UTC(2026, 0, 1) + s * 1000;
const legacyEntry = (tag: string, when: number, baseline = false): LegacyMigration => ({
  name: predictedFolderName(tag, when),
  tag,
  when,
  hash: `${tag}`.padEnd(64, '0').slice(0, 64).replace(/[^0-9a-f]/g, 'a'),
  ...(baseline ? { baseline: true as const } : {}),
});

const LEGACY: LegacyMigration[] = [
  legacyEntry('0000_baseline', sec(10) + 111, true),
  legacyEntry('0001_one', sec(20) + 222),
  legacyEntry('0002_two', sec(30) + 333),
  legacyEntry('0003_three', sec(40) + 444),
];
const REBASE = '20260601000000_snapshot_rebase';
const POST = '20260602000000_add_widgets';

function folderOf(name: string, hash: string, sql: string[]): TreeMigration {
  return { name, hash, folderMillis: Date.UTC(+name.slice(0, 4), +name.slice(4, 6) - 1, +name.slice(6, 8), +name.slice(8, 10), +name.slice(10, 12), +name.slice(12, 14)), sql };
}
const TREE: TreeMigration[] = [
  ...LEGACY.map((e) => folderOf(e.name, e.hash, [`-- ${e.tag}\nSELECT 1;`])),
  folderOf(REBASE, 'r'.repeat(64), ['-- snapshot rebase: no DDL\n']),
  folderOf(POST, 'p'.repeat(64), ['ALTER TABLE "w" ADD COLUMN "c" text;']),
];

/** A row the old migrator wrote: ms when, no name. */
const oldRow = (e: LegacyMigration) => ({ name: null, hash: e.hash, created_at: String(e.when) });
/** A row the v1 migrator wrote. */
const v1Row = (name: string, createdAt: number) => ({ name, hash: 'h', created_at: createdAt });

const names = (ms: readonly TreeMigration[]) => ms.map((m) => m.name);

describe('planMigrationsV1', () => {
  it('fresh database: every legacy migration runs in map order, then post-cutover by name', () => {
    const plan = planMigrationsV1(TREE, [], LEGACY);
    expect(names(plan.toRun)).toEqual([...LEGACY.map((e) => e.name), POST]);
    expect(names(plan.toRecordOnly)).toEqual([REBASE]);
    expect(plan.toBackfill).toEqual([]);
    expect(plan.nameUpdates).toEqual([]);
  });

  it('legacy migrations record their exact-ms when as created_at, so the old migrator still recognises them', () => {
    const plan = planMigrationsV1(TREE, [], LEGACY);
    expect(plan.toRun.slice(0, LEGACY.length).map((m) => m.folderMillis)).toEqual(LEGACY.map((e) => e.when));
    expect(plan.toRun.at(-1)!.folderMillis).toBe(Date.UTC(2026, 5, 2));
  });

  it('legacy exact-ms rows count as applied (and get named); nothing replays on a fully migrated DB', () => {
    const plan = planMigrationsV1(TREE, LEGACY.map(oldRow), LEGACY);
    expect(plan.toRun.map((m) => m.name)).toEqual([POST]);
    expect(plan.toBackfill).toEqual([]);
    expect(plan.nameUpdates).toEqual(LEGACY.map((e) => ({ when: e.when, name: e.name })));
    expect(plan.unrecordedLegacy).toEqual([]);
  });

  it('a row matching only to the second is NOT a legacy match (keying on folderMillis would be)', () => {
    const rows = [...LEGACY.slice(0, 3).map(oldRow), { name: null, hash: 'x', created_at: sec(40) }];
    const plan = planMigrationsV1(TREE, rows, LEGACY);
    // 0003's ms when is sec(40)+444; a row at exactly sec(40) is someone else's.
    expect(plan.toRun.map((m) => m.name)).toContain(LEGACY[3]!.name);
  });

  it('name-keyed rows count as applied', () => {
    const rows = [...LEGACY.map((e) => v1Row(e.name, e.when)), v1Row(REBASE, 0), v1Row(POST, 0)];
    const plan = planMigrationsV1(TREE, rows, LEGACY);
    expect(plan.toRun).toEqual([]);
    expect(plan.toRecordOnly).toEqual([]);
    expect(plan.nameUpdates).toEqual([]);
  });

  it('legacy row lost below the legacy mark: backfill candidate (with evidence), never a replay', () => {
    const rows = [LEGACY[0]!, LEGACY[1]!, LEGACY[3]!].map(oldRow);
    const plan = planMigrationsV1(TREE, rows, LEGACY);
    expect(names(plan.toBackfill)).toEqual([LEGACY[2]!.name]);
    expect(plan.toBackfill[0]!.folderMillis).toBe(LEGACY[2]!.when);
    expect(plan.toRun.map((m) => m.name)).toEqual([POST]);
  });

  it('legacy migration above the legacy mark (DB several releases behind): runs, in legacy order', () => {
    const rows = LEGACY.slice(0, 2).map(oldRow);
    const plan = planMigrationsV1(TREE, rows, LEGACY);
    expect(names(plan.toRun)).toEqual([LEGACY[2]!.name, LEGACY[3]!.name, POST]);
    expect(plan.toBackfill).toEqual([]);
  });

  it('once anything post-cutover is recorded, a missing legacy row is a backfill candidate even above the mark', () => {
    // Every legacy migration ran before the cutover release recorded its first
    // post-cutover row, so a lost row here cannot mean "never ran".
    const rows = [...LEGACY.slice(0, 3).map(oldRow), v1Row(REBASE, Date.UTC(2026, 5, 1))];
    const plan = planMigrationsV1(TREE, rows, LEGACY);
    expect(names(plan.toBackfill)).toEqual([LEGACY[3]!.name]);
    expect(names(plan.toRun)).toEqual([POST]);
  });

  it('post-cutover with no row runs regardless of its timestamp (no high-water mark after cutover)', () => {
    const late = '20200101000000_late_branch';
    const tree = [...TREE, folderOf(late, 'l'.repeat(64), ['ALTER TABLE "w" ADD COLUMN "d" text;'])];
    const rows = [...LEGACY.map(oldRow), v1Row(REBASE, 1), v1Row(POST, 2)];
    const plan = planMigrationsV1(tree, rows, LEGACY);
    expect(names(plan.toRun)).toEqual([late]);
    expect(plan.toBackfill).toEqual([]);
  });

  it('comment-only post-cutover migrations are recorded without execution', () => {
    const rows = [...LEGACY.map(oldRow), v1Row(POST, 2)];
    const plan = planMigrationsV1(TREE, rows, LEGACY);
    expect(names(plan.toRecordOnly)).toEqual([REBASE]);
    expect(plan.toRun).toEqual([]);
  });

  it('pre-baseline database: throws before emitting any name update', () => {
    const preSquash = [{ name: null, hash: 'old', created_at: sec(1) }, { name: null, hash: 'old', created_at: sec(2) }];
    let plan: unknown;
    expect(() => {
      plan = planMigrationsV1(TREE, preSquash, LEGACY);
    }).toThrow(PreBaselineDatabaseError);
    expect(plan).toBeUndefined();
  });

  it('skips the baseline on a DB past the cut point even if the baseline row itself was lost', () => {
    const rows = LEGACY.slice(1).map(oldRow);
    const plan = planMigrationsV1(TREE, rows, LEGACY);
    expect(names(plan.toRun)).toEqual([POST]);
    expect(plan.toBackfill).toEqual([]);
    expect(plan.unrecordedLegacy).toEqual([LEGACY[0]!.name]);
  });

  it('historical rows outside the map (pre-squash history) are ignored, not named', () => {
    const rows = [{ name: null, hash: 'pre', created_at: sec(5) }, ...LEGACY.map(oldRow)];
    const plan = planMigrationsV1(TREE, rows, LEGACY);
    expect(plan.nameUpdates.map((u) => u.when)).toEqual(LEGACY.map((e) => e.when));
    expect(names(plan.toRun)).toEqual([POST]);
  });

  it('refuses a row whose name disagrees with the legacy map at the same when', () => {
    const rows = [...LEGACY.map(oldRow), { name: '20990101000000_impostor', hash: 'x', created_at: LEGACY[2]!.when }];
    expect(() => planMigrationsV1(TREE, rows, LEGACY)).toThrow(/disagree/);
  });

  it('reports (does not fail on) a legacy row whose hash differs: 0079-0081 were edited in place in #1288', () => {
    const rows = LEGACY.map((e, i) => (i === 2 ? { ...oldRow(e), hash: 'edited' } : oldRow(e)));
    const plan = planMigrationsV1(TREE, rows, LEGACY);
    expect(plan.hashMismatches).toEqual([LEGACY[2]!.name]);
  });

  it('compares created_at numerically whether the driver returns a string or a number', () => {
    const rows = LEGACY.map((e) => ({ name: null, hash: e.hash, created_at: e.when }));
    expect(planMigrationsV1(TREE, rows, LEGACY).toRun.map((m) => m.name)).toEqual([POST]);
  });

  it('refuses a tree that disagrees with the legacy map', () => {
    expect(() => planMigrationsV1(TREE.slice(1), [], LEGACY)).toThrow(/no folder/);
  });

  it('a tree with no legacy history plans purely by name', () => {
    const tree = [folderOf(POST, 'p'.repeat(64), ['SELECT 1;'])];
    expect(names(planMigrationsV1(tree, [], []).toRun)).toEqual([POST]);
    expect(planMigrationsV1(tree, [v1Row(POST, 0)], []).toRun).toEqual([]);
  });
});
