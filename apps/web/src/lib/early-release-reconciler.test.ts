import { describe, it, expect, beforeEach, mock } from 'bun:test';

const gateEvents: any[] = [];
mock.module('@/lib/gate-ledger', () => ({
  GATE_SLUGS: { EARLY_RELEASE: 'early_release' },
  fireGateEvent: (e: any) => { gateEvents.push(e); return 'id'; },
}));
// Schema is safe to import for real (pure drizzle table definitions); only the
// live DB client needs stubbing so the module can load with no DATABASE_URL.
mock.module('@buildd/core/db', () => ({ db: {} }));

import {
  evaluatePushedCommits,
  evaluateClosedUpstream,
  evaluateRequestChanges,
  reconcileEarlyReleases,
  type ActiveRelease,
  type DependentTaskInfo,
  type RepoIdentity,
  type UpstreamPrState,
  type EarlyReleaseReconcilerDeps,
} from './early-release-reconciler';

// ── Pure rules ───────────────────────────────────────────────────────────────

describe('evaluatePushedCommits (case 1: upstream still open, pushed changes)', () => {
  it('refreshes when the upstream diff overlaps the dependent manifest', () => {
    const action = evaluatePushedCommits(['apps/web/src/lib/foo.ts'], ['apps/web/src/lib/foo.ts']);
    expect(action.kind).toBe('refresh');
  });

  it('ignores when there is no overlap', () => {
    const action = evaluatePushedCommits(['apps/web/src/lib/foo.ts'], ['apps/web/src/lib/bar.ts']);
    expect(action.kind).toBe('ignore');
  });

  it('treats an undeclared (non-concrete) manifest as unknown overlap — conservative refresh', () => {
    const action = evaluatePushedCommits(null, ['apps/web/src/lib/bar.ts']);
    expect(action.kind).toBe('refresh');
  });

  it('ignores on no data rather than acting on an empty diff', () => {
    const action = evaluatePushedCommits(['apps/web/src/lib/foo.ts'], []);
    expect(action.kind).toBe('ignore');
  });
});

describe('evaluateClosedUpstream (case 2: upstream closed without merging)', () => {
  it('escalates when nothing verified landed anywhere', () => {
    const action = evaluateClosedUpstream(['apps/web/src/lib/foo.ts'], null);
    expect(action.kind).toBe('escalate');
  });

  it('redirects the overlap check to the verified landing PR — refreshes on overlap', () => {
    const action = evaluateClosedUpstream(['apps/web/src/lib/foo.ts'], ['apps/web/src/lib/foo.ts']);
    expect(action.kind).toBe('refresh');
  });

  it('redirects the overlap check to the verified landing PR — ignores with no overlap', () => {
    const action = evaluateClosedUpstream(['apps/web/src/lib/foo.ts'], ['apps/web/src/lib/bar.ts']);
    expect(action.kind).toBe('ignore');
  });
});

describe('evaluateRequestChanges (case 3: upstream has an outstanding request-changes round)', () => {
  it('keeps the default (ignore) with no file-level evidence', () => {
    const action = evaluateRequestChanges(['apps/web/src/lib/foo.ts'], []);
    expect(action.kind).toBe('ignore');
  });

  it('escalates only when the commented files overlap the dependent manifest', () => {
    const action = evaluateRequestChanges(['apps/web/src/lib/foo.ts'], ['apps/web/src/lib/foo.ts']);
    expect(action.kind).toBe('escalate');
  });

  it('keeps the default when the commented files do not overlap', () => {
    const action = evaluateRequestChanges(['apps/web/src/lib/foo.ts'], ['apps/web/src/lib/bar.ts']);
    expect(action.kind).toBe('ignore');
  });
});

// ── Orchestration ────────────────────────────────────────────────────────────

const ROW: ActiveRelease = {
  id: 'release-1',
  dependentTaskId: 'dep-1',
  upstreamTaskId: 'up-1',
  upstreamPrNumber: 42,
};

const DEPENDENT: DependentTaskInfo = {
  id: 'dep-1',
  title: 'the dependent task',
  workspaceId: 'ws-1',
  missionId: 'mission-1',
  pathManifest: ['apps/web/src/lib/foo.ts'],
};

const REPO: RepoIdentity = {
  installationId: 123,
  repoFullName: 'acme/app',
  gitConfig: null,
};

