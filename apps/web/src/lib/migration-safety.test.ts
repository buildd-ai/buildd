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

  it('classifies ambiguous procedural SQL as CONTRACT (migration 0019)', () => {
    const result = classifyMigrationSql(migration('0019_loving_pride.sql'));
    expect(result.safe).toBe(false);
    expect(result.safe ? '' : result.reason).toMatch(/^ambiguous migration statement: DO \$\$ BEGIN/);
    expect(result.operationClass).toBe('CONTRACT');
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

  it('escalates schema.ts without a generated migration (CONTRACT)', () => {
    expect(
      classifyPullRequestMigrations([{ filename: 'packages/core/db/schema.ts' }], []),
    ).toEqual({
      safe: false,
      operationClass: 'CONTRACT',
      reason: 'schema changed without a generated SQL migration',
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
