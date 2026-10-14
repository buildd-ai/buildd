import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// The real sweep (lib/decision-model-optimizer/optimizer.ts) over a fake store:
// the route must hand it the due teams, as a scheduled run, and report counts.
const compared: Array<{ teamId: string; trigger?: string; callCap?: number }> = [];
let due: string[] = [];
let opted = new Set<string>();
const deps = {
  optedIn: async (id: string) => opted.has(id),
  readDecisionModel: async () => null,
  compare: async (input: { teamId: string; trigger?: string; callCap?: number }) => {
    compared.push({ teamId: input.teamId, trigger: input.trigger, callCap: input.callCap });
    return { status: 'skipped', reason: 'no cases' };
  },
  preflight: async () => ({ ok: true }),
  fingerprintFor: async () => null,
  measurements: async () => [],
  writeMeasurement: async () => {},
  setKindModel: async () => ({ ok: true }),
  switches: {
    pinnedKinds: async () => new Set<string>(),
    insert: async () => 'x',
    supersede: async () => {},
    listActive: async () => [],
    get: async () => null,
    end: async () => true,
  },
  liveGrades: async () => ({ graded: 0, correct: 0 }),
  recordLedger: async () => {},
};
mock.module('@/lib/decision-model-optimizer/store', () => ({
  dueOptimizerTeams: async () => due,
  optimizerDeps: () => deps,
}));

const { GET } = await import('./route');
const req = (auth?: string) => new NextRequest('http://localhost/api/cron/decision-model-optimizer', { headers: auth ? { authorization: auth } : {} });

const saved = { ...process.env };
beforeEach(() => { compared.length = 0; due = []; opted = new Set(); });
afterEach(() => { process.env = { ...saved }; });

describe('GET /api/cron/decision-model-optimizer', () => {
  it('requires CRON_SECRET and replays nothing without it', async () => {
    process.env.CRON_SECRET = 's';
    due = ['t1'];
    opted = new Set(['t1']);
    expect((await GET(req())).status).toBe(401);
    expect(compared).toEqual([]);
  });

  it('runs each due team as a scheduled comparison with the default call cap', async () => {
    process.env.CRON_SECRET = 's';
    due = ['t1', 't2'];
    opted = new Set(['t1', 't2']);
    const res = await GET(req('Bearer s'));
    expect(res.status).toBe(200);
    expect(compared.map(c => c.teamId)).toEqual(['t1', 't2']);
    expect(compared.every(c => c.trigger === 'cron' && c.callCap === 1500)).toBe(true);
    const body = await res.json();
    expect(body.teams.map((t: { status: string }) => t.status)).toEqual(['skipped', 'skipped']);
  });

  it('a due team that has since opted out is never replayed', async () => {
    process.env.CRON_SECRET = 's';
    due = ['t1'];
    const res = await GET(req('Bearer s'));
    expect(res.status).toBe(200);
    expect(compared).toEqual([]);
    expect((await res.json()).teams).toEqual([{ teamId: 't1', status: 'not_opted_in' }]);
  });
});
