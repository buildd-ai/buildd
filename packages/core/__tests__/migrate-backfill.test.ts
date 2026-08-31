import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  deriveAssertions,
  evaluateBackfill,
  backfillTrackingRows,
  emptyDbShape,
  type DbShape,
} from '../db/migrate-backfill';
import type { MigrationFile } from '../db/migrate-plan';

/**
 * Regression guard for the silent-backfill bug (finding C9).
 *
 * `db/migrate.ts` classified any untracked migration older than the
 * `__drizzle_migrations` high-water mark as "already applied, row lost" and
 * inserted a tracking row for it WITHOUT ever looking at `migration.sql`. When
 * the migration had in fact never run (the 0021/0022 high-water-mark skip is a
 * confirmed production instance of exactly that), the deploy exited 0, the
 * schema-drift gate logged `[pending]` and passed, and `applied.has(...)` then
 * skipped the migration forever — permanent, silent schema loss.
 *
 * The invariant these tests hold: a tracking row is written only when the DB is
 * observed to already contain the migration's DDL. Otherwise the run fails loudly.
 */

function shape(partial: Partial<DbShape>): DbShape {
  return { ...emptyDbShape(), ...partial };
}

function migration(hash: string, folderMillis: number, sql: string[]): MigrationFile {
  return { hash, folderMillis, sql };
}

describe('deriveAssertions', () => {
  it('derives a column_exists assertion from ADD COLUMN', () => {
    const { assertions, opaque } = deriveAssertions([
      'ALTER TABLE "workers" ADD COLUMN "pr_opened_base_sha" text;',
    ]);
    expect(assertions).toEqual([{ kind: 'column_exists', target: 'workers.pr_opened_base_sha' }]);
    expect(opaque).toEqual([]);
  });

  it('derives a table_exists assertion from CREATE TABLE', () => {
    const { assertions } = deriveAssertions([
      'CREATE TABLE IF NOT EXISTS "missions" (\n\t"id" text PRIMARY KEY NOT NULL\n);',
    ]);
    expect(assertions).toEqual([{ kind: 'table_exists', target: 'missions' }]);
  });

  it('derives absence assertions from DROP COLUMN and DROP TABLE', () => {
    const { assertions } = deriveAssertions([
      'ALTER TABLE "missions" DROP COLUMN IF EXISTS "cron_expression";',
      'DROP TABLE IF EXISTS "secret_refs";',
    ]);
    expect(assertions).toEqual([
      { kind: 'column_absent', target: 'missions.cron_expression' },
      { kind: 'table_absent', target: 'secret_refs' },
    ]);
  });

  it('derives index assertions from CREATE INDEX / CREATE UNIQUE INDEX / DROP INDEX', () => {
    const { assertions } = deriveAssertions([
      'CREATE INDEX IF NOT EXISTS "tasks_status_idx" ON "tasks" USING btree ("status");',
      'CREATE UNIQUE INDEX IF NOT EXISTS "tasks_slug_uq" ON "tasks" USING btree ("slug");',
      'DROP INDEX IF EXISTS "tasks_source_external_idx";',
    ]);
    expect(assertions).toEqual([
      { kind: 'index_exists', target: 'tasks_status_idx' },
      { kind: 'index_exists', target: 'tasks_slug_uq' },
      { kind: 'index_absent', target: 'tasks_source_external_idx' },
    ]);
  });

  it('reads the ADD CONSTRAINT out of drizzle\'s DO $$ ... EXCEPTION wrapper', () => {
    const { assertions, opaque } = deriveAssertions([
      'DO $$ BEGIN\n ALTER TABLE "file_reservations" ADD CONSTRAINT "fr_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE cascade ON UPDATE no action;\nEXCEPTION\n WHEN duplicate_object THEN null;\nEND $$;',
    ]);
    expect(assertions).toEqual([
      { kind: 'constraint_exists', target: 'file_reservations.fr_workspace_id_fk' },
    ]);
    expect(opaque).toEqual([]);
  });

  it('turns a RENAME into an absence plus an existence assertion', () => {
    const { assertions } = deriveAssertions([
      'ALTER TABLE "objectives" RENAME COLUMN "old_name" TO "new_name";',
      'ALTER TABLE "objectives" RENAME TO "missions";',
    ]);
    expect(assertions).toEqual([
      { kind: 'column_absent', target: 'objectives.old_name' },
      { kind: 'column_exists', target: 'objectives.new_name' },
      { kind: 'table_absent', target: 'objectives' },
      { kind: 'table_exists', target: 'missions' },
    ]);
  });

  it('reports statements it cannot check as opaque instead of assuming them applied', () => {
    const { assertions, opaque } = deriveAssertions([
      "UPDATE workspace_skills SET is_role = true WHERE slug = 'builder';",
      'ALTER TABLE "tasks" ALTER COLUMN "status" SET NOT NULL;',
    ]);
    expect(assertions).toEqual([]);
    expect(opaque.length).toBe(2);
  });

  it('ignores comment-only and blank statements entirely', () => {
    const { assertions, opaque } = deriveAssertions([
      '-- every line of this custom migration is commented out\n-- so it is inert',
      '   \n',
    ]);
    expect(assertions).toEqual([]);
    expect(opaque).toEqual([]);
  });
});

