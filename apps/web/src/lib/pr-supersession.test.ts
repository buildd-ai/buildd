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
  installationForRepo = { 'org/buildd': 22 };
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
    expect(await recordPrAbandonment({ workerId: 'w-1', reason: '  ', recordedBy: 'me' })).toMatchObject({ ok: false, status: 400 });
    expect(updates).toHaveLength(0);
  });

  it('records abandonment on a closed PR', async () => {
    const r = await recordPrAbandonment({ workerId: 'w-1', reason: 'plan changed', recordedBy: 'me' });
    expect(r.ok).toBe(true);
    expect(updates[0].set).toMatchObject({ abandonedReason: 'plan changed', abandonedRecordedBy: 'me' });
    expect(updates[0].set.abandonedAt).toBeInstanceOf(Date);
  });

  it('refuses an open PR', async () => {
    workerRow = closedWorker({ prLifecycleStatus: 'pr_open' });
    expect(await recordPrAbandonment({ workerId: 'w-1', reason: 'x', recordedBy: 'me' })).toMatchObject({ ok: false, status: 409 });
  });

  it('refuses a PR already recorded as superseded', async () => {
    workerRow = closedWorker({ supersededByPrNumber: 9 });
    expect(await recordPrAbandonment({ workerId: 'w-1', reason: 'x', recordedBy: 'me' })).toMatchObject({ ok: false, status: 409 });
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
