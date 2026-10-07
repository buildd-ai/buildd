import { describe, it, expect } from 'bun:test';
import {
  planMigrations,
  findBaselineMillis,
  PreBaselineDatabaseError,
  LAST_RELEASE_BEFORE_SQUASH,
  type MigrationFile,
} from '../db/migrate-plan';

/**
 * Regression guard for the tasks_source_external_idx incident (2026-07-19):
 * a custom migration runner (introduced by #1288) treated "no tracking row"
 * as "never applied" and blindly replayed migration 0000's raw SQL — most of
 * which is `IF NOT EXISTS` and no-ops harmlessly, except the one statement
 * that recreates a unique index on a column ("source_id") a later migration
 * (0002) had already dropped for good. That crashed `db:migrate` outright.
 */
function migration(hash: string, folderMillis: number): MigrationFile {
  return { hash, folderMillis, sql: [] };
}

describe('planMigrations', () => {
  it('never re-runs a migration older than the high-water mark just because its row is missing', () => {
    const migrations = [
      migration('a', 100), // 0000 — DDL already ran years ago, row lost
      migration('b', 200), // 0002 — tracked normally
      migration('c', 300), // new migration, genuinely pending
    ];
    const appliedRows = [{ created_at: 200 }];

    const plan = planMigrations(migrations, appliedRows);

    expect(plan.toRun.map((m) => m.folderMillis)).toEqual([300]);
    expect(plan.toBackfill.map((m) => m.folderMillis)).toEqual([100]);
  });

  it('runs every migration on a genuinely fresh database', () => {
    const migrations = [migration('a', 100), migration('b', 200)];

    const plan = planMigrations(migrations, []);

    expect(plan.toRun.map((m) => m.folderMillis)).toEqual([100, 200]);
    expect(plan.toBackfill).toEqual([]);
  });

  it('skips migrations that already have a tracking row', () => {
    const migrations = [migration('a', 100), migration('b', 200)];
    const appliedRows = [{ created_at: 100 }, { created_at: 200 }];

    const plan = planMigrations(migrations, appliedRows);

    expect(plan.toRun).toEqual([]);
    expect(plan.toBackfill).toEqual([]);
  });

  it('treats string created_at values the same as numeric ones', () => {
    const migrations = [migration('a', 100)];
    const appliedRows = [{ created_at: '100' }];

    const plan = planMigrations(migrations, appliedRows);

    expect(plan.toRun).toEqual([]);
    expect(plan.toBackfill).toEqual([]);
  });

  it('runs a migration newer than the high-water mark even with gaps below it', () => {
    const migrations = [migration('a', 100), migration('b', 200), migration('c', 300)];
    // Only 200 is tracked; 100 is a legacy gap, 300 is new.
    const appliedRows = [{ created_at: 200 }];

    const plan = planMigrations(migrations, appliedRows);

    expect(plan.toRun.map((m) => m.folderMillis)).toEqual([300]);
    expect(plan.toBackfill.map((m) => m.folderMillis)).toEqual([100]);
  });
});

/**
 * The squashed baseline (drizzle/0000_baseline.sql) carries the `when` of the
 * last migration it absorbed, so every database that already ran that migration
 * holds its tracking row and skips it. It may only ever run on an EMPTY tracking
 * table: on a database that stopped partway through the absorbed history it
 * would collide with half of what is already there — or worse, half-apply.
 */
describe('planMigrations with a squashed baseline', () => {
  const BASELINE = 500;
  const tree = () => [migration('baseline', BASELINE), migration('later-1', 600), migration('later-2', 700)];

  it('runs the baseline and everything after it on a fresh database', () => {
    const plan = planMigrations(tree(), [], { baselineMillis: BASELINE });

    expect(plan.toRun.map((m) => m.folderMillis)).toEqual([BASELINE, 600, 700]);
    expect(plan.toBackfill).toEqual([]);
  });

  it('skips the baseline on a database that already applied the cut-point migration', () => {
    // Pre-squash history: many rows, the newest of which is the cut point.
    const rows = [{ created_at: 100 }, { created_at: 300 }, { created_at: BASELINE }];

    const plan = planMigrations(tree(), rows, { baselineMillis: BASELINE });

    expect(plan.toRun.map((m) => m.folderMillis)).toEqual([600, 700]);
    expect(plan.toBackfill).toEqual([]);
  });

  it('is a no-op on a database that is fully up to date', () => {
    const rows = [{ created_at: 100 }, { created_at: BASELINE }, { created_at: 600 }, { created_at: 700 }];

    const plan = planMigrations(tree(), rows, { baselineMillis: BASELINE });

    expect(plan.toRun).toEqual([]);
    expect(plan.toBackfill).toEqual([]);
  });

  it('never offers the baseline as a backfill candidate, even when its row is missing above the mark', () => {
    // The cut-point row was lost but later migrations ran: the DB is past the
    // baseline. Introspecting a whole-schema dump to "prove" it would be
    // meaningless, and re-running it would explode.
    const rows = [{ created_at: 100 }, { created_at: 600 }];

    const plan = planMigrations(tree(), rows, { baselineMillis: BASELINE });

    expect(plan.toBackfill).toEqual([]);
    expect(plan.toRun.map((m) => m.folderMillis)).toEqual([700]);
  });

  it('still backfill-checks a post-baseline migration below the mark', () => {
    const rows = [{ created_at: BASELINE }, { created_at: 700 }];

    const plan = planMigrations(tree(), rows, { baselineMillis: BASELINE });

    expect(plan.toRun).toEqual([]);
    expect(plan.toBackfill.map((m) => m.folderMillis)).toEqual([600]);
  });

  it('refuses a partially migrated database whose high-water mark is below the baseline', () => {
    const rows = [{ created_at: 100 }, { created_at: 300 }];

    expect(() => planMigrations(tree(), rows, { baselineMillis: BASELINE })).toThrow(PreBaselineDatabaseError);
  });

  it('names the release to upgrade through first', () => {
    let message = '';
    try {
      planMigrations(tree(), [{ created_at: 300 }], { baselineMillis: BASELINE });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain(LAST_RELEASE_BEFORE_SQUASH);
    expect(message).toMatch(/upgrade/i);
  });

  it('rejects a baseline that is not the first migration in the tree', () => {
    const migrations = [migration('early', 100), migration('baseline', BASELINE)];

    expect(() => planMigrations(migrations, [], { baselineMillis: BASELINE })).toThrow(/first/);
  });
});

describe('findBaselineMillis', () => {
  const entry = (idx: number, when: number, extra: Record<string, unknown> = {}) => ({
    idx,
    when,
    tag: `${String(idx).padStart(4, '0')}_x`,
    ...extra,
  });

  it('returns the when of the entry flagged baseline', () => {
    expect(findBaselineMillis({ entries: [entry(0, 500, { baseline: true }), entry(251, 600)] })).toBe(500);
  });

  it('returns undefined for a tree with no baseline (pre-squash history)', () => {
    expect(findBaselineMillis({ entries: [entry(0, 100), entry(1, 200)] })).toBeUndefined();
  });

  it('rejects a baseline flag on anything but the first entry', () => {
    expect(() => findBaselineMillis({ entries: [entry(0, 100), entry(1, 200, { baseline: true })] })).toThrow(/first/);
  });

  it('rejects two baselines', () => {
    expect(() =>
      findBaselineMillis({ entries: [entry(0, 100, { baseline: true }), entry(1, 200, { baseline: true })] })
    ).toThrow();
  });
});
