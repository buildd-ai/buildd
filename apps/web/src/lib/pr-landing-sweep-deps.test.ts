import { beforeEach, describe, expect, it, mock } from 'bun:test';

// ── Mocks: a tiny in-memory database behind the query builder ──────────────────

let workerRow: any;
let workspaceRow: any;
let taskRow: any;
let floorRows: any[];
let floorLimit: number | null;
let reviewState: string;
let repoInstallation: number | null;

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workers: { findFirst: async () => workerRow },
      workspaces: { findFirst: async () => workspaceRow },
      tasks: { findFirst: async () => taskRow },
    },
    selectDistinct: () => ({
      from: () => ({
        where: () => ({
          limit: async (n: number) => {
            floorLimit = n;
            return floorRows;
          },
        }),
      }),
    }),
  },
}));
mock.module('@buildd/core/db/schema', () => ({
  tasks: { id: 'tasks.id' },
  workers: { workspaceId: 'w.ws', prNumber: 'w.pr', mergedAt: 'w.merged', prLifecycleStatus: 'w.lc', createdAt: 'w.created' },
  workspaces: { id: 'ws.id' },
}));
mock.module('drizzle-orm', () => {
  const sql: any = (strings: any, ...values: any[]) => ({ type: 'sql', strings, values });
  sql.raw = (s: string) => ({ type: 'raw', s });
  return {
    sql,
    eq: (a: any, b: any) => ({ type: 'eq', a, b }),
    and: (...a: any[]) => ({ type: 'and', a }),
    or: (...a: any[]) => ({ type: 'or', a }),
    isNull: (a: any) => ({ type: 'isNull', a }),
    isNotNull: (a: any) => ({ type: 'isNotNull', a }),
    notInArray: (a: any, b: any) => ({ type: 'notInArray', a, b }),
    desc: (a: any) => ({ type: 'desc', a }),
  };
});

const githubApi = mock(async (..._a: any[]): Promise<any> => ({}));
mock.module('@/lib/github', () => ({ githubApi }));

const landPr = mock(async (..._a: any[]): Promise<any> => ({ kind: 'merged', sha: 's' }));
mock.module('@/lib/pr-landing', () => ({
  landPr,
  resolveLandingMode: (gc: any) => (gc?.landing?.mode === 'off' || gc?.landing?.mode === 'enforce' ? gc.landing.mode : 'shadow'),
}));
const readLandingMarker = mock(async (..._a: any[]): Promise<any> => null);
mock.module('@/lib/pr-landing-marker', () => ({ readLandingMarker }));
const readPrReviewStatus = mock(async (..._a: any[]): Promise<any> => ({ state: reviewState }));
mock.module('@/lib/pr-review-request', () => ({ readPrReviewStatus }));
// The kernel delivery that owns the PR (null = legacy-owned).
let kernelView: any;
const kernelLandingView = mock(async (..._a: any[]): Promise<any> => kernelView);
let kernelFloor: any[];
mock.module('@/lib/workflow/seam', () => ({ kernelLandingView, listApprovedKernelPrs: async () => kernelFloor }));
mock.module('@/lib/workspace-installation', () => ({
  WORKSPACE_INSTALLATION_WITH: {},
  pickWorkspaceRepoIdentity: (ws: any) => ({
    fullName: ws?.repo ?? null,
    installationId: ws?.installationId ?? null,
  }),
  installationIdForRepo: async () => repoInstallation,
}));
const redis = {
  listDue: mock(async (..._a: any[]): Promise<string[]> => []),
  markDue: mock(async (..._a: any[]) => {}),
  clearDue: mock(async (..._a: any[]) => {}),
  reseedDue: mock(async (..._a: any[]) => {}),
};
mock.module('@/lib/redis', () => redis);

import { createLandingSweepDeps, sweepLandingPrs } from './pr-landing-sweep-deps';
import { PR_LANDING_DUE_QUEUE } from './pr-landing-sweep';

const REF = { workspaceId: 'ws-1', prNumber: 42 };

beforeEach(() => {
  workerRow = { id: 'worker-1', taskId: 'task-1', prUrl: 'https://github.com/buildd-ai/buildd/pull/42', prBaseRef: 'dev' };
  workspaceRow = { id: 'ws-1', repo: 'buildd-ai/buildd', installationId: 7, gitConfig: { landing: { mode: 'enforce' } }, releaseConfig: null, mergePolicy: null };
  taskRow = { id: 'task-1', requiresReview: false, missionId: null, mission: null };
  floorRows = [];
  floorLimit = null;
  reviewState = 'approved';
  repoInstallation = null;
  kernelView = null;
  kernelFloor = [];
  for (const m of [githubApi, landPr, readLandingMarker, readPrReviewStatus, kernelLandingView, ...Object.values(redis)]) m.mockClear();
});

