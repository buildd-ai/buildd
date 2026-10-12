import { describe, it, expect } from 'bun:test';
import {
  applyV1,
  executableStatements,
  needsUnbatched,
  replaySensitiveStatements,
  type ApplyV1Deps,
} from '../db/migrate-apply';
import { BackfillContradictedError, emptyDbShape, type DbShape } from '../db/migrate-backfill';
import type { TreeMigration } from '../db/migrate-tree';

/**
 * The v1 apply step (packages/core/db/migrate-apply.ts). Post-cutover there is
 * no high-water mark, so two things replace it:
 *   - each file runs with its tracking insert in ONE transaction (db.batch), so
 *     the "DDL ran, row lost" window the mark existed to cover is closed;
 *   - a post-cutover migration with no row whose DDL is already present is
 *     recorded, not replayed; partly present DDL is refused.
 */

const m = (name: string, sql: string[]): TreeMigration => ({ name, hash: `h-${name}`, folderMillis: 1, sql });

function fakeDeps(shape: DbShape = emptyDbShape()) {
  const calls: string[] = [];
  const deps: ApplyV1Deps = {
    async execute(statement) {
      calls.push(`exec ${statement}`);
    },
    async executeAtomic(statements, migration) {
      calls.push(`batch ${migration.name} [${statements.join(' | ')}] +row`);
    },
    async record(migration) {
      calls.push(`record ${migration.name}`);
    },
    async readShape() {
      calls.push('shape');
      return shape;
    },
    log() {},
  };
  return { deps, calls };
}

describe('executableStatements', () => {
  it('drops blank and comment-only chunks; keeps the rest verbatim', () => {
    expect(executableStatements(['-- header only\n', 'CREATE TABLE a ();', '\n  \n'])).toEqual(['CREATE TABLE a ();']);
  });
});

describe('replaySensitiveStatements', () => {
  it('keeps statements that fail on replay; drops IF [NOT] EXISTS and exception-guarded DO blocks', () => {
    expect(
      replaySensitiveStatements([
        'ALTER TABLE "t" ADD COLUMN "a" text;',
        'ALTER TABLE "t" ADD COLUMN IF NOT EXISTS "b" text;',
        'CREATE INDEX IF NOT EXISTS "i" ON "t" ("a");',
        'DROP TABLE IF EXISTS "old";',
        'DO $$ BEGIN ALTER TABLE "t" ADD CONSTRAINT "fk" FOREIGN KEY ("a") REFERENCES "u"("id"); EXCEPTION WHEN duplicate_object THEN null; END $$;',
        '-- comment only\n',
      ])
    ).toEqual(['ALTER TABLE "t" ADD COLUMN "a" text;']);
  });
});

describe('needsUnbatched', () => {
  it('flags statements Postgres refuses inside a transaction block', () => {
    expect(needsUnbatched(['CREATE INDEX CONCURRENTLY i ON t (c);'])).toMatch(/CONCURRENTLY/);
    expect(needsUnbatched(['VACUUM t;'])).toMatch(/VACUUM/);
  });

  it('flags ALTER TYPE ... ADD VALUE followed by a use of that value in the same file', () => {
    expect(
      needsUnbatched([`ALTER TYPE "mode" ADD VALUE 'assertion';`, `UPDATE t SET m = 'assertion' WHERE false;`])
    ).toMatch(/ADD VALUE/);
  });

  it('ADD VALUE alone is fine in a transaction (Postgres 12+)', () => {
    expect(needsUnbatched([`ALTER TYPE "mode" ADD VALUE IF NOT EXISTS 'assertion';`])).toBeNull();
  });

  it('ordinary DDL batches', () => {
    expect(needsUnbatched(['ALTER TABLE t ADD COLUMN c text;', 'CREATE INDEX i ON t (c);'])).toBeNull();
  });

  it('ignores the word in a comment', () => {
    expect(needsUnbatched(['-- not CONCURRENTLY: runs in the batch\nCREATE INDEX i ON t (c);'])).toBeNull();
  });
});

