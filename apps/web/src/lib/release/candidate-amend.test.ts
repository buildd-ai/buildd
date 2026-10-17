import { describe, it, expect, mock } from 'bun:test';

const target = {
  ok: true,
  target: {
    workspaceId: 'ws1', workspaceName: 'w', owner: 'o', name: 'r', repoFullName: 'o/r', installationId: 7,
    releaseConfig: { enabled: true, strategy: 'workflow_dispatch', workflowFile: 'release.yml', ref: 'dev', prodBranch: 'main' },
    defaultBranch: 'dev', gitConfig: null,
  },
};
mock.module('@/lib/release/target', () => ({ resolveReleaseTarget: async () => target }));
mock.module('@/lib/release/record', () => ({ recordAndDispatchRelease: async () => ({ ok: true }) }));

const { amendCandidateOnFixMerge, RELEASE_CANDIDATE_AMEND_PR_KEY } = await import('./candidate-amend');
const { RELEASE_CANDIDATE_FIX_KEY } = await import('@/lib/release-candidate-ci');

const fixCtx = { prNumber: 90, headSha: 'cand-sha', version: '1.2.3', branch: 'release/v1.2.3', sourceBranch: 'dev' };

function stubDb(opts: { taskContext?: Record<string, unknown> | null; claim?: boolean; worker?: boolean }) {
  const updates: any[] = [];
  const db: any = {
    query: {
      workers: { findFirst: async () => (opts.worker === false ? undefined : { taskId: 't1' }) },
      tasks: { findFirst: async () => ({ id: 't1', workspaceId: 'ws1', context: opts.taskContext === undefined ? { [RELEASE_CANDIDATE_FIX_KEY]: fixCtx } : opts.taskContext }) },
    },
    update: () => ({
      set: (v: any) => ({
        where: () => {
          updates.push(v);
          return { returning: async () => (opts.claim === false ? [] : [{ id: 't1' }]) , then: (r: any) => r(undefined) };
        },
      }),
    }),
  };
  return { db, updates };
}

const input = { repoFullName: 'o/r', prNumber: 101, baseRef: 'dev', installationId: 7 };

function gh(candidate: { state: string; sha: string }) {
  const calls: Array<{ path: string; opts?: any }> = [];
  const fn: any = async (_i: number, path: string, opts?: any) => {
    calls.push({ path, opts });
    return path.endsWith('/comments') ? {} : { state: candidate.state, head: { sha: candidate.sha } };
  };
  return { fn, calls };
}

describe('amendCandidateOnFixMerge', () => {
  it('dispatches the amendment once with amend and amend_confirm, and comments on the candidate', async () => {
    const { db } = stubDb({});
    const g = gh({ state: 'open', sha: 'cand-sha' });
    const dispatch = mock(async (_p: any) => ({ ok: true as const, releaseId: 'r1', deduped: false, headSha: 'x' }));
    const out = await amendCandidateOnFixMerge(input, { db, githubApi: g.fn, dispatch: dispatch as any });
    expect(out).toEqual({ kind: 'amended', version: '1.2.3', candidatePr: 90 });
    expect(dispatch).toHaveBeenCalledTimes(1);
    const p = (dispatch.mock.calls[0] as any)[0];
    expect(p.inputs.amend).toBe('1.2.3');
    expect(p.inputs.amend_confirm).toBe('1.2.3');
    expect(p.ref).toBe('dev');
    const comment = g.calls.find((c) => c.path === '/repos/o/r/issues/90/comments');
    expect(comment?.opts.method).toBe('POST');
    expect(JSON.parse(comment!.opts.body).body).toContain('amend: 1.2.3');
  });

  it('does nothing a second time for the same fix PR (marker already taken)', async () => {
    const { db } = stubDb({ claim: false });
    const dispatch = mock(async () => ({ ok: true as const }));
    const out = await amendCandidateOnFixMerge(input, { db, githubApi: gh({ state: 'open', sha: 'cand-sha' }).fn, dispatch: dispatch as any });
    expect(out).toEqual({ kind: 'skipped', reason: 'already_amended' });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('ignores a merged PR that is not a candidate fix, or merged into another base', async () => {
    const dispatch = mock(async () => ({ ok: true as const }));
    expect((await amendCandidateOnFixMerge(input, { db: stubDb({ worker: false }).db, githubApi: gh({ state: 'open', sha: 'a' }).fn, dispatch: dispatch as any })).kind).toBe('skipped');
    expect(await amendCandidateOnFixMerge(input, { db: stubDb({ taskContext: {} }).db, githubApi: gh({ state: 'open', sha: 'a' }).fn, dispatch: dispatch as any }))
      .toEqual({ kind: 'skipped', reason: 'not_a_candidate_fix' });
    expect(await amendCandidateOnFixMerge({ ...input, baseRef: 'main' }, { db: stubDb({}).db, githubApi: gh({ state: 'open', sha: 'a' }).fn, dispatch: dispatch as any }))
      .toEqual({ kind: 'skipped', reason: 'wrong_base' });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('leaves a candidate that is closed or already amended by someone else', async () => {
    const dispatch = mock(async () => ({ ok: true as const }));
    expect(await amendCandidateOnFixMerge(input, { db: stubDb({}).db, githubApi: gh({ state: 'closed', sha: 'cand-sha' }).fn, dispatch: dispatch as any }))
      .toEqual({ kind: 'skipped', reason: 'candidate_not_open' });
    expect(await amendCandidateOnFixMerge(input, { db: stubDb({}).db, githubApi: gh({ state: 'open', sha: 'newer' }).fn, dispatch: dispatch as any }))
      .toEqual({ kind: 'skipped', reason: 'candidate_moved' });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('hands the marker back when the dispatch fails so a redelivery can amend', async () => {
    const { db, updates } = stubDb({});
    const dispatch = mock(async () => ({ ok: false as const, status: 500, error: 'boom' }));
    const out = await amendCandidateOnFixMerge(input, { db, githubApi: gh({ state: 'open', sha: 'cand-sha' }).fn, dispatch: dispatch as any });
    expect(out).toEqual({ kind: 'dispatch_failed', error: 'boom' });
    expect(updates.length).toBe(2); // claim, then release
    expect(RELEASE_CANDIDATE_AMEND_PR_KEY).toBe('releaseCandidateAmendPr');
  });
});
