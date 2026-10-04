import { beforeEach, describe, expect, it, mock } from 'bun:test';

// ── Chainable drizzle mock ──────────────────────────────────────────────────
// Every builder call is recorded; awaiting a statement resolves to the next
// queued result for its operation.

type Call = { op: 'select' | 'insert' | 'update' | 'delete'; table: unknown; steps: Array<[string, unknown[]]> };
const calls: Call[] = [];
const results: Record<Call['op'], unknown[][]> = { select: [], insert: [], update: [], delete: [] };

function chain(call: Call): any {
  const proxy: any = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'then') return (ok: any, err: any) => Promise.resolve(results[call.op].shift() ?? []).then(ok, err);
      return (...args: unknown[]) => {
        if (prop === 'from') call.table = args[0];
        call.steps.push([String(prop), args]);
        return proxy;
      };
    },
  });
  return proxy;
}

function start(op: Call['op'], table: unknown = null) {
  const call: Call = { op, table, steps: [] };
  calls.push(call);
  return chain(call);
}

mock.module('@buildd/core/db', () => ({
  db: {
    query: { tasks: { findFirst: async () => null }, workspaces: { findFirst: async () => null } },
    select: () => start('select'),
    insert: (t: unknown) => start('insert', t),
    update: (t: unknown) => start('update', t),
    delete: (t: unknown) => start('delete', t),
  },
}));

import { artifacts, postSessionFindings } from '@buildd/core/db/schema';
import { postSessionFindingStore as store } from './post-session-findings-store';

const NOW = new Date('2026-10-04T12:00:00Z');

function dbRow(over: Record<string, unknown> = {}) {
  return {
    id: 'f-1', workspaceId: 'ws-1', policyVersion: 'psq-v1', signature: 'sig', recurrenceKey: 'rk',
    class: 'platform', severity: 'high', confidence: '0.850', title: 't', summary: 's', proposedAction: 'file_task',
    occurrenceCount: 2, firstSeenAt: NOW, lastSeenAt: NOW, affectedRefs: [], evidenceRefs: [],
    actionState: 'observed', actionTaskId: null, actionArtifactId: null, actionAt: null, createdAt: NOW, updatedAt: NOW,
    ...over,
  };
}

const aggregate = {
  class: 'platform' as const, severity: 'high' as const, confidence: 0.85, title: 't', summary: 's', recurrenceKey: 'rk',
  proposedAction: 'file_task' as const, occurrenceCount: 1, firstSeenAt: NOW, lastSeenAt: NOW, affectedRefs: [], evidenceRefs: [],
};

const step = (c: Call, name: string) => c.steps.find(s => s[0] === name);

beforeEach(() => {
  calls.length = 0;
  for (const k of Object.keys(results) as Call['op'][]) results[k] = [];
});

describe('postSessionFindingStore', () => {
  it('inserts on the unique (workspace, signature, policy) target and converts decimals', async () => {
    results.insert.push([dbRow()]);
    const row = await store.insertFinding({ workspaceId: 'ws-1', signature: 'sig', policyVersion: 'psq-v1', aggregate, now: NOW });
    expect(row?.confidence).toBe(0.85);
    const c = calls[0];
    expect(c.table).toBe(postSessionFindings);
    const conflict = step(c, 'onConflictDoNothing')![1][0] as { target: unknown[] };
    expect(conflict.target).toEqual([postSessionFindings.workspaceId, postSessionFindings.signature, postSessionFindings.policyVersion]);
    const values = step(c, 'values')![1][0] as Record<string, unknown>;
    expect(values).toMatchObject({ confidence: '0.850', updatedAt: NOW, actionState: 'observed' });
  });

  it('returns null when the insert conflicts', async () => {
    results.insert.push([]);
    expect(await store.insertFinding({ workspaceId: 'ws-1', signature: 'sig', policyVersion: 'psq-v1', aggregate, now: NOW })).toBeNull();
  });

  it('a lost CAS or a lost claim reports so', async () => {
    results.update.push([], []);
    expect(await store.updateFindingIfUnchanged('f-1', NOW, aggregate, NOW)).toBeNull();
    expect(await store.claimAction('f-1', { state: 'task_filed', taskId: 't-1', now: NOW })).toBe(false);
  });

  it('the claim never bumps updated_at', async () => {
    results.update.push([{ id: 'f-1' }]);
    expect(await store.claimAction('f-1', { state: 'proposal_filed', artifactId: 'a-1', now: NOW })).toBe(true);
    const set = step(calls[0], 'set')![1][0] as Record<string, unknown>;
    expect(set).toEqual({ actionState: 'proposal_filed', actionTaskId: null, actionArtifactId: 'a-1', actionAt: NOW });
  });

  it('proposals are keyed artifacts: a conflict resolves to the existing one', async () => {
    results.insert.push([]);
    results.select.push([{ id: 'a-existing' }]);
    const id = await store.upsertProposal('ws-1', null, {
      key: 'post-session-correction:psq-v1:sig', type: 'recommendation', title: 't', content: 'c', metadata: {} as any,
    }, NOW);
    expect(id).toBe('a-existing');
    const conflict = step(calls[0], 'onConflictDoNothing')![1][0] as { target: unknown[] };
    expect(conflict.target).toEqual([artifacts.workspaceId, artifacts.key]);
    expect((step(calls[0], 'values')![1][0] as Record<string, unknown>).visibility).toBe('private');
  });
});