describe('evaluateBackfill', () => {
  it('is verified when every derived assertion holds against the live DB', () => {
    const result = evaluateBackfill(
      ['ALTER TABLE "workers" ADD COLUMN "pr_opened_base_sha" text;'],
      shape({ columns: new Set(['workers.pr_opened_base_sha']) }),
    );
    expect(result.verdict).toBe('verified');
    expect(result.checked).toBe(1);
    expect(result.failures).toEqual([]);
  });

  it('is contradicted when an added column is missing from the DB', () => {
    const result = evaluateBackfill(
      ['ALTER TABLE "tasks" ADD COLUMN "path_manifest" jsonb;'],
      shape({ tables: new Set(['tasks']) }),
    );
    expect(result.verdict).toBe('contradicted');
    expect(result.failures.join(' ')).toContain('tasks.path_manifest');
  });

  it('is contradicted when a dropped table is still present', () => {
    const result = evaluateBackfill(
      ['DROP TABLE IF EXISTS "secret_refs";'],
      shape({ tables: new Set(['secret_refs']) }),
    );
    expect(result.verdict).toBe('contradicted');
    expect(result.failures.join(' ')).toContain('secret_refs');
  });

  it('accepts a migration whose checkable DDL is all present even if some statements are opaque', () => {
    const result = evaluateBackfill(
      [
        'ALTER TABLE "tasks" ADD COLUMN "role_slug" text;',
        "UPDATE tasks SET role_slug = 'builder';",
      ],
      shape({ columns: new Set(['tasks.role_slug']) }),
    );
    expect(result.verdict).toBe('verified');
    expect(result.opaque.length).toBe(1);
  });

  it('is unverifiable when nothing about the migration can be checked', () => {
    const result = evaluateBackfill(
      ["UPDATE workspace_skills SET is_role = true WHERE slug = 'builder';"],
      shape({}),
    );
    expect(result.verdict).toBe('unverifiable');
    expect(result.checked).toBe(0);
  });

  it('is inert when the migration contains no executable statement at all', () => {
    const result = evaluateBackfill(['-- commented out'], shape({}));
    expect(result.verdict).toBe('inert');
  });
});

