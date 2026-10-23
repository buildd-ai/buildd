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

const activities: any[] = [];
mock.module('@/lib/pr-activity-comment', () => ({
  appendPrActivity: async (p: any) => { activities.push(p); return { action: 'updated' }; },
}));

const { amendCandidateOnFixMerge, RELEASE_CANDIDATE_AMEND_PR_KEY } = await import('./candidate-amend');
const { RELEASE_CANDIDATE_FIX_KEY } = await import('@/lib/release-candidate-ci');

const fixCtx = { prNumber: 90, headSha: 'cand-sha', version: '1.2.3', branch: 'release/v1.2.3', sourceBranch: 'dev' };

// The stub db below does not evaluate WHERE, so the compare-and-set predicate
// is asserted on the rendered SQL instead (PgDialect), not trusted to the stub.
import { PgDialect } from 'drizzle-orm/pg-core';
const dialect = new PgDialect();
const render = (q: unknown) => dialect.sqlToQuery(q as any);

function stubDb(opts: { taskContext?: Record<string, unknown> | null; claim?: boolean; worker?: boolean }) {
  const updates: any[] = [];
  const wheres: any[] = [];
  const db: any = {
    query: {
      workers: { findFirst: async () => (opts.worker === false ? undefined : { taskId: 't1' }) },
      tasks: { findFirst: async () => ({ id: 't1', workspaceId: 'ws1', context: opts.taskContext === undefined ? { [RELEASE_CANDIDATE_FIX_KEY]: fixCtx } : opts.taskContext }) },
    },
    update: () => ({
      set: (v: any) => ({
        where: (w: unknown) => {
          updates.push(v);
          wheres.push(w);
          return { returning: async () => (opts.claim === false ? [] : [{ id: 't1' }]) , then: (r: any) => r(undefined) };
        },
      }),
    }),
  };
  return { db, updates, wheres };
}

const input = { repoFullName: 'o/r', prNumber: 101, baseRef: 'dev', installationId: 7 };

function gh(candidate: { state: string; sha: string }, fixPr: { merged: boolean; base: string } = { merged: true, base: 'dev' }) {
  const calls: Array<{ installationId: number; path: string; opts?: any }> = [];
  const fn: any = async (installationId: number, path: string, opts?: any) => {
    calls.push({ installationId, path, opts });
    if (path.endsWith('/comments')) return {};
    if (path.endsWith(`/pulls/${input.prNumber}`)) return { merged: fixPr.merged, base: { ref: fixPr.base } };
    return { state: candidate.state, head: { sha: candidate.sha } };
  };
  return { fn, calls };
}

describe('amendCandidateOnFixMerge', () => {
  it('dispatches the amendment once with amend and amend_confirm, updates activity, and comments on the fix PR', async () => {
    activities.length = 0;
    const { db } = stubDb({});
    const g = gh({ state: 'open', sha: 'cand-sha' });
    const dispatch = mock(async (_p: any) => ({ ok: true as const, releaseId: 'r1', deduped: false, headSha: 'x', value: { runUrl: 'https://example.test/run/1' } }));
    const out = await amendCandidateOnFixMerge(input, { db, githubApi: g.fn, dispatch: dispatch as any });
    expect(out).toEqual({ kind: 'amended', version: '1.2.3', candidatePr: 90 });
    expect(dispatch).toHaveBeenCalledTimes(1);
    const p = (dispatch.mock.calls[0] as any)[0];
    expect(p.inputs.amend).toBe('1.2.3');
    expect(p.inputs.amend_confirm).toBe('1.2.3');
    expect(p.ref).toBe('dev');
    // Activity comment on candidate PR
    expect(activities).toHaveLength(1);
    expect(activities[0].prNumber).toBe(90);
    expect(activities[0].entry.kind).toBe('release_amended');
    expect(activities[0].entry.note).toContain('merged into `dev`');
    expect(activities[0].entry.note).toContain('Release candidate v1.2.3 was amended automatically');
    // Comment on fix PR (legacy)
    const comment = g.calls.find((c) => c.path === '/repos/o/r/issues/101/comments');
    expect(comment?.opts?.method).toBe('POST');
    expect(JSON.parse(comment!.opts!.body).body).toContain('amend: 1.2.3');
    expect(JSON.parse(comment!.opts!.body).body).toMatch(/^The fix for this candidate merged in #\d+\. /);
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

  it('claims the marker with a compare-and-set on this task and an unset marker, and hands it back by key', async () => {
    const { db, updates, wheres } = stubDb({});
    const dispatch = mock(async () => ({ ok: false as const, status: 500, error: 'boom' }));
    await amendCandidateOnFixMerge(input, { db, githubApi: gh({ state: 'open', sha: 'cand-sha' }).fn, dispatch: dispatch as any });
    expect(wheres.length).toBe(2);

    const claimWhere = render(wheres[0]);
    expect(claimWhere.sql).toBe('(("tasks"."id" = $1) and ("tasks"."context"->>$2 is null))');
    expect(claimWhere.params).toEqual(['t1', RELEASE_CANDIDATE_AMEND_PR_KEY]);
    const claimSet = render(updates[0].context);
    expect(claimSet.sql).toBe(`jsonb_set(coalesce("tasks"."context", '{}'::jsonb), $1::text[], to_jsonb($2::int))`);
    expect(claimSet.params).toEqual([`{${RELEASE_CANDIDATE_AMEND_PR_KEY}}`, input.prNumber]);

    const releaseWhere = render(wheres[1]);
    expect(releaseWhere.sql).toBe('"tasks"."id" = $1');
    expect(releaseWhere.params).toEqual(['t1']);
    const releaseSet = render(updates[1].context);
    expect(releaseSet.sql).toBe('"tasks"."context" - $1');
    expect(releaseSet.params).toEqual([RELEASE_CANDIDATE_AMEND_PR_KEY]);
  });

  it('a merge found by reconciliation (no delivery) reads the base from GitHub on the release target installation', async () => {
    const { db } = stubDb({});
    const g = gh({ state: 'open', sha: 'cand-sha' });
    const dispatch = mock(async (_p: any) => ({ ok: true as const, releaseId: 'r1', deduped: false, headSha: 'x' }));
    const out = await amendCandidateOnFixMerge({ repoFullName: 'o/r', prNumber: 101 }, { db, githubApi: g.fn, dispatch: dispatch as any });
    expect(out).toEqual({ kind: 'amended', version: '1.2.3', candidatePr: 90 });
    expect(g.calls[0]).toMatchObject({ installationId: 7, path: '/repos/o/r/pulls/101' });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('a reconciled merge into another base, or a PR GitHub says is not merged, is skipped with a reason', async () => {
    const dispatch = mock(async () => ({ ok: true as const }));
    expect(await amendCandidateOnFixMerge({ repoFullName: 'o/r', prNumber: 101 }, { db: stubDb({}).db, githubApi: gh({ state: 'open', sha: 'cand-sha' }, { merged: true, base: 'main' }).fn, dispatch: dispatch as any }))
      .toEqual({ kind: 'skipped', reason: 'wrong_base' });
    expect(await amendCandidateOnFixMerge({ repoFullName: 'o/r', prNumber: 101 }, { db: stubDb({}).db, githubApi: gh({ state: 'open', sha: 'cand-sha' }, { merged: false, base: 'dev' }).fn, dispatch: dispatch as any }))
      .toEqual({ kind: 'skipped', reason: 'not_merged' });
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