function harness(overrides: Partial<EarlyReleaseReconcilerDeps> = {}) {
  const calls = {
    refresh: [] as any[],
    escalate: [] as any[],
    hasOpenEscalationCalls: 0,
  };
  const deps: EarlyReleaseReconcilerDeps = {
    findActiveReleases: async () => [ROW],
    getDependentTask: async () => DEPENDENT,
    getUpstreamTaskTitle: async () => 'the upstream task',
    getRepoIdentity: async () => REPO,
    getUpstreamPrState: async () => ({
      prLifecycleStatus: 'pr_open',
      mergedAt: null,
      abandonedAt: null,
      supersededByPrNumber: null,
      supersededByPrUrl: null,
    } satisfies UpstreamPrState),
    findOpenDependentPrNumber: async () => 7,
    getLiveHeadSha: async () => 'h'.repeat(40),
    getDiffFiles: async () => [],
    getRequestChangesPaths: async () => [],
    refresh: async (params) => { calls.refresh.push(params); return { kind: 'updated' }; },
    hasOpenEscalation: async () => { calls.hasOpenEscalationCalls++; return false; },
    postEscalation: async (input) => { calls.escalate.push(input); },
    ...overrides,
  };
  return { deps, calls };
}

beforeEach(() => {
  gateEvents.length = 0;
});

describe('reconcileEarlyReleases — case (1): upstream pushed commits', () => {
  it('refreshes the dependent when the new upstream diff overlaps its manifest', async () => {
    const { deps, calls } = harness({ getDiffFiles: async () => ['apps/web/src/lib/foo.ts'] });
    const result = await reconcileEarlyReleases(deps);
    expect(calls.refresh).toHaveLength(1);
    expect(calls.refresh[0]).toMatchObject({ installationId: 123, repoFullName: 'acme/app', prNumber: 7, taskId: 'dep-1' });
    expect(result).toMatchObject({ enumerated: 1, processed: 1, refreshed: 1, errors: 0 });
  });

  it('does nothing when the new upstream diff does not overlap', async () => {
    const { deps, calls } = harness({ getDiffFiles: async () => ['apps/web/src/lib/bar.ts'] });
    const result = await reconcileEarlyReleases(deps);
    expect(calls.refresh).toHaveLength(0);
    // The independent case-(3) request-changes check also clears on this same
    // row (no evidence in the default harness), so both contribute 'ignored'.
    expect(result).toMatchObject({ refreshed: 0, ignored: 2 });
  });

  it('skips the refresh (but does not fail) when the dependent has no open PR yet', async () => {
    const { deps, calls } = harness({
      getDiffFiles: async () => ['apps/web/src/lib/foo.ts'],
      findOpenDependentPrNumber: async () => null,
    });
    const result = await reconcileEarlyReleases(deps);
    expect(calls.refresh).toHaveLength(0);
    expect(result).toMatchObject({ ignored: 2, errors: 0 });
  });
});

describe('reconcileEarlyReleases — case (2): upstream closed without merging', () => {
  function closed(overrides: Partial<UpstreamPrState> = {}): UpstreamPrState {
    return {
      prLifecycleStatus: 'closed',
      mergedAt: null,
      abandonedAt: null,
      supersededByPrNumber: null,
      supersededByPrUrl: null,
      ...overrides,
    };
  }

  it('escalates when no verified landing elsewhere was found', async () => {
    const { deps, calls } = harness({ getUpstreamPrState: async () => closed() });
    const result = await reconcileEarlyReleases(deps);
    expect(calls.escalate).toHaveLength(1);
    expect(calls.escalate[0]).toMatchObject({ dependentTaskId: 'dep-1', missionId: 'mission-1' });
    expect(result).toMatchObject({ escalated: 1 });
  });

  it('does not re-escalate once an open note already covers this release', async () => {
    const { deps, calls } = harness({
      getUpstreamPrState: async () => closed(),
      hasOpenEscalation: async () => { calls.hasOpenEscalationCalls++; return true; },
    });
    const result = await reconcileEarlyReleases(deps);
    expect(calls.escalate).toHaveLength(0);
    expect(calls.hasOpenEscalationCalls).toBe(1);
    expect(result).toMatchObject({ escalated: 1 });
  });

  it('redirects the overlap check to a verified superseding PR and refreshes on overlap', async () => {
    const { deps, calls } = harness({
      getUpstreamPrState: async () => closed({ supersededByPrNumber: 99 }),
      getDiffFiles: async ({ prNumber }) => (prNumber === 99 ? ['apps/web/src/lib/foo.ts'] : []),
    });
    const result = await reconcileEarlyReleases(deps);
    expect(calls.refresh).toHaveLength(1);
    expect(calls.escalate).toHaveLength(0);
    expect(result).toMatchObject({ refreshed: 1 });
  });

  it('does nothing when a human already marked the closed PR abandoned', async () => {
    const { deps, calls } = harness({ getUpstreamPrState: async () => closed({ abandonedAt: new Date() }) });
    const result = await reconcileEarlyReleases(deps);
    expect(calls.escalate).toHaveLength(0);
    expect(calls.refresh).toHaveLength(0);
    expect(result).toMatchObject({ ignored: 1 });
  });
});

