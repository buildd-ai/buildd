import { afterEach, describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const calls: string[] = [];
mock.module('@/lib/sibling-conflict-probe-store', () => ({
  createSiblingProbeStore: () => ({
    loadLiveWorkers: async () => {
      calls.push('loadLiveWorkers');
      const w = (id: string) => ({
        workerId: id, taskId: `t-${id}`, workspaceId: 'ws', missionId: null, branch: `buildd/${id}`, title: null,
        startedAt: null, prNumber: null, observedTouches: ['src/x.ts'], mergiraf: false, sensitive: false,
      });
      return [w('a'), w('b')];
    },
    loadProbes: async () => { calls.push('loadProbes'); return new Map(); },
    upsertRequest: async (pair: any) => { calls.push(`upsert:${pair.pairKey}`); },
  }),
}));

let due: number | null = 0;
const cleared: string[] = [];
mock.module('@/lib/redis', () => ({
  countDue: async () => due,
  clearDueThrough: async (job: string) => { cleared.push(job); },
}));

const { GET } = await import('./route');
const req = (auth?: string, query = '') => new NextRequest(`http://localhost/api/cron/sibling-probe${query}`, { headers: auth ? { authorization: auth } : {} });

const saved = { ...process.env };
afterEach(() => { process.env = { ...saved }; calls.length = 0; cleared.length = 0; due = 0; });

describe('GET /api/cron/sibling-probe', () => {
  it('requires CRON_SECRET', async () => {
    process.env.CRON_SECRET = 's';
    expect((await GET(req())).status).toBe(401);
    expect(calls).toEqual([]);
  });

  it('SIBLING_PROBE_ENABLED=0 is a hard off', async () => {
    process.env.CRON_SECRET = 's';
    process.env.SIBLING_PROBE_ENABLED = '0';
    const res = await GET(req('Bearer s'));
    expect((await res.json()).disabled).toBe(true);
    expect(calls).toEqual([]);
  });

  it('a gated tick with nothing due never reads Postgres', async () => {
    process.env.CRON_SECRET = 's';
    delete process.env.SIBLING_PROBE_ENABLED;
    const res = await GET(req('Bearer s', '?gate=due'));
    expect(await res.json()).toMatchObject({ gated: true, reason: 'nothing_due' });
    expect(calls).toEqual([]);
  });

  it('a gated tick with a workspace due runs and clears the queue', async () => {
    process.env.CRON_SECRET = 's';
    delete process.env.SIBLING_PROBE_ENABLED;
    due = 1;
    const res = await GET(req('Bearer s', '?gate=due'));
    expect(await res.json()).toMatchObject({ requested: 1 });
    expect(cleared).toEqual(['sibling-probe']);
  });

  it('the floor tick asks the prober of each live pair sharing a file', async () => {
    process.env.CRON_SECRET = 's';
    delete process.env.SIBLING_PROBE_ENABLED;
    const res = await GET(req('Bearer s'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, pairs: 1, requested: 1 });
    expect(calls).toEqual(['loadLiveWorkers', 'loadProbes', 'upsert:a:b']);
  });
});
