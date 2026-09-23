import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  classifyPullRequestMigrations,
  classifyMigrationSql,
  getMigrationNumber,
  isGeneratedMigrationPath,
} from './migration-safety';

const drizzleDir = join(import.meta.dir, '../../../../packages/core/drizzle');
const migration = (name: string) => readFileSync(join(drizzleDir, name), 'utf8');

describe('classifyMigrationSql', () => {
  it('classifies additive table, nullable columns, constraints, and indexes as EXPAND (migration 0092)', () => {
    expect(classifyMigrationSql(migration('0092_aspiring_abomination.sql'))).toEqual({
      safe: true,
      operationClass: 'EXPAND',
    });
  });

  it('classifies additive table and indexes as EXPAND (migration 0093)', () => {
    expect(classifyMigrationSql(migration('0093_vengeful_power_pack.sql'))).toEqual({
      safe: true,
      operationClass: 'EXPAND',
    });
  });

  it('allows a new NOT NULL column only when it has a default (EXPAND)', () => {
    expect(
      classifyMigrationSql(
        'ALTER TABLE "missions" ADD COLUMN "enabled" boolean DEFAULT false NOT NULL;',
      ),
    ).toEqual({ safe: true, operationClass: 'EXPAND' });

    expect(
      classifyMigrationSql(
        'ALTER TABLE "missions" ADD COLUMN "enabled" boolean NOT NULL;',
      ),
    ).toEqual({
      safe: false,
      operationClass: 'CONTRACT',
      reason: 'adds NOT NULL column without default missions.enabled',
    });
    expect(
      classifyMigrationSql(
        'ALTER TABLE "missions" ALTER COLUMN "enabled" SET NOT NULL;',
      ),
    ).toEqual({
      safe: false,
      operationClass: 'CONTRACT',
      reason: 'adds NOT NULL constraint to existing column missions.enabled',
    });
  });

  it('classifies destructive operations as CONTRACT with actionable object names', () => {
    expect(
      classifyMigrationSql('ALTER TABLE "missions" DROP COLUMN "legacy_mode";'),
    ).toEqual({ safe: false, operationClass: 'CONTRACT', reason: 'drops column missions.legacy_mode' });
    expect(classifyMigrationSql('DROP TABLE IF EXISTS "secret_refs";')).toEqual({
      safe: false,
      operationClass: 'CONTRACT',
      reason: 'drops table secret_refs',
    });
    expect(
      classifyMigrationSql(
        'ALTER TABLE "missions" RENAME COLUMN "old_name" TO "new_name";',
      ),
    ).toEqual({
      safe: false,
      operationClass: 'CONTRACT',
      reason: 'renames column missions.old_name to new_name',
    });
    expect(
      classifyMigrationSql(
        'ALTER TABLE "missions" ALTER COLUMN "status" TYPE varchar(40);',
      ),
    ).toEqual({
      safe: false,
      operationClass: 'CONTRACT',
      reason: 'changes type of missions.status',
    });
  });

  it('classifies data-migrating DML as CONTRACT (migration 0020)', () => {
    expect(classifyMigrationSql(migration('0020_data_fix_is_role.sql'))).toEqual({
      safe: false,
      operationClass: 'CONTRACT',
      reason: 'runs data migration UPDATE on workspace_skills',
    });
  });

  it("unwraps drizzle's idempotent DO-block FK wrapper and classifies the inner statement (migration 0019)", () => {
    expect(classifyMigrationSql(migration('0019_loving_pride.sql'))).toEqual({ safe: true, operationClass: 'EXPAND' });
  });

  it('still escalates a DO block that is not the idempotent wrapper around a safe statement', () => {
    const procedural = classifyMigrationSql(
      'DO $$ DECLARE n integer; BEGIN DELETE FROM "task_schedules" WHERE id IS NULL; END $$;',
    );
    expect(procedural.safe).toBe(false);
    expect(procedural.safe ? '' : procedural.reason).toMatch(/^ambiguous migration statement: DO \$\$ DECLARE/);

    const wrappedDrop = classifyMigrationSql(
      'DO $$ BEGIN\n ALTER TABLE "tasks" DROP COLUMN "legacy";\nEXCEPTION\n WHEN duplicate_object THEN null;\nEND $$;',
    );
    expect(wrappedDrop).toEqual({ safe: false, operationClass: 'CONTRACT', reason: 'drops column tasks.legacy' });
  });

  it('does not split a dollar-quoted body on its inner semicolons', () => {
    const result = classifyMigrationSql(
      'CREATE OR REPLACE FUNCTION f() RETURNS void AS $fn$ BEGIN UPDATE "tasks" SET x = 1; END; $fn$ LANGUAGE plpgsql;',
    );
    expect(result.safe).toBe(false);
    expect(result.safe ? '' : result.reason).toMatch(/^ambiguous migration statement: CREATE OR REPLACE FUNCTION/);
  });

  it.each([
    ['CREATE TYPE "public"."mode" AS ENUM(\'a\', \'b\');'],
    ['ALTER TYPE "public"."mode" ADD VALUE IF NOT EXISTS \'c\';'],
    ['ALTER TABLE "workspaces" ALTER COLUMN "access_mode" SET DEFAULT \'open\';'],
    ['ALTER TABLE "workspaces" ALTER COLUMN "access_mode" DROP DEFAULT;'],
    ['ALTER TABLE "artifacts" ALTER COLUMN "worker_id" DROP NOT NULL;'],
    ['CREATE EXTENSION IF NOT EXISTS vector;'],
    ['ALTER TABLE "workspace_skills" ADD COLUMN IF NOT EXISTS "account_id" uuid;'],
  ])('classifies low-risk DDL as EXPAND: %s', (sql) => {
    expect(classifyMigrationSql(sql)).toEqual({ safe: true, operationClass: 'EXPAND' });
  });

  it.each([
    ['DROP INDEX "path_claims_active_idx";', 'drops index path_claims_active_idx'],
    ['DROP INDEX IF EXISTS "secrets_account_purpose_idx";', 'drops index secrets_account_purpose_idx'],
    ['ALTER TABLE "tasks" DROP CONSTRAINT "tasks_source_uniq";', 'drops constraint tasks.tasks_source_uniq'],
    ['DROP TYPE "public"."mode";', 'drops type public.mode'],
    ['ALTER TABLE "x" ADD COLUMN IF NOT EXISTS "y" text NOT NULL;', 'adds NOT NULL column without default x.y'],
  ])('names the risky operation instead of "ambiguous": %s', (sql, reason) => {
    expect(classifyMigrationSql(sql)).toEqual({ safe: false, operationClass: 'CONTRACT', reason });
  });
});

