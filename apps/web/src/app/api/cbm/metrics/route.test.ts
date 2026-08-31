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

let workerSeq = 0;
/** Build a worker row carrying an arbitrary cbm record. */
function mkWorker(cbm: Record<string, unknown>, inputTokens: number) {
  return {
    id: `w-gen-${++workerSeq}`,
    inputTokens,
    resultMeta: { stopReason: 'end_turn', durationMs: 0, durationApiMs: 0, numTurns: 1, modelUsage: {}, cbm },
  };
}

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

  // ---------------------------------------------------------------------------
  // FIX 1 — control-group contamination
  // ---------------------------------------------------------------------------

  it('counts legacy_mcp_json workers as CBM-active, never as the baseline', async () => {
    mockAuthenticateApiKey.mockResolvedValue(adminAccount);
    mockWorkersFindMany.mockResolvedValue([mkWorker({
      outcome: 'legacy_mcp_json',
      toolCalls: { search_code: 2 },
      totalCbmCalls: 2,
      readCount: 1, grepCount: 1, globCount: 0,
    }, 7000)]);
    const res = await GET(makeRequest({}, 'bld_admin'));
    const body = await res.json();
    expect(body.cbmActive.count).toBe(1);
    expect(body.cbmActive.byOutcome.legacy_mcp_json).toBe(1);
    expect(body.cbmDisabled.count).toBe(0);
    expect(body.cbmDisabled.comparableCount).toBe(0);
  });

  it('excludes disabled rows that recorded CBM tool usage from the comparison baseline', async () => {
    mockAuthenticateApiKey.mockResolvedValue(adminAccount);
    // role_opt_out (so not filtered by the binary_absent rule) but the row carries
    // real graph calls: codebase-memory was mounted by a connector / project
    // .mcp.json even though the harness did not enforce it. Not a control.
    const contaminated = mkWorker({
      outcome: 'disabled',
      disableReason: 'role_opt_out',
      toolCalls: { search_code: 4 },
      totalCbmCalls: 4,
      readCount: 9, grepCount: 4, globCount: 2,
    }, 11000);
    mockWorkersFindMany.mockResolvedValue([
      ...Array(5).fill(workerWithCbmEnforced),
      ...Array(5).fill(contaminated),
    ]);
    const res = await GET(makeRequest({}, 'bld_admin'));
    const body = await res.json();
    expect(body.cbmDisabled.count).toBe(5);
    expect(body.cbmDisabled.comparableCount).toBe(0);
    expect(body.cbmDisabled.excludedFromComparable.recorded_cbm_usage).toBe(5);
    // No usable control cohort → deltas must be suppressed.
    expect(body.specTargets.inputTokenDeltaPct).toBeNull();
    expect(body.specTargets.deltasSuppressedBecause).toBe('insufficient_cohort');
  });

  it('reports how many baseline rows were excluded and why', async () => {
    mockAuthenticateApiKey.mockResolvedValue(adminAccount);
    const clean = mkWorker({
      outcome: 'disabled', disableReason: 'role_opt_out',
      toolCalls: {}, totalCbmCalls: 0, readCount: 10, grepCount: 5, globCount: 3,
    }, 12000);
    const contaminated = mkWorker({
      outcome: 'disabled', disableReason: 'no_worktree',
      toolCalls: { query_graph: 1 }, totalCbmCalls: 1, readCount: 2, grepCount: 0, globCount: 0,
    }, 9000);
    mockWorkersFindMany.mockResolvedValue([
      workerWithCbmDisabled,   // binary_absent
      clean,
      contaminated,
    ]);
    const res = await GET(makeRequest({}, 'bld_admin'));
    const body = await res.json();
    expect(body.cbmDisabled.count).toBe(3);
    expect(body.cbmDisabled.comparableCount).toBe(1);
    expect(body.cbmDisabled.excludedFromComparable).toEqual({
      binary_absent: 1,
      recorded_cbm_usage: 1,
      total: 2,
    });
  });

  it('counts a binary_absent row that recorded CBM usage only once as excluded', async () => {
    mockAuthenticateApiKey.mockResolvedValue(adminAccount);
    const both = mkWorker({
      outcome: 'disabled', disableReason: 'binary_absent',
      toolCalls: { search_code: 3 }, totalCbmCalls: 3, readCount: 1, grepCount: 1, globCount: 1,
    }, 9000);
    mockWorkersFindMany.mockResolvedValue([both]);
    const res = await GET(makeRequest({}, 'bld_admin'));
    const body = await res.json();
    expect(body.cbmDisabled.excludedFromComparable.total).toBe(1);
    expect(body.cbmDisabled.comparableCount).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // FIX 2 — fallback denominator + index-build failure
  // ---------------------------------------------------------------------------

  it('excludes by-design skips from the eligible fallback denominator', async () => {
    mockAuthenticateApiKey.mockResolvedValue(adminAccount);
    const skip = (reason: string) => mkWorker({
      outcome: 'disabled', disableReason: reason,
      toolCalls: {}, totalCbmCalls: 0, readCount: 1, grepCount: 0, globCount: 0,
    }, 5000);
    mockWorkersFindMany.mockResolvedValue([
      ...Array(4).fill(workerWithCbmEnforced),
      skip('codex_task'), skip('codex_task'),
      skip('no_worktree'), skip('no_worktree'),
      skip('role_opt_out'), skip('role_opt_out'),
    ]);
    const res = await GET(makeRequest({}, 'bld_admin'));
    const body = await res.json();
    // Old field keeps its old (contaminated) meaning: 6 disabled / 10 tracked.
    expect(body.fallbackRate).toBe(0.6);
    // New field: no eligible case failed → 0, and the spec target is reachable.
    expect(body.eligibleFallbackRate).toBe(0);
    expect(body.eligibility.eligibleCount).toBe(4);
    expect(body.eligibility.fallbackCount).toBe(0);
    expect(body.eligibility.byDesignSkipCount).toBe(6);
    expect(body.eligibility.byDesignSkips).toEqual({
      codex_task: 2, no_worktree: 2, role_opt_out: 2,
    });
    expect(body.specTargets.eligibleFallbackRateMet).toBe(true);
  });

  it('counts binary_absent as a real fallback inside the eligible denominator', async () => {
    mockAuthenticateApiKey.mockResolvedValue(adminAccount);
    mockWorkersFindMany.mockResolvedValue([
      ...Array(9).fill(workerWithCbmEnforced),
      workerWithCbmDisabled, // binary_absent
    ]);
    const res = await GET(makeRequest({}, 'bld_admin'));
    const body = await res.json();
    expect(body.eligibleFallbackRate).toBeCloseTo(0.1, 6);
    expect(body.eligibility.eligibleCount).toBe(10);
    expect(body.eligibility.fallbackCount).toBe(1);
    expect(body.specTargets.eligibleFallbackRateMet).toBe(false);
  });

  it('treats a disabled row with an unknown reason as an eligible fallback', async () => {
    mockAuthenticateApiKey.mockResolvedValue(adminAccount);
    mockWorkersFindMany.mockResolvedValue([
      workerWithCbmEnforced,
      mkWorker({ outcome: 'disabled', toolCalls: {}, totalCbmCalls: 0, readCount: 0, grepCount: 0, globCount: 0 }, 1000),
    ]);
    const res = await GET(makeRequest({}, 'bld_admin'));
    const body = await res.json();
    expect(body.eligibility.eligibleCount).toBe(2);
    expect(body.eligibility.fallbackCount).toBe(1);
    expect(body.eligibleFallbackRate).toBe(0.5);
  });

  it('surfaces index-build failures as a first-class metric aggregated from bootstrapResult', async () => {
    mockAuthenticateApiKey.mockResolvedValue(adminAccount);
    const bootstrapped = (result: 'ok' | 'failed', failReason?: string) => mkWorker({
      outcome: 'enforced',
      bootstrapResult: result,
      ...(failReason ? { bootstrapFailReason: failReason } : {}),
      toolCalls: { search_code: 1 }, totalCbmCalls: 1,
      readCount: 1, grepCount: 0, globCount: 0,
    }, 8000);
    mockWorkersFindMany.mockResolvedValue([
      bootstrapped('ok'),
      bootstrapped('ok'),
      bootstrapped('failed', 'index_timeout'),
      bootstrapped('failed', 'index_timeout'),
      workerWithCbmEnforced, // enforced but never reported a bootstrapResult
    ]);
    const res = await GET(makeRequest({}, 'bld_admin'));
    const body = await res.json();
    expect(body.indexBuild.attempted).toBe(4);
    expect(body.indexBuild.ok).toBe(2);
    expect(body.indexBuild.failed).toBe(2);
    expect(body.indexBuild.failureRate).toBe(0.5);
    expect(body.indexBuild.failReasons).toEqual({ index_timeout: 2 });
    expect(body.indexBuild.unreported).toBe(1);
    expect(body.specTargets.indexBuildFailureRateMet).toBe(false);
  });

  it('reports a null index-build failure rate when no bootstrap ever ran', async () => {
    mockAuthenticateApiKey.mockResolvedValue(adminAccount);
    mockWorkersFindMany.mockResolvedValue([workerWithCbmDisabled]);
    const res = await GET(makeRequest({}, 'bld_admin'));
    const body = await res.json();
    expect(body.indexBuild.attempted).toBe(0);
    expect(body.indexBuild.failureRate).toBeNull();
    expect(body.specTargets.indexBuildFailureRateMet).toBeNull();
  });

  it('keeps the deprecated fallbackRate/fallbackRateMet fields at their original meaning', async () => {
    mockAuthenticateApiKey.mockResolvedValue(adminAccount);
    mockWorkersFindMany.mockResolvedValue([workerWithCbmEnforced, workerWithCbmDisabled]);
    const res = await GET(makeRequest({}, 'bld_admin'));
    const body = await res.json();
    expect(body.fallbackRate).toBe(0.5); // all disabled / totalTracked
    expect(body.specTargets.fallbackRateMet).toBe(false);
    expect(body.specTargets.fallbackRateTarget).toBe(0.05);
  });

  it('includes the new fields in the empty response', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1', email: 'test@example.com' });
    mockGetUserTeamIds.mockResolvedValue([]); // no teams → early empty response
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body.eligibleFallbackRate).toBeNull();
    expect(body.eligibility).toEqual({
      eligibleCount: 0, fallbackCount: 0, byDesignSkipCount: 0, byDesignSkips: {},
    });
    expect(body.indexBuild).toEqual({
      attempted: 0, ok: 0, failed: 0, failureRate: null,
      // Warm starts are reported separately from attempts: a task served by the
      // shared seeded cache built nothing, so counting it as an attempt would
      // dilute the failure rate of the tasks that did build an index.
      skippedWarm: 0, warmStartRate: null,
      unreported: 0, failReasons: {},
    });
    expect(body.cbmActive.byOutcome).toEqual({});
    expect(body.cbmDisabled.excludedFromComparable).toEqual({
      binary_absent: 0, recorded_cbm_usage: 0, total: 0,
    });
    expect(body.specTargets.eligibleFallbackRateMet).toBeNull();
    expect(body.specTargets.indexBuildFailureRateMet).toBeNull();
  });
});
