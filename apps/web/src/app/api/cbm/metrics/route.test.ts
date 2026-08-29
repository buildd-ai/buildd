import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => Promise.resolve(null as any));
const mockAuthenticateApiKey = mock(() => Promise.resolve(null as any));
const mockGetUserTeamIds = mock(() => Promise.resolve([] as string[]));
const mockWorkspacesFindMany = mock(() => Promise.resolve([] as any[]));
const mockWorkersFindMany = mock(() => Promise.resolve([] as any[]));

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuthenticateApiKey }));
mock.module('@/lib/team-access', () => ({ getUserTeamIds: mockGetUserTeamIds }));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workers: { findMany: mockWorkersFindMany },
      workspaces: { findMany: mockWorkspacesFindMany },
    },
  },
}));

import { GET } from './route';

function makeRequest(params: Record<string, string> = {}, apiKey?: string) {
  const url = new URL('http://localhost/api/cbm/metrics');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const headers: Record<string, string> = {};
  if (apiKey) headers['authorization'] = `Bearer ${apiKey}`;
  return new NextRequest(url.toString(), { headers });
}

const adminAccount = { id: 'acct-1', level: 'admin', teamId: 'team-1' };

const workerWithCbmEnforced = {
  id: 'w1',
  inputTokens: 8000,
  resultMeta: {
    stopReason: 'end_turn',
    durationMs: 5000,
    durationApiMs: 4000,
    numTurns: 10,
    modelUsage: {},
    cbm: {
      outcome: 'enforced',
      toolCalls: { search_code: 3, query_graph: 2 },
      totalCbmCalls: 5,
      readCount: 4,
      grepCount: 2,
      globCount: 1,
    },
  },
};

const workerWithCbmDisabled = {
  id: 'w2',
  inputTokens: 12000,
  resultMeta: {
    stopReason: 'end_turn',
    durationMs: 6000,
    durationApiMs: 5000,
    numTurns: 12,
    modelUsage: {},
    cbm: {
      outcome: 'disabled',
      disableReason: 'binary_absent',
      toolCalls: {},
      totalCbmCalls: 0,
      readCount: 10,
      grepCount: 5,
      globCount: 3,
    },
  },
};

const workerWithoutCbm = {
  id: 'w3',
  inputTokens: 9000,
  resultMeta: { stopReason: 'end_turn', durationMs: 0, durationApiMs: 0, numTurns: 5, modelUsage: {} },
};

