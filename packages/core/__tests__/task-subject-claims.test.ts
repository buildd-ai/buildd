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
 * NOTE on `state`: nothing retires a claim. A superseded claim is ROTATED in
 * place (apps/web/src/lib/subject-intake-db.ts `rotateClaim`), which keeps the
 * retry-chain links a release-and-reinsert would discard, so 'active' is the
 * only value ever written and the index predicate is constant-true. The column
 * and the predicate stay as the extension point; the `released_at` timestamp
 * that nothing ever wrote was dropped in migration 0147.
 *
 * These tests validate the constraint definition is correct in the migration SQL
 * and that the schema module exports the expected table shape. The full
 * collision behaviour is only exercisable against a real Postgres instance;
 * see apps/web/tests/integration/ for end-to-end coverage once the intake path
 * is implemented.
 */
import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { taskSubjectClaims, taskSubjectReports } from '../db/schema';

const DRIZZLE_DIR = join(import.meta.dir, '..', 'drizzle');

// ── The migration that creates task_subject_claims ───────────────────────────
//
// It was squashed into drizzle/0000_baseline.sql, a pg_dump of the released
// schema, so these read pg_dump's spelling (`public.` qualifiers, identifiers
// quoted only when needed, constraints as `ALTER TABLE ONLY`).

const baselineSql = readFileSync(join(DRIZZLE_DIR, '0000_baseline.sql'), 'utf8');

function tableBody(table: string): string {
  const start = baselineSql.indexOf(`CREATE TABLE public.${table} (`);
  if (start < 0) throw new Error(`baseline does not create ${table}`);
  return baselineSql.slice(start, baselineSql.indexOf('\n);', start));
}

describe('task_subject_claims — migration SQL', () => {
  const body = tableBody('task_subject_claims');

  it('creates the task_subject_claims table', () => {
    expect(baselineSql).toContain('CREATE TABLE public.task_subject_claims (');
  });

  it('includes workspace_id, key_type, key_hash, canonical_task_id, state columns', () => {
    for (const col of ['workspace_id', 'key_type', 'key_hash', 'canonical_task_id', 'state', 'generation']) {
      expect(body).toContain(`\n    ${col} `);
    }
  });

  it('has the partial unique index that enforces single-active-row per dedupe key', () => {
    // This is the constraint that makes concurrent inserts collide. The WHERE
    // clause restricts it to active rows; since nothing ever retires a claim it
    // is constant-true in practice, and it is the shape, not the filtering, that
    // is load-bearing here.
    expect(baselineSql).toContain(
      "CREATE UNIQUE INDEX task_subject_claims_active_unique ON public.task_subject_claims USING btree (workspace_id, key_type, key_hash) WHERE (state = 'active'::text);",
    );
  });

  it('state defaults to active so every new claim participates in dedup', () => {
    // The DEFAULT guarantees that INSERT without an explicit state still lands
    // under the unique constraint, preventing omission bugs.
    expect(body).toContain("state text DEFAULT 'active'::text NOT NULL");
  });

  it('has FK from canonical_task_id to tasks with cascade delete', () => {
    expect(baselineSql).toContain(
      'ADD CONSTRAINT task_subject_claims_canonical_task_id_tasks_id_fk FOREIGN KEY (canonical_task_id) REFERENCES public.tasks(id) ON DELETE CASCADE;',
    );
  });

  it('creates lookup indexes for workspace and canonical task', () => {
    expect(baselineSql).toContain('CREATE INDEX task_subject_claims_workspace_idx ON public.task_subject_claims');
    expect(baselineSql).toContain('CREATE INDEX task_subject_claims_canonical_task_idx ON public.task_subject_claims');
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

  it('a key with no active row is claimable — the only way a second create happens', async () => {
    // The previous version of this test claimed to model a RELEASED row falling
    // out of the partial index. No code path releases a claim, so that scenario
    // does not exist; what it actually modelled is the first-ever claim for a
    // key. Keep the case, drop the fiction: a superseded key is reused by
    // rotating its existing row, never by inserting a second one.
    const db = makeMockDb(null);
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
    expect(cols).toContain('reservationToken');
    expect(cols).toContain('reservationExpiresAt');
    expect(cols).toContain('generation');
    expect(cols).toContain('state');
    expect(cols).toContain('createdAt');
    // No `releasedAt`: dropped in 0147 because nothing ever set it. A column
    // that only ever holds NULL is a claim about a lifecycle that does not run.
    expect(cols).not.toContain('releasedAt');
  });
});

describe('task_subject_claims — reservation migration', () => {
  const body = tableBody('task_subject_claims');

  it('allows an ownerless short-lived reservation before task insertion', () => {
    expect(body).toContain('\n    canonical_task_id uuid,');
    expect(body).toContain('\n    reservation_token uuid');
    expect(body).toContain('\n    reservation_expires_at timestamp with time zone');
  });
});

describe('task_subject_reports — migration SQL', () => {
  it('creates the task_subject_reports table with all required columns', () => {
    const body = tableBody('task_subject_reports');
    expect(body).toContain('\n    task_id uuid NOT NULL');
    expect(body).toContain('\n    reporting_task_id uuid');
    expect(body).toContain('\n    origin text NOT NULL');
    expect(body).toContain('\n    reporter_id uuid');
    expect(body).toContain('\n    note text');
    expect(body).toContain('\n    anchor_snapshot jsonb');
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
  it('adds all subject anchor columns to tasks', () => {
    const body = tableBody('tasks');
    for (const col of [
      'subject_anchor jsonb',
      'subject_kind text',
      'subject_pr_number integer',
      'subject_head_sha text',
      'subject_branch text',
      'subject_error_signature text',
      'subject_mission_id uuid',
      'subject_dedupe_scope text',
      'subject_superseded_by_task_id uuid',
      'subject_resolution text',
    ]) {
      expect(body).toContain(`\n    ${col}`);
    }
  });

  const subjectIndexLines = baselineSql
    .split('\n')
    .filter((l) => /^CREATE INDEX tasks_subject_\w+ ON public\.tasks /.test(l));

  it('creates all subject lookup indexes on tasks', () => {
    const names = subjectIndexLines.map((l) => l.split(' ')[2]);
    expect(names.sort()).toEqual([
      'tasks_subject_dedupe_scope_idx',
      'tasks_subject_error_idx',
      'tasks_subject_head_sha_idx',
      'tasks_subject_kind_idx',
      'tasks_subject_mission_idx',
      'tasks_subject_pr_idx',
    ]);
  });

  it('all lookup indexes are on (workspace_id, subject_*) for workspace-scoped queries', () => {
    // Hot lookups always filter by workspace first — compound index prefix matches.
    expect(subjectIndexLines.length).toBe(6);
    for (const line of subjectIndexLines) {
      expect(line).toContain('USING btree (workspace_id, ');
    }
  });
});
