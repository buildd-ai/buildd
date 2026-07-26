/**
 * Constraint contract tests for task_subject_claims.
 *
 * The single-active-row invariant is enforced by the partial unique index:
 *
 *   UNIQUE (workspace_id, key_type, key_hash) WHERE state = 'active'
 *
 * This means two concurrent INSERTs for the same dedupe key both with
 * state = 'active' will collide: the second insert raises a unique-constraint
 * violation. The winner creates the canonical task; the loser reads
 * canonical_task_id from the conflicting row and attaches a subject report
 * instead of creating a duplicate task.
 *
 * These tests validate the constraint definition is correct in the migration SQL
 * and that the schema module exports the expected table shape. The full
 * collision behaviour is only exercisable against a real Postgres instance;
 * see apps/web/tests/integration/ for end-to-end coverage once the intake path
 * is implemented.
 */
import { describe, it, expect } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { taskSubjectClaims, taskSubjectReports } from '../db/schema';

const DRIZZLE_DIR = join(import.meta.dir, '..', 'drizzle');

// ── Locate the migration that creates task_subject_claims ─────────────────────

function findSubjectClaimsMigration(): string {
  const files = readdirSync(DRIZZLE_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files.reverse()) {
    const sql = readFileSync(join(DRIZZLE_DIR, file), 'utf8');
    if (sql.includes('task_subject_claims')) return sql;
  }
  throw new Error('No migration found that creates task_subject_claims');
}

describe('task_subject_claims — migration SQL', () => {
  const migrationSql = findSubjectClaimsMigration();

  it('creates the task_subject_claims table', () => {
    expect(migrationSql).toContain('CREATE TABLE "task_subject_claims"');
  });

  it('includes workspace_id, key_type, key_hash, canonical_task_id, state columns', () => {
    expect(migrationSql).toContain('"workspace_id"');
    expect(migrationSql).toContain('"key_type"');
    expect(migrationSql).toContain('"key_hash"');
    expect(migrationSql).toContain('"canonical_task_id"');
    expect(migrationSql).toContain('"state"');
    expect(migrationSql).toContain('"generation"');
  });

  it('has the partial unique index that enforces single-active-row per dedupe key', () => {
    // This is the constraint that makes concurrent inserts collide.
    // The WHERE clause restricts it to active rows only, so released claims
    // don't block new generations for the same key.
    expect(migrationSql).toContain('CREATE UNIQUE INDEX "task_subject_claims_active_unique"');
    expect(migrationSql).toContain('"workspace_id","key_type","key_hash"');
    expect(migrationSql).toContain(`WHERE "task_subject_claims"."state" = 'active'`);
  });

  it('state defaults to active so every new claim participates in dedup', () => {
    // The DEFAULT guarantees that INSERT without an explicit state still lands
    // under the unique constraint, preventing omission bugs.
    expect(migrationSql).toContain(`"state" text DEFAULT 'active' NOT NULL`);
  });

  it('has FK from canonical_task_id to tasks with cascade delete', () => {
    expect(migrationSql).toContain(
      'ADD CONSTRAINT "task_subject_claims_canonical_task_id_tasks_id_fk" FOREIGN KEY ("canonical_task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade',
    );
  });

  it('creates lookup indexes for workspace and canonical task', () => {
    expect(migrationSql).toContain('CREATE INDEX "task_subject_claims_workspace_idx"');
    expect(migrationSql).toContain('CREATE INDEX "task_subject_claims_canonical_task_idx"');
  });
});

describe('task_subject_claims — concurrent-insert collision contract', () => {
  /**
   * Simulates the INSERT ... ON CONFLICT behaviour that the unique partial index
   * enforces. In production Postgres, two concurrent inserts for the same
   * (workspace_id, key_type, key_hash) where state='active' will:
   *   - First insert: succeeds → creates the canonical task claim.
   *   - Second insert: raises 23505 unique_violation → the loser reads
   *     canonical_task_id and attaches a subject report.
   *
   * We can't run two real concurrent inserts in a unit test, but we can model
   * the three possible outcomes of a claim attempt and assert the logic a
   * future intake helper must implement.
   */
  type ClaimResult =
    | { outcome: 'created'; claimId: string }
    | { outcome: 'attached'; canonicalTaskId: string }
    | { outcome: 'error'; code: string };

  // Minimal mock that reproduces the collision signal
  function makeMockDb(existingCanonicalId: string | null) {
    return {
      async insert(_table: unknown): Promise<ClaimResult> {
        if (existingCanonicalId !== null) {
          // Simulate 23505 unique_violation from Postgres
          const err: any = new Error('duplicate key value violates unique constraint "task_subject_claims_active_unique"');
          err.code = '23505';
          throw err;
        }
        return { outcome: 'created', claimId: 'new-claim-id' };
      },
      async select(_table: unknown, _key: unknown): Promise<string | null> {
        return existingCanonicalId;
      },
    };
  }

  async function tryClaimSubject(
    db: ReturnType<typeof makeMockDb>,
    _workspaceId: string,
    _keyType: string,
    _keyHash: string,
    _canonicalTaskId: string,
  ): Promise<ClaimResult> {
    try {
      return await db.insert(null);
    } catch (err: any) {
      if (err?.code === '23505') {
        const existing = await db.select(null, null);
        if (existing) return { outcome: 'attached', canonicalTaskId: existing };
        return { outcome: 'error', code: '23505_no_row' };
      }
      throw err;
    }
  }

  it('first insert succeeds and creates the canonical claim', async () => {
    const db = makeMockDb(null); // no existing row → insert succeeds
    const result = await tryClaimSubject(db, 'ws-1', 'pr_generation', 'hash-abc', 'task-1');
    expect(result.outcome).toBe('created');
  });

  it('second insert for same key collides and returns the canonical task to attach to', async () => {
    const db = makeMockDb('task-1'); // existing row → 23505
    const result = await tryClaimSubject(db, 'ws-1', 'pr_generation', 'hash-abc', 'task-2');
    expect(result.outcome).toBe('attached');
    expect((result as { outcome: 'attached'; canonicalTaskId: string }).canonicalTaskId).toBe('task-1');
  });

  it('released claims (state=released) do not collide — a new active claim is permitted', async () => {
    // This is what the partial WHERE clause guarantees: released rows are out of
    // the unique index, so a new active insert for the same key succeeds (new
    // generation). Modelled here by having no existing ACTIVE row.
    const db = makeMockDb(null); // no active row (released row not in index)
    const result = await tryClaimSubject(db, 'ws-1', 'pr_generation', 'hash-abc', 'task-3');
    expect(result.outcome).toBe('created');
  });
});

