/**
 * Unit tests for packages/core/worker-messages.ts
 *
 * The worker→worker message queue lives in `tasks.context.pendingWorkerMessages`.
 * Two operations, and the invariant that separates them: a message is only ever
 * removed from the queue by an ACK naming its id. Nothing else may clear it —
 * that is what made every auto-generated overlap message in production
 * unreadable (drained by the PATCH route before any consumer saw it).
 */

import { describe, it, expect, mock, beforeEach } from 'bun:test';

// ── DB mock ──────────────────────────────────────────────────────────────────

const mockTasksFindFirst = mock(async (_opts?: any) => null as any);
const setCalls: any[] = [];
let returningRows: any[] = [];
const mockUpdate = mock((_table: any) => ({
  set: mock((vals: any) => {
    setCalls.push(vals);
    return {
      where: mock(() => ({
        returning: mock(() => Promise.resolve(returningRows)),
      })),
    };
  }),
}));

mock.module('../db', () => ({
  db: {
    query: { tasks: { findFirst: mockTasksFindFirst } },
    update: mockUpdate,
  },
}));

const {
  WORKER_MESSAGE_CAP,
  buildWorkerMessage,
  enqueueWorkerMessage,
  clearWorkerMessages,
  buildEnqueueContextSql,
  buildClearContextSql,
} = await import('../worker-messages');

// The queue writes are single atomic statements now, so a mocked db has no
// resulting array to inspect — only the statement we sent. Render it.
const { PgDialect } = await import('drizzle-orm/pg-core');
const dialect = new PgDialect();
function render(chunk: any): { sql: string; params: unknown[] } {
  const q = dialect.sqlToQuery(chunk);
  return { sql: q.sql, params: q.params };
}

const TASK = 'task-recipient';
const SENDER = 'task-sender';

function msg(id: string) {
  return {
    id,
    type: 'question' as const,
    fromTaskId: SENDER,
    sentAt: '2026-09-04T00:00:00.000Z',
    hopCount: 0,
    body: { text: id },
  };
}

beforeEach(() => {
  setCalls.length = 0;
  returningRows = [{ id: TASK }];
  mockTasksFindFirst.mockReset();
  mockUpdate.mockClear();
});

// ── buildWorkerMessage ───────────────────────────────────────────────────────

describe('buildWorkerMessage', () => {
  it('stamps id/sentAt and defaults hopCount to 0', () => {
    const m = buildWorkerMessage({
      type: 'path_released',
      fromTaskId: SENDER,
      toTaskId: TASK,
      body: { paths: ['src/a.ts'], releasedAt: '2026-09-04T00:00:00.000Z' },
    });
    expect(m.id).toMatch(/[0-9a-f-]{36}/);
    expect(m.type).toBe('path_released');
    expect(m.hopCount).toBe(0);
    expect(typeof m.sentAt).toBe('string');
    expect(m.body).toEqual({ paths: ['src/a.ts'], releasedAt: '2026-09-04T00:00:00.000Z' });
  });
});

// ── enqueueWorkerMessage ─────────────────────────────────────────────────────
//
// These used to assert on the array the code handed the mock. That array was
// built from a snapshot read, which is the lost-update this rewrite removes:
// two producers writing at once each replaced the whole column from their own
// stale copy. The write is one statement now, so the assertions are on the
// statement.

describe('buildEnqueueContextSql', () => {
  it('appends to the live column value rather than a snapshot', () => {
    const { sql, params } = render(buildEnqueueContextSql(msg('m1')));
    // Reads context inside the SET expression — no client-side array anywhere.
    expect(sql).toContain('pendingWorkerMessages');
    expect(sql).toContain('jsonb_array_elements');
    expect(sql).toContain('||');
    expect(params.some(p => typeof p === 'string' && p.includes('"m1"'))).toBe(true);
  });

  it('caps by position so only the newest WORKER_MESSAGE_CAP survive', () => {
    const { sql, params } = render(buildEnqueueContextSql(msg('m1')));
    expect(sql).toContain('jsonb_array_length');
    expect(params).toContain(WORKER_MESSAGE_CAP);
  });
});

describe('enqueueWorkerMessage', () => {
  it('writes one atomic statement and reports success from the updated row', async () => {
    returningRows = [{ id: TASK }];
    const ok = await enqueueWorkerMessage(TASK, msg('m1'));
    expect(ok).toBe(true);
    // No pre-read: the statement itself reads the column.
    expect(mockTasksFindFirst).not.toHaveBeenCalled();
    expect(setCalls).toHaveLength(1);
    expect(render(setCalls[0].context).sql).toContain('pendingWorkerMessages');
  });

  it('returns false when the task does not exist', async () => {
    returningRows = [];
    const ok = await enqueueWorkerMessage(TASK, msg('m1'));
    expect(ok).toBe(false);
  });
});

// ── clearWorkerMessages ──────────────────────────────────────────────────────

describe('buildClearContextSql', () => {
  it('filters by id against the live column', () => {
    const { sql, params } = render(buildClearContextSql(['m2']));
    expect(sql).toContain('pendingWorkerMessages');
    expect(sql).toContain('jsonb_array_elements');
    expect(params.some(p => typeof p === 'string' && p.includes('"m2"'))).toBe(true);
  });

  it('keeps messages whose id is missing instead of dropping them', () => {
    // `jsonb ? NULL` is NULL, and NOT NULL is NULL — which would silently
    // filter the row out. The predicate has to admit a null id explicitly.
    const { sql } = render(buildClearContextSql(['m2']));
    expect(sql).toMatch(/IS NULL/i);
  });
});

describe('clearWorkerMessages', () => {
  it('writes one atomic statement for the acked ids', async () => {
    returningRows = [{ id: TASK }];
    const cleared = await clearWorkerMessages(TASK, ['m2']);
    expect(cleared).toBe(true);
    expect(setCalls).toHaveLength(1);
    expect(render(setCalls[0].context).sql).toContain('jsonb_array_elements');
  });

  it('writes nothing when the ack list is empty', async () => {
    const cleared = await clearWorkerMessages(TASK, []);
    expect(cleared).toBe(false);
    expect(setCalls).toHaveLength(0);
  });
});
