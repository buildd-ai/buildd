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
  },
}));

const { recordGateEvent, GATE_SLUGS } = await import('../gate-events');

const WS = '11111111-2222-4333-8444-555555555555';

beforeEach(() => {
  inserted = [];
  insertShouldThrow = false;
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
