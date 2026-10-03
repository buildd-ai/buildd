import { describe, it, expect, beforeEach, mock } from 'bun:test';

// ─── DB mocks ─────────────────────────────────────────────────────────────────

let taskRows: any[][] = [];
let workerRows: any[][] = [];
let updateReturning: any[] = [];
const updates: Array<{ set: any; where: any }> = [];
const inserts: any[] = [];

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      tasks: {
        findMany: mock(async () => taskRows.shift() ?? []),
        findFirst: mock(async () => (taskRows.shift() ?? [])[0] ?? null),
      },
      workers: {
        findMany: mock(async () => workerRows.shift() ?? []),
        findFirst: mock(async () => (workerRows.shift() ?? [])[0] ?? null),
      },
    },
    update: () => ({
      set: (set: any) => ({
        where: (where: any) => {
          updates.push({ set, where });
          const p: any = Promise.resolve();
          p.returning = () => Promise.resolve(updateReturning);
          return p;
        },
      }),
    }),
    insert: () => ({
      values: (v: any) => {
        inserts.push(v);
        return Promise.resolve();
      },
    }),
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (a: any, b: any) => ({ op: 'eq', a, b }),
  and: (...args: any[]) => ({ op: 'and', args }),
  or: (...args: any[]) => ({ op: 'or', args }),
  inArray: (a: any, b: any) => ({ op: 'inArray', a, b }),
  isNotNull: (a: any) => ({ op: 'isNotNull', a }),
  desc: (a: any) => ({ op: 'desc', a }),
  sql: (strings: TemplateStringsArray, ...values: any[]) => ({ op: 'sql', strings, values }),
}));

mock.module('@buildd/core/db/schema', () => ({
  tasks: new Proxy({}, { get: (_t, k) => `tasks.${String(k)}` }),
  workers: new Proxy({}, { get: (_t, k) => `workers.${String(k)}` }),
  missionNotes: 'missionNotes',
  taskSubjectReports: 'taskSubjectReports',
}));

const gateEvents: any[] = [];
mock.module('@buildd/core/gate-events', () => ({
  GATE_SLUGS: { SUPERSESSION: 'supersession' },
  recordGateEvent: mock(async (e: any) => { gateEvents.push(e); return 'row'; }),
}));

const activity: any[] = [];
mock.module('./pr-activity-comment', () => ({
  appendPrActivity: mock(async (p: any) => { activity.push(p); return { action: 'appended' }; }),
}));

const released: string[] = [];
mock.module('./path-claim-release', () => ({
  releaseAndNotify: mock(async (id: string) => { released.push(id); }),
}));

const pushes: Array<{ channel: string; event: string; payload: any }> = [];
mock.module('./pusher', () => ({
  triggerEvent: mock(async (channel: string, event: string, payload: any) => { pushes.push({ channel, event, payload }); }),
  channels: { workspace: (id: string) => `ws:${id}`, worker: (id: string) => `worker:${id}` },
  events: { TASK_UPDATED: 'task:updated', WORKER_COMMAND: 'worker:command' },
}));

import { subjectHasLiveSuccessor, supersessionStore } from './supersession-store';
import { SUPERSESSION_RULES, type SupersessionCandidate, type SubjectEvent } from './supersession';

const rule = (id: string) => SUPERSESSION_RULES.find(r => r.id === id)!;

const candidate = (o: Partial<SupersessionCandidate> = {}): SupersessionCandidate => ({
  id: 'fix-1', workspaceId: 'ws-1', missionId: 'mission-1', status: 'pending', parentTaskId: 'orig',
  category: null, taskClass: 'attempt', creationSource: 'webhook', reviewerRetryPrNumber: 42,
  reviewerRetryHeadSha: 'sha', ciRetryPrNumber: null, subjectPrNumber: null, subjectAnchor: null,
  subjectResolution: null, context: null, createdAt: null, ownLivePrNumber: null, ...o,
});

const approveEvent: SubjectEvent = {
  kind: 'verdict', verdict: 'approve', workspaceId: 'ws-1', prNumber: 42, reviewerTaskId: 'r',
  originalTaskId: 'orig', door: 'test door', pr: { installationId: 1, repoFullName: 'o/r' },
};

beforeEach(() => {
  taskRows = [];
  workerRows = [];
  updateReturning = [];
  updates.length = 0;
  inserts.length = 0;
  gateEvents.length = 0;
  activity.length = 0;
  released.length = 0;
  pushes.length = 0;
});

describe('subjectHasLiveSuccessor (the liveness half of the old subject sweep)', () => {
  it('is false when nothing is anchored to the PR', async () => {
    taskRows = [[]];
    expect(await subjectHasLiveSuccessor('ws-1', 42)).toBe(false);
  });

  it('is false when only closed/merged PRs exist in the chain', async () => {
    taskRows = [[{ id: 't1', parentTaskId: null }]];
    workerRows = [[{ prLifecycleStatus: 'closed' }, { prLifecycleStatus: 'merged' }]];
    expect(await subjectHasLiveSuccessor('ws-1', 42)).toBe(false);
  });

  it('is true when a retry-chain member has an open PR (e.g. ci_running)', async () => {
    taskRows = [[{ id: 't1', parentTaskId: 'p1' }], [{ id: 'sibling' }]];
    workerRows = [[{ prLifecycleStatus: 'ci_running' }]];
    expect(await subjectHasLiveSuccessor('ws-1', 42)).toBe(true);
  });
});

