/**
 * POST /api/workers/[id]/reattach — a new cloud container takes over a parked
 * worker. One conditional UPDATE; never an INSERT.
 *
 * The db fake applies the same compare-and-set the route's WHERE expresses
 * (reattachWhere, whose rendered SQL is pinned in lib/worker-park.test.ts), so
 * a race between two re-attaches is observable here: the first clears the
 * park and the second finds nothing to update.
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const WORKER = '33333333-3333-4333-8333-333333333333';
const ACCOUNT = '44444444-4444-4444-8444-444444444444';
const OTHER_ACCOUNT = '55555555-5555-4555-8555-555555555555';

type Row = { id: string; accountId: string; workspaceId: string; claimedByUserId: string | null; taskId: string; status: string; parkedUntil: Date | null; updatedAt: Date };
let row: Row;
const inserts: unknown[] = [];
const updateWheres: unknown[] = [];
let authed: { id: string; level?: string; teamId?: string | null; sessionUserId?: string; taskScope?: { taskId: string; workspaceId: string; expiresAt: number } } | null;
type Caller = NonNullable<typeof authed>;
/** Yield between read and write inside the fake UPDATE, so concurrent calls interleave. */
let yieldInsideUpdate = false;

const mockAuth = mock(async () => authed);
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuth }));

mock.module('@/lib/worker-park', () => ({
  // Recorded, and evaluated by the fake below with the same semantics.
  reattachWhere: (id: string, caller: Caller, now: Date) => ({ id, caller, now, kind: 'reattach' }),
}));

mock.module('@buildd/core/db/schema', () => ({ workers: { id: 'workers.id', taskId: 'workers.task_id', status: 'workers.status' } }));

mock.module('@buildd/core/db', () => ({
  db: {
    insert: () => { inserts.push(1); throw new Error('reattach must never insert'); },
    update: () => ({
      set: (values: Partial<Row>) => ({
        where: (w: { id: string; caller: Caller; now: Date }) => ({
          returning: async () => {
            updateWheres.push(w);
            // ownedByCaller (lib/worker-park.ts) is the SQL form of callerOwnsWorker.
            const matches = row.id === w.id && callerOwnsWorker(w.caller as never, row)
              && (row.status === 'waiting_input' || row.status === 'running')
              && row.parkedUntil !== null && row.parkedUntil.getTime() > w.now.getTime();
            if (yieldInsideUpdate) await new Promise(r => setTimeout(r, 5));
            // Compare-and-set: re-check after the yield, as the database would under its row lock.
            const stillMatches = matches && row.parkedUntil !== null && row.parkedUntil.getTime() > w.now.getTime();
            if (!stillMatches) return [];
            row = { ...row, ...values };
            return [{ id: row.id, taskId: row.taskId, status: row.status }];
          },
        }),
      }),
    }),
  },
}));

import { POST } from './route';
import { callerOwnsWorker } from '@/lib/worker-owner';

function req(apiKey: string | null = 'bld_runner') {
  return new NextRequest(`http://localhost/api/workers/${WORKER}/reattach`, {
    method: 'POST',
    headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
  });
}
const params = (id = WORKER) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  row = { id: WORKER, accountId: ACCOUNT, workspaceId: 'ws-1', claimedByUserId: null, taskId: 'task-1', status: 'waiting_input', parkedUntil: new Date(Date.now() + 60 * 60 * 1000), updatedAt: new Date(0) };
  inserts.length = 0;
  updateWheres.length = 0;
  authed = { id: ACCOUNT, level: 'worker' };
  yieldInsideUpdate = false;
});