describe('GET /api/cbm/metrics', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockAuthenticateApiKey.mockReset();
    mockGetUserTeamIds.mockReset();
    mockWorkspacesFindMany.mockReset();
    mockWorkersFindMany.mockReset();

    // Defaults
    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockResolvedValue(null);
  });

  it('returns 401 when unauthenticated', async () => {
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
  });

  it('returns 403 when non-admin API key is used', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acct-x', level: 'worker', teamId: 'team-1' });
    const res = await GET(makeRequest({}, 'bld_worker'));
    expect(res.status).toBe(403);
  });

  it('returns empty response when no workers are found', async () => {
    mockAuthenticateApiKey.mockResolvedValue(adminAccount);
    mockWorkersFindMany.mockResolvedValue([]);
    const res = await GET(makeRequest({}, 'bld_admin'));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.totalTracked).toBe(0);
    expect(body.fallbackRate).toBeNull();
  });

  it('excludes pre-CBM workers (no cbm in resultMeta)', async () => {
    mockAuthenticateApiKey.mockResolvedValue(adminAccount);
    mockWorkersFindMany.mockResolvedValue([workerWithoutCbm]);
    const res = await GET(makeRequest({}, 'bld_admin'));
    const body = await res.json();
    expect(body.totalTracked).toBe(0);
  });

  it('computes correct aggregates for CBM-active and CBM-disabled tasks', async () => {
    mockAuthenticateApiKey.mockResolvedValue(adminAccount);
    mockWorkersFindMany.mockResolvedValue([workerWithCbmEnforced, workerWithCbmDisabled]);

    const res = await GET(makeRequest({ window: '7d' }, 'bld_admin'));
    const body = await res.json();

    expect(body.totalTracked).toBe(2);
    expect(body.fallbackRate).toBe(0.5);
    expect(body.cbmActive.count).toBe(1);
    expect(body.cbmActive.avgInputTokens).toBe(8000);
    // fileAccess: read(4) + grep(2) + glob(1) = 7
    expect(body.cbmActive.avgFileAccessCalls).toBe(7);
    expect(body.cbmActive.avgToolCalls.search_code).toBe(3);
    expect(body.cbmActive.avgToolCalls.query_graph).toBe(2);

    expect(body.cbmDisabled.count).toBe(1);
    expect(body.cbmDisabled.avgInputTokens).toBe(12000);
    // fileAccess: read(10) + grep(5) + glob(3) = 18
    expect(body.cbmDisabled.avgFileAccessCalls).toBe(18);
    expect(body.cbmDisabled.disableReasons.binary_absent).toBe(1);
  });

  it('suppresses deltas when the only disabled tasks are binary_absent', async () => {
    mockAuthenticateApiKey.mockResolvedValue(adminAccount);
    // The single disabled task is binary_absent, so there is no control cohort:
    // those workers never had the capability at all. Comparing against them is
    // what produced a bogus -80% on first rollout.
    mockWorkersFindMany.mockResolvedValue([workerWithCbmEnforced, workerWithCbmDisabled]);
    const res = await GET(makeRequest({}, 'bld_admin'));
    const body = await res.json();
    expect(body.cbmDisabled.comparableCount).toBe(0);
    expect(body.specTargets.inputTokenDeltaPct).toBeNull();
    expect(body.specTargets.fileAccessDeltaPct).toBeNull();
    expect(body.specTargets.fallbackRateTarget).toBe(0.05);
    expect(body.specTargets.fallbackRateMet).toBe(false); // 0.5 > 0.05
  });

  it('suppresses deltas and flags the reason when no graph tool calls were observed', async () => {
    mockAuthenticateApiKey.mockResolvedValue(adminAccount);
    // 5 active workers with CBM mounted but never queried, against 5 legitimate
    // (role_opt_out) controls. Both cohorts clear MIN_COHORT, so only the missing
    // mechanism suppresses the delta. This is the exact first-rollout condition.
    const mountedButUnused = {
      ...workerWithCbmEnforced,
      resultMeta: {
        cbm: {
          ...(workerWithCbmEnforced.resultMeta as any).cbm,
          toolCalls: {},
        },
      },
    };
    const optedOut = {
      ...workerWithCbmDisabled,
      resultMeta: {
        cbm: {
          ...(workerWithCbmDisabled.resultMeta as any).cbm,
          disableReason: 'role_opt_out',
        },
      },
    };
    mockWorkersFindMany.mockResolvedValue([
      ...Array(5).fill(mountedButUnused),
      ...Array(5).fill(optedOut),
    ]);
    const res = await GET(makeRequest({}, 'bld_admin'));
    const body = await res.json();
    expect(body.cbmActive.count).toBe(5);
    expect(body.cbmActive.activeWithZeroToolCalls).toBe(5);
    expect(body.cbmActive.mechanismObserved).toBe(false);
    expect(body.cbmDisabled.comparableCount).toBe(5);
    expect(body.specTargets.inputTokenDeltaPct).toBeNull();
    expect(body.specTargets.deltasSuppressedBecause).toBe('no_graph_tool_calls_observed');
  });

  it('reports deltas once both cohorts are sufficient and the mechanism is observed', async () => {
    mockAuthenticateApiKey.mockResolvedValue(adminAccount);
    const optedOut = {
      ...workerWithCbmDisabled,
      resultMeta: {
        cbm: {
          ...(workerWithCbmDisabled.resultMeta as any).cbm,
          disableReason: 'role_opt_out',
        },
      },
    };
    mockWorkersFindMany.mockResolvedValue([
      ...Array(5).fill(workerWithCbmEnforced), // these DO have toolCalls
      ...Array(5).fill(optedOut),
    ]);
    const res = await GET(makeRequest({}, 'bld_admin'));
    const body = await res.json();
    expect(body.cbmActive.mechanismObserved).toBe(true);
    expect(body.specTargets.deltasSuppressedBecause).toBeNull();
    // active 8000 vs comparable 12000 → -0.333...
    expect(body.specTargets.inputTokenDeltaPct).toBeCloseTo(-0.333, 2);
  });

  it('respects the window param', async () => {
    mockAuthenticateApiKey.mockResolvedValue(adminAccount);
    mockWorkersFindMany.mockResolvedValue([]);
    const res = await GET(makeRequest({ window: '24h' }, 'bld_admin'));
    const body = await res.json();
    expect(body.window).toBe('24h');
    // Verify findMany was called with a completedAt filter (can't check exact date, just that it was called)
    expect(mockWorkersFindMany).toHaveBeenCalledTimes(1);
  });

  it('works for logged-in users via session auth', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1', email: 'test@example.com' });
    mockGetUserTeamIds.mockResolvedValue(['team-1']);
    mockWorkspacesFindMany.mockResolvedValue([{ id: 'ws-1' }]);
    mockWorkersFindMany.mockResolvedValue([workerWithCbmEnforced]);

    const res = await GET(makeRequest());  // no API key — uses session
    const body = await res.json();
    expect(body.totalTracked).toBe(1);
    expect(body.cbmActive.count).toBe(1);
  });
});
