import { describe, it, expect, beforeEach, mock } from 'bun:test';

let workerRow: any = null;
let missionTask: any = null;
let missionSiblings: any[] = [];
const updates: Array<{ set: any }> = [];
const githubCalls: string[] = [];
let githubResponse: (path: string) => any = () => ({ merged: true, html_url: 'https://github.com/org/repo/pull/2' });
let installationForRepo: Record<string, number> = {};

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workers: { findFirst: mock(() => Promise.resolve(workerRow)) },
      tasks: {
        findFirst: mock(() => Promise.resolve(missionTask)),
        findMany: mock(() => Promise.resolve(missionSiblings)),
      },
    },
    update: () => ({ set: (set: any) => ({ where: () => { updates.push({ set }); return Promise.resolve(); } }) }),
  },
}));
mock.module('@/lib/github', () => ({
  githubApi: mock((_inst: number, path: string) => {
    githubCalls.push(path);
    return Promise.resolve(githubResponse(path));
  }),
}));
mock.module('@/lib/workspace-installation', () => ({
  installationIdForRepo: mock((repo: string) => Promise.resolve(installationForRepo[repo.toLowerCase()] ?? null)),
}));
/** The workflow kernel's answer for a kernel-owned PR; `{ handled: false }` = legacy PR. */
let kernelAnswer: any = { handled: false };
const kernelCalls: Array<{ fn: string; p: any }> = [];
mock.module('@/lib/workflow/seam', () => ({
  recordSupersession: mock((p: any) => { kernelCalls.push({ fn: 'recordSupersession', p }); return Promise.resolve(kernelAnswer); }),
  abandonDelivery: mock((p: any) => { kernelCalls.push({ fn: 'abandonDelivery', p }); return Promise.resolve(kernelAnswer); }),
}));

import { recordPrSupersession, recordPrAbandonment, dismissSupersessionSuggestion } from './pr-supersession';

function closedWorker(over: Record<string, unknown> = {}) {
  return {
    id: 'w-1',
    taskId: 't-1',
    prNumber: 6,
    prUrl: 'https://github.com/org/kb/pull/6',
    mergedAt: null,
    prLifecycleStatus: 'closed',
    supersededByPrNumber: null,
    workspace: { githubRepo: { fullName: 'org/kb', installation: { installationId: 11 } } },
    ...over,
  };
}

beforeEach(() => {
  workerRow = closedWorker();
  missionTask = { missionId: 'm-1' };
  missionSiblings = [];
  updates.length = 0;
  githubCalls.length = 0;
  installationForRepo = { 'org/buildd': 22, 'org/kb': 11 };
  kernelAnswer = { handled: false };
  kernelCalls.length = 0;
  githubResponse = (path: string) => ({ merged: true, html_url: `https://github.com${path.replace('/repos', '').replace('/pulls/', '/pull/')}` });
});

describe('recordPrSupersession — same repo (unchanged rule)', () => {
  it('records a merged target in the same repo', async () => {
    const r = await recordPrSupersession({ workerId: 'w-1', supersedingPrNumber: 9, reason: 'moved', recordedBy: 'me' });
    expect(r.ok).toBe(true);
    expect(githubCalls).toEqual(['/repos/org/kb/pulls/9']);
    expect(updates[0].set.supersededByPrNumber).toBe(9);
  });

  it('refuses an unmerged target', async () => {
    githubResponse = () => ({ merged: false, state: 'open' });
    const r = await recordPrSupersession({ workerId: 'w-1', supersedingPrNumber: 9, reason: 'x', recordedBy: 'me' });
    expect(r).toMatchObject({ ok: false, status: 409 });
    expect(updates).toHaveLength(0);
  });

  it('refuses the PR itself as its own target', async () => {
    const r = await recordPrSupersession({ workerId: 'w-1', supersedingPrNumber: 6, reason: 'x', recordedBy: 'me' });
    expect(r).toMatchObject({ ok: false, status: 400 });
  });
});

