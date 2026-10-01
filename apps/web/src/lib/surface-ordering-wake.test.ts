/**
 * Closure-driven re-drive of a PR that was waiting on surface order
 * (conflict-aware-orchestration.md §3): which door it goes through, and when it
 * must not merge at all.
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test';

let worker: any = null;
let workspace: any = null;
let task: any = null;
let livePr: any = null;
let policy: any = { tier: 'auto-threshold' };
let reviewStatus: any = { state: 'not_requested' };
let selfMergeable = false;

const mockLandPr = mock(async (_input: any) => ({ kind: 'merged' }));
const mockTryAutoMerge = mock(async (_input: any) => ({ merged: true } as { merged: boolean; reason?: string }));
const mockGithubApi = mock(async (_inst: number, _path: string) => livePr);
const mockResolvePolicy = mock((_ws: any, _mission: any, _task: any, _opts: any) => policy);

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workers: { findFirst: async () => worker },
      workspaces: { findFirst: async () => workspace },
      tasks: { findFirst: async () => task },
    },
  },
}));
mock.module('@/lib/github', () => ({ githubApi: mockGithubApi }));
mock.module('@/lib/merge-policy', () => ({ resolvePolicy: mockResolvePolicy, RESOLVE_POLICY_MISSION_COLUMNS: {} }));
mock.module('@/lib/workspace-installation', () => ({
  WORKSPACE_INSTALLATION_WITH: {},
  pickWorkspaceRepoIdentity: (ws: any) => ({ fullName: ws.repoFullName, installationId: ws.installationId }),
  installationIdForRepo: async () => null,
}));
mock.module('@/lib/pr-landing', () => ({
  landPr: mockLandPr,
  resolveLandingMode: (gc: any) => gc?.landing?.mode ?? 'shadow',
}));
mock.module('@/lib/pr-review-request', () => ({ readPrReviewStatus: async () => reviewStatus }));
mock.module('@/lib/pr-review-status', () => ({ isApprovalSelfMergeable: () => selfMergeable }));
mock.module('@/lib/auto-merge', () => ({ tryAutoMergeWorkerPr: mockTryAutoMerge }));

import { redriveSurfaceWaiter } from './surface-ordering-wake';

const GIT_CONFIG = { surfaceOrdering: 'enforce' };

beforeEach(() => {
  worker = { id: 'w-12', taskId: 't-12', prUrl: 'https://github.com/acme/repo/pull/12', prBaseRef: 'dev', workspaceId: 'ws-1' };
  workspace = { id: 'ws-1', repoFullName: 'acme/repo', installationId: 7, gitConfig: GIT_CONFIG, releaseConfig: null };
  task = { id: 't-12', requiresReview: false, missionId: null, mission: null };
  livePr = { state: 'open', merged: false, draft: false, head: { sha: 'head-12' }, base: { ref: 'dev' } };
  policy = { tier: 'auto-threshold' };
  reviewStatus = { state: 'not_requested' };
  selfMergeable = false;
  mockLandPr.mockClear();
  mockTryAutoMerge.mockClear();
  mockResolvePolicy.mockClear();
});

describe('redriveSurfaceWaiter', () => {
  it('no open worker for the PR: nothing to re-drive', async () => {
    worker = null;
    expect(await redriveSurfaceWaiter('ws-1', 12)).toBe('no_open_worker');
    expect(mockTryAutoMerge).not.toHaveBeenCalled();
  });

  it('a PR GitHub no longer has open (or a draft) is left alone', async () => {
    livePr = { ...livePr, state: 'closed' };
    expect(await redriveSurfaceWaiter('ws-1', 12)).toBe('not_open');
    livePr = { ...livePr, state: 'open', draft: true };
    expect(await redriveSurfaceWaiter('ws-1', 12)).toBe('not_open');
    expect(mockTryAutoMerge).not.toHaveBeenCalled();
    expect(mockLandPr).not.toHaveBeenCalled();
  });

  it('human tier: re-driving never merges', async () => {
    policy = { tier: 'human' };
    expect(await redriveSurfaceWaiter('ws-1', 12)).toBe('human_tier');
    expect(mockTryAutoMerge).not.toHaveBeenCalled();
    expect(mockLandPr).not.toHaveBeenCalled();
  });

  it('resolves policy against the live base ref', async () => {
    livePr = { ...livePr, base: { ref: 'mission/abcd1234-integration' } };
    await redriveSurfaceWaiter('ws-1', 12);
    expect(mockResolvePolicy.mock.calls[0][3]).toEqual({ baseRef: 'mission/abcd1234-integration' });
  });

  it('agent-review without a self-mergeable approval waits for the reviewer', async () => {
    policy = { tier: 'agent-review', agentReview: {} };
    reviewStatus = { state: 'changes_requested' };
    expect(await redriveSurfaceWaiter('ws-1', 12)).toBe('awaiting_review');
    reviewStatus = { state: 'approved' };
    selfMergeable = false;
    expect(await redriveSurfaceWaiter('ws-1', 12)).toBe('awaiting_review');
    expect(mockTryAutoMerge).not.toHaveBeenCalled();
  });

  it('agent-review with a self-mergeable approval goes through auto-merge with the gitConfig', async () => {
    policy = { tier: 'agent-review', agentReview: {} };
    reviewStatus = { state: 'approved' };
    selfMergeable = true;
    expect(await redriveSurfaceWaiter('ws-1', 12)).toBe('merged');
    expect(mockTryAutoMerge.mock.calls[0][0]).toMatchObject({
      repoFullName: 'acme/repo', prNumber: 12, headSha: 'head-12', installationId: 7,
      worker: { id: 'w-12', taskId: 't-12', workspaceId: 'ws-1' },
      surfaceOrderingConfig: GIT_CONFIG,
    });
  });

  it('auto-threshold: the legacy auto-merge path, reporting a refusal reason', async () => {
    mockTryAutoMerge.mockImplementationOnce(async () => ({ merged: false, reason: 'CI red' }));
    expect(await redriveSurfaceWaiter('ws-1', 12)).toBe('not_merged: CI red');
    expect(mockLandPr).not.toHaveBeenCalled();
  });

  it('landing enforce: re-driven through landPr as the surface_wakeup door, with the gitConfig', async () => {
    workspace = { ...workspace, gitConfig: { ...GIT_CONFIG, landing: { mode: 'enforce' } } };
    expect(await redriveSurfaceWaiter('ws-1', 12)).toBe('merged');
    expect(mockTryAutoMerge).not.toHaveBeenCalled();
    expect(mockLandPr.mock.calls[0][0]).toMatchObject({
      door: 'surface_wakeup', prNumber: 12, eventHeadSha: 'head-12', mode: 'enforce',
      owner: { taskId: 't-12', workerId: 'w-12' },
      gitConfig: workspace.gitConfig,
    });
  });

  it('with expectHeadSha, a moved head is not re-driven', async () => {
    expect(await redriveSurfaceWaiter('ws-1', 12, { expectHeadSha: 'older-head' })).toBe('head_moved');
    expect(mockTryAutoMerge).not.toHaveBeenCalled();
    expect(await redriveSurfaceWaiter('ws-1', 12, { expectHeadSha: 'head-12' })).toBe('merged');
  });
});