describe('migration paths', () => {
  it('recognizes generated migrations at any drizzle root', () => {
    expect(isGeneratedMigrationPath('packages/core/drizzle/0093_name.sql')).toBe(true);
    expect(isGeneratedMigrationPath('drizzle/0093_name.sql')).toBe(true);
    expect(isGeneratedMigrationPath('packages/core/drizzle/meta/0093_snapshot.json')).toBe(false);
  });

  it('extracts the collision key from a generated migration filename', () => {
    expect(getMigrationNumber('packages/core/drizzle/0093_first.sql')).toBe('0093');
    expect(getMigrationNumber('drizzle/0093_second.sql')).toBe('0093');
    expect(getMigrationNumber('packages/core/db/schema.ts')).toBeNull();
  });
});

describe('classifyPullRequestMigrations', () => {
  it('classifies schema.ts with additive migration as EXPAND', () => {
    expect(
      classifyPullRequestMigrations(
        [
          { filename: 'packages/core/db/schema.ts' },
          {
            filename: 'packages/core/drizzle/0094_safe.sql',
            content: 'ALTER TABLE "missions" ADD COLUMN "summary" text;',
          },
        ],
        [],
      ),
    ).toEqual({ safe: true, operationClass: 'EXPAND' });
  });

  it('classifies schema.ts with destructive migration as CONTRACT', () => {
    expect(
      classifyPullRequestMigrations(
        [
          { filename: 'packages/core/db/schema.ts' },
          {
            filename: 'packages/core/drizzle/0094_drop.sql',
            content: 'ALTER TABLE "missions" DROP COLUMN "legacy";',
          },
        ],
        [],
      ),
    ).toEqual({ safe: false, operationClass: 'CONTRACT', reason: 'drops column missions.legacy' });
  });

  it('escalates when generated SQL cannot be loaded (CONTRACT)', () => {
    expect(
      classifyPullRequestMigrations(
        [
          { filename: 'packages/core/db/schema.ts' },
          { filename: 'packages/core/drizzle/0094_missing.sql' },
        ],
        [],
      ),
    ).toEqual({
      safe: false,
      operationClass: 'CONTRACT',
      reason: 'could not inspect generated migration packages/core/drizzle/0094_missing.sql',
    });
  });

  it('does not escalate schema.ts touched with zero generated migrations (EXPAND — TS-only edit)', () => {
    // Covers $type<>() union widening, JSONB-shaped interface fields (e.g.
    // TaskResult), and type aliases — none of which alter table shape. A real
    // structural change with a forgotten migration is caught by the
    // `schema-drift` CI job, not by this classifier.
    expect(
      classifyPullRequestMigrations([{ filename: 'packages/core/db/schema.ts' }], []),
    ).toEqual({ safe: true, operationClass: 'EXPAND' });
  });

  it('still classifies CONTRACT when schema.ts is touched alongside an unparseable migration statement', () => {
    expect(
      classifyPullRequestMigrations(
        [
          { filename: 'packages/core/db/schema.ts' },
          {
            filename: 'packages/core/drizzle/0094_weird.sql',
            content: 'DO $$ BEGIN RAISE NOTICE \'hi\'; END $$;',
          },
        ],
        [],
      ),
    ).toEqual({
      safe: false,
      operationClass: 'CONTRACT',
      reason: expect.stringMatching(/^ambiguous migration statement:/),
    });
  });

  it('keeps migration-number collisions as CONTRACT regardless of content', () => {
    expect(
      classifyPullRequestMigrations(
        [
          {
            filename: 'packages/core/drizzle/0093_safe.sql',
            content: 'CREATE INDEX "missions_title_idx" ON "missions" ("title");',
          },
        ],
        ['packages/core/drizzle/0093_other.sql'],
      ),
    ).toEqual({
      safe: false,
      operationClass: 'CONTRACT',
      reason:
        'migration number collision: 0093_safe.sql conflicts with open PR migration 0093_other.sql',
    });
  });

  it('rejects a PR that mixes EXPAND and CONTRACT migrations', () => {
    const result = classifyPullRequestMigrations(
      [
        {
          filename: 'packages/core/drizzle/0094_additive.sql',
          content: 'ALTER TABLE "missions" ADD COLUMN "summary" text;',
        },
        {
          filename: 'packages/core/drizzle/0095_destructive.sql',
          content: 'ALTER TABLE "missions" DROP COLUMN "legacy";',
        },
      ],
      [],
    );
    expect(result.safe).toBe(false);
    expect(result.operationClass).toBe('CONTRACT');
    expect(result.safe ? '' : result.reason).toMatch(/mixes EXPAND and CONTRACT/);
    expect(result.safe ? '' : result.reason).toMatch(/drops column missions.legacy/);
  });
});