describe('recordPrSupersession — cross-repo target', () => {
  it('allows a merged target in a repo another task of the same mission works in', async () => {
    missionSiblings = [{ id: 't-2', workspace: { repo: null, githubRepo: { fullName: 'org/buildd' } }, workers: [] }];
    const r = await recordPrSupersession({
      workerId: 'w-1', supersedingPrNumber: 3366, supersedingRepo: 'org/buildd', reason: 'docs moved', recordedBy: 'me',
    });
    expect(r).toMatchObject({ ok: true, supersedingRepo: 'org/buildd', supersedingPrUrl: 'https://github.com/org/buildd/pull/3366' });
    expect(githubCalls).toEqual(['/repos/org/buildd/pulls/3366']);
    // Same number, different repo: not "the PR itself".
  });

  it('allows a repo a sibling task opened a PR in, even with no workspace bound to it', async () => {
    missionSiblings = [{ id: 't-2', workspace: null, workers: [{ prUrl: 'https://github.com/org/buildd/pull/6' }] }];
    const r = await recordPrSupersession({
      workerId: 'w-1', supersedingPrNumber: 6, supersedingRepo: 'org/buildd', reason: 'same number, other repo', recordedBy: 'me',
    });
    expect(r.ok).toBe(true);
  });

  it('refuses a repo outside the workspace and mission, without asking GitHub', async () => {
    missionSiblings = [{ id: 't-2', workspace: { githubRepo: { fullName: 'org/buildd' } }, workers: [] }];
    const r = await recordPrSupersession({
      workerId: 'w-1', supersedingPrNumber: 1, supersedingRepo: 'someone/else', reason: 'x', recordedBy: 'me',
    });
    expect(r).toMatchObject({ ok: false, status: 403 });
    expect(githubCalls).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });

  it('refuses a cross-repo target when the task has no mission', async () => {
    missionTask = { missionId: null };
    const r = await recordPrSupersession({
      workerId: 'w-1', supersedingPrNumber: 1, supersedingRepo: 'org/buildd', reason: 'x', recordedBy: 'me',
    });
    expect(r).toMatchObject({ ok: false, status: 403 });
  });

  it('still requires the cross-repo target to be merged', async () => {
    missionSiblings = [{ id: 't-2', workspace: { githubRepo: { fullName: 'org/buildd' } }, workers: [] }];
    githubResponse = () => ({ merged: false, state: 'closed' });
    const r = await recordPrSupersession({
      workerId: 'w-1', supersedingPrNumber: 3366, supersedingRepo: 'org/buildd', reason: 'x', recordedBy: 'me',
    });
    expect(r).toMatchObject({ ok: false, status: 409 });
  });

  it('targetRepoWithinWorkspace drops the mission’s other repos, without asking GitHub', async () => {
    missionSiblings = [{ id: 't-2', workspace: { repo: null, githubRepo: { fullName: 'org/buildd' } }, workers: [] }];
    const r = await recordPrSupersession({
      workerId: 'w-1', supersedingPrNumber: 3366, supersedingRepo: 'org/buildd', reason: 'x', recordedBy: 'me', targetRepoWithinWorkspace: true,
    });
    expect(r).toMatchObject({ ok: false, status: 403 });
    expect(githubCalls).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });

  it('targetRepoWithinWorkspace still allows the workspace’s own repo', async () => {
    const r = await recordPrSupersession({
      workerId: 'w-1', supersedingPrNumber: 9, supersedingRepo: 'org/kb', reason: 'x', recordedBy: 'me', targetRepoWithinWorkspace: true,
    });
    expect(r.ok).toBe(true);
  });
});

describe('recordPrAbandonment', () => {
  it('requires a reason', async () => {
    expect(await recordPrAbandonment({ workerId: 'w-1', reason: '  ', recordedBy: 'me', actor: 'human:u-1' })).toMatchObject({ ok: false, status: 400 });
    expect(updates).toHaveLength(0);
  });

  it('records abandonment on a closed PR', async () => {
    const r = await recordPrAbandonment({ workerId: 'w-1', reason: 'plan changed', recordedBy: 'me', actor: 'human:u-1' });
    expect(r.ok).toBe(true);
    expect(updates[0].set).toMatchObject({ abandonedReason: 'plan changed', abandonedRecordedBy: 'me' });
    expect(updates[0].set.abandonedAt).toBeInstanceOf(Date);
  });

  it('refuses an open PR', async () => {
    workerRow = closedWorker({ prLifecycleStatus: 'pr_open' });
    expect(await recordPrAbandonment({ workerId: 'w-1', reason: 'x', recordedBy: 'me', actor: 'human:u-1' })).toMatchObject({ ok: false, status: 409 });
  });

  it.each(['agent:acct-svc', 'agent:task-1', 'runner', 'svc key'])('refuses a non-person actor (%s) before reading or writing anything', async (actor) => {
    workerRow = closedWorker({ workspaceId: 'ws-1' });
    expect(await recordPrAbandonment({ workerId: 'w-1', reason: 'plan changed', recordedBy: 'svc key', actor })).toMatchObject({ ok: false, status: 403 });
    expect(updates).toHaveLength(0);
    expect(kernelCalls).toHaveLength(0);
  });

  it('refuses a PR already recorded as superseded', async () => {
    workerRow = closedWorker({ supersededByPrNumber: 9 });
    expect(await recordPrAbandonment({ workerId: 'w-1', reason: 'x', recordedBy: 'me', actor: 'human:u-1' })).toMatchObject({ ok: false, status: 409 });
  });
});