describe('POST /api/workers/[id]/reattach', () => {
  it('clears the park on the SAME worker and returns it', async () => {
    const res = await POST(req(), params());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ worker: { id: WORKER, taskId: 'task-1', status: 'waiting_input' } });
    expect(row.parkedUntil).toBeNull();
    expect(row.updatedAt.getTime()).toBeGreaterThan(0);
    expect(inserts).toHaveLength(0);
  });

  it('two concurrent re-attaches: exactly one wins, the other is refused with 409', async () => {
    yieldInsideUpdate = true;
    const [a, b] = await Promise.all([POST(req(), params()), POST(req(), params())]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(inserts).toHaveLength(0);
  });

  it('a second re-attach after a successful one is refused', async () => {
    expect((await POST(req(), params())).status).toBe(200);
    const again = await POST(req(), params());
    expect(again.status).toBe(409);
    expect((await again.json()).error).toBe('not_parked');
  });

  it('an expired park is refused (the waiting_input sweep owns it now)', async () => {
    row.parkedUntil = new Date(Date.now() - 1);
    expect((await POST(req(), params())).status).toBe(409);
  });

  it('a worker that was never parked is refused', async () => {
    row.parkedUntil = null;
    expect((await POST(req(), params())).status).toBe(409);
  });

  it('a terminal worker is refused even with a park left on it', async () => {
    row.status = 'failed';
    expect((await POST(req(), params())).status).toBe(409);
  });

  it("another account's key cannot take the worker", async () => {
    authed = { id: OTHER_ACCOUNT, level: 'worker' };
    expect((await POST(req(), params())).status).toBe(409);
    expect(row.parkedUntil).not.toBeNull();
    expect((updateWheres[0] as { caller: Caller }).caller.id).toBe(OTHER_ACCOUNT);
  });

  it('a per-task token re-attaches its own worker only', async () => {
    authed = { id: ACCOUNT, level: 'worker', taskScope: { taskId: 'task-other', workspaceId: 'ws-1', expiresAt: Date.now() + 60_000 } };
    expect((await POST(req(), params())).status).toBe(409);
    expect(row.parkedUntil).not.toBeNull();
    authed = { id: ACCOUNT, level: 'worker', taskScope: { taskId: 'task-1', workspaceId: 'ws-1', expiresAt: Date.now() + 60_000 } };
    expect((await POST(req(), params())).status).toBe(200);
  });

  it('auth: no key 401, trigger-level key 403, non-uuid 404', async () => {
    authed = null;
    expect((await POST(req(null), params())).status).toBe(401);
    authed = { id: ACCOUNT, level: 'trigger' };
    expect((await POST(req(), params())).status).toBe(403);
    authed = { id: ACCOUNT, level: 'worker' };
    expect((await POST(req(), params('not-a-uuid'))).status).toBe(404);
    expect(updateWheres).toHaveLength(0);
  });
});

// An OAuth session resolves to an account its whole team shares; only the
// session user that claimed the worker may take it over.
describe('reattach: OAuth session owner check', () => {
  const session = (userId: string, extra: Record<string, unknown> = {}) =>
    ({ id: ACCOUNT, teamId: 'team-1', level: 'worker', sessionUserId: userId, ...extra });

  beforeEach(() => { row.claimedByUserId = 'user-a'; });

  it('the session that claimed re-attaches', async () => {
    authed = session('user-a');
    expect((await POST(req(), params())).status).toBe(200);
    expect(row.parkedUntil).toBeNull();
  });

  it('another member of the same team, on the shared account, is refused', async () => {
    authed = session('user-b');
    expect((await POST(req(), params())).status).toBe(409);
    expect(row.parkedUntil).not.toBeNull();
  });

  it('an admin session or a bld_ key on the shared account is refused too (no admin path here)', async () => {
    authed = session('user-b', { level: 'admin' });
    expect((await POST(req(), params())).status).toBe(409);
    authed = { id: ACCOUNT, level: 'admin' };
    expect((await POST(req(), params())).status).toBe(409);
    expect(row.parkedUntil).not.toBeNull();
  });
});

describe('scoped runner keys', () => {
  it('passes the request to auth, so a capability-scoped key is checked rather than refused', async () => {
    mockAuth.mockClear();
    const r = req();
    await POST(r, { params: Promise.resolve({ id: WORKER }) } as never);
    expect(mockAuth.mock.calls.at(-1)?.[1]).toBe(r);
  });
});
