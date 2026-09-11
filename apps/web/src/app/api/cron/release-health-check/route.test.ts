import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// This file covers the stale-'deploying' sweep added alongside the existing
// healthy→degraded watch window. Regression context: six live releases got
// stuck in 'deploying' forever because verifyReleaseDeployment only ever runs
// once (fire-and-forget, on webhook receipt) and no-ops silently when
// releaseConfig.verificationUrl is unset — nothing else ever revisited the
// row. The probe-and-degrade path is unit-tested in release-health-watcher.test.ts;
// this file is about the sweep's own querying/branching and auth.

const mockTriggerEvent = mock(() => Promise.resolve());
mock.module('@/lib/pusher', () => ({
  triggerEvent: mockTriggerEvent,
  channels: { workspace: (id: string) => `workspace-${id}` },
  events: { RELEASE_UPDATED: 'release:updated' },
}));

const mockProbeAndDegrade = mock((_release: any, _url: string, _db: any, _repoIdentity?: any) => Promise.resolve('ok'));
const mockHealSupersededRelease = mock((_release: any, _url: string, _db: any, _repoIdentity: any) =>
  Promise.resolve('unresolved'),
);
mock.module('@/lib/release-health-watcher', () => ({
  probeAndDegrade: mockProbeAndDegrade,
  healSupersededRelease: mockHealSupersededRelease,
}));

const mockVerifyReleaseDeployment = mock((_releaseId: string, _db: any) => Promise.resolve());
mock.module('@/lib/release-verification', () => ({
  verifyReleaseDeployment: mockVerifyReleaseDeployment,
}));

mock.module('@buildd/core/db/schema', () => ({
  // withCronRun imports this; mock.module replaces the whole module, so a
  // partial stub deletes the export for every other importer in the process.
  // `workers` is needed transitively: route.ts -> workspace-installation.ts ->
  // repo-scope.ts imports `workers` from this same module at the top level.
  cronRuns: { id: 'id', job: 'job', startedAt: 'startedAt', alertedAt: 'alertedAt' },
  releases: {
    id: 'id',
    state: 'state',
    verificationStrategy: 'verificationStrategy',
    deployUrl: 'deployUrl',
    headSha: 'headSha',
    healthyAt: 'healthyAt',
    deployedAt: 'deployedAt',
    dispatchedAt: 'dispatchedAt',
    workspaceId: 'workspaceId',
    failureReason: 'failureReason',
  },
  workspaces: {
    id: 'id',
    repo: 'repo',
    releaseConfig: 'releaseConfig',
    githubInstallationId: 'githubInstallationId',
    githubRepoId: 'githubRepoId',
  },
  workers: { id: 'id' },
}));

mock.module('drizzle-orm', () => ({
  // Operators withCronRun imports. mock.module is process-global, so a
  // partial stub removes them for every other importer too.
  desc: (a: any) => ({ a, op: 'desc' }),
  gt: (a: any, b: any) => ({ a, b, op: 'gt' }),
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  and: (...c: any[]) => ({ c, type: 'and' }),
  gte: (field: any, value: any) => ({ field, value, type: 'gte' }),
  lt: (field: any, value: any) => ({ field, value, type: 'lt' }),
  sql: (strings: TemplateStringsArray, ...values: any[]) => ({ strings, values, type: 'sql' }),
}));

// Four select() calls happen per request, in order: (1) healthy-window
// candidates, (2) stale-deploying candidates, (3) stale-dispatched candidates,
// (4) degraded-but-healable candidates. Queue results for each.
let selectResults: any[][];
let updateReturning: any[][];
let updateCalls: Array<{ values: any; where?: any }>;
let selectCallCount = 0;
/**
 * Predicates handed to each select, in order.
 *
 * The mock returns queued rows regardless of the WHERE clause, so a sweep that
 * queried the wrong state would still "pass" every row-count assertion. The
 * predicate is the only observable proof that the sweep looks at what it claims
 * to look at.
 */
let selectConditions: any[];
// Result of resolveRepoIdentity's db.query.workspaces.findFirst lookup —
// defaults to no linked repo/installation (both null identity fields).
let queryWorkspaceResult: any = null;