// Slice D (docs/specs/workflow-state-kernel.md T20/T21): for a kernel-owned PR the kernel decides
// and its projection writes the columns; this module only authorises and verifies the target.
describe('a kernel-owned PR: T20/T21 decide, the direct column write never runs', () => {
  const current = (state: string) => ({ state, version: 7, head: 'H1', round: 1 });

  it('supersession is recorded through T20 with the verified target and the caller as actor', async () => {
    workerRow = closedWorker({ workspaceId: 'ws-1' });
    kernelAnswer = { handled: true, deliveryId: 'd1', result: { result: 'applied', transitionId: 't', deliveryId: 'd1', version: 8, decision: {} } };
    const r = await recordPrSupersession({ workerId: 'w-1', supersedingPrNumber: 9, reason: ' moved ', recordedBy: 'agent:abc' });
    expect(r).toMatchObject({ ok: true, supersededPrNumber: 6, supersedingPrNumber: 9, supersedingPrUrl: 'https://github.com/org/kb/pull/9' });
    expect(kernelCalls).toEqual([{ fn: 'recordSupersession', p: {
      workspaceId: 'ws-1', repoFullName: 'org/kb', prNumber: 6, installationId: 11, actor: 'agent:abc', reason: 'moved',
      target: { repoFullName: 'org/kb', prNumber: 9, url: 'https://github.com/org/kb/pull/9' },
    } }]);
    expect(updates).toHaveLength(0);
  });

  it('a replay is the same answer (duplicate), not an error', async () => {
    workerRow = closedWorker({ workspaceId: 'ws-1' });
    kernelAnswer = { handled: true, deliveryId: 'd1', result: { result: 'duplicate', transitionId: 't', reason: 'edge_exists_same', current: current('SUPERSEDED') } };
    expect((await recordPrSupersession({ workerId: 'w-1', supersedingPrNumber: 9, reason: 'moved', recordedBy: 'me' })).ok).toBe(true);
  });

  it('the kernel refuses an open PR and an overwrite, and the refusal says which', async () => {
    workerRow = closedWorker({ workspaceId: 'ws-1', prLifecycleStatus: 'pr_open' });
    kernelAnswer = { handled: true, deliveryId: 'd1', result: { result: 'rejected', reason: 'not_closed_unmerged', current: current('AWAITING_REVIEW') } };
    const open = await recordPrSupersession({ workerId: 'w-1', supersedingPrNumber: 9, reason: 'x', recordedBy: 'me' });
    expect(open).toMatchObject({ ok: false, status: 409 });
    expect((open as { error: string }).error).toContain('awaiting review');
    kernelAnswer = { handled: true, deliveryId: 'd1', result: { result: 'rejected', reason: 'edge_exists', current: current('SUPERSEDED') } };
    const over = await recordPrSupersession({ workerId: 'w-1', supersedingPrNumber: 10, reason: 'x', recordedBy: 'me' });
    expect(over).toMatchObject({ ok: false, status: 409 });
    expect((over as { error: string }).error).toContain('never overwritten');
    expect(updates).toHaveLength(0);
  });

  it('the kernel never sees a target that is not merged: that is refused before T20', async () => {
    workerRow = closedWorker({ workspaceId: 'ws-1' });
    githubResponse = () => ({ merged: false, state: 'open' });
    kernelAnswer = { handled: true, deliveryId: 'd1', result: { result: 'applied' } };
    expect(await recordPrSupersession({ workerId: 'w-1', supersedingPrNumber: 9, reason: 'x', recordedBy: 'me' })).toMatchObject({ ok: false, status: 409 });
    expect(kernelCalls).toHaveLength(0);
  });

  it('abandonment goes through T21 as a person, and the kernel (not a stale column) decides it is closed', async () => {
    workerRow = closedWorker({ workspaceId: 'ws-1', prLifecycleStatus: 'pr_open' }); // the close webhook was lost
    kernelAnswer = { handled: true, deliveryId: 'd1', result: { result: 'applied', transitionId: 't', deliveryId: 'd1', version: 9, decision: {} } };
    expect(await recordPrAbandonment({ workerId: 'w-1', reason: 'plan changed', recordedBy: 'me@example.com', actor: 'human:u-1' })).toEqual({ ok: true });
    expect(kernelCalls).toEqual([{ fn: 'abandonDelivery', p: {
      workspaceId: 'ws-1', repoFullName: 'org/kb', prNumber: 6, installationId: 11, actor: 'human:u-1', reason: 'plan changed',
    } }]);
    expect(updates).toHaveLength(0);
  });

  it('a legacy PR (no kernel delivery) keeps the direct write', async () => {
    workerRow = closedWorker({ workspaceId: 'ws-1' });
    expect((await recordPrSupersession({ workerId: 'w-1', supersedingPrNumber: 9, reason: 'moved', recordedBy: 'me' })).ok).toBe(true);
    expect(kernelCalls.map((c) => c.fn)).toEqual(['recordSupersession']);
    expect(updates[0].set.supersededByPrNumber).toBe(9);
  });
});

describe('dismissSupersessionSuggestion', () => {
  it('clears the matching suggestion and remembers the candidate', async () => {
    const url = 'https://github.com/org/kb/pull/9';
    workerRow = closedWorker({
      supersessionScan: { scannedAt: '2026-10-01T00:00:00Z', candidatesChecked: 1, suggestion: { prUrl: url, prNumber: 9 } },
    });
    expect((await dismissSupersessionSuggestion({ workerId: 'w-1', candidatePrUrl: url })).ok).toBe(true);
    expect(updates[0].set.supersessionScan).toMatchObject({ suggestion: null, dismissed: [url] });
  });
});
