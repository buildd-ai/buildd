/**
 * `recordGateEvent` — the gate ledger writer.
 *
 * The two properties that matter are both failure-shaped: the reason must be
 * normalized with the SAME function the failure aggregation uses (or one family
 * silently becomes N singletons nobody can count), and a broken insert must
 * never reach the request path (or an observability table becomes an outage).
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test';

interface InsertedRow {
  gate: string;
  surface: string;
  outcome: string;
  reason: string;
  workspaceId: string | null;
  missionId: string | null;
  taskId: string | null;
  workerId: string | null;
  detail: Record<string, unknown> | null;
  callerOrigin: string | null;
}

let inserted: InsertedRow[] = [];
let insertShouldThrow = false;
/** What `recordOrCoalesceDeferral`'s lookup SELECT should return — the "latest row for this task" fixture. */
let latestRow: { id: string; reason: string; outcome: string; detail: Record<string, unknown> | null } | undefined;
let updateCalls: Array<{ id: string; set: Record<string, unknown> }> = [];
/** The WHERE the lookup SELECT was built with — rendered to SQL so scoping is observable. */
let lastWhere: unknown = null;

mock.module('../db/client', () => ({
  db: {
    insert: () => ({
      values: (row: InsertedRow) => ({
        returning: async () => {
          if (insertShouldThrow) throw new Error('relation "gate_events" does not exist');
          inserted.push(row);
          return [{ id: 'row-1' }];
        },
      }),
    }),
    select: () => ({
      from: () => ({
        where: (w: unknown) => (lastWhere = w, {
          orderBy: () => ({
            limit: async () => (latestRow ? [latestRow] : []),
          }),
        }),
      }),
    }),
    update: () => ({
      set: (set: Record<string, unknown>) => ({
        where: async () => {
          updateCalls.push({ id: latestRow!.id, set });
        },
      }),
    }),
  },
}));

const { recordGateEvent, recordOrCoalesceDeferral, recordOrCoalesceRepeat, GATE_SLUGS } = await import('../gate-events');
const { PgDialect } = await import('drizzle-orm/pg-core');
const renderWhere = () => new PgDialect().sqlToQuery(lastWhere as any);

const WS = '11111111-2222-4333-8444-555555555555';
const TASK = '99999999-8888-4777-8666-555555555555';

beforeEach(() => {
  inserted = [];
  insertShouldThrow = false;
  latestRow = undefined;
  updateCalls = [];
  lastWhere = null;
});

