import { describe, it, expect, beforeEach, mock } from 'bun:test';

// ─── DB mocks ─────────────────────────────────────────────────────────────────

let taskRows: any[][] = [];
let workerRows: any[][] = [];
let updateReturning: any[] = [];
const updates: Array<{ set: any; where: any }> = [];
const inserts: any[] = [];

const tasksFindMany = mock(async (_args?: any) => taskRows.shift() ?? []);
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      tasks: {
        findMany: tasksFindMany,
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

const familyCalls: string[] = [];
let familyIds: string[] = [];
mock.module('./retry-pr-supersession', () => ({
  collectRetryFamily: mock(async (id: string) => { familyCalls.push(id); return { rootId: 'orig', taskIds: familyIds }; }),
}));

import { loadOpenRetryIds, subjectHasLiveSuccessor, supersessionStore } from './supersession-store';
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
  familyCalls.length = 0;
  familyIds = [];
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

describe('loadOpenRetryIds (the one-open-retry-per-PR fact)', () => {
  const at = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s));

  it('returns every open attempt bound to the PR through any retry key, from any parent', async () => {
    taskRows = [[{ id: 'review-fix', createdAt: at(1) }, { id: 'ci-fix', createdAt: at(2) }]];
    expect(await loadOpenRetryIds('ws-1', 42, null)).toEqual(['review-fix', 'ci-fix']);
  });

  it('post-insert: excludes the inserted row and counts only attempts ordered before it', async () => {
    taskRows = [[{ id: 'older', createdAt: at(1) }, { id: 'self', createdAt: at(2) }, { id: 'newer', createdAt: at(3) }]];
    expect(await loadOpenRetryIds('ws-1', 42, 'self')).toEqual(['older']);
  });

  it('breaks a createdAt tie by id, so exactly one of two simultaneous inserts survives', async () => {
    const rows = [{ id: 'a', createdAt: at(1) }, { id: 'b', createdAt: at(1) }];
    taskRows = [rows, rows];
    expect(await loadOpenRetryIds('ws-1', 42, 'a')).toEqual([]);
    expect(await loadOpenRetryIds('ws-1', 42, 'b')).toEqual(['a']);
  });

  const findManyWhere = () => (tasksFindMany.mock.calls.at(-1) as any[])[0].where;

  it('family: also loads open attempts by id from the retry family, whatever PR they are bound to', async () => {
    taskRows = [[{ id: 'sibling-fix-for-other-pr', createdAt: at(1), status: 'in_progress', category: null }]];
    expect(await loadOpenRetryIds('ws-1', 42, null, { familyTaskIds: ['orig', 'sibling-fix-for-other-pr'] }))
      .toEqual(['sibling-fix-for-other-pr']);
    const scope = findManyWhere().args[3];
    expect(scope.op).toBe('or');
    expect(scope.args[1]).toEqual({ op: 'inArray', a: 'tasks.id', b: ['orig', 'sibling-fix-for-other-pr'] });
  });

  it('without a family the scope is the PR binding alone (unchanged)', async () => {
    taskRows = [[]];
    await loadOpenRetryIds('ws-1', 42, null);
    expect(findManyWhere().args[3].args.map((a: any) => a.a)).toEqual([
      'tasks.reviewerRetryPrNumber', 'tasks.ciRetryPrNumber', 'tasks.conflictRetryPrNumber',
    ]);
  });

  it('a reviewer task is an attempt but never a blocker', async () => {
    taskRows = [[{ id: 'reviewer', createdAt: at(1), status: 'in_progress', category: 'review' }]];
    expect(await loadOpenRetryIds('ws-1', 42, null, { familyTaskIds: ['reviewer'] })).toEqual([]);
  });

  it('claim mode counts a newer sibling that already started', async () => {
    const rows = [{ id: 'self', createdAt: at(1), status: 'pending' }, { id: 'newer', createdAt: at(2), status: 'in_progress' }];
    taskRows = [rows, rows];
    expect(await loadOpenRetryIds('ws-1', 42, 'self')).toEqual([]);
    expect(await loadOpenRetryIds('ws-1', 42, 'self', { startedAlwaysCounts: true })).toEqual(['newer']);
  });
});

describe('loadDispatchFacts — the retry family feeds the open-retry fact', () => {
  it('reads the family of the proposal parent and passes claim mode through', async () => {
    familyIds = ['orig', 'sib'];
    taskRows = [
      [{ id: 'sib', createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 2)), status: 'in_progress', category: null },
       { id: 'self', createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 1)), status: 'pending', category: null }],
      [], // parent lookup
    ];
    workerRows = [[]];
    const facts = await supersessionStore.loadDispatchFacts({
      kind: 'ci_retry', workspaceId: 'ws-1', prNumber: 42, parentTaskId: 'orig', door: 't', selfTaskId: 'self', mode: 'claim',
    });
    expect(familyCalls).toEqual(['orig']);
    expect(facts.openRetryIds).toEqual(['sib']);
  });

  it('a family read failure falls back to the per-PR set instead of failing the dispatch', async () => {
    const mod: any = await import('./retry-pr-supersession');
    mod.collectRetryFamily.mockImplementationOnce(async () => { throw new Error('db down'); });
    taskRows = [[{ id: 'bound', createdAt: new Date(0), status: 'pending', category: null }], []];
    workerRows = [[]];
    const facts = await supersessionStore.loadDispatchFacts({ kind: 'ci_retry', workspaceId: 'ws-1', prNumber: 42, parentTaskId: 'orig', door: 't' });
    expect(facts.openRetryIds).toEqual(['bound']);
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
