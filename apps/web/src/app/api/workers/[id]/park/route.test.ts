/**
 * POST / DELETE /api/workers/[id]/park — a cloud --once runner marks its
 * worker parked after uploading the park bundle, or clears the mark when a
 * resume could not restore it.
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const WORKER = '33333333-3333-4333-8333-333333333333';
const ACCOUNT = '44444444-4444-4444-8444-444444444444';

type Row = { id: string; accountId: string; status: string; parkedUntil: Date | null; updatedAt: Date; task: { missionId: string | null } | null };
let row: Row | null;
let authed: { id: string; level?: string } | null;
const sets: Array<Record<string, unknown>> = [];

mock.module('@/lib/api-auth', () => ({ authenticateApiKey: async () => authed }));
mock.module('@buildd/core/db/schema', () => ({ workers: { id: 'workers.id', parkedUntil: 'workers.parked_until' } }));
mock.module('drizzle-orm', () => ({ eq: (f: unknown, v: unknown) => ({ f, v }) }));
mock.module('@/lib/worker-park', () => ({
  parkedUntilFor: (now: Date, mission: boolean) => new Date(now.getTime() + (mission ? 4 : 24) * 3600e3),
  parkWhere: (id: string, accountId: string) => ({ kind: 'park', id, accountId }),
  unparkWhere: (id: string, accountId: string) => ({ kind: 'unpark', id, accountId }),
}));
mock.module('@buildd/core/db', () => ({
  db: {
    query: { workers: { findFirst: async () => row } },
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: (w: { kind: string; id: string; accountId: string }) => ({
          returning: async () => {
            if (!row || row.id !== w.id || row.accountId !== w.accountId) return [];
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

const req = (method: string, apiKey: string | null = 'bld_runner') =>
  new NextRequest(`http://localhost/api/workers/${WORKER}/park`, { method, headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {} });
const params = (id = WORKER) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  row = { id: WORKER, accountId: ACCOUNT, status: 'waiting_input', parkedUntil: null, updatedAt: new Date(0), task: { missionId: null } };
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
