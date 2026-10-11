import { describe, it, expect } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  backfillTrackingRows,
  ciCloneApplyAbsentEnabled,
  CI_CLONE_APPLY_ABSENT_ENV,
  emptyDbShape,
  evaluateBackfill,
  type DbShape,
} from '../db/migrate-backfill';
import { executionOrder, type MigrationFile } from '../db/migrate-plan';

/**
 * The Visual QA clone flag (MIGRATION_CI_CLONE_APPLY_ABSENT).
 *
 * visual-qa.yml clones prod's schema and runs the dispatched branch's
 * migrations on it. A mission branch often carries a migration generated
 * before dev's newest released one, so on the clone it sits below the
 * high-water mark with no tracking row and its DDL absent. The migrator
 * refuses that as a contradicted backfill, which is right for prod and stops
 * every mission-branch capture.
 *
 * Under the flag, and only in GitHub Actions, a migration whose DDL is WHOLLY
 * absent is executed in journal order instead. Partially-present DDL and
 * unverifiable SQL are still refused, and nothing changes without the flag.
 */

function shape(partial: Partial<DbShape>): DbShape {
  return { ...emptyDbShape(), ...partial };
}

function migration(hash: string, folderMillis: number, sql: string[]): MigrationFile {
  return { hash, folderMillis, sql };
}

function recorder() {
  const recorded: number[] = [];
  return { recorded, record: async (m: MigrationFile) => void recorded.push(m.folderMillis) };
}

// The shape of the migration that blocked the failure-sentinel mission audit:
// one new table, its foreign keys and indexes. Names here are illustrative.
const NEW_TABLE = migration('incidents', 100, [
  'CREATE TABLE "incidents" ("id" uuid PRIMARY KEY NOT NULL, "workspace_id" uuid NOT NULL);',
  'DO $$ BEGIN\n ALTER TABLE "incidents" ADD CONSTRAINT "incidents_ws_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id");\nEXCEPTION\n WHEN duplicate_object THEN null;\nEND $$;',
  'CREATE INDEX "incidents_ws_idx" ON "incidents" USING btree ("workspace_id");',
]);

describe('evaluateBackfill marks wholly-absent DDL', () => {
  it('is absent when no assertion holds', () => {
    const evaluation = evaluateBackfill(NEW_TABLE.sql, shape({ tables: new Set(['workspaces']) }));
    expect(evaluation.verdict).toBe('contradicted');
    expect(evaluation.absent).toBe(true);
  });

  it('is not absent when part of the DDL is already there', () => {
    const evaluation = evaluateBackfill(
      NEW_TABLE.sql,
      shape({ tables: new Set(['workspaces', 'incidents']) }),
    );
    expect(evaluation.verdict).toBe('contradicted');
    expect(evaluation.absent).toBe(false);
  });

  it('is not absent when verified', () => {
    const evaluation = evaluateBackfill(
      ['ALTER TABLE "tasks" ADD COLUMN "a" text;'],
      shape({ columns: new Set(['tasks.a']) }),
    );
    expect(evaluation.absent).toBe(false);
  });
});

