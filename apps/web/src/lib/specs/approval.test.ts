/**
 * The approve response path (lib/specs/approval.ts): what a person waits for
 * when they press Approve. The approval itself (the CAS statement, who may
 * approve, stale versions) is pinned against real Postgres in
 * apps/web/tests/db/spec-approval.test.ts; this file pins only latency shape:
 * - the knowledge index (`spec.approved`) runs after the response, never on it;
 * - the access check and the approver check go out together;
 * - the two reads after the approval go out together;
 * - a caller the workspace does not reach is still a 404 before a 403.
 *
 * The db here is a stub that returns rows by table; no predicate is asserted,
 * so nothing below claims anything about a WHERE clause.
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { specRevisions, specs, users, workspaces } from '@buildd/core/db/schema';

const SPEC = '11111111-1111-4111-8111-111111111111';
const WS = '22222222-2222-4222-8222-222222222222';
const specRow = { id: SPEC, workspaceId: WS, status: 'in_review', version: 3, headRevision: 2, approvedRevision: 1 };

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void };
const deferred = <T,>(): Deferred<T> => { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };

let rowsByTable: Map<unknown, unknown[][]>;
let inflight = 0;
let maxInflightAfterWrite = 0;
let wrote = false;
const selectedTables: unknown[] = [];
const query = (table: unknown) => ({
  where: () => ({
    limit: async () => {
      selectedTables.push(table);
      inflight++;
      if (wrote) maxInflightAfterWrite = Math.max(maxInflightAfterWrite, inflight);
      await new Promise(r => setTimeout(r, 1));
      inflight--;
      return rowsByTable.get(table)?.shift() ?? [];
    },
  }),
});
mock.module('@buildd/core/db', () => ({
  db: {
    select: () => ({ from: (table: unknown) => query(table) }),
    execute: async () => { wrote = true; return { rows: [{ id: SPEC }] }; },
  },
}));

let reachGate: Deferred<boolean> | null = null;
let reachResult = true;
const events: string[] = [];
mock.module('@/lib/specs/store', () => ({
  fail: (status: number, error: string, extra = {}) => ({ ok: false, status, error, ...extra }),
  importedRefusal: () => null,
  reach: async () => {
    events.push('reach:start');
    const ok = reachGate ? await reachGate.promise : reachResult;
    events.push('reach:end');
    return ok;
  },
}));
let holds = true;
mock.module('@/lib/team-access', () => ({
  holdsInWorkspace: async () => { events.push('holds:start'); return holds; },
}));
const emitted: unknown[] = [];
mock.module('@/lib/core-emit', () => ({
  // The real index is many sequential round trips; a never-settling emit
  // makes any await of it on the response path hang the test.
  emit: (e: unknown) => { emitted.push(e); return new Promise<void>(() => {}); },
}));

let gate: { passed: boolean; refusals: Array<{ code: string; message: string }>; warnings: Array<{ code: string; message: string }> } = { passed: true, refusals: [], warnings: [] };
mock.module('./approval-gate', () => ({ runApprovalGate: async () => ({ gate, review: null }) }));
process.env.AUTH_SECRET ||= 'approval-unit-test-secret';

const { approveSpecRevision, specApprovalDeps } = await import('./approval');

const notices: Array<{ confirmUrl: string; revision: number; title: string }> = [];
const user = { kind: 'user' as const, userId: '33333333-3333-4333-8333-333333333333' };
let scheduled: Array<() => Promise<unknown>>;
beforeEach(() => {
  rowsByTable = new Map<unknown, unknown[][]>([
    [specs, [[specRow], [{ ...specRow, version: 4, approvedRevision: 2, status: 'approved' }]]],
    // The head's hash and the specs it replaces (none), read before the approval; then the stamped revision.
    [specRevisions, [[{ contentHash: 'h', replaces: null }], [{ specId: SPEC, revision: 2, approvedAt: new Date() }]]],
    [workspaces, [[{ gitConfig: null }]]],
    [users, [[{ name: 'Sam' }]]],
  ]);
  gate = { passed: true, refusals: [], warnings: [] };
  notices.length = 0;
  specApprovalDeps.notify = async n => { notices.push(n); };
  inflight = 0; maxInflightAfterWrite = 0; wrote = false;
  selectedTables.length = 0; events.length = 0; emitted.length = 0;
  reachGate = null; reachResult = true; holds = true;
  scheduled = [];
  specApprovalDeps.afterResponse = task => { scheduled.push(task); };
});

describe('approveSpecRevision response path', () => {
  it('answers before the knowledge index runs, and schedules it for after the response', async () => {
    const r = await approveSpecRevision(user, SPEC, { revision: 2, expectedVersion: 3 });
    expect(r).toMatchObject({ ok: true, spec: { version: 4, approvedRevision: 2 }, revision: { revision: 2 } });
    expect(emitted).toEqual([]);
    expect(scheduled.length).toBe(1);
    void scheduled[0]();
    expect(emitted).toEqual([{ type: 'spec.approved', specId: SPEC, workspaceId: WS, revision: 2 }]);
  });

  it('starts the approver check while the access check is still out', async () => {
    reachGate = deferred<boolean>();
    const pending = approveSpecRevision(user, SPEC, { revision: 2, expectedVersion: 3 });
    for (let i = 0; i < 20 && !events.includes('holds:start'); i++) await new Promise(r => setTimeout(r, 1));
    expect(events).toContain('holds:start');
    expect(events).not.toContain('reach:end');
    reachGate.resolve(true);
    expect((await pending).ok).toBe(true);
  });

  it('reads the approved spec and its revision together', async () => {
    await approveSpecRevision(user, SPEC, { revision: 2, expectedVersion: 3 });
    expect(maxInflightAfterWrite).toBe(2);
  });

  it('a workspace the caller cannot reach is a 404 even for someone who would hold approve', async () => {
    reachResult = false;
    holds = true;
    const r = await approveSpecRevision(user, SPEC, { revision: 2, expectedVersion: 3 });
    expect(r).toMatchObject({ ok: false, status: 404 });
    expect(wrote).toBe(false);
    expect(scheduled).toEqual([]);
  });

  it('a person who may not approve is a 403 and nothing is written or scheduled', async () => {
    holds = false;
    reachResult = true;
    // Not a delegated approver: the workspace names no one.
    const r = await approveSpecRevision(user, SPEC, { revision: 2, expectedVersion: 3 });
    expect(r).toMatchObject({ ok: false, status: 403 });
    expect(wrote).toBe(false);
    expect(scheduled).toEqual([]);
  });
});

describe('an approval asked for over MCP or chat', () => {
  const bearer = { kind: 'account' as const, account: { id: 'a1', sessionUserId: user.userId } } as never;
  beforeEach(() => {
    rowsByTable.set(specs, [[{ ...specRow, title: 'Checkout' }]]);
    rowsByTable.set(specRevisions, [[{ contentHash: 'h'.repeat(64) }]]);
  });

  it('never approves: it writes nothing and returns the link, who it went to, and the gate result', async () => {
    const r = await approveSpecRevision(bearer, SPEC, { revision: 2, expectedVersion: 3 });
    expect(r).toMatchObject({ ok: true, pending: { revision: 2, sentTo: 'Sam', gate: { passed: true } } });
    expect(wrote).toBe(false);
    expect(scheduled).toEqual([]);
  });

  it('sends the person exactly one notification, carrying the confirm link', async () => {
    const r = await approveSpecRevision(bearer, SPEC, { revision: 2, expectedVersion: 3 });
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ title: 'Checkout', revision: 2 });
    expect(notices[0]!.confirmUrl).toBe(r.ok && 'pending' in r ? r.pending.confirmUrl : '');
    expect(notices[0]!.confirmUrl).toContain(`/app/specs/${SPEC}/approve?request=`);
  });

  it('a notification that fails does not lose the link', async () => {
    specApprovalDeps.notify = async () => { throw new Error('pushover down'); };
    expect(await approveSpecRevision(bearer, SPEC, { revision: 2, expectedVersion: 3 })).toMatchObject({ ok: true, pending: { revision: 2 } });
  });

  it('a gate refusal creates no request and sends nothing, and says why', async () => {
    gate = { passed: false, refusals: [{ code: 'id_meaning_changed', message: 'R-1 now means something else.' }], warnings: [] };
    const r = await approveSpecRevision(bearer, SPEC, { revision: 2, expectedVersion: 3 });
    expect(r).toMatchObject({ ok: false, status: 409, code: 'gate_refused', gate: { passed: false } });
    expect(!r.ok && r.error).toContain('R-1 now means something else.');
    expect(notices).toEqual([]);
  });

  it('a warning passes the gate and rides along on the request', async () => {
    gate = { passed: true, refusals: [], warnings: [{ code: 'no_change_summary', message: 'No summary.' }] };
    const r = await approveSpecRevision(bearer, SPEC, { revision: 2, expectedVersion: 3 });
    expect(r).toMatchObject({ ok: true, pending: { gate: { warnings: [{ code: 'no_change_summary' }] } } });
    expect(notices).toHaveLength(1);
  });

  it('a stale version is refused before the gate or any notification', async () => {
    const r = await approveSpecRevision(bearer, SPEC, { revision: 2, expectedVersion: 1 });
    expect(r).toMatchObject({ ok: false, status: 409 });
    expect(notices).toEqual([]);
  });

  it('an agent run or API key, with no person behind it, cannot even ask', async () => {
    const agent = { kind: 'account' as const, account: { id: 'a2', taskScope: { taskId: 't1' } } } as never;
    expect(await approveSpecRevision(agent, SPEC, { revision: 2, expectedVersion: 3 })).toMatchObject({ ok: false, status: 403 });
    expect(notices).toEqual([]);
  });
});