describe('backfillTrackingRows', () => {
  function recorder() {
    const recorded: number[] = [];
    return {
      recorded,
      record: async (m: MigrationFile) => {
        recorded.push(m.folderMillis);
      },
    };
  }

  it('records a tracking row only for migrations whose DDL is observed in the DB', async () => {
    const { recorded, record } = recorder();
    const result = await backfillTrackingRows({
      toBackfill: [migration('a', 100, ['ALTER TABLE "tasks" ADD COLUMN "a" text;'])],
      shape: shape({ columns: new Set(['tasks.a']) }),
      record,
    });

    expect(recorded).toEqual([100]);
    expect(result.recorded).toBe(1);
  });

  it('THE C9 BUG: refuses to record a migration whose column is absent, and writes nothing', async () => {
    const { recorded, record } = recorder();

    let error: Error | undefined;
    try {
      await backfillTrackingRows({
        toBackfill: [
          migration('a', 100, ['ALTER TABLE "tasks" ADD COLUMN "path_manifest" jsonb;']),
        ],
        shape: shape({ tables: new Set(['tasks']) }),
        record,
      });
    } catch (err) {
      error = err as Error;
    }

    // No tracking row: `applied.has(...)` must not learn to skip this forever.
    expect(recorded).toEqual([]);
    expect(error).toBeDefined();
    expect(error!.message).toContain('tasks.path_manifest');
  });

  it('does not record the later migrations in the batch once one is contradicted', async () => {
    const { recorded, record } = recorder();
    await expect(
      backfillTrackingRows({
        toBackfill: [
          migration('a', 100, ['ALTER TABLE "tasks" ADD COLUMN "missing" text;']),
          migration('b', 200, ['ALTER TABLE "tasks" ADD COLUMN "present" text;']),
        ],
        shape: shape({ columns: new Set(['tasks.present']) }),
        record,
      }),
    ).rejects.toThrow();
    expect(recorded).toEqual([]);
  });

  it('refuses an unverifiable migration by default', async () => {
    const { recorded, record } = recorder();
    await expect(
      backfillTrackingRows({
        toBackfill: [migration('a', 100, ["UPDATE tasks SET x = 1;"])],
        shape: shape({}),
        record,
      }),
    ).rejects.toThrow(/unverifiable/i);
    expect(recorded).toEqual([]);
  });

  it('records an unverifiable migration only under an explicit opt-in', async () => {
    const { recorded, record } = recorder();
    const result = await backfillTrackingRows({
      toBackfill: [migration('a', 100, ['UPDATE tasks SET x = 1;'])],
      shape: shape({}),
      record,
      allowUnverified: true,
    });
    expect(recorded).toEqual([100]);
    expect(result.unverified).toBe(1);
  });

  it('records an inert migration without needing the opt-in', async () => {
    const { recorded, record } = recorder();
    const result = await backfillTrackingRows({
      toBackfill: [migration('a', 100, ['-- inert'])],
      shape: shape({}),
      record,
    });
    expect(recorded).toEqual([100]);
    expect(result.recorded).toBe(1);
  });

  it('never allows the opt-in to record a contradicted migration', async () => {
    const { recorded, record } = recorder();
    await expect(
      backfillTrackingRows({
        toBackfill: [migration('a', 100, ['ALTER TABLE "tasks" ADD COLUMN "gone" text;'])],
        shape: shape({ tables: new Set(['tasks']) }),
        record,
        allowUnverified: true,
      }),
    ).rejects.toThrow(/tasks\.gone/);
    expect(recorded).toEqual([]);
  });
});

describe('assertion coverage over the real migration corpus', () => {
  /**
   * A verifier that derives nothing from real migrations would pass everything
   * through the `unverifiable` path, where an operator's one-time opt-in
   * (MIGRATION_BACKFILL_ALLOW_UNVERIFIED=1) would then wave through every
   * migration — a gate that measures an empty set. This pins the coverage.
   */
  it('derives checkable assertions from nearly every committed migration', () => {
    const drizzleDir = new URL('../drizzle', import.meta.url).pathname;
    const journal = JSON.parse(
      readFileSync(join(drizzleDir, 'meta', '_journal.json'), 'utf8'),
    ) as { entries: Array<{ tag: string }> };

    let assertions = 0;
    let opaque = 0;
    const withoutAssertions: string[] = [];

    for (const entry of journal.entries) {
      const statements = readFileSync(join(drizzleDir, `${entry.tag}.sql`), 'utf8')
        .split('--> statement-breakpoint')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      const derived = deriveAssertions(statements);
      assertions += derived.assertions.length;
      opaque += derived.opaque.length;
      if (derived.assertions.length === 0) withoutAssertions.push(entry.tag);
    }

    console.log(
      `backfill coverage: ${journal.entries.length} migrations, ${assertions} assertions, ` +
        `${opaque} opaque statements, ${withoutAssertions.length} migrations with no ` +
        `checkable assertion (${withoutAssertions.join(', ')})`,
    );

    expect(assertions).toBeGreaterThan(500);
    // Only pure data-fix migrations should be unverifiable. If this grows, the
    // parser has lost ground against a new SQL form.
    expect(withoutAssertions.length).toBeLessThanOrEqual(6);
  });
});
