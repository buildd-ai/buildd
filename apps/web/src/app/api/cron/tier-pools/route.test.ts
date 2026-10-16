// Asserts on the cron_runs row against a mocked db, so opt in to recording
// (withCronRun records nothing under NODE_ENV=test by default).
process.env.BUILDD_CRON_RUN_RECORD_IN_TESTS = '1';

import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// The step itself is covered in packages/core/__tests__/tier-pool-daily*.test.ts;
// here the wiring: auth, the cron_runs verdict, and the summary returned.
let summary: any = { pools: 2, stepped: 2, written: 1, suggestions: 0, added: 0, stale: 0, errors: 0, rankings: {}, changes: [] };
const run = mock(async (_a: { now: Date }) => summary);
mock.module('@buildd/core/tier-pool-daily-source', () => ({ TIER_POOLS_JOB: 'tier-pools', runTierPoolsDaily: run }));
let dialSummary: any = { pools: 0, evaluated: 0, transitions: [], stale: 0, errors: 0 };
const runDial = mock(async (_a: { now: Date }) => dialSummary);
mock.module('@buildd/core/tier-dial-source', () => ({ runDialStep: runDial }));
let claimSummary: any = { evaluatedAt: '2026-01-01', cells: [] };
let claimFails = false;
const runClaimLearning = mock(async (_a: { now: Date }) => { if (claimFails) throw new Error('unavailable'); return claimSummary; });
mock.module('@buildd/core/orchestration-claim-learning-source', () => ({ runClaimLearningStep: runClaimLearning }));
const RETRO_SOURCE = { status: async () => ({ enabled: true, judgeModel: 'typesafe/jev-1.13' }), verdicts: async () => [] };
mock.module('@/lib/chat-retro/policy-signal', () => ({ chatRetroQualitySource: RETRO_SOURCE }));

const recorded: any[] = [];
mock.module('@buildd/core/db', () => ({
  db: {
    insert: () => ({ values: (v: any) => { recorded.push(v); return { returning: async () => [{ id: 'cron-run-1' }] }; } }),
    update: () => ({ set: (v: any) => { recorded.push(v); return { where: async () => {} }; } }),
    delete: () => ({ where: () => Promise.resolve() }),
    query: { cronRuns: { findMany: async () => [] } },
  },
}));
mock.module('@/lib/pushover', () => ({ notifyOperator: mock(() => undefined) }));

const { GET } = await import('./route');

const SECRET = 'test-cron-secret';
const req = (token: string | null = SECRET) => new NextRequest('http://localhost:3000/api/cron/tier-pools', {
  headers: token ? { authorization: `Bearer ${token}` } : {},
});

describe('GET /api/cron/tier-pools', () => {
  beforeEach(() => { process.env.CRON_SECRET = SECRET; run.mockClear(); recorded.length = 0; runClaimLearning.mockClear(); claimFails = false; claimSummary = { evaluatedAt: '2026-01-01', cells: [] }; });

  it('refuses without the cron secret and runs nothing', async () => {
    expect((await GET(req('wrong'))).status).toBe(401);
    expect(run).not.toHaveBeenCalled();
    expect(runClaimLearning).not.toHaveBeenCalled();
  });

  it('runs the daily step and reports changed = pools whose allocation changed', async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ pools: 2, written: 1 });
    expect(run).toHaveBeenCalledTimes(1);
    const verdict = recorded.find(r => r.changed !== undefined);
    expect(verdict).toMatchObject({ processed: 2, changed: 1, errors: 0 });
  });

  it('evaluates the dial cells every run and counts their transitions as changes', async () => {
    dialSummary = { pools: 1, evaluated: 1, transitions: [{ poolId: 'p', kind: 'revert', to: 'reverted' }], stale: 0, errors: 0 };
    const res = await GET(req());
    expect(runDial).toHaveBeenCalled();
    expect((await res.json()).dial).toMatchObject({ pools: 1, transitions: [{ kind: 'revert' }] });
    const verdict = recorded.filter(r => r.changed !== undefined).at(-1);
    expect(verdict).toMatchObject({ processed: 3, changed: 2 });
  });

  it('gives chat dial cells the chat retro as their quality source', async () => {
    runDial.mockClear();
    await GET(req());
    expect((runDial.mock.calls[0][0] as { chatQuality?: unknown }).chatQuality).toBe(RETRO_SOURCE);
  });

  it('evaluates claim cells and includes changes in the existing cron report', async () => {
    dialSummary = { pools: 0, evaluated: 0, transitions: [], stale: 0, errors: 0 };
    claimSummary = { cells: [{ applied: true, changed: true }, { applied: true, changed: false }, { applied: false, changed: false }] };
    const response = await GET(req());
    expect(runClaimLearning).toHaveBeenCalledTimes(1);
    expect((await response.json()).claimLearning.cells).toHaveLength(3);
    expect(recorded.filter(r => r.changed !== undefined).at(-1)).toMatchObject({ processed: 5, changed: 2, errors: 1 });
    expect(runClaimLearning.mock.calls[0][0].now).toBe(run.mock.calls[0][0].now);
  });
  it('reports a claim learning read failure while retaining other pool results', async () => {
    dialSummary = { pools: 0, evaluated: 0, transitions: [], stale: 0, errors: 0 };
    claimFails = true;
    const response = await GET(req());
    expect(response.status).toBe(200);
    expect((await response.json()).claimLearning).toBeNull();
    expect(recorded.filter(r => r.changed !== undefined).at(-1)).toMatchObject({ processed: 2, changed: 1, errors: 1 });
  });

});