describe('resolveTarget', () => {
  it('builds the landing target for an approved PR in an enforce workspace', async () => {
    const res = await createLandingSweepDeps().resolveTarget(REF);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.target).toMatchObject({
      workspaceId: 'ws-1',
      prNumber: 42,
      installationId: 7,
      repoFullName: 'buildd-ai/buildd',
      owner: { taskId: 'task-1', workerId: 'worker-1' },
      mission: null,
      // Carried so surface ordering does not re-read the workspace per PR.
      gitConfig: { landing: { mode: 'enforce' } },
    });
    expect(res.target.policyFor('dev').tier).not.toBe('human');
  });

  it('skips a PR with no open worker row', async () => {
    workerRow = undefined;
    expect(await createLandingSweepDeps().resolveTarget(REF)).toEqual({ ok: false, skip: 'no_open_worker' });
  });

  it.each(['shadow', 'off', undefined])('skips a workspace in %s mode: the sweep only acts where landing is enforced', async (mode) => {
    workspaceRow.gitConfig = mode ? { landing: { mode } } : {};
    expect(await createLandingSweepDeps().resolveTarget(REF)).toEqual({ ok: false, skip: 'not_enforce' });
  });

  it('skips a PR on the human tier', async () => {
    taskRow.requiresReview = true;
    expect(await createLandingSweepDeps().resolveTarget(REF)).toEqual({ ok: false, skip: 'human_tier' });
  });

  it.each(['not_requested', 'in_flight', 'review_failed'])('skips a PR whose review is %s', async (state) => {
    reviewState = state;
    expect(await createLandingSweepDeps().resolveTarget(REF)).toEqual({ ok: false, skip: 'not_approved' });
  });

  // A blocking verdict may be stale (an earlier head, a sibling PR that has
  // since merged) and landPr is where it is revalidated, so the backstop must
  // reach it even when the webhook that would have re-reviewed it was missed.
  it.each(['changes_requested', 'escalated'])('hands a PR whose review is %s to landPr for revalidation', async (state) => {
    reviewState = state;
    const res: any = await createLandingSweepDeps().resolveTarget(REF);
    expect(res.ok).toBe(true);
  });

  // Task 57e1d5b8: on a kernel-owned PR the delivery, not the legacy reviewer row, says
  // whether there is anything to land. A composition-approved delivery has no reviewer row.
  it('hands a kernel PR whose delivery is APPROVED to landPr, whatever the legacy row says', async () => {
    kernelView = { deliveryId: 'd1', current: { state: 'APPROVED', version: 3, head: 'h', round: 0 } };
    reviewState = 'not_requested';
    const res = await createLandingSweepDeps().resolveTarget(REF);
    expect(res.ok).toBe(true);
    expect(kernelLandingView).toHaveBeenCalledWith('ws-1', 'buildd-ai/buildd', 42);
    expect(readPrReviewStatus).not.toHaveBeenCalled();
  });

  it.each(['AWAITING_REVIEW', 'CHANGES_REQUESTED', 'ESCALATED', 'LANDING'])('skips a kernel PR whose delivery is %s, even with a legacy approve row', async (state) => {
    kernelView = { deliveryId: 'd1', current: { state, version: 3, head: 'h', round: 1 } };
    reviewState = 'approved';
    expect(await createLandingSweepDeps().resolveTarget(REF)).toEqual({ ok: false, skip: 'not_approved' });
  });

  it('skips a PR it cannot place in a repo', async () => {
    workerRow.prUrl = null;
    workspaceRow.repo = null;
    expect(await createLandingSweepDeps().resolveTarget(REF)).toEqual({ ok: false, skip: 'no_repo' });
  });

  it('skips a PR with no usable installation', async () => {
    workspaceRow.installationId = null;
    repoInstallation = null;
    expect(await createLandingSweepDeps().resolveTarget(REF)).toEqual({ ok: false, skip: 'no_installation' });
  });

  it("uses the PR's own repo installation when the PR lives outside the workspace repo", async () => {
    workerRow.prUrl = 'https://github.com/buildd-ai/sibling/pull/42';
    repoInstallation = 99;
    const res = await createLandingSweepDeps().resolveTarget(REF);
    expect(res.ok && res.target).toMatchObject({ repoFullName: 'buildd-ai/sibling', installationId: 99 });
  });

  it('hands the mission integration fields through to landPr', async () => {
    taskRow.mission = { mergePolicy: null, requiresReview: false, workingBranch: 'mission/x', integrationBranchEnabled: true };
    const res = await createLandingSweepDeps().resolveTarget(REF);
    expect(res.ok && res.target.mission).toMatchObject({ workingBranch: 'mission/x', integrationBranchEnabled: true });
  });
});

