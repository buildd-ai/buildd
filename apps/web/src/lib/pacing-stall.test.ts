/**
 * Unit tests for apps/web/src/lib/pacing-stall.ts
 *
 * The queue-stall route tests stub `createPacingProbe` wholesale, so this file
 * is where the probe's own contract lives: which inputs make it claim a task is
 * paced, and — more importantly — which make it decline to.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/web/src/lib/pacing-stall.test.ts
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test';

let teamAccounts: any[] = [];

mock.module('@buildd/core/db', () => ({
  db: { query: { accounts: { findMany: mock(() => Promise.resolve(teamAccounts)) } } },
}));
mock.module('@buildd/core/db/schema', () => ({
  accounts: { teamId: 'teamId', createdAt: 'createdAt' },
}));
mock.module('drizzle-orm', () => ({ eq: (a: unknown, b: unknown) => ({ a, b }) }));

// OAuth pacing is inert in these cases unless a test opts in; the API-key half
// needs no episodes at all, which is precisely what makes it worth testing.
const mockLoadOauthEpisodes = mock(() => Promise.resolve([] as any[]));
const mockMeasureOauthWindow = mock(() => Promise.resolve({ windowStartedAt: null, usage: {} } as any));
mock.module('@/lib/oauth-budget-window', () => ({
  resolveSeatIdPeers: mock(() => Promise.resolve(['a1'])),
  loadOauthEpisodes: mockLoadOauthEpisodes,
  measureOauthWindow: mockMeasureOauthWindow,
}));

const { createPacingProbe } = await import('./pacing-stall');

const apiAccount = (over: Record<string, unknown> = {}) => ({
  id: 'a1', teamId: 'team-1', seatId: null, authType: 'api',
  totalCost: 96, maxCostPerDay: 100, ...over,
});

beforeEach(() => {
  teamAccounts = [];
  process.env.OAUTH_BUDGET_PACING = 'off';
});

describe('createPacingProbe', () => {
  // Learned OAuth pressure only narrows seat parallelism now; it never pauses a
  // task. Reporting such a stall as paced would send the operator to spend when
  // the claim route is not holding the task for it.
  it('declines on learned OAuth pressure, which never pauses a task', async () => {
    process.env.OAUTH_BUDGET_PACING = 'on';
    teamAccounts = [{ id: 'a1', teamId: 'team-1', seatId: null, authType: 'oauth', totalCost: 0, maxCostPerDay: null }];
    mockLoadOauthEpisodes.mockResolvedValueOnce(Array.from({ length: 5 }, (_, i) => ({
      exhaustedAt: new Date(Date.now() - (24 + i) * 3_600_000), resetsAt: null,
      workerCount: 10, turns: 600, inputTokens: 0, outputTokens: 0, weightedTurns: 600, weightedTokens: 0,
    })));
    mockMeasureOauthWindow.mockResolvedValueOnce({
      windowStartedAt: new Date(),
      usage: { workerCount: 10, turns: 600, tokens: 0, weightedTurns: 600, weightedTokens: 0 },
    });

    const r = await createPacingProbe().check({
      teamId: 'team-1', priority: 0, kind: null, explicitModel: null,
    });

    expect(r).toBeNull();
  });

  it('reports pacing for a priority-0 task on a team past its API-key cap', async () => {
    teamAccounts = [apiAccount()];

    const r = await createPacingProbe().check({
      teamId: 'team-1', priority: 0, kind: null, explicitModel: null,
    });

    expect(r).not.toBeNull();
    expect(r!.pct).toBeCloseTo(0.96, 2);
  });

  it('declines for a task carrying an explicit model, whatever the pressure', async () => {
    // The router returns explicit_override before the pause gate, so such a
    // task is never actually paced — reporting it as paced would misattribute
    // the most common re-queued-task stall to spend.
    teamAccounts = [apiAccount({ totalCost: 100 })];

    const r = await createPacingProbe().check({
      teamId: 'team-1', priority: 0, kind: null, explicitModel: 'claude-opus-4-6',
    });

    expect(r).toBeNull();
  });

  it('declines above priority 0, which the router downshifts rather than pauses', async () => {
    teamAccounts = [apiAccount({ totalCost: 100 })];

    const r = await createPacingProbe().check({
      teamId: 'team-1', priority: 8, kind: null, explicitModel: null,
    });

    expect(r).toBeNull();
  });

  it('declines for coordination work, which the router exempts from the pause', async () => {
    teamAccounts = [apiAccount({ totalCost: 100 })];

    const r = await createPacingProbe().check({
      teamId: 'team-1', priority: 0, kind: 'coordination', explicitModel: null,
    });

    expect(r).toBeNull();
  });

  it('declines when pressure is below the pause threshold', async () => {
    teamAccounts = [apiAccount({ totalCost: 10 })];

    const r = await createPacingProbe().check({
      teamId: 'team-1', priority: 0, kind: null, explicitModel: null,
    });

    expect(r).toBeNull();
  });

  it('declines without a team, since a provider window is team-scoped at minimum', async () => {
    teamAccounts = [apiAccount({ totalCost: 100 })];

    const r = await createPacingProbe().check({
      teamId: null, priority: 0, kind: null, explicitModel: null,
    });

    expect(r).toBeNull();
  });

  it('declines when the team has no accounts to measure', async () => {
    teamAccounts = [];

    const r = await createPacingProbe().check({
      teamId: 'team-1', priority: 0, kind: null, explicitModel: null,
    });

    expect(r).toBeNull();
  });

  it('ignores an unrecognised kind rather than throwing on it', async () => {
    // tasks.kind is plain text — its $type<> is compile-time only — and the
    // router indexes BASELINE[kind] directly, so an unknown value would throw
    // out of the probe and break the whole sweep.
    teamAccounts = [apiAccount({ totalCost: 100 })];

    const r = await createPacingProbe().check({
      teamId: 'team-1', priority: 0, kind: 'not-a-real-kind', explicitModel: null,
    });

    expect(r).not.toBeNull();
  });

  it('measures a team only once across repeated checks', async () => {
    teamAccounts = [apiAccount()];
    const probe = createPacingProbe();
    const { db } = await import('@buildd/core/db');
    // Delta, not an absolute: the mock is shared across this file's tests.
    const before = (db.query.accounts.findMany as any).mock.calls.length;

    await probe.check({ teamId: 'team-1', priority: 0, kind: null, explicitModel: null });
    await probe.check({ teamId: 'team-1', priority: 0, kind: null, explicitModel: null });

    expect((db.query.accounts.findMany as any).mock.calls.length - before).toBe(1);
  });
});