describe('loadCandidates', () => {
  it('records each task\'s own open PR and ignores a merged or closed one', async () => {
    taskRows = [[candidate({ id: 'a' }), candidate({ id: 'b' }), candidate({ id: 'c' })]];
    workerRows = [[
      { taskId: 'a', prNumber: 99, prLifecycleStatus: 'open', mergedAt: null },
      { taskId: 'b', prNumber: 98, prLifecycleStatus: 'merged', mergedAt: new Date() },
      { taskId: 'c', prNumber: 97, prLifecycleStatus: 'closed', mergedAt: null },
    ]];
    const rows = await supersessionStore.loadCandidates(approveEvent);
    expect(rows.map(r => [r.id, r.ownLivePrNumber])).toEqual([['a', 99], ['b', null], ['c', null]]);
  });
});

describe('casCancel', () => {
  it('is a status CAS: the WHERE carries the id and the rule\'s statuses, and only RETURNING wins', async () => {
    updateReturning = [{ id: 'fix-1' }];
    expect(await supersessionStore.casCancel(candidate(), rule('approve_supersedes_fix'))).toBe(true);
    const { set, where } = updates[0];
    expect(set.status).toBe('cancelled');
    expect(where.args).toContainEqual({ op: 'eq', a: 'tasks.id', b: 'fix-1' });
    expect(where.args).toContainEqual({ op: 'inArray', a: 'tasks.status', b: ['pending', 'assigned', 'in_progress'] });

    updateReturning = [];
    expect(await supersessionStore.casCancel(candidate(), rule('approve_supersedes_fix'))).toBe(false);
  });

  it('stamps reconciled and narrows to unstarted work for close_reconciles_subject', async () => {
    updateReturning = [{ id: 'x' }];
    await supersessionStore.casCancel(candidate(), rule('close_reconciles_subject'));
    const { set, where } = updates[0];
    expect(set).toMatchObject({ status: 'cancelled', subjectResolution: 'reconciled' });
    expect(where.args).toContainEqual({ op: 'inArray', a: 'tasks.status', b: ['pending', 'assigned'] });
  });
});

describe('applyCancelEffects', () => {
  it('fails each live worker, aborts its session, releases claims and broadcasts', async () => {
    workerRows = [[{ id: 'w1', status: 'running' }]];
    await supersessionStore.applyCancelEffects(candidate(), rule('approve_supersedes_fix'), approveEvent);
    expect(updates[0].set).toMatchObject({ status: 'failed', exitCause: 'condition_unmet' });
    expect(released).toEqual(['fix-1']);
    expect(pushes.map(p => p.event).sort()).toEqual(['task:updated', 'worker:command']);
    expect(pushes.find(p => p.event === 'worker:command')!.payload).toMatchObject({ action: 'abort', reason: 'approve_supersedes_fix' });
  });

  it('writes the subject audit row for close_reconciles_subject', async () => {
    workerRows = [[]];
    await supersessionStore.applyCancelEffects(
      candidate({ subjectAnchor: { source: 'system', confidence: 'exact' } }),
      rule('close_reconciles_subject'),
      { kind: 'closed', workspaceId: 'ws-1', prNumber: 42, door: 't' },
    );
    expect(inserts[0]).toMatchObject({ taskId: 'fix-1', origin: 'system' });
    expect(inserts[0].note).toContain('subject_reconciled');
  });
});

describe('recordSupersession', () => {
  it('writes one supersession ledger row with the rule id and the event', async () => {
    await supersessionStore.recordSupersession(candidate(), rule('approve_supersedes_fix'), approveEvent);
    expect(gateEvents).toHaveLength(1);
    expect(gateEvents[0]).toMatchObject({
      gate: 'supersession', outcome: 'accepted', surface: 'test door', taskId: 'fix-1',
      detail: { rule: 'approve_supersedes_fix', event: { kind: 'verdict', prNumber: 42 } },
    });
    expect(activity).toHaveLength(1);
    expect(activity[0].entry).toEqual({ kind: 'fix_superseded_by_approval' });
  });

  it('keeps the existing wording for a merge-cancelled review and labels the rest', async () => {
    const merged: SubjectEvent = { kind: 'merged', workspaceId: 'ws-1', prNumber: 42, door: 't', pr: { installationId: 1, repoFullName: 'o/r' } };
    await supersessionStore.recordSupersession(candidate(), rule('merge_supersedes_review'), merged);
    await supersessionStore.recordSupersession(candidate(), rule('merge_supersedes_fix'), merged);
    expect(activity.map(a => a.entry)).toEqual([
      { kind: 'review_superseded_by_merge' },
      { kind: 'work_superseded', detail: 'fix cancelled · already merged' },
    ]);
  });

  it('writes no PR activity when the door did not know the repo', async () => {
    await supersessionStore.recordSupersession(candidate(), rule('cancel_supersedes_retry'), {
      kind: 'cancelled', workspaceId: 'ws-1', taskId: 'orig', door: 't',
    });
    expect(gateEvents).toHaveLength(1);
    expect(activity).toHaveLength(0);
  });
});

describe('recordBulkRefusal', () => {
  it('records the would-cancel set as a rejected ledger row and posts a note', async () => {
    const would = [{ task: candidate({ id: 'a' }), verdict: 'cancel' as const, rule: 'approve_supersedes_fix' as const, bound: null }];
    await supersessionStore.recordBulkRefusal(approveEvent, would);
    expect(gateEvents[0]).toMatchObject({ gate: 'supersession', outcome: 'rejected', detail: { wouldCancel: [{ taskId: 'a', rule: 'approve_supersedes_fix' }] } });
    expect(inserts[0]).toMatchObject({ type: 'warning', missionId: 'mission-1' });
  });
});