describe('recordGateEvent', () => {
  it('writes exactly one row with the outcome the caller declared', async () => {
    const id = await recordGateEvent({
      gate: GATE_SLUGS.MANIFEST_REQUIRED,
      surface: 'POST /api/tasks',
      outcome: 'rejected',
      reason: 'pathManifest is required',
      workspaceId: WS,
      callerOrigin: 'worker',
    });

    expect(id).toBe('row-1');
    expect(inserted).toHaveLength(1);
    expect(inserted[0].gate).toBe('manifest_required');
    expect(inserted[0].outcome).toBe('rejected');
    expect(inserted[0].workspaceId).toBe(WS);
    expect(inserted[0].callerOrigin).toBe('worker');
  });

  it('normalizes the reason so one refusal family is one row, not N singletons', async () => {
    // The create_pr rejection that produced four distinct signatures before the
    // quoted-slug rule existed. Two different branch pairs, one stored reason.
    const a = "Task PR head 'buildd_ed211c59-consolidate-the-create-pr-bran' does not match this worker's own branch ('buildd_ed211c59-consolidate-the-create-pr-bran-wf4817cb0').";
    const b = "Task PR head 'mission/spec-conformance-the-ledger-f02e0dc0-wcda33d93' does not match this worker's own branch ('mission/spec-conformance-the-ledger-f02e0dc0').";

    for (const reason of [a, b]) {
      await recordGateEvent({ gate: 'pr_head_mismatch', surface: 'POST /api/github/pr', outcome: 'rejected', reason });
    }

    expect(inserted).toHaveLength(2);
    expect(inserted[0].reason).toBe(inserted[1].reason);
    expect(inserted[0].reason).toContain("'<id>'");
  });

  it('resolves without throwing when the insert fails, and reports the miss', async () => {
    insertShouldThrow = true;
    // No try/catch here on purpose: a rejected promise here is the bug this
    // test exists to catch, because every call site fires without awaiting.
    const id = await recordGateEvent({
      gate: 'prose_gate',
      surface: 'POST /api/tasks',
      outcome: 'warned',
      reason: 'description declares a gate',
    });
    expect(id).toBeNull();
    expect(inserted).toHaveLength(0);
  });

  it('drops non-UUID relation hints rather than failing the insert on them', async () => {
    await recordGateEvent({
      gate: 'task_param_vocabulary',
      surface: 'POST /api/tasks',
      outcome: 'rejected',
      reason: 'kind must be one of: …',
      // A repo name is a perfectly ordinary thing for a caller to pass.
      workspaceId: 'buildd',
      taskId: 'not-a-uuid',
    });
    expect(inserted[0].workspaceId).toBeNull();
    expect(inserted[0].taskId).toBeNull();
  });

  it('bounds a runaway detail payload instead of storing it whole', async () => {
    await recordGateEvent({
      gate: 'output_requirement',
      surface: 'PATCH /api/workers/[id]',
      outcome: 'bypassed',
      reason: 'edits discarded',
      detail: { blob: 'x'.repeat(10_000) },
    });
    expect(inserted[0].detail?.truncated).toBe(true);
    expect(JSON.stringify(inserted[0].detail).length).toBeLessThan(6000);
  });

  it('survives an unserializable detail without losing the event', async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await recordGateEvent({
      gate: 'path_claim',
      surface: 'POST /api/tasks/[id]/path-claim',
      outcome: 'deferred',
      reason: 'paths overlap an active claim',
      detail: circular,
    });
    expect(inserted).toHaveLength(1);
    expect(inserted[0].detail).toEqual({ unserializable: true });
  });
});

