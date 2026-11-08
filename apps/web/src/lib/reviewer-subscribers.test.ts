/**
 * `reviewerDispatchOnOpen` (the PR-opened slot's reviewer dispatch) against a
 * frozen release candidate: composition decides what, if anything, is
 * reviewed (release-flow.md AC-14, AC-25 to AC-27), the same attestation
 * `pr-landing.ts` reads at merge time. Covers the gap task 194f4501 reports:
 * the webhook's first-review dispatch had no candidate awareness at all, so
 * a fully composed release candidate (every change already approved on its
 * own PR) got a full reviewer anyway, which escalated under the reviewer
 * role's hard "release PR → human sign-off" rule — asking a person to
 * re-approve work they (or an agent) already approved.
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockCandidateReviewScope = mock(async (_p: any): Promise<any> => ({ kind: 'not_candidate' }));
mock.module('@/lib/workflow/candidate-review', () => ({ candidateReviewScope: mockCandidateReviewScope }));

mock.module('@/lib/core-events', () => ({ subscriber: () => ({}) }));

const mockWorkspacesFindFirst = mock(() => null as any);
const mockTasksFindFirst = mock(() => null as any);
const mockMissionsFindFirst = mock(() => null as any);
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workspaces: { findFirst: mockWorkspacesFindFirst },
      tasks: { findFirst: mockTasksFindFirst },
      missions: { findFirst: mockMissionsFindFirst },
    },
    insert: () => ({ values: () => Promise.resolve() }),
  },
}));
mock.module('@buildd/core/db/schema', () => ({
  tasks: 'tasks_table', workspaces: 'workspaces_table', missions: 'missions_table', missionNotes: 'mission_notes_table',
}));
mock.module('drizzle-orm', () => ({ eq: (field: any, value: any) => ({ field, value }) }));
mock.module('@buildd/core/db/relational-sql', () => ({ sqlWhere: (c: any) => c }));

const mockGithubApi = mock(async (_installationId: number, path: string) => {
  if (typeof path === 'string' && path.includes('/files')) return [];
  return null;
});
mock.module('@/lib/github', () => ({ githubApi: mockGithubApi }));

mock.module('@/lib/dispatch-authority', () => ({ announceTaskCreated: mock(async () => {}), wakeTask: mock(async () => {}) }));
mock.module('@/lib/notify', () => ({ notifyTeamOf: mock(async () => {}) }));
mock.module('@/lib/ci-failure-retry', () => ({ retryCiFailureForPr: mock(async () => {}) }));

const mockCreateReviewerTask = mock(async (_p: any) => ({ id: 'review-task-1' }) as any);
mock.module('@/lib/reviewer', () => ({
  createReviewerTask: mockCreateReviewerTask,
  // Trivial stand-in: none of these cases touch a schema path or a configured
  // risk class, so the real function would answer the same; stubbed to keep
  // this file's mocks self-contained rather than reaching into reviewer.ts.
  preflightEscalationCheck: () => ({ shouldEscalate: false }),
}));
mock.module('@/lib/copy-review', () => ({ prNeedsCopyReview: mock(async () => false) }));
mock.module('@/lib/workspace-policy', () => ({ applyPolicyConfigToMergePolicy: (base: any) => base }));
mock.module('@/lib/task-title', () => ({ reviewerTitle: (n: number, title: string) => `Review PR #${n}: ${title}` }));
mock.module('@/lib/migration-inspector', () => ({ inspectPullRequestMigrations: mock(async () => ({ safe: true })) }));
mock.module('@/lib/integration-refresh', () => ({
  effectiveDeltaFiles: mock(async () => null),
  refreshDeltaBase: () => null,
}));
mock.module('@/lib/migration-collision-retry', () => ({ tryDispatchMigrationCollisionRetry: mock(async () => ({ handled: false })) }));
mock.module('@/lib/path-declaration', () => ({ conformanceManifest: () => null }));
mock.module('@/lib/pr-activity-comment', () => ({ appendPrActivity: mock(async () => {}) }));
const mockListWorkspaceRoles = mock(async () => [{ slug: 'reviewer', isRole: true }] as any[]);
mock.module('@/lib/pr-review-request', () => ({
  listWorkspaceRoles: mockListWorkspaceRoles,
  readPrReviewStatus: mock(async () => null),
}));
// pr-review-status stays REAL — pickReviewerRole is the actual role-selection
// contract this dispatch is judged on.
mock.module('@/lib/approval-carry-forward', () => ({ carryForwardApprovalIfUnchanged: mock(async () => ({ carried: false })) }));
mock.module('@/lib/gate-ledger', () => ({ fireGateEvent: mock(() => 'gate-1'), GATE_SLUGS: {} }));
mock.module('@/lib/workflow/seam', () => ({ policyFindingFor: () => null }));
const mockOpenKernelDelivery = mock(async () => ({ owned: false }) as any);
mock.module('@/lib/workflow/kernel-client', () => ({
  openKernelDelivery: mockOpenKernelDelivery,
  observeHead: mock(async () => null),
  systemPrincipal: { kind: 'system', id: 'system:test' },
}));
mock.module('@/lib/workflow/authority', () => ({ releaseKernelDeliveryForPr: mock(async () => {}) }));

const { reviewerDispatchOnOpen } = await import('./reviewer-subscribers');

// ── Fixtures ──────────────────────────────────────────────────────────────────

const WORKER = { id: 'worker-1', workspaceId: 'ws-1', taskId: 'task-1', branch: 'release/v1.2.3' };
const WORKSPACE = {
  id: 'ws-1', teamId: 'team-1', gitConfig: { mergePolicy: { tier: 'agent-review', agentReview: { reviewerRole: 'reviewer' } } },
  releaseConfig: { candidate: {} },
};
const TASK = { id: 'task-1', title: 'Release v1.2.3', description: null, backend: 'claude', missionId: null, pathManifest: null, pathDeclaration: null, context: {} };
const PR = { number: 77, headSha: 'cand-head', htmlUrl: 'https://github.com/buildd-ai/buildd/pull/77', baseRef: 'main', body: null };

function dispatch(extra: { pr?: Partial<typeof PR> } = {}) {
  return reviewerDispatchOnOpen({
    installationId: 5000, repoFullName: 'buildd-ai/buildd', worker: WORKER,
    pr: { ...PR, ...extra.pr },
  });
}

beforeEach(() => {
  mockCandidateReviewScope.mockReset();
  mockCandidateReviewScope.mockResolvedValue({ kind: 'not_candidate' });
  mockWorkspacesFindFirst.mockReset();
  mockWorkspacesFindFirst.mockReturnValue(WORKSPACE);
  mockTasksFindFirst.mockReset();
  mockTasksFindFirst.mockReturnValue(TASK);
  mockMissionsFindFirst.mockReset();
  mockMissionsFindFirst.mockReturnValue(null);
  mockCreateReviewerTask.mockReset();
  mockCreateReviewerTask.mockResolvedValue({ id: 'review-task-1' });
  mockOpenKernelDelivery.mockReset();
  mockOpenKernelDelivery.mockResolvedValue({ owned: false });
  mockListWorkspaceRoles.mockReset();
  mockListWorkspaceRoles.mockResolvedValue([{ slug: 'reviewer', isRole: true }]);
  mockGithubApi.mockClear();
});

describe('reviewerDispatchOnOpen — a frozen release candidate is reviewed by its composition', () => {
  it('every change approved on its own PR at this head: no reviewer is filed, and the PR is held (no no-CI auto-merge)', async () => {
    mockCandidateReviewScope.mockResolvedValue({ kind: 'composed', headSha: 'cand-head', constituents: 2 });
    const out = await dispatch();
    expect(out).toEqual({ held: true });
    expect(mockCreateReviewerTask).not.toHaveBeenCalled();
    expect(mockOpenKernelDelivery).not.toHaveBeenCalled();
    // The composed case never needed the PR's file list at all.
    expect(mockGithubApi).not.toHaveBeenCalled();
    expect(mockCandidateReviewScope).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'ws-1', prNumber: 77, repoFullName: 'buildd-ai/buildd', releaseConfig: { candidate: {} } }),
      {},
    );
  });

  it('commits no earlier review covered: one reviewer, scoped to those commits, never the whole PR', async () => {
    const commits = [{ sha: 'd'.repeat(40), reason: 'direct_commit', paths: ['apps/web/x.ts'] }];
    const files = [{ filename: 'apps/web/x.ts', status: 'modified', additions: 1, deletions: 0 }];
    mockCandidateReviewScope.mockResolvedValue({ kind: 'delta', headSha: 'cand-head', commits, paths: ['apps/web/x.ts'], files });
    const out = await dispatch();
    expect(out).toEqual({ held: true });
    expect(mockCreateReviewerTask).toHaveBeenCalledTimes(1);
    const params = (mockCreateReviewerTask.mock.calls[0] as any[])[0];
    expect(params.compositionScope).toEqual({ novelDeltaPaths: ['apps/web/x.ts'], novelCommits: commits });
    expect(params.prFiles).toEqual(files);
    // The delta's files are exactly what candidateReviewScope already read — no second GitHub call.
    expect(mockGithubApi).not.toHaveBeenCalled();
  });

  it('a composition that cannot be proved, or a read that throws, keeps the full review unscoped', async () => {
    mockCandidateReviewScope.mockResolvedValue({ kind: 'unverifiable', headSha: 'cand-head', reason: 'commit_list_truncated' });
    await dispatch();
    expect(((mockCreateReviewerTask.mock.calls[0] as any[])[0]).compositionScope).toBeUndefined();
    expect(mockGithubApi).toHaveBeenCalledWith(5000, expect.stringContaining('/files'));

    mockCreateReviewerTask.mockClear();
    mockGithubApi.mockClear();
    mockCandidateReviewScope.mockRejectedValue(new Error('github down'));
    await dispatch();
    expect(((mockCreateReviewerTask.mock.calls[0] as any[])[0]).compositionScope).toBeUndefined();
    expect(mockGithubApi).toHaveBeenCalledWith(5000, expect.stringContaining('/files'));
  });

  it('an answer about another head claims nothing for this one: the full review stays', async () => {
    mockCandidateReviewScope.mockResolvedValue({ kind: 'composed', headSha: 'old-head', constituents: 2 });
    await dispatch();
    expect(mockCreateReviewerTask).toHaveBeenCalledTimes(1);
    expect(((mockCreateReviewerTask.mock.calls[0] as any[])[0]).compositionScope).toBeUndefined();
  });

  it('not a candidate workspace (no releaseConfig.candidate): never asks for a composition; unchanged full review', async () => {
    mockWorkspacesFindFirst.mockReturnValue({ ...WORKSPACE, releaseConfig: null });
    mockCandidateReviewScope.mockResolvedValue({ kind: 'composed', headSha: 'cand-head', constituents: 2 });
    await dispatch();
    expect(mockCandidateReviewScope).not.toHaveBeenCalled();
    expect(mockCreateReviewerTask).toHaveBeenCalledTimes(1);
  });

  it('a human-tier workspace never trusts composition to skip a reviewer', async () => {
    mockWorkspacesFindFirst.mockReturnValue({
      ...WORKSPACE, gitConfig: { mergePolicy: { tier: 'human' } },
    });
    mockCandidateReviewScope.mockResolvedValue({ kind: 'composed', headSha: 'cand-head', constituents: 2 });
    const out = await dispatch();
    expect(out).toEqual({ held: true });
    expect(mockCandidateReviewScope).not.toHaveBeenCalled();
    // Human tier escalates on the pre-flight path, never through the reviewer at all.
    expect(mockCreateReviewerTask).not.toHaveBeenCalled();
  });
});
