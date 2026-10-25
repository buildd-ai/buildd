import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// buildd's own contract, as its workspace declares it explicitly (no default).
const BUILDD_AMEND = { mode: 'inputs', versionInput: 'amend', confirmInput: 'amend_confirm' } as const;
const baseReleaseConfig = () => ({
  enabled: true, strategy: 'workflow_dispatch', workflowFile: 'release.yml', ref: 'dev', prodBranch: 'main',
  candidate: { branches: ['release/v*'], sourceBranch: 'dev', authors: ['github-actions[bot]'], amend: BUILDD_AMEND as any },
});
const target = {
  ok: true,
  target: {
    workspaceId: 'ws1', workspaceName: 'w', owner: 'o', name: 'r', repoFullName: 'o/r', installationId: 7,
    releaseConfig: baseReleaseConfig() as any,
    defaultBranch: 'dev', gitConfig: null,
  },
};
beforeEach(() => { target.target.releaseConfig = baseReleaseConfig(); });
mock.module('@/lib/release/target', () => ({ resolveReleaseTarget: async () => target }));
mock.module('@/lib/release/record', () => ({ recordAndDispatchRelease: async () => ({ ok: true }) }));

const activities: any[] = [];
mock.module('@/lib/pr-activity-comment', () => ({
  appendPrActivity: async (p: any) => { activities.push(p); return { action: 'updated' }; },
}));

const { amendCandidateOnFixMerge, amendCandidateOnFixCompletion, RELEASE_CANDIDATE_AMEND_PR_KEY } = await import('./candidate-amend');
const { RELEASE_CANDIDATE_FIX_KEY } = await import('@/lib/release-candidate-ci');
const { parseWorkflowDispatchInputs } = await import('@/lib/workflow-dispatch-inputs');

// The workflow file at `ref`, as GitHub would serve it: buildd's real release.yml by default.
const RELEASE_YML = readFileSync(join(import.meta.dir, '../../../../../.github/workflows/release.yml'), 'utf8');
const readsWorkflow = (yaml: string = RELEASE_YML) => mock(async (_p: any) => ({ ok: true as const, inputs: parseWorkflowDispatchInputs(yaml), path: '.github/workflows/release.yml' }));
const noNotify = async () => {};

const fixCtx = { prNumber: 90, headSha: 'cand-sha', version: '1.2.3', branch: 'release/v1.2.3', sourceBranch: 'dev' };

// The stub db below does not evaluate WHERE, so the compare-and-set predicate
// is asserted on the rendered SQL instead (PgDialect), not trusted to the stub.
import { PgDialect } from 'drizzle-orm/pg-core';
const dialect = new PgDialect();
const render = (q: unknown) => dialect.sqlToQuery(q as any);