describe('recordOrCoalesceDeferral', () => {
  it('inserts a fresh row at consecutiveDeferrals=1 when there is no prior row', async () => {
    latestRow = undefined;
    await recordOrCoalesceDeferral({
      gate: GATE_SLUGS.CLAIM_LOOP_DEFERRAL,
      surface: 'POST /api/workers/claim',
      outcome: 'deferred',
      reason: 'workspace_cap',
      taskId: TASK,
    });

    expect(inserted).toHaveLength(1);
    expect(updateCalls).toHaveLength(0);
    expect(inserted[0].detail?.consecutiveDeferrals).toBe(1);
    expect(typeof inserted[0].detail?.firstDeferredAt).toBe('string');
  });

  it('coalesces a repeat of the SAME (taskId, outcome, reason) into the latest row instead of inserting a new one', async () => {
    latestRow = {
      id: 'row-existing',
      reason: 'workspace_cap',
      outcome: 'deferred',
      detail: { consecutiveDeferrals: 3, firstDeferredAt: '2026-01-01T00:00:00.000Z' },
    };

    const id = await recordOrCoalesceDeferral({
      gate: GATE_SLUGS.CLAIM_LOOP_DEFERRAL,
      surface: 'POST /api/workers/claim',
      outcome: 'deferred',
      reason: 'workspace_cap',
      taskId: TASK,
    });

    expect(id).toBe('row-existing');
    expect(inserted).toHaveLength(0);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].id).toBe('row-existing');
    expect((updateCalls[0].set.detail as Record<string, unknown>).consecutiveDeferrals).toBe(4);
    // firstDeferredAt must survive untouched — it is the one field a coalesced
    // update is not allowed to move forward, or "how long has this been stuck"
    // becomes unanswerable.
    expect((updateCalls[0].set.detail as Record<string, unknown>).firstDeferredAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('starts a fresh streak when the reason changes, even for the same task', async () => {
    latestRow = {
      id: 'row-existing',
      reason: 'workspace_cap',
      outcome: 'deferred',
      detail: { consecutiveDeferrals: 10, firstDeferredAt: '2026-01-01T00:00:00.000Z' },
    };

    await recordOrCoalesceDeferral({
      gate: GATE_SLUGS.CLAIM_LOOP_DEFERRAL,
      surface: 'POST /api/workers/claim',
      outcome: 'deferred',
      reason: 'mission_paced',
      taskId: TASK,
    });

    expect(updateCalls).toHaveLength(0);
    expect(inserted).toHaveLength(1);
    expect(inserted[0].reason).toBe('mission_paced');
    expect(inserted[0].detail?.consecutiveDeferrals).toBe(1);
  });

  it('starts a fresh streak when the outcome changes (deferred → stranded) even with the same reason', async () => {
    latestRow = {
      id: 'row-existing',
      reason: 'workspace_cap',
      outcome: 'deferred',
      detail: { consecutiveDeferrals: 50, firstDeferredAt: '2026-01-01T00:00:00.000Z' },
    };

    await recordOrCoalesceDeferral({
      gate: GATE_SLUGS.CLAIM_LOOP_DEFERRAL,
      surface: 'sweepStrandedTasks',
      outcome: 'stranded',
      reason: 'workspace_cap',
      taskId: TASK,
    });

    expect(updateCalls).toHaveLength(0);
    expect(inserted).toHaveLength(1);
    expect(inserted[0].outcome).toBe('stranded');
    expect(inserted[0].detail?.consecutiveDeferrals).toBe(1);
  });
});

describe('recordOrCoalesceRepeat', () => {
  const ACCOUNT = '12345678-1234-4234-8234-123456789abc';
  const HOUR = 60 * 60 * 1000;
  const base = {
    gate: GATE_SLUGS.CLAIM_LOOP_DEFERRAL,
    surface: 'POST /api/workers/claim',
    outcome: 'rejected' as const,
    reason: 'runner_field_missing',
    detail: { accountId: ACCOUNT },
  };

  it('inserts a fresh row with count=1 when nothing matches in the window', async () => {
    await recordOrCoalesceRepeat(base, { key: { accountId: ACCOUNT }, windowMs: HOUR });
    expect(inserted).toHaveLength(1);
    expect(updateCalls).toHaveLength(0);
    expect(inserted[0].detail).toMatchObject({ accountId: ACCOUNT, count: 1 });
    expect(typeof inserted[0].detail?.lastSeenAt).toBe('string');
  });

  it('bumps count on the matching row instead of inserting', async () => {
    latestRow = { id: 'row-existing', reason: 'runner_field_missing', outcome: 'rejected', detail: { accountId: ACCOUNT, count: 41 } };
    const id = await recordOrCoalesceRepeat(base, { key: { accountId: ACCOUNT }, windowMs: HOUR });
    expect(id).toBe('row-existing');
    expect(inserted).toHaveLength(0);
    expect(updateCalls).toHaveLength(1);
    const detail = updateCalls[0].set.detail as Record<string, unknown>;
    expect(detail.count).toBe(42);
    expect(detail.accountId).toBe(ACCOUNT);
    // occurredAt stays the window's first occurrence, so "one row per hour" holds.
    expect(updateCalls[0].set.occurredAt).toBeUndefined();
  });

  it('scopes the lookup by gate, outcome, reason, the key, and the window', async () => {
    await recordOrCoalesceRepeat(base, { key: { accountId: ACCOUNT }, windowMs: HOUR });
    const { sql, params } = renderWhere();
    expect(sql).toContain('"gate_events"."gate" = $');
    expect(sql).toContain('"gate_events"."outcome" = $');
    expect(sql).toContain('"gate_events"."reason" = $');
    expect(sql).toContain('"gate_events"."occurred_at" > $');
    expect(sql).toContain('"gate_events"."detail" @> $');
    expect(params).toContain(GATE_SLUGS.CLAIM_LOOP_DEFERRAL);
    expect(params).toContain('rejected');
    expect(params).toContain('runner_field_missing');
    expect(params).toContain(JSON.stringify({ accountId: ACCOUNT }));
    const cutoff = params.find(p => p instanceof Date || (typeof p === 'string' && /^\d{4}-/.test(p)));
    const cutoffMs = new Date(cutoff as any).getTime();
    expect(Math.abs(Date.now() - HOUR - cutoffMs)).toBeLessThan(5000);
  });

  it('never throws when the lookup fails', async () => {
    insertShouldThrow = true;
    const id = await recordOrCoalesceRepeat(base, { key: { accountId: ACCOUNT }, windowMs: HOUR });
    expect(id).toBeNull();
  });
});