describe('task_subject_claims — schema shape', () => {
  it('exports taskSubjectClaims with the expected column set', () => {
    const cols = Object.keys(taskSubjectClaims) as string[];
    expect(cols).toContain('id');
    expect(cols).toContain('workspaceId');
    expect(cols).toContain('keyType');
    expect(cols).toContain('keyHash');
    expect(cols).toContain('canonicalTaskId');
    expect(cols).toContain('generation');
    expect(cols).toContain('state');
    expect(cols).toContain('createdAt');
    expect(cols).toContain('releasedAt');
  });
});

describe('task_subject_reports — migration SQL', () => {
  const migrationSql = findSubjectClaimsMigration();

  it('creates the task_subject_reports table with all required columns', () => {
    expect(migrationSql).toContain('CREATE TABLE "task_subject_reports"');
    expect(migrationSql).toContain('"task_id" uuid NOT NULL');
    expect(migrationSql).toContain('"reporting_task_id" uuid');
    expect(migrationSql).toContain('"origin" text NOT NULL');
    expect(migrationSql).toContain('"reporter_id" uuid');
    expect(migrationSql).toContain('"note" text');
    expect(migrationSql).toContain('"anchor_snapshot" jsonb');
  });

  it('exports taskSubjectReports with the expected column set', () => {
    const cols = Object.keys(taskSubjectReports) as string[];
    expect(cols).toContain('id');
    expect(cols).toContain('taskId');
    expect(cols).toContain('reportingTaskId');
    expect(cols).toContain('origin');
    expect(cols).toContain('reporterId');
    expect(cols).toContain('note');
    expect(cols).toContain('anchorSnapshot');
    expect(cols).toContain('createdAt');
  });
});

describe('tasks — subject anchor columns migration', () => {
  const migrationSql = findSubjectClaimsMigration();

  it('adds all subject anchor columns to tasks', () => {
    expect(migrationSql).toContain('ADD COLUMN "subject_anchor" jsonb');
    expect(migrationSql).toContain('ADD COLUMN "subject_kind" text');
    expect(migrationSql).toContain('ADD COLUMN "subject_pr_number" integer');
    expect(migrationSql).toContain('ADD COLUMN "subject_head_sha" text');
    expect(migrationSql).toContain('ADD COLUMN "subject_branch" text');
    expect(migrationSql).toContain('ADD COLUMN "subject_error_signature" text');
    expect(migrationSql).toContain('ADD COLUMN "subject_mission_id" uuid');
    expect(migrationSql).toContain('ADD COLUMN "subject_dedupe_scope" text');
    expect(migrationSql).toContain('ADD COLUMN "subject_superseded_by_task_id" uuid');
    expect(migrationSql).toContain('ADD COLUMN "subject_resolution" text');
  });

  it('creates all subject lookup indexes on tasks', () => {
    expect(migrationSql).toContain('CREATE INDEX "tasks_subject_kind_idx"');
    expect(migrationSql).toContain('CREATE INDEX "tasks_subject_pr_idx"');
    expect(migrationSql).toContain('CREATE INDEX "tasks_subject_head_sha_idx"');
    expect(migrationSql).toContain('CREATE INDEX "tasks_subject_error_idx"');
    expect(migrationSql).toContain('CREATE INDEX "tasks_subject_mission_idx"');
    expect(migrationSql).toContain('CREATE INDEX "tasks_subject_dedupe_scope_idx"');
  });

  it('all lookup indexes are on (workspace_id, subject_*) for workspace-scoped queries', () => {
    // Hot lookups always filter by workspace first — compound index prefix matches.
    const subjectIndexLines = migrationSql
      .split('\n')
      .filter((l) => l.includes('tasks_subject_') && l.includes('CREATE INDEX'));
    expect(subjectIndexLines.length).toBe(6);
    for (const line of subjectIndexLines) {
      expect(line).toContain('"workspace_id"');
    }
  });
});