function stubDb(opts: { taskContext?: Record<string, unknown> | null; taskResult?: Record<string, unknown> | null; claim?: boolean; worker?: boolean }) {
  const updates: any[] = [];
  const wheres: any[] = [];
  const notes: any[] = [];
  const db: any = {
    insert: () => ({ values: (v: any) => { notes.push(v); return Promise.resolve(); } }),
    query: {
      workers: { findFirst: async () => (opts.worker === false ? undefined : { taskId: 't1' }) },
      tasks: { findFirst: async () => ({ id: 't1', workspaceId: 'ws1', missionId: null, context: opts.taskContext === undefined ? { [RELEASE_CANDIDATE_FIX_KEY]: fixCtx } : opts.taskContext, result: opts.taskResult ?? null }) },
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
  return { db, updates, wheres, notes };
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
    const dispatch = mock(async (_p: any) => ({ ok: true as const, releaseId: 'r1', deduped: false, headSha: 'x', runUrl: 'https://example.test/run/1' }));
    const out = await amendCandidateOnFixMerge(input, { db, githubApi: g.fn, dispatch: dispatch as any, readInputs: readsWorkflow() as any, notify: noNotify });
    expect(out).toEqual({ kind: 'amended', version: '1.2.3', candidatePr: 90 });
    expect(dispatch).toHaveBeenCalledTimes(1);
    const p = (dispatch.mock.calls[0] as any)[0];
    expect(p.inputs.amend).toBe('1.2.3');
    expect(p.inputs.amend_confirm).toBe('1.2.3');
    expect(p.ref).toBe('dev');
    // Activity comment on candidate PR — updated ci_fixing and appended two new entries
    expect(activities).toHaveLength(3);
    // First entry: update ci_fixing with fix PR link
    expect(activities[0].prNumber).toBe(90);
    expect(activities[0].entry.kind).toBe('ci_fixing');
    expect(activities[0].entry.detail).toContain('fix via #101');
    expect(activities[0].entry.url).toBe('https://github.com/o/r/pull/101');
    // Second entry: fix PR opened
    expect(activities[1].prNumber).toBe(90);
    expect(activities[1].entry.kind).toBe('fix_pr_opened');
    expect(activities[1].entry.note).toContain('Fix opened in #101');
    expect(activities[1].entry.url).toBe('https://github.com/o/r/pull/101');
    // Third entry: amendment dispatched
    expect(activities[2].prNumber).toBe(90);
    expect(activities[2].entry.kind).toBe('release_amended');
    expect(activities[2].entry.note).toContain('merged into `dev`');
    expect(activities[2].entry.note).toContain('Release candidate v1.2.3 was amended automatically');
    expect(activities[2].entry.url).toBe('https://example.test/run/1');
    // Comment on fix PR (legacy)
    const comment = g.calls.find((c) => c.path === '/repos/o/r/issues/101/comments');
    expect(comment?.opts?.method).toBe('POST');
    expect(JSON.parse(comment!.opts!.body).body).toContain('amend: 1.2.3');
    expect(JSON.parse(comment!.opts!.body).body).toMatch(/^The fix for this candidate merged in #\d+\. /);
  });

  it('does nothing a second time for the same fix PR (marker already taken)', async () => {
    const { db } = stubDb({ claim: false });
    const dispatch = mock(async () => ({ ok: true as const }));
    const out = await amendCandidateOnFixMerge(input, { db, githubApi: gh({ state: 'open', sha: 'cand-sha' }).fn, dispatch: dispatch as any, readInputs: readsWorkflow() as any, notify: noNotify });
    expect(out).toEqual({ kind: 'skipped', reason: 'already_amended' });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('ignores a merged PR that is not a candidate fix, or merged into another base', async () => {
    const dispatch = mock(async () => ({ ok: true as const }));
    expect((await amendCandidateOnFixMerge(input, { db: stubDb({ worker: false }).db, githubApi: gh({ state: 'open', sha: 'a' }).fn, dispatch: dispatch as any, readInputs: readsWorkflow() as any, notify: noNotify })).kind).toBe('skipped');
    expect(await amendCandidateOnFixMerge(input, { db: stubDb({ taskContext: {} }).db, githubApi: gh({ state: 'open', sha: 'a' }).fn, dispatch: dispatch as any, readInputs: readsWorkflow() as any, notify: noNotify }))
      .toEqual({ kind: 'skipped', reason: 'not_a_candidate_fix' });
    expect(await amendCandidateOnFixMerge({ ...input, baseRef: 'main' }, { db: stubDb({}).db, githubApi: gh({ state: 'open', sha: 'a' }).fn, dispatch: dispatch as any, readInputs: readsWorkflow() as any, notify: noNotify }))
      .toEqual({ kind: 'skipped', reason: 'wrong_base' });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('leaves a candidate that is closed or already amended by someone else', async () => {
    const dispatch = mock(async () => ({ ok: true as const }));
    expect(await amendCandidateOnFixMerge(input, { db: stubDb({}).db, githubApi: gh({ state: 'closed', sha: 'cand-sha' }).fn, dispatch: dispatch as any, readInputs: readsWorkflow() as any, notify: noNotify }))
      .toEqual({ kind: 'skipped', reason: 'candidate_not_open' });
    expect(await amendCandidateOnFixMerge(input, { db: stubDb({}).db, githubApi: gh({ state: 'open', sha: 'newer' }).fn, dispatch: dispatch as any, readInputs: readsWorkflow() as any, notify: noNotify }))
      .toEqual({ kind: 'skipped', reason: 'candidate_moved' });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('claims the marker with a compare-and-set on this task and an unset marker, and hands it back by key', async () => {
    const { db, updates, wheres } = stubDb({});
    const dispatch = mock(async () => ({ ok: false as const, status: 500, error: 'boom' }));
    await amendCandidateOnFixMerge(input, { db, githubApi: gh({ state: 'open', sha: 'cand-sha' }).fn, dispatch: dispatch as any, readInputs: readsWorkflow() as any, notify: noNotify });
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
    const out = await amendCandidateOnFixMerge({ repoFullName: 'o/r', prNumber: 101 }, { db, githubApi: g.fn, dispatch: dispatch as any, readInputs: readsWorkflow() as any, notify: noNotify });
    expect(out).toEqual({ kind: 'amended', version: '1.2.3', candidatePr: 90 });
    expect(g.calls[0]).toMatchObject({ installationId: 7, path: '/repos/o/r/pulls/101' });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('a reconciled merge into another base, or a PR GitHub says is not merged, is skipped with a reason', async () => {
    const dispatch = mock(async () => ({ ok: true as const }));
    expect(await amendCandidateOnFixMerge({ repoFullName: 'o/r', prNumber: 101 }, { db: stubDb({}).db, githubApi: gh({ state: 'open', sha: 'cand-sha' }, { merged: true, base: 'main' }).fn, dispatch: dispatch as any, readInputs: readsWorkflow() as any, notify: noNotify }))
      .toEqual({ kind: 'skipped', reason: 'wrong_base' });
    expect(await amendCandidateOnFixMerge({ repoFullName: 'o/r', prNumber: 101 }, { db: stubDb({}).db, githubApi: gh({ state: 'open', sha: 'cand-sha' }, { merged: false, base: 'dev' }).fn, dispatch: dispatch as any, readInputs: readsWorkflow() as any, notify: noNotify }))
      .toEqual({ kind: 'skipped', reason: 'not_merged' });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('hands the marker back when the dispatch fails so a redelivery can amend', async () => {
    const { db, updates } = stubDb({});
    const dispatch = mock(async () => ({ ok: false as const, status: 500, error: 'boom' }));
    const out = await amendCandidateOnFixMerge(input, { db, githubApi: gh({ state: 'open', sha: 'cand-sha' }).fn, dispatch: dispatch as any, readInputs: readsWorkflow() as any, notify: noNotify });
    expect(out).toEqual({ kind: 'dispatch_failed', error: 'boom' });
    expect(updates.length).toBe(2); // claim, then release
    expect(RELEASE_CANDIDATE_AMEND_PR_KEY).toBe('releaseCandidateAmendPr');
  });

  describe('the declared amend contract', () => {
    const ok = () => mock(async (_p: any) => ({ ok: true as const, releaseId: 'r1', deduped: false, headSha: 'x' }));

    it("(c) buildd's own workspace, with its explicit mapping, amends exactly as before", async () => {
      const { db } = stubDb({});
      const dispatch = ok();
      const readInputs = readsWorkflow();
      const out = await amendCandidateOnFixMerge(input, { db, githubApi: gh({ state: 'open', sha: 'cand-sha' }).fn, dispatch: dispatch as any, readInputs: readInputs as any, notify: noNotify });
      expect(out).toEqual({ kind: 'amended', version: '1.2.3', candidatePr: 90 });
      expect((readInputs.mock.calls[0] as any)[0]).toMatchObject({ workflowFile: 'release.yml', ref: 'dev', repoFullName: 'o/r', installationId: 7 });
      const p = (dispatch.mock.calls[0] as any)[0];
      expect(p.inputs).toEqual({ amend: '1.2.3', amend_confirm: '1.2.3' });
      expect(p.amendment).toBe(true);
    });

    it('(a) no contract: dispatches nothing, and tells the candidate, the fix task and the team a re-cut is needed', async () => {
      delete target.target.releaseConfig.candidate.amend;
      const { db, notes, updates } = stubDb({});
      const g = gh({ state: 'open', sha: 'cand-sha' });
      const dispatch = ok();
      const notify = mock(async (..._a: any[]) => {});
      const out = await amendCandidateOnFixMerge(input, { db, githubApi: g.fn, dispatch: dispatch as any, readInputs: readsWorkflow() as any, notify: notify as any });
      expect(out).toMatchObject({ kind: 'needs_recut', reason: 'no_contract', candidatePr: 90 });
      expect(dispatch).not.toHaveBeenCalled();

      const comment = JSON.parse(g.calls.find((c) => c.path === '/repos/o/r/issues/90/comments')!.opts.body).body;
      expect(comment).toContain('The fix for this candidate merged in #101');
      expect(comment).toContain('re-cut or amend');
      expect(comment).toContain('Checked: the workspace release settings declare no amend contract');
      expect(notes).toHaveLength(1);
      expect(notes[0]).toMatchObject({ taskId: 't1', authorType: 'system', type: 'warning', status: 'open' });
      expect(notes[0].title).toContain('v1.2.3 needs a re-cut');
      expect(notify).toHaveBeenCalledTimes(1);
      expect((notify.mock.calls[0] as any)[1]).toBe('needsAttention');
      // The marker stays claimed: a redelivery does not post the notice twice.
      expect(updates).toHaveLength(1);
    });

    it('(a) a strategy other than workflow_dispatch has no workflow to dispatch: re-cut notice', async () => {
      target.target.releaseConfig = { ...baseReleaseConfig(), strategy: 'branch_merge' } as any;
      const dispatch = ok();
      const out = await amendCandidateOnFixMerge(input, { db: stubDb({}).db, githubApi: gh({ state: 'open', sha: 'cand-sha' }).fn, dispatch: dispatch as any, readInputs: readsWorkflow() as any, notify: noNotify });
      expect(out).toMatchObject({ kind: 'needs_recut', reason: 'no_contract' });
      expect(dispatch).not.toHaveBeenCalled();
    });

    it('(b) a contract the workflow at ref no longer declares: not dispatched, the notice names what is missing', async () => {
      const yaml = 'on:\n  workflow_dispatch:\n    inputs:\n      force: {}\n      amend: {}\n';
      const { db, notes } = stubDb({});
      const g = gh({ state: 'open', sha: 'cand-sha' });
      const dispatch = ok();
      const out = await amendCandidateOnFixMerge(input, { db, githubApi: g.fn, dispatch: dispatch as any, readInputs: readsWorkflow(yaml) as any, notify: noNotify });
      expect(out).toMatchObject({ kind: 'needs_recut', reason: 'contract_not_in_workflow' });
      expect((out as any).checked).toContain('does not declare workflow_dispatch input `amend_confirm`');
      expect((out as any).checked).toContain('`release.yml` at `dev`');
      expect(dispatch).not.toHaveBeenCalled();
      expect(notes).toHaveLength(1);
      expect(JSON.parse(g.calls.find((c) => c.path.endsWith('/comments'))!.opts.body).body).toContain('amend_confirm');
    });

    it('(b) a workflow file that cannot be read is not dispatched either', async () => {
      const readInputs = mock(async () => ({ ok: false as const, error: '.github/workflows/release.yml was not found at dev', path: '.github/workflows/release.yml' }));
      const dispatch = ok();
      const out = await amendCandidateOnFixMerge(input, { db: stubDb({}).db, githubApi: gh({ state: 'open', sha: 'cand-sha' }).fn, dispatch: dispatch as any, readInputs: readInputs as any, notify: noNotify });
      expect(out).toMatchObject({ kind: 'needs_recut', reason: 'workflow_unreadable', checked: '.github/workflows/release.yml was not found at dev' });
      expect(dispatch).not.toHaveBeenCalled();
    });

    it("another team's input names are used as declared, and nothing buildd-specific is added", async () => {
      target.target.releaseConfig.candidate.amend = { mode: 'inputs', versionInput: 'recut_version' };
      target.target.releaseConfig.inputs = { channel: 'stable' };
      const dispatch = ok();
      const yaml = 'on:\n  workflow_dispatch:\n    inputs:\n      channel: {}\n      recut_version: {}\n';
      const g = gh({ state: 'open', sha: 'cand-sha' });
      const out = await amendCandidateOnFixMerge(input, { db: stubDb({}).db, githubApi: g.fn, dispatch: dispatch as any, readInputs: readsWorkflow(yaml) as any, notify: noNotify });
      expect(out.kind).toBe('amended');
      const p = (dispatch.mock.calls[0] as any)[0];
      expect(p.inputs).toEqual({ channel: 'stable', recut_version: '1.2.3' });
      expect(p.amendment).toBe(true);
      expect(JSON.parse(g.calls.find((c) => c.path.endsWith('/comments'))!.opts.body).body).toContain('recut_version: 1.2.3');
    });

    it('redispatch: the workflow is dispatched with its ordinary inputs for the pipeline to re-cut', async () => {
      target.target.releaseConfig.candidate.amend = { mode: 'redispatch' };
      const dispatch = ok();
      const yaml = 'on: workflow_dispatch\n';
      const out = await amendCandidateOnFixMerge(input, { db: stubDb({}).db, githubApi: gh({ state: 'open', sha: 'cand-sha' }).fn, dispatch: dispatch as any, readInputs: readsWorkflow(yaml) as any, notify: noNotify });
      expect(out.kind).toBe('amended');
      const p = (dispatch.mock.calls[0] as any)[0];
      expect(p.inputs).toEqual({});
      expect(p.amendment).toBe(true);
    });

    it('redispatch of a workflow with no workflow_dispatch trigger is refused', async () => {
      target.target.releaseConfig.candidate.amend = { mode: 'redispatch' };
      const dispatch = ok();
      const out = await amendCandidateOnFixMerge(input, { db: stubDb({}).db, githubApi: gh({ state: 'open', sha: 'cand-sha' }).fn, dispatch: dispatch as any, readInputs: readsWorkflow('on: push\n') as any, notify: noNotify });
      expect(out).toMatchObject({ kind: 'needs_recut', reason: 'contract_not_in_workflow' });
      expect(dispatch).not.toHaveBeenCalled();
    });
  });
});

// v0.381.0: the candidate was red because dev forked; the fix was an `autofix:`
// commit pushed straight to dev and its PR was closed. No fix PR ever merged, so
// nothing amended the candidate until an operator did, two hours later.
describe('amendCandidateOnFixCompletion: a fix task that names where the fix already is', () => {
  const FIX = 'b9c6a996b0000000000000000000000000000000';
  /** GitHub for the commit route: FIX is on dev, and the red candidate head does not hold it. */
  function ghCommit(candidate: { state: string; sha: string }, opts: { onDev?: boolean } = {}) {
    const calls: Array<{ installationId: number; path: string; opts?: any }> = [];
    const fn: any = async (installationId: number, path: string, o?: any) => {
      calls.push({ installationId, path, opts: o });
      if (path.endsWith('/comments')) return {};
      if (path.endsWith(`/commits/${FIX}`)) return { sha: FIX };
      const m = /\/compare\/([^.]+)\.\.\.(.+)$/.exec(path);
      if (m) return { status: m[2] === 'dev' && opts.onDev !== false ? 'ahead' : 'diverged' };
      if (path.endsWith('/pulls/77')) return { merged: true, base: { ref: 'dev' } };
      return { state: candidate.state, head: { sha: candidate.sha } };
    };
    return { fn, calls };
  }
  const ok = () => mock(async (_p: any) => ({ ok: true as const, releaseId: 'r1', deduped: false, headSha: 'x' }));

  it('a completion naming a dev commit already holding the fix amends the candidate, and says which commit', async () => {
    const { db, updates } = stubDb({ taskResult: { candidateFixLanded: { commitSha: FIX, sourceBranch: 'dev', candidatePr: 90 } } });
    const g = ghCommit({ state: 'open', sha: 'cand-sha' });
    const dispatch = ok();
    const out = await amendCandidateOnFixCompletion({ taskId: 't1' }, { db, githubApi: g.fn, dispatch: dispatch as any, readInputs: readsWorkflow() as any, notify: noNotify });
    expect(out).toEqual({ kind: 'amended', version: '1.2.3', candidatePr: 90 });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect((dispatch.mock.calls[0] as any)[0].inputs).toEqual({ amend: '1.2.3', amend_confirm: '1.2.3' });
    // The marker is the commit, so a replay of the same completion is a no-op.
    expect(render(updates[0].context).sql).toContain('to_jsonb($2::text)');
    expect(render(updates[0].context).params[1]).toBe(FIX);
    const comment = JSON.parse(g.calls.find((c) => c.path === '/repos/o/r/issues/90/comments')!.opts.body).body;
    expect(comment).toContain('The fix for this candidate landed on `dev` in `b9c6a996b000`');
  });

  it('re-checks the commit: one that is no longer on the source branch amends nothing', async () => {
    const { db, updates } = stubDb({ taskResult: { candidateFixLanded: { commitSha: FIX, sourceBranch: 'dev', candidatePr: 90 } } });
    const dispatch = ok();
    const out = await amendCandidateOnFixCompletion({ taskId: 't1' }, { db, githubApi: ghCommit({ state: 'open', sha: 'cand-sha' }, { onDev: false }).fn, dispatch: dispatch as any, readInputs: readsWorkflow() as any, notify: noNotify });
    expect(out).toEqual({ kind: 'skipped', reason: 'commit_not_on_source' });
    expect(dispatch).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it('a completion accepted on a merged PR another task owns (alreadyShippedIn) amends too', async () => {
    const { db } = stubDb({ taskResult: { alreadyShippedIn: { prNumber: 77, prUrl: 'https://github.com/o/r/pull/77' } } });
    const g = ghCommit({ state: 'open', sha: 'cand-sha' });
    const dispatch = ok();
    const out = await amendCandidateOnFixCompletion({ taskId: 't1' }, { db, githubApi: g.fn, dispatch: dispatch as any, readInputs: readsWorkflow() as any, notify: noNotify });
    expect(out).toEqual({ kind: 'amended', version: '1.2.3', candidatePr: 90 });
    expect(JSON.parse(g.calls.find((c) => c.path.endsWith('/comments'))!.opts.body).body).toContain('merged in #77');
  });

  it('an ordinary task, or a fix task that named nothing, is left alone', async () => {
    const dispatch = ok();
    expect(await amendCandidateOnFixCompletion({ taskId: 't1' }, { db: stubDb({ taskContext: {}, taskResult: { alreadyShippedIn: { prNumber: 77 } } }).db, githubApi: ghCommit({ state: 'open', sha: 'cand-sha' }).fn, dispatch: dispatch as any, readInputs: readsWorkflow() as any, notify: noNotify }))
      .toEqual({ kind: 'skipped', reason: 'not_a_candidate_fix' });
    expect(await amendCandidateOnFixCompletion({ taskId: 't1' }, { db: stubDb({ taskResult: { summary: 'done' } }).db, githubApi: ghCommit({ state: 'open', sha: 'cand-sha' }).fn, dispatch: dispatch as any, readInputs: readsWorkflow() as any, notify: noNotify }))
      .toEqual({ kind: 'skipped', reason: 'no_fix_named' });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('a candidate someone already amended is not amended again', async () => {
    const { db } = stubDb({ taskResult: { candidateFixLanded: { commitSha: FIX, sourceBranch: 'dev', candidatePr: 90 } } });
    const dispatch = ok();
    const out = await amendCandidateOnFixCompletion({ taskId: 't1' }, { db, githubApi: ghCommit({ state: 'open', sha: 'amended-sha' }).fn, dispatch: dispatch as any, readInputs: readsWorkflow() as any, notify: noNotify });
    expect(out).toEqual({ kind: 'skipped', reason: 'candidate_moved' });
    expect(dispatch).not.toHaveBeenCalled();
  });
});