describe('peek', () => {
  const target: any = { installationId: 7, repoFullName: 'buildd-ai/buildd', prNumber: 42 };

  it.each([
    [{ state: 'open', merged: false, draft: false }, 'open', false],
    [{ state: 'open', merged: false, draft: true }, 'open', true],
    [{ state: 'closed', merged: true, draft: false }, 'merged', false],
    [{ state: 'closed', merged: false, draft: false }, 'closed', false],
  ])('maps %p', async (pr, state, draft) => {
    githubApi.mockImplementationOnce(async () => ({ ...pr, head: { sha: 'abc' }, base: { ref: 'dev' } }));
    expect(await createLandingSweepDeps().peek(target)).toEqual({ state, draft, headSha: 'abc', baseRef: 'dev' });
    expect(githubApi.mock.calls[0]).toEqual([7, '/repos/buildd-ai/buildd/pulls/42']);
  });

  it('throws when GitHub names no head', async () => {
    githubApi.mockImplementationOnce(async () => ({ state: 'open' }));
    await expect(createLandingSweepDeps().peek(target)).rejects.toThrow();
  });
});

describe('bindings', () => {
  it('lists floor candidates as workspace and PR refs, asking the database for exactly the limit', async () => {
    floorRows = [{ workspaceId: 'ws-1', prNumber: 5 }, { workspaceId: 'ws-2', prNumber: null }];
    expect(await createLandingSweepDeps().listFloor(11)).toEqual([{ workspaceId: 'ws-1', prNumber: 5 }]);
    expect(floorLimit).toBe(11);
  });

  it('adds APPROVED kernel deliveries to the floor, once each', async () => {
    floorRows = [{ workspaceId: 'ws-1', prNumber: 5 }];
    kernelFloor = [{ workspaceId: 'ws-1', prNumber: 5 }, { workspaceId: 'ws-1', prNumber: 9 }];
    expect(await createLandingSweepDeps().listFloor(11)).toEqual([{ workspaceId: 'ws-1', prNumber: 5 }, { workspaceId: 'ws-1', prNumber: 9 }]);
  });

  it('reads the marker off the owning task, and none when no task owns the PR', async () => {
    const deps = createLandingSweepDeps();
    await deps.readMarker({ owner: { taskId: 'task-1', workerId: null }, prNumber: 42 } as any);
    expect(readLandingMarker).toHaveBeenCalledWith('task-1', 42);
    expect(await deps.readMarker({ owner: { taskId: null, workerId: null }, prNumber: 42 } as any)).toBeNull();
  });

  it('lands through landPr with no fix dispatcher wired (one decision path)', async () => {
    const input: any = { prNumber: 42 };
    await createLandingSweepDeps().land(input);
    expect(landPr.mock.calls[0]).toEqual([input]);
  });

  it('keeps the due queue under the name the route gates on', async () => {
    const deps = createLandingSweepDeps();
    await deps.listDue(5, 3);
    await deps.markDue('m', 9);
    await deps.clearDue(['m']);
    await deps.reseedDue([]);
    expect(redis.listDue.mock.calls[0]).toEqual([PR_LANDING_DUE_QUEUE, 5, 3]);
    expect(redis.markDue.mock.calls[0]).toEqual([PR_LANDING_DUE_QUEUE, 'm', 9]);
    expect(redis.clearDue.mock.calls[0]).toEqual([PR_LANDING_DUE_QUEUE, ['m']]);
    expect(redis.reseedDue.mock.calls[0]).toEqual([PR_LANDING_DUE_QUEUE, []]);
  });
});

describe('sweepLandingPrs', () => {
  it('runs a due sweep over an empty queue without touching GitHub or landPr', async () => {
    const res = await sweepLandingPrs({ source: 'due' });
    expect(res).toMatchObject({ enumerated: 0, processed: 0, errors: 0 });
    expect(githubApi).not.toHaveBeenCalled();
    expect(landPr).not.toHaveBeenCalled();
  });
});