describe('applyV1', () => {
  const legacy = m('20250101000000_legacy', ['ALTER TABLE "t" ADD COLUMN "a" text;']);
  const post = m('20260101000000_post', ['ALTER TABLE "t" ADD COLUMN "b" text;', 'CREATE INDEX "t_b_idx" ON "t" ("b");']);
  const rebase = m('20260101000001_snapshot_rebase', ['-- no DDL\n']);
  const legacyNames = new Set([legacy.name]);

  it('runs each file and its tracking row as one batch', async () => {
    const { deps, calls } = fakeDeps();
    await applyV1({ toExecute: [legacy, post], toRecordOnly: [], legacyNames }, deps);
    expect(calls).toEqual([
      `batch ${legacy.name} [ALTER TABLE "t" ADD COLUMN "a" text;] +row`,
      'shape',
      `batch ${post.name} [ALTER TABLE "t" ADD COLUMN "b" text; | CREATE INDEX "t_b_idx" ON "t" ("b");] +row`,
    ]);
  });

  it('records a comment-only migration without executing anything', async () => {
    const { deps, calls } = fakeDeps();
    const result = await applyV1({ toExecute: [], toRecordOnly: [rebase], legacyNames }, deps);
    expect(calls).toEqual([`record ${rebase.name}`]);
    expect(result).toEqual({ executed: [], recordedOnly: [rebase.name], recordedPresent: [] });
  });

  it('post-cutover, no row, DDL already present: records, never replays', async () => {
    const shape = emptyDbShape();
    shape.tables.add('t');
    shape.columns.add('t.b');
    shape.indexes.add('t_b_idx');
    const { deps, calls } = fakeDeps(shape);
    const result = await applyV1({ toExecute: [post], toRecordOnly: [], legacyNames }, deps);
    expect(calls).toEqual(['shape', `record ${post.name}`]);
    expect(result.recordedPresent).toEqual([post.name]);
  });

  it('post-cutover, no row, DDL partly present: refuses and writes nothing', async () => {
    const shape = emptyDbShape();
    shape.columns.add('t.b'); // the column, but not the index
    const { deps, calls } = fakeDeps(shape);
    await expect(applyV1({ toExecute: [post], toRecordOnly: [], legacyNames }, deps)).rejects.toThrow(
      BackfillContradictedError
    );
    expect(calls).toEqual(['shape']);
  });

  it('an idempotent reconciliation migration re-issuing existing DDL is not "partly present": it executes', async () => {
    const reconcile = m('20260103000000_reconcile', [
      'CREATE INDEX IF NOT EXISTS "t_b_idx" ON "t" ("b");', // already there
      'ALTER TABLE "t" ADD COLUMN "c" text;', // new
    ]);
    const shape = emptyDbShape();
    shape.indexes.add('t_b_idx');
    const { deps, calls } = fakeDeps(shape);
    await applyV1({ toExecute: [reconcile], toRecordOnly: [], legacyNames }, deps);
    expect(calls.at(-1)).toStartWith(`batch ${reconcile.name}`);
  });

  it('a legacy migration in toExecute is not evidence-checked (it is above the legacy mark: it never ran)', async () => {
    const { deps, calls } = fakeDeps();
    await applyV1({ toExecute: [legacy], toRecordOnly: [], legacyNames }, deps);
    expect(calls).not.toContain('shape');
  });

  it('an unbatchable file runs statement by statement, then records', async () => {
    const conc = m('20260102000000_conc', ['CREATE INDEX CONCURRENTLY IF NOT EXISTS "i" ON "t" ("c");']);
    const { deps, calls } = fakeDeps();
    await applyV1({ toExecute: [conc], toRecordOnly: [], legacyNames }, deps);
    expect(calls).toEqual(['shape', `exec ${conc.sql[0]}`, `record ${conc.name}`]);
  });

  it('a failed batch stops the run: nothing after it executes', async () => {
    const { deps, calls } = fakeDeps();
    deps.executeAtomic = async (_s, migration) => {
      calls.push(`batch ${migration.name}`);
      throw new Error('boom');
    };
    await expect(applyV1({ toExecute: [legacy, post], toRecordOnly: [], legacyNames }, deps)).rejects.toThrow('boom');
    expect(calls).toEqual([`batch ${legacy.name}`]);
  });
});
