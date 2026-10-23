import { beforeEach, describe, expect, it, mock } from 'bun:test';

// In-memory tasks table: the dedupe lookup answers with the open
// [capability] task for the need, if one was filed.
type Row = { id: string; workspaceId: string; title: string; description: string; status: string; context: Record<string, unknown> };
let rows: Row[] = [];
let lastLookup: { workspaceId: string; need: string } | null = null;

const insertValues = mock((v: any) => ({
  returning: async () => {
    const r: Row = { id: `task-${rows.length + 1}`, workspaceId: v.workspaceId, title: v.title, description: v.description, status: v.status, context: v.context };
    rows.push(r);
    return [{ id: r.id }];
  },
}));
const updateSet = mock((_v: any) => ({ where: async () => undefined }));

mock.module('@buildd/core/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            const hit = rows.find(r => lastLookup && r.workspaceId === lastLookup.workspaceId
              && r.context.type === 'capability_blocker' && r.context.capabilityNeed === lastLookup.need
              && ['pending', 'assigned', 'in_progress'].includes(r.status));
            return hit ? [{ id: hit.id, description: hit.description }] : [];
          },
        }),
      }),
    }),
    insert: () => ({ values: insertValues }),
    update: () => ({ set: updateSet }),
  },
}));

const { fileCapabilityTask, settleCapabilityBlocker, toCallRecord } = await import('./capability-blocker-store');

const claim = { need: 'model.inference', triedPath: 'Needed a governed model call.' };
const WORKER_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const WORKER_B = 'bbbbbbbb-0000-4000-8000-000000000002';

function file(workerId: string, workspaceId = 'ws-1') {
  lastLookup = { workspaceId, need: claim.need };
  return fileCapabilityTask({ workspaceId, claim, outcome: 'unavailable', sourceTaskId: 'cccccccc-0000-4000-8000-000000000003', sourceTaskTitle: 'Eval', workerId });
}

describe('fileCapabilityTask', () => {
  beforeEach(() => {
    rows = [];
    lastLookup = null;
    insertValues.mockClear();
    updateSet.mockClear();
  });

  it('files one [capability] task, and a second identical outcome appends to it', async () => {
    const first = await file(WORKER_A);
    expect(first.deduplicated).toBe(false);
    expect(insertValues).toHaveBeenCalledTimes(1);
    const inserted = insertValues.mock.calls[0][0];
    expect(inserted.title).toBe('[capability] model.inference is not available to agents in this workspace');
    expect(inserted.context).toMatchObject({ type: 'capability_blocker', capabilityNeed: 'model.inference', outcome: 'unavailable' });
    expect(inserted.description).toContain('Needed a governed model call.');

    const second = await file(WORKER_B);
    expect(second).toEqual({ id: first.id, deduplicated: true });
    expect(insertValues).toHaveBeenCalledTimes(1);
    expect(updateSet).toHaveBeenCalledTimes(1);
  });

  it('a retried completion from the same worker appends nothing', async () => {
    await file(WORKER_A);
    const again = await file(WORKER_A);
    expect(again.deduplicated).toBe(true);
    expect(updateSet).not.toHaveBeenCalled();
  });

  it('dedupes per workspace: another workspace gets its own task', async () => {
    await file(WORKER_A, 'ws-1');
    const other = await file(WORKER_B, 'ws-2');
    expect(other.deduplicated).toBe(false);
    expect(insertValues).toHaveBeenCalledTimes(2);
  });
});

describe('toCallRecord', () => {
  const at = new Date('2026-10-22T10:00:00Z');
  it('reads the ask from sideEffect, and from resource on older rows', () => {
    expect(toCallRecord({ capability: 'capability.request', resource: 'grant:g-1', reasonCode: 'pending_approval:write_needs_human', sideEffect: { capability: 'model.inference', provider: 'openrouter' }, occurredAt: at }))
      .toMatchObject({ call: 'request', capability: 'model.inference', provider: 'openrouter', outcome: 'pending_approval', grantId: 'g-1' });
    expect(toCallRecord({ capability: 'capability.request', resource: 'axiom:read@axiom', reasonCode: 'unavailable:no_provider', sideEffect: { risk: 'read' }, occurredAt: at }))
      .toMatchObject({ capability: 'axiom:read', provider: 'axiom', outcome: 'unavailable', grantId: null });
    expect(toCallRecord({ capability: 'capability.resolve', resource: 'observability:query', reasonCode: 'served', sideEffect: { capability: 'observability:query', providers: ['axiom'] }, occurredAt: at }))
      .toMatchObject({ call: 'resolve', outcome: 'served', providers: ['axiom'] });
    expect(toCallRecord({ capability: 'capability.use', resource: null, reasonCode: 'ok', sideEffect: null, occurredAt: at })).toBeNull();
  });
});

describe('settleCapabilityBlocker', () => {
  const input = { claim, workerId: WORKER_A, workspaceId: 'ws-1', taskId: 'task-src', taskTitle: 'Eval' };

  it('refuses with no ask and files nothing', async () => {
    const fileFn = mock(async () => ({ id: 'x', deduplicated: false }));
    const out = await settleCapabilityBlocker(input, { load: async () => ({ calls: [], requests: [] }), file: fileFn });
    expect(out.ok).toBe(false);
    expect(fileFn).not.toHaveBeenCalled();
  });

  it('routes an unavailable answer to a [capability] task', async () => {
    const fileFn = mock(async () => ({ id: 'cap-task', deduplicated: false }));
    const out = await settleCapabilityBlocker(input, {
      load: async () => ({ calls: [{ call: 'request', capability: 'model.inference', provider: 'openrouter', outcome: 'unavailable', grantId: null, at: new Date() }], requests: [] }),
      file: fileFn,
    });
    expect(out).toEqual({ ok: true, record: { ...claim, outcome: 'unavailable', routedTo: 'capability_task', capabilityTaskId: 'cap-task' } });
  });

  it('routes a denied request to that request and files nothing', async () => {
    const fileFn = mock(async () => ({ id: 'x', deduplicated: false }));
    const out = await settleCapabilityBlocker(input, {
      load: async () => ({ calls: [], requests: [{ id: 'g-1', capability: 'model.inference', provider: 'openrouter', status: 'denied', requestedAt: new Date() }] }),
      file: fileFn,
    });
    expect(out).toEqual({ ok: true, record: { ...claim, outcome: 'denied', routedTo: 'capability_request', requestId: 'g-1' } });
    expect(fileFn).not.toHaveBeenCalled();
  });
});
