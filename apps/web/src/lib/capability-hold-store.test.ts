/**
 * The hold's db half (capability-hold-store.ts) against an in-memory table:
 * the completion verdict reads the team's wait window and applies its side
 * effects; the agent withdraws its own request and no one else's; the sweep
 * expires an unanswered request as `wait_window_elapsed` (never "task ended")
 * and tells the worker; a decision reaches the worker's instruction queue.
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { capturedWhere } from '@buildd/core/db/relational-sql';

type Row = Record<string, any>;
type Pred = (r: Row) => boolean;
const col = (name: string) => ({ __col: name });
const tableOf = (name: string, cols: string[]) => Object.assign({ __table: name }, Object.fromEntries(cols.map(c => [c, col(c)])));

mock.module('drizzle-orm', () => ({
  eq: (c: any, v: any): Pred => r => r[c.__col] === v,
  and: (...ps: Pred[]): Pred => r => ps.every(p => p(r)),
  inArray: (c: any, vs: any[]): Pred => r => vs.includes(r[c.__col]),
  lte: (c: any, v: any): Pred => r => r[c.__col] != null && r[c.__col] <= v,
  desc: (c: any) => ({ desc: c.__col }),
}));

const schema = {
  capabilityGrants: tableOf('grants', ['id', 'teamId', 'workspaceId', 'taskId', 'workerId', 'status', 'capability', 'requestedAt', 'decidedAt', 'decisionReason', 'decidedBy']),
  teams: tableOf('teams', ['id', 'accessWaitWindowSeconds']),
  workspaces: tableOf('workspaces', ['id', 'teamId']),
  workers: tableOf('workers', ['id']),
};
mock.module('@buildd/core/db/schema', () => schema);

const T: Record<string, Row[]> = { grants: [], teams: [], workspaces: [], workers: [] };

const finder = (name: string) => ({
  findFirst: async (q: { where?: unknown } = {}) => { const w = capturedWhere(q.where) as Pred | undefined; const r = T[name].find(r => !w || w(r)); return r ? { ...r, workspace: r.workspace } : undefined; },
  findMany: async (q: { where?: unknown } = {}) => { const w = capturedWhere(q.where) as Pred | undefined; return T[name].filter(r => !w || w(r)).map(r => ({ ...r })); },
});

/** `select({...}).from(a).leftJoin(b, on).where(p).limit(n)`: joins by the one FK each query uses. */
function select(shape: Record<string, any>) {
  let from = '';
  let joined: { table: string; by: (a: Row, b: Row) => boolean } | null = null;
  let pred: Pred | null = null;
  const run = async () => {
    let rows = T[from].map(r => ({ ...r }));
    if (pred) rows = rows.filter(pred);
    return rows.map(r => {
      const other = joined ? T[joined.table].find(b => joined!.by(r, b)) ?? null : null;
      const out: Row = {};
      for (const [k, v] of Object.entries(shape)) {
        if (v && v.__table) out[k] = r;
        else if (v && v.__col) out[k] = from === 'workspaces' && v.__col === 'accessWaitWindowSeconds' ? other?.[v.__col] ?? null : (v.__col in r ? r[v.__col] : other?.[v.__col] ?? null);
      }
      return out;
    });
  };
  const chain: any = {
    from: (t: any) => { from = t.__table; return chain; },
    leftJoin: (t: any) => {
      joined = { table: t.__table, by: from === 'workspaces' ? (a, b) => b.id === a.teamId : (a, b) => b.id === a.teamId };
      return chain;
    },
    where: (p: Pred) => { pred = p; return chain; },
    limit: () => chain,
    then: (res: any, rej: any) => run().then(res, rej),
  };
  return chain;
}

const db = {
  query: { capabilityGrants: finder('grants'), workers: finder('workers') },
  select,
  update: (t: any) => ({
    set: (v: Row) => ({
      where: (p: Pred) => {
        const run = async () => { const hit = T[t.__table].filter(p); hit.forEach(r => Object.assign(r, v)); return hit.map(r => ({ ...r })); };
        const pr = run();
        return Object.assign(pr, { returning: () => pr });
      },
    }),
  }),
};
mock.module('@buildd/core/db', () => ({ db }));

const audit: any[] = [];
mock.module('./agent-capabilities/audit', () => ({ recordCapabilityDecision: (r: any) => { audit.push(r); return Promise.resolve(); } }));
const queued: { workerId: string; text: string; opts: any }[] = [];
mock.module('./system-instruction-queue', () => ({ queueSystemInstruction: async (workerId: string, text: string, opts: any) => { queued.push({ workerId, text, opts }); return T.workers.some(w => w.id === workerId); } }));
const pushed: string[] = [];
mock.module('./worker-instruction-push', () => ({ pushInstructionDelivery: async (workerId: string) => { pushed.push(workerId); } }));

const { evaluateCompletionHold, expireOverdueRequests, withdrawCapabilityRequest, notifyWorkerOfAccessDecision, teamWaitWindowMs } = await import('./capability-hold-store');