describe('reconcileEarlyReleases — case (3): upstream gets request-changes', () => {
  it('keeps the dependent going (default) when there is no file-level evidence', async () => {
    const { deps, calls } = harness({ getRequestChangesPaths: async () => [] });
    const result = await reconcileEarlyReleases(deps);
    expect(calls.escalate).toHaveLength(0);
    // Case (1)'s pushed-commits check also clears on this same row (no diff
    // in the default harness), so both contribute 'ignored'.
    expect(result).toMatchObject({ escalated: 0, ignored: 2 });
  });

  it('escalates when the requested fix overlaps the dependent manifest', async () => {
    const { deps, calls } = harness({ getRequestChangesPaths: async () => ['apps/web/src/lib/foo.ts'] });
    const result = await reconcileEarlyReleases(deps);
    expect(calls.escalate).toHaveLength(1);
    expect(result).toMatchObject({ escalated: 1 });
  });

  it('keeps the default when the requested fix does not overlap', async () => {
    const { deps, calls } = harness({ getRequestChangesPaths: async () => ['apps/web/src/lib/bar.ts'] });
    const result = await reconcileEarlyReleases(deps);
    expect(calls.escalate).toHaveLength(0);
    expect(result).toMatchObject({ ignored: 2 });
  });

  it('can both refresh (case 1) and escalate (case 3) for the same still-open PR', async () => {
    const { deps, calls } = harness({
      getDiffFiles: async () => ['apps/web/src/lib/foo.ts'],
      getRequestChangesPaths: async () => ['apps/web/src/lib/foo.ts'],
    });
    const result = await reconcileEarlyReleases(deps);
    expect(calls.refresh).toHaveLength(1);
    expect(calls.escalate).toHaveLength(1);
    expect(result).toMatchObject({ refreshed: 1, escalated: 1 });
  });
});

describe('reconcileEarlyReleases — terminal/edge cases', () => {
  it('does nothing once the upstream PR has merged', async () => {
    const { deps, calls } = harness({
      getUpstreamPrState: async () => ({
        prLifecycleStatus: 'merged', mergedAt: new Date(), abandonedAt: null, supersededByPrNumber: null, supersededByPrUrl: null,
      }),
      getDiffFiles: async () => ['apps/web/src/lib/foo.ts'],
      getRequestChangesPaths: async () => ['apps/web/src/lib/foo.ts'],
    });
    const result = await reconcileEarlyReleases(deps);
    expect(calls.refresh).toHaveLength(0);
    expect(calls.escalate).toHaveLength(0);
    expect(result).toMatchObject({ ignored: 1 });
  });

  it('skips a row whose dependent task no longer exists', async () => {
    const { deps } = harness({ getDependentTask: async () => null });
    const result = await reconcileEarlyReleases(deps);
    expect(result).toMatchObject({ skipped: 1, processed: 1 });
  });

  it('isolates one row throwing from the rest of the sweep', async () => {
    const other: ActiveRelease = { ...ROW, id: 'release-2', dependentTaskId: 'dep-2' };
    const { deps, calls } = harness({
      findActiveReleases: async () => [ROW, other],
      getDependentTask: async (id) => {
        if (id === 'dep-1') throw new Error('boom');
        return { ...DEPENDENT, id: 'dep-2' };
      },
    });
    const result = await reconcileEarlyReleases(deps);
    expect(result.enumerated).toBe(2);
    expect(result.errors).toBe(1);
    expect(result.processed).toBe(1);
    expect(calls.refresh).toHaveLength(0);
  });

  it('fires an early_release gate event for every action taken', async () => {
    const { deps } = harness({ getDiffFiles: async () => ['apps/web/src/lib/foo.ts'] });
    await reconcileEarlyReleases(deps);
    expect(gateEvents.some((e) => e.gate === 'early_release' && e.outcome === 'warned')).toBe(true);
  });
});
