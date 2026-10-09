/**
 * POST / DELETE /api/workers/[id]/park — a cloud --once runner marks its
 * worker parked after uploading the park bundle, or clears the mark when a
 * resume could not restore it.
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const WORKER = '33333333-3333-4333-8333-333333333333';
const ACCOUNT = '44444444-4444-4444-8444-444444444444';

type Row = { id: string; accountId: string; workspaceId: string; claimedByUserId: string | null; taskId: string; status: string; parkedUntil: Date | null; updatedAt: Date; task: { missionId: string | null } | null };
let row: Row | null;
let authed: { id: string; level?: string; teamId?: string | null; sessionUserId?: string; taskScope?: { taskId: string; workspaceId: string; expiresAt: number } } | null;
const sets: Array<Record<string, unknown>> = [];
type Caller = NonNullable<typeof authed>;

const authCalls: unknown[][] = [];
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: async (...args: unknown[]) => { authCalls.push(args); return authed; } }));
mock.module('@buildd/core/db/schema', () => ({ workers: { id: 'workers.id', parkedUntil: 'workers.parked_until' } }));
mock.module('drizzle-orm', () => ({ eq: (f: unknown, v: unknown) => ({ f, v }) }));
mock.module('@/lib/worker-park', () => ({
  parkedUntilFor: (now: Date, mission: boolean) => new Date(now.getTime() + (mission ? 4 : 24) * 3600e3),
  parkWhere: (id: string, caller: Caller) => ({ kind: 'park', id, caller }),
  unparkWhere: (id: string, caller: Caller) => ({ kind: 'unpark', id, caller }),
}));
mock.module('@buildd/core/db', () => ({
  db: {
    query: { workers: { findFirst: async () => row } },
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: (w: { kind: string; id: string; caller: Caller }) => ({
          returning: async () => {
            // ownedByCaller (lib/worker-park.ts) is the SQL form of callerOwnsWorker.
            if (!row || row.id !== w.id || !callerOwnsWorker(w.caller as never, row)) return [];
            if (w.kind === 'park' && row.status !== 'waiting_input' && row.status !== 'running') return [];
            sets.push(values);
            row = { ...row, ...(values as Partial<Row>) };
            return [{ id: row.id, parkedUntil: row.parkedUntil }];
          },
        }),
      }),
    }),
  },
}));

import { DELETE, POST } from './route';
import { callerOwnsWorker } from '@/lib/worker-owner';

const req = (method: string, apiKey: string | null = 'bld_runner') =>
  new NextRequest(`http://localhost/api/workers/${WORKER}/park`, { method, headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {} });
const params = (id = WORKER) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  row = { id: WORKER, accountId: ACCOUNT, workspaceId: 'ws-1', claimedByUserId: null, taskId: 'task-1', status: 'waiting_input', parkedUntil: null, updatedAt: new Date(0), task: { missionId: null } };
  authed = { id: ACCOUNT, level: 'worker' };
  sets.length = 0;
});

describe('POST /api/workers/[id]/park', () => {
  it('sets parkedUntil = now + 24 h for a standalone task, and bumps updatedAt', async () => {
    const before = Date.now();
    const res = await POST(req('POST'), params());
    expect(res.status).toBe(200);
    const body = await res.json() as { parkedUntil: string };
    const until = Date.parse(body.parkedUntil);
    expect(until - before).toBeGreaterThanOrEqual(24 * 3600e3 - 1000);
    expect(until - before).toBeLessThanOrEqual(24 * 3600e3 + 1000);
    expect(row!.updatedAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('4 h for a mission task', async () => {
    row!.task = { missionId: 'mission-1' };
    const before = Date.now();
    const body = await (await POST(req('POST'), params())).json() as { parkedUntil: string };
    expect(Date.parse(body.parkedUntil) - before).toBeLessThanOrEqual(4 * 3600e3 + 1000);
  });

  it('a terminal worker cannot be parked', async () => {
    row!.status = 'completed';
    expect((await POST(req('POST'), params())).status).toBe(409);
    expect(row!.parkedUntil).toBeNull();
  });

  it("another account's worker: 404, nothing written", async () => {
    authed = { id: '55555555-5555-4555-8555-555555555555', level: 'worker' };
    expect((await POST(req('POST'), params())).status).toBe(404);
    expect(sets).toHaveLength(0);
  });

  it('auth: 401 without a key, 403 for a trigger key, 404 for a non-uuid', async () => {
    authed = null;
    expect((await POST(req('POST', null), params())).status).toBe(401);
    authed = { id: ACCOUNT, level: 'trigger' };
    expect((await POST(req('POST'), params())).status).toBe(403);
    authed = { id: ACCOUNT, level: 'worker' };
    expect((await POST(req('POST'), params('nope'))).status).toBe(404);
  });
});

describe('park with a per-task token', () => {
  const scope = (taskId: string) => ({ taskId, workspaceId: 'ws-1', expiresAt: Date.now() + 60_000 });

  it('parks its own worker', async () => {
    authed = { id: ACCOUNT, level: 'worker', taskScope: scope('task-1') };
    expect((await POST(req('POST'), params())).status).toBe(200);
  });

  it("cannot park or unpark the same account's worker on another task", async () => {
    authed = { id: ACCOUNT, level: 'worker', taskScope: scope('task-other') };
    expect((await POST(req('POST'), params())).status).toBe(404);
    expect(sets).toHaveLength(0);
    row!.parkedUntil = new Date(Date.now() + 3600e3);
    expect((await DELETE(req('DELETE'), params())).status).toBe(404);
    expect(row!.parkedUntil).not.toBeNull();
  });
});

describe('DELETE /api/workers/[id]/park', () => {
  it('clears the park (a resume that could not restore the bundle)', async () => {
    row!.parkedUntil = new Date(Date.now() + 3600e3);
    const res = await DELETE(req('DELETE'), params());
    expect(res.status).toBe(200);
    expect(row!.parkedUntil).toBeNull();
  });

  it("cannot clear another account's park", async () => {
    row!.parkedUntil = new Date(Date.now() + 3600e3);
    authed = { id: '55555555-5555-4555-8555-555555555555', level: 'worker' };
    expect((await DELETE(req('DELETE'), params())).status).toBe(404);
    expect(row!.parkedUntil).not.toBeNull();
  });
});

// An OAuth session resolves to an account its whole team shares; only the
// session user that claimed the worker may park or unpark it.
describe('park and unpark: OAuth session owner check', () => {
  const session = (userId: string, extra: Record<string, unknown> = {}) =>
    ({ id: ACCOUNT, teamId: 'team-1', level: 'worker', sessionUserId: userId, ...extra });

  beforeEach(() => { row!.claimedByUserId = 'user-a'; });

  it('the session that claimed parks and unparks it', async () => {
    authed = session('user-a');
    expect((await POST(req('POST'), params())).status).toBe(200);
    expect((await DELETE(req('DELETE'), params())).status).toBe(200);
    expect(row!.parkedUntil).toBeNull();
  });

  it('another member of the same team, on the shared account, is refused and nothing is written', async () => {
    authed = session('user-b');
    expect((await POST(req('POST'), params())).status).toBe(404);
    row!.parkedUntil = new Date(Date.now() + 3600e3);
    expect((await DELETE(req('DELETE'), params())).status).toBe(404);
    expect(row!.parkedUntil).not.toBeNull();
    expect(sets).toHaveLength(0);
  });

  it('an admin session or a bld_ key on the shared account is refused too (no admin path here)', async () => {
    authed = session('user-b', { level: 'admin' });
    expect((await POST(req('POST'), params())).status).toBe(404);
    authed = { id: ACCOUNT, level: 'admin' };
    expect((await POST(req('POST'), params())).status).toBe(404);
    expect(sets).toHaveLength(0);
  });

  it('a session with no team id is refused', async () => {
    authed = session('user-a', { teamId: null });
    expect((await POST(req('POST'), params())).status).toBe(404);
  });
});

describe('scoped runner keys', () => {
  it('passes the request to auth, so a capability-scoped key is checked rather than refused', async () => {
    // Without the request, authenticateApiKey refuses any scoped key: an
    // evicted cloud agent could not mark its orphan run parked and crashed it.
    authCalls.length = 0;
    const r = req('POST');
    await POST(r, params());
    expect(authCalls.at(-1)?.[1]).toBe(r);
  });
});