const NOW = new Date('2026-11-07T12:00:00Z');
const TEAM = 'team-a';
const WS = '33333333-3333-4333-8333-333333333333';
const TASK = '22222222-2222-4222-8222-222222222222';
const WORKER = '11111111-1111-4111-8111-111111111111';
const OTHER_WORKER = '99999999-9999-4999-8999-999999999999';
const R1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PRINCIPAL = { workerId: WORKER, taskId: TASK, workspaceId: WS, accountId: 'acct-1', via: 'task_token' as const };

const grant = (over: Row = {}): Row => ({
  id: R1, teamId: TEAM, workspaceId: WS, taskId: TASK, workerId: WORKER, capability: 'database.query', provider: 'neon', risk: 'read',
  tool: null, resource: null, status: 'pending', decidedBy: null, decidedAt: null, decisionReason: null,
  requestedAt: new Date(NOW.getTime() - 10 * 60_000), expiresAt: null, scope: null, ...over,
});

beforeEach(() => {
  T.grants = []; audit.length = 0; queued.length = 0; pushed.length = 0;
  T.teams = [{ id: TEAM, accessWaitWindowSeconds: null }];
  T.workspaces = [{ id: WS, teamId: TEAM }];
  T.workers = [{ id: WORKER, workspace: { dataClass: 'standard' } }];
  delete process.env.BUILDD_QUERY_DATABASE_URL;
});

describe('teamWaitWindowMs', () => {
  it('reads the team setting through the workspace, default when unset', async () => {
    expect(await teamWaitWindowMs(WS)).toBe(4 * 3600 * 1000);
    T.teams[0].accessWaitWindowSeconds = 1800;
    expect(await teamWaitWindowMs(WS)).toBe(1800 * 1000);
  });
});

describe('evaluateCompletionHold', () => {
  it('no request, no declaration: passes without reading the team', async () => {
    const v = await evaluateCompletionHold({ workerId: WORKER, taskId: TASK, workspaceId: WS, structuredOutput: { shipped: { lede: 'x' } }, now: NOW });
    expect(v).toMatchObject({ kind: 'pass', summaryLead: null });
  });

  it('a pending request inside the window holds; past the team window it is expired on the pass', async () => {
    T.grants = [grant()];
    expect(await evaluateCompletionHold({ workerId: WORKER, taskId: TASK, workspaceId: WS, structuredOutput: undefined, now: NOW })).toMatchObject({ kind: 'refuse', code: 'capability_request_pending' });
    // The team waits 5 minutes; the request is 10 minutes old.
    T.teams[0].accessWaitWindowSeconds = 300;
    expect(await evaluateCompletionHold({ workerId: WORKER, taskId: TASK, workspaceId: WS, structuredOutput: undefined, now: NOW })).toMatchObject({ kind: 'refuse', code: 'capability_outcome_unreported' });
    const v = await evaluateCompletionHold({ workerId: WORKER, taskId: TASK, workspaceId: WS, structuredOutput: { blockedByCapability: { requestId: R1 } }, now: NOW });
    expect(v).toMatchObject({ kind: 'pass', expire: [R1], blockedByCapability: [{ requestId: R1, outcome: 'expired', reason: 'wait_window_elapsed' }] });
    expect(T.grants[0]).toMatchObject({ status: 'expired', decidedBy: 'system', decisionReason: 'wait_window_elapsed' });
    expect(audit).toContainEqual(expect.objectContaining({ capability: 'capability.expire', resource: `grant:${R1}`, reasonCode: 'wait_window_elapsed' }));
  });

  it('giving up on a pending request closes it as the agent\'s doing', async () => {
    T.grants = [grant()];
    const v = await evaluateCompletionHold({ workerId: WORKER, taskId: TASK, workspaceId: WS, structuredOutput: { blockedByCapability: { requestId: R1, whatIsMissing: 'No prod counts.' } }, now: NOW });
    expect(v).toMatchObject({ kind: 'pass', stopWaiting: [R1] });
    expect(T.grants[0]).toMatchObject({ status: 'expired', decidedBy: 'agent', decisionReason: 'agent_stopped_waiting' });
    expect(audit).toContainEqual(expect.objectContaining({ capability: 'capability.withdraw', reasonCode: 'agent_stopped_waiting' }));
  });

  it('a granted database read with no query role configured is a blocker of its own kind, not a denial', async () => {
    T.grants = [grant({ status: 'granted', decidedBy: 'human', decidedAt: NOW, expiresAt: new Date(NOW.getTime() + 3600_000) })];
    expect(await evaluateCompletionHold({ workerId: WORKER, taskId: TASK, workspaceId: WS, structuredOutput: undefined, now: NOW })).toMatchObject({ kind: 'refuse', code: 'capability_outcome_unreported' });
    const v = await evaluateCompletionHold({ workerId: WORKER, taskId: TASK, workspaceId: WS, structuredOutput: { blockedByCapability: { requestId: R1 } }, now: NOW });
    expect(v).toMatchObject({ kind: 'pass', blockedByCapability: [{ requestId: R1, outcome: 'query_role_unconfigured' }] });
    // With the role configured the same grant is simply usable.
    process.env.BUILDD_QUERY_DATABASE_URL = 'postgres://ro@example/db';
    expect(await evaluateCompletionHold({ workerId: WORKER, taskId: TASK, workspaceId: WS, structuredOutput: undefined, now: NOW })).toMatchObject({ kind: 'pass', summaryLead: null });
  });

  it('another worker\'s request on the same task is not this worker\'s hold', async () => {
    T.grants = [grant({ workerId: OTHER_WORKER })];
    expect(await evaluateCompletionHold({ workerId: WORKER, taskId: TASK, workspaceId: WS, structuredOutput: undefined, now: NOW })).toMatchObject({ kind: 'pass' });
  });
});

