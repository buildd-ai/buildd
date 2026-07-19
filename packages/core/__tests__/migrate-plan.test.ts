import { describe, it, expect } from 'bun:test';
import { planMigrations, type MigrationFile } from '../db/migrate-plan';

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