describe('backfillTrackingRows with applyAbsent (CI clone only)', () => {
  it('without the flag, a wholly-absent migration is still refused (prod behaviour)', async () => {
    const { recorded, record } = recorder();
    await expect(
      backfillTrackingRows({ toBackfill: [NEW_TABLE], shape: shape({}), record }),
    ).rejects.toThrow(/Refusing to backfill/);
    expect(recorded).toEqual([]);
  });

  it('with the flag, hands a wholly-absent migration back to execute and records nothing for it', async () => {
    const { recorded, record } = recorder();
    const result = await backfillTrackingRows({
      toBackfill: [NEW_TABLE],
      shape: shape({ tables: new Set(['workspaces']) }),
      record,
      applyAbsent: true,
    });
    expect(result.toApply.map((m) => m.folderMillis)).toEqual([100]);
    // The row is written by the executor after the SQL succeeds, never here.
    expect(recorded).toEqual([]);
    expect(result.recorded).toBe(0);
  });

  it('with the flag, still records verified migrations and applies only the absent one', async () => {
    const { recorded, record } = recorder();
    const result = await backfillTrackingRows({
      toBackfill: [migration('present', 50, ['ALTER TABLE "tasks" ADD COLUMN "a" text;']), NEW_TABLE],
      shape: shape({ columns: new Set(['tasks.a']) }),
      record,
      applyAbsent: true,
    });
    expect(recorded).toEqual([50]);
    expect(result.toApply.map((m) => m.folderMillis)).toEqual([100]);
  });

  it('with the flag, still refuses partially-present DDL and writes nothing', async () => {
    const { recorded, record } = recorder();
    await expect(
      backfillTrackingRows({
        toBackfill: [migration('present', 50, ['ALTER TABLE "tasks" ADD COLUMN "a" text;']), NEW_TABLE],
        shape: shape({ columns: new Set(['tasks.a']), tables: new Set(['incidents']) }),
        record,
        applyAbsent: true,
      }),
    ).rejects.toThrow(/partially present/);
    expect(recorded).toEqual([]);
  });

  it('with the flag, still refuses unverifiable SQL', async () => {
    const { recorded, record } = recorder();
    await expect(
      backfillTrackingRows({
        toBackfill: [migration('dml', 100, ['UPDATE tasks SET x = 1;'])],
        shape: shape({}),
        record,
        applyAbsent: true,
      }),
    ).rejects.toThrow(/unverifiable/i);
    expect(recorded).toEqual([]);
  });
});

describe('ciCloneApplyAbsentEnabled', () => {
  it('needs both the flag and GitHub Actions', () => {
    expect(ciCloneApplyAbsentEnabled({ [CI_CLONE_APPLY_ABSENT_ENV]: '1', GITHUB_ACTIONS: 'true' })).toBe(true);
  });

  it('is off without the flag', () => {
    expect(ciCloneApplyAbsentEnabled({ GITHUB_ACTIONS: 'true' })).toBe(false);
    expect(ciCloneApplyAbsentEnabled({ [CI_CLONE_APPLY_ABSENT_ENV]: 'true', GITHUB_ACTIONS: 'true' })).toBe(false);
  });

  it('is off outside GitHub Actions, so a stray flag on a deploy does nothing', () => {
    expect(ciCloneApplyAbsentEnabled({ [CI_CLONE_APPLY_ABSENT_ENV]: '1' })).toBe(false);
    expect(ciCloneApplyAbsentEnabled({ [CI_CLONE_APPLY_ABSENT_ENV]: '1', VERCEL: '1' })).toBe(false);
  });
});

describe('executionOrder', () => {
  it('runs applied-absent and pending migrations together in journal order', () => {
    // Journal order differs from timestamp order: the mission migration (when
    // 150) was generated before dev's newest one (when 300) but sits after it
    // in the journal, which is exactly how it ends up below the mark.
    const dev = migration('dev', 300, []);
    const mission = migration('mission', 150, []);
    const next = migration('next', 400, []);
    const journal = [dev, mission, next];
    const order = executionOrder(journal, [next], [mission]);
    expect(order.map((m) => m.hash)).toEqual(['mission', 'next']);
  });

  it('is just toRun when nothing is applied-absent', () => {
    const a = migration('a', 1, []);
    const b = migration('b', 2, []);
    expect(executionOrder([a, b], [b], [])).toEqual([b]);
  });
});

describe('only the Visual QA clone sets the flag', () => {
  it('no other workflow names it', () => {
    const dir = join(import.meta.dir, '..', '..', '..', '.github', 'workflows');
    const setters = readdirSync(dir)
      .filter((f) => /\.ya?ml$/.test(f))
      .filter((f) => readFileSync(join(dir, f), 'utf8').includes(CI_CLONE_APPLY_ABSENT_ENV));
    expect(setters).toEqual(['visual-qa.yml']);
  });
});