function makeMockDb(): any {
  return {
    query: {
      workspaces: {
        findFirst: (_opts: any) => Promise.resolve(queryWorkspaceResult),
      },
    },
    select: (_cols?: any) => ({
      from: (_table: any) => ({
        innerJoin: (_join: any, _cond: any) => ({
          where: (cond2: any) => {
            selectConditions.push(cond2);
            return Promise.resolve(selectResults[selectCallCount++] ?? []);
          },
        }),
        where: (cond: any) => {
          selectConditions.push(cond);
          return Promise.resolve(selectResults[selectCallCount++] ?? []);
        },
      }),
    }),
    update: (_table: any) => ({
      set: (values: any) => {
        const call: { values: any; where?: any } = { values };
        updateCalls.push(call);
        return {
          where: (cond: any) => {
            call.where = cond;
            return {
              returning: (_cols: any) => Promise.resolve(updateReturning.shift() ?? []),
            };
          },
        };
      },
    }),
  };
}

mock.module('@buildd/core/db', () => ({ db: makeMockDb() }));

const { GET } = await import('./route');

const CRON_SECRET = 'test-cron-secret';

function makeRequest(token: string | null = CRON_SECRET): NextRequest {
  return new NextRequest('http://localhost/api/cron/release-health-check', {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

const hoursAgo = (n: number) => new Date(Date.now() - n * 3_600_000);

beforeEach(() => {
  process.env.CRON_SECRET = CRON_SECRET;
  selectResults = [[], [], [], []];
  updateReturning = [];
  updateCalls = [];
  selectConditions = [];
  selectCallCount = 0;
  queryWorkspaceResult = null;
  mockTriggerEvent.mockClear();
  mockProbeAndDegrade.mockClear();
  mockProbeAndDegrade.mockResolvedValue('ok' as any);
  mockHealSupersededRelease.mockClear();
  mockHealSupersededRelease.mockResolvedValue('unresolved' as any);
  mockVerifyReleaseDeployment.mockClear();
  mockVerifyReleaseDeployment.mockResolvedValue(undefined as any);
});

describe('release-health-check cron — auth', () => {
  it('rejects a request without the cron secret', async () => {
    const res = await GET(makeRequest(null));
    expect(res.status).toBe(401);
  });

  it('fails closed when CRON_SECRET is not configured', async () => {
    delete process.env.CRON_SECRET;
    const res = await GET(makeRequest());
    expect(res.status).toBe(500);
  });
});

describe('release-health-check cron — stale deploying sweep', () => {
  it('does nothing when there are no stale deploying releases', async () => {
    selectResults = [[], []];
    const res = await GET(makeRequest());
    const data = await res.json();
    expect(data.staleDeploying).toBe(0);
    expect(mockVerifyReleaseDeployment).not.toHaveBeenCalled();
    expect(updateCalls).toHaveLength(0);
  });

  it('retries verification for a release stuck past the retry threshold but under the hard-fail ceiling', async () => {
    selectResults = [
      [],
      [{ id: 'rel-stale-1', deployedAt: hoursAgo(1), workspaceId: 'ws-1' }],
    ];
    const res = await GET(makeRequest());
    const data = await res.json();

    expect(mockVerifyReleaseDeployment).toHaveBeenCalledTimes(1);
    expect(mockVerifyReleaseDeployment).toHaveBeenCalledWith('rel-stale-1', expect.anything());
    expect(data.staleRetried).toBe(1);
    expect(data.staleHardFailed).toBe(0);
    expect(updateCalls).toHaveLength(0);
  });

  it('hard-fails a release stuck past the hard-fail ceiling instead of retrying', async () => {
    selectResults = [
      [],
      [{ id: 'rel-stale-2', deployedAt: hoursAgo(48), workspaceId: 'ws-2' }],
    ];
    updateReturning = [[{ id: 'rel-stale-2' }]];

    const res = await GET(makeRequest());
    const data = await res.json();

    expect(mockVerifyReleaseDeployment).not.toHaveBeenCalled();
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].values.state).toBe('failed');
    expect(updateCalls[0].values.failureReason).toContain("stuck in 'deploying'");
    expect(data.staleHardFailed).toBe(1);
    expect(data.staleRetried).toBe(0);

    const pusherCall = mockTriggerEvent.mock.calls.find(
      ([, event, payload]: any[]) => event === 'release:updated' && payload?.state === 'failed',
    );
    expect(pusherCall).toBeDefined();
    expect(pusherCall![0]).toBe('workspace-ws-2');
    expect(pusherCall![2].releaseId).toBe('rel-stale-2');
  });

  it('does not emit an event when the hard-fail update loses the optimistic lock race', async () => {
    selectResults = [
      [],
      [{ id: 'rel-stale-3', deployedAt: hoursAgo(48), workspaceId: 'ws-3' }],
    ];
    updateReturning = [[]]; // no row returned — another process already advanced it

    const res = await GET(makeRequest());
    const data = await res.json();

    expect(data.staleHardFailed).toBe(0);
    expect(mockTriggerEvent).not.toHaveBeenCalled();
  });

  it('handles multiple stale releases independently', async () => {
    selectResults = [
      [],
      [
        { id: 'rel-retry', deployedAt: hoursAgo(1), workspaceId: 'ws-1' },
        { id: 'rel-fail', deployedAt: hoursAgo(30), workspaceId: 'ws-2' },
      ],
    ];
    updateReturning = [[{ id: 'rel-fail' }]];

    const res = await GET(makeRequest());
    const data = await res.json();

    expect(data.staleDeploying).toBe(2);
    expect(data.staleRetried).toBe(1);
    expect(data.staleHardFailed).toBe(1);
    expect(mockVerifyReleaseDeployment).toHaveBeenCalledWith('rel-retry', expect.anything());
  });
});


describe('release-health-check cron — stale dispatched sweep', () => {
  // A `dispatched` row is waiting for a workflow_run webhook that may never
  // match it: the readback resolves no run url within its ~15s poll, or
  // resolves a stale one, or the delivery is lost. Before this sweep nothing
  // ever revisited such a row — one production row sat in `dispatched` through
  // 25 consecutive green runs of this job, while also blocking every future
  // non-forced release of that commit via the trigger route's dedup check.
  const stale = { id: 'rel-stuck', workspaceId: 'ws-1', dispatchedAt: hoursAgo(30) };

  it('hard-fails a dispatched release that never advanced, and says why', async () => {
    selectResults = [[], [], [stale]];
    updateReturning = [[{ id: 'rel-stuck' }]];

    const res = await GET(makeRequest());
    const data = await res.json();

    expect(data.staleDispatched).toBe(1);
    expect(data.dispatchedHardFailed).toBe(1);

    const update = updateCalls.at(-1)!;
    expect(update.values.state).toBe('failed');
    expect(String(update.values.failureReason)).toContain("never advanced past 'dispatched'");
    // The reason must not claim we gave up verifying — nothing was ever
    // verifiable; the dispatch outcome itself is unknown.
    expect(String(update.values.failureReason)).toContain('workflow_run');
  });

  it('notifies the workspace so the UI does not keep showing it as in-flight', async () => {
    selectResults = [[], [], [stale]];
    updateReturning = [[{ id: 'rel-stuck' }]];

    await GET(makeRequest());

    expect(mockTriggerEvent).toHaveBeenCalledWith('workspace-ws-1', 'release:updated', {
      releaseId: 'rel-stuck',
      state: 'failed',
    });
  });

  it('queries dispatched rows past the hard-fail cutoff, not merely any dispatched row', async () => {
    // The mock ignores WHERE clauses, so the predicate is the only proof the
    // sweep is scoped: without the `lt` on dispatchedAt this would hard-fail a
    // release dispatched seconds ago.
    selectResults = [[], [], []];
    await GET(makeRequest());

    // Index 2: (0) healthy candidates, (1) stale-deploying, (2) stale-dispatched,
    // (3) healable-degraded — not .at(-1), which is the sweep added after this one.
    const flat = JSON.stringify(selectConditions[2]);
    expect(flat).toContain('dispatched');
    expect(flat).toContain('"type":"lt"');
    expect(flat).toContain('dispatchedAt');
  });

  it('guards the write on the row still being dispatched', async () => {
    // Optimistic lock: a workflow_run arriving between the select and the
    // update must win, not be clobbered by the sweep.
    selectResults = [[], [], [stale]];
    updateReturning = [[{ id: 'rel-stuck' }]];

    await GET(makeRequest());

    expect(JSON.stringify(updateCalls.at(-1)!.where)).toContain('dispatched');
  });

  it('counts nothing when the guarded write loses the race', async () => {
    selectResults = [[], [], [stale]];
    updateReturning = [[]]; // returning() empty => another writer got there first

    const res = await GET(makeRequest());
    const data = await res.json();

    expect(data.staleDispatched).toBe(1);
    expect(data.dispatchedHardFailed).toBe(0);
    expect(mockTriggerEvent).not.toHaveBeenCalled();
  });
});

describe('release-health-check cron — self-heal degraded (sha-mismatch false positives)', () => {
  // Regression context: a release can degrade because a *later* legitimate
  // merge landed on top of its own headSha mid-watch-window — the deploy
  // identity endpoint then reports a newer sha and trips the mismatch check
  // even though production is fine. probeAndDegrade's own ancestry check
  // (unit-tested in release-health-watcher.test.ts) stops new false
  // positives; this sweep re-checks and heals rows that already degraded.
  const degradedRow = {
    id: 'rel-degraded-1',
    workspaceId: 'ws-1',
    verificationStrategy: 'http',
    deployUrl: null,
    headSha: 'sha-old',
    healthyAt: hoursAgo(1),
    verificationUrl: 'https://example.com/api/version',
  };

  it('does nothing when there are no healable degraded releases', async () => {
    selectResults = [[], [], [], []];
    const res = await GET(makeRequest());
    const data = await res.json();

    expect(data.healableDegraded).toBe(0);
    expect(data.healed).toBe(0);
    expect(mockHealSupersededRelease).not.toHaveBeenCalled();
  });

  it('calls healSupersededRelease for each degraded candidate and counts a heal', async () => {
    selectResults = [[], [], [], [degradedRow]];
    mockHealSupersededRelease.mockResolvedValue('healed' as any);
    queryWorkspaceResult = { githubRepo: { fullName: 'org/repo', installation: { installationId: 7 } } };

    const res = await GET(makeRequest());
    const data = await res.json();

    expect(mockHealSupersededRelease).toHaveBeenCalledTimes(1);
    const call = mockHealSupersededRelease.mock.calls[0];
    expect(call[0].id).toBe('rel-degraded-1');
    expect(call[1]).toBe('https://example.com/api/version');
    expect(call[3]).toEqual({ installationId: 7, fullName: 'org/repo' });
    expect(data.healableDegraded).toBe(1);
    expect(data.healed).toBe(1);
  });

  it('does not count a heal when healSupersededRelease reports unresolved', async () => {
    selectResults = [[], [], [], [degradedRow]];
    mockHealSupersededRelease.mockResolvedValue('unresolved' as any);

    const res = await GET(makeRequest());
    const data = await res.json();

    expect(data.healableDegraded).toBe(1);
    expect(data.healed).toBe(0);
  });

  it('skips a degraded candidate with no configured verification URL', async () => {
    selectResults = [[], [], [], [{ ...degradedRow, verificationUrl: null }]];

    await GET(makeRequest());

    expect(mockHealSupersededRelease).not.toHaveBeenCalled();
  });

  it('scopes the query to degraded, http-verified, sha-mismatch releases', async () => {
    selectResults = [[], [], [], []];
    await GET(makeRequest());

    const flat = JSON.stringify(selectConditions.at(-1));
    expect(flat).toContain('degraded');
    expect(flat).toContain('does not match release head sha');
  });
});

describe('release-health-check cron — repo identity for the main probe loop', () => {
  it('resolves repo identity per candidate and passes it to probeAndDegrade', async () => {
    const healthyRow = {
      id: 'rel-healthy-1',
      workspaceId: 'ws-1',
      verificationStrategy: 'http',
      deployUrl: null,
      headSha: 'sha-current',
      healthyAt: new Date(),
      verificationUrl: 'https://example.com/api/version',
    };
    selectResults = [[healthyRow], [], [], []];
    queryWorkspaceResult = { githubRepo: { fullName: 'org/repo', installation: { installationId: 7 } } };

    await GET(makeRequest());

    expect(mockProbeAndDegrade).toHaveBeenCalledTimes(1);
    const call = mockProbeAndDegrade.mock.calls[0];
    expect(call[3]).toEqual({ installationId: 7, fullName: 'org/repo' });
  });
});