describe('withdrawCapabilityRequest', () => {
  it('closes the agent\'s own pending request as withdrawn, idempotently', async () => {
    T.grants = [grant()];
    expect(await withdrawCapabilityRequest(PRINCIPAL, R1, NOW)).toMatchObject({ ok: true, requestId: R1, alreadyClosed: false, status: 'expired' });
    expect(T.grants[0]).toMatchObject({ status: 'expired', decidedBy: 'agent', decisionReason: 'withdrawn', decidedAt: NOW });
    expect(audit).toContainEqual(expect.objectContaining({ capability: 'capability.withdraw', reasonCode: 'withdrawn', workerId: WORKER }));
    expect(await withdrawCapabilityRequest(PRINCIPAL, R1, NOW)).toMatchObject({ ok: true, alreadyClosed: true });
  });

  it('another worker\'s request is not found; a granted one is kept; a decided one says so', async () => {
    T.grants = [grant({ workerId: OTHER_WORKER })];
    expect(await withdrawCapabilityRequest(PRINCIPAL, R1, NOW)).toMatchObject({ ok: false, status: 404, code: 'not_found' });
    T.grants = [grant({ status: 'granted', decidedBy: 'human', decidedAt: NOW })];
    expect(await withdrawCapabilityRequest(PRINCIPAL, R1, NOW)).toMatchObject({ ok: false, status: 409, code: 'already_granted', requestStatus: 'granted' });
    expect(T.grants[0].status).toBe('granted');
    T.grants = [grant({ status: 'denied', decidedBy: 'human', decidedAt: NOW })];
    expect(await withdrawCapabilityRequest(PRINCIPAL, R1, NOW)).toMatchObject({ ok: false, status: 409, code: 'already_decided', requestStatus: 'denied' });
  });
});

describe('expireOverdueRequests', () => {
  it('expires a request older than the team window as wait_window_elapsed and tells the worker; a fresh one stays', async () => {
    T.grants = [grant(), grant({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', requestedAt: new Date(NOW.getTime() - 5 * 3600_000) })];
    const out = await expireOverdueRequests({ now: NOW });
    expect(out.map(o => o.requestId)).toEqual(['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb']);
    expect(T.grants[1]).toMatchObject({ status: 'expired', decidedBy: 'system', decisionReason: 'wait_window_elapsed' });
    expect(T.grants[0].status).toBe('pending');
    expect(queued).toHaveLength(1);
    expect(queued[0].workerId).toBe(WORKER);
    expect(queued[0].text).toContain('expired');
    expect(queued[0].text).toContain('blockedByCapability');
    expect(queued[0].opts.marker).toBe('[access expired bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb]');
    expect(pushed).toEqual([WORKER]);
    expect(audit).toContainEqual(expect.objectContaining({ capability: 'capability.expire', reasonCode: 'wait_window_elapsed' }));
  });

  it('honours a shorter team window and a team scope', async () => {
    T.teams[0].accessWaitWindowSeconds = 300;
    T.grants = [grant(), grant({ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', teamId: 'team-b', workspaceId: 'ws-b', requestedAt: new Date(NOW.getTime() - 6 * 3600_000) })];
    const out = await expireOverdueRequests({ teamId: TEAM, now: NOW });
    expect(out.map(o => o.requestId)).toEqual([R1]);
    expect(T.grants[1].status).toBe('pending');
  });
});

describe('notifyWorkerOfAccessDecision', () => {
  it('queues the decision once per request and wakes the runner; an ended worker gets nothing', async () => {
    T.grants = [grant()];
    expect(await notifyWorkerOfAccessDecision({ id: R1, capability: 'database.query', workerId: WORKER }, 'approved')).toBe(true);
    expect(queued[0].text).toContain('approved');
    expect(queued[0].text).toContain('query_database');
    expect(queued[0].opts).toEqual({ marker: `[access approved ${R1}]`, sensitive: false });
    expect(pushed).toEqual([WORKER]);
    T.workers = [];
    expect(await notifyWorkerOfAccessDecision({ id: R1, capability: 'database.query', workerId: WORKER }, 'denied', { reason: 'not for this task' })).toBe(false);
    expect(queued[1].text).toContain('"not for this task"');
    expect(pushed).toHaveLength(1);
  });
});
