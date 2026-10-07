/**
 * The fix-loop effect handlers (review-effects.ts, docs/specs/workflow-state-kernel.md
 * §10.2): idempotent, they re-read the delivery and act only on what is still
 * owed. The kernel and the legacy helpers they call are stubbed; the CAS and
 * the whole loop run on real Postgres in apps/web/tests/db/workflow-seam.test.ts.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { KernelView } from './types';

let view: KernelView;
const applied: any[] = [];
const ingested: any[] = [];
const executed: string[] = [];
const inserted: any[] = [];
const notes: any[] = [];
let existingTask: { id: string } | null = null;
let ownerRow: any = { id: 'owner-1', title: 'Fix the thing', description: 'd', missionId: 'm1', pathManifest: ['a.ts'], backend: 'claude', context: {} };
let reviewerResult: any = { structuredOutput: { verdict: 'request-changes', confidence: 0.9, summary: 's', feedback: 'check the caller task' } };
let livePr: any = { state: 'open', merged: false, headSha: 'H1', headRepoFullName: 'acme/w', baseRef: 'dev' };
let roles: any[] = [{ slug: 'reviewer' }];
let created: any = { id: 'reviewer-2' };
let postResult: any = { posted: true };

mock.module('./kernel', () => ({
  loadView: async () => view,
  applyCommand: async (cmd: any) => {
    applied.push(cmd);
    if (cmd.type === 'FixDispatched') {
      view = { ...view, attempts: [...view.attempts, { id: 'a-new', family: 'review_fix', attemptNo: 1, mode: 'agent', boundHeadSha: 'H1', triggerReason: cmd.roundId, taskId: cmd.taskId, status: 'queued', outcome: null, maxAttempts: cmd.maxAttempts, reportedShas: [] }] };
      return { result: 'applied' };
    }
    return { result: 'applied' };
  },
}));
mock.module('./facts', () => ({ ingestFact: async (f: any) => { ingested.push(f); return { result: 'applied' }; } }));
mock.module('./github-facts', () => ({
  githubReader: () => ({ readPr: async () => livePr, contains: async () => true }),
  workspaceRepo: async () => ({ installationId: 1, repoFullName: 'acme/w', gitConfig: null }),
}));
const chain = (rows: any[] = []) => ({ where: () => ({ returning: async () => rows }) });
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      tasks: {
        findFirst: async (o: any) => {
          const cols = Object.keys(o?.columns ?? {});
          if (cols.length === 1 && cols[0] === 'result') return { result: reviewerResult };
          if (cols.length === 1 && cols[0] === 'id') return existingTask;
          if (cols.length === 1 && cols[0] === 'missionId') return { missionId: ownerRow.missionId };
          return ownerRow;
        },
      },
      workers: { findFirst: async () => ({ id: 'w1', branch: 'feat/x', prUrl: 'https://github.com/acme/w/pull/7', prBaseRef: 'dev', lastCommitSha: 'H1' }) },
      workspaces: { findFirst: async () => ({ id: 'ws1', teamId: 'team1', gitConfig: null, releaseConfig: workspaceReleaseConfig }) },
      missions: { findFirst: async () => null },
    },
    insert: (table: any) => ({
      values: (v: any) => {
        if (table === 'missionNotes') { notes.push(v); return Promise.resolve(); }
        inserted.push(v);
        return { onConflictDoNothing: () => ({ returning: async () => [{ id: v.id, title: v.title }] }) };
      },
    }),
    update: () => ({ set: () => chain([]) }),
    execute: async (q: any) => { executed.push(JSON.stringify(q.queryChunks?.map((c: any) => c.value ?? '').flat())); return { rows: [] }; },
  },
}));
mock.module('@buildd/core/db/schema', () => ({
  missionNotes: 'missionNotes', missions: 'missions', tasks: new Proxy({}, { get: (_t, k) => `tasks.${String(k)}` }),
  workers: new Proxy({}, { get: (_t, k) => `workers.${String(k)}` }), workspaces: new Proxy({}, { get: (_t, k) => `workspaces.${String(k)}` }),
}));
const mockPostPrReview = mock(async (_p: any) => postResult);
/** Composed-PR reads for the §5.9 check; default: GitHub unreadable (the check falls through). */
let ghApi: (path: string) => unknown = (path) => { throw new Error(`no fake GitHub for ${path}`); };
let workspaceReleaseConfig: unknown = null;
mock.module('@/lib/github', () => ({ postPrReview: mockPostPrReview, githubApi: async (_i: number, path: string) => ghApi(path) }));
mock.module('@/lib/notify', () => ({ notifyTeamOf: mock(async () => undefined) }));
const mockAppend = mock(async (_p: any) => ({ action: 'created' }));
mock.module('@/lib/pr-activity-comment', () => ({ appendPrActivity: mockAppend, taskActivityUrl: (id: string) => `u/${id}` }));
const mockWake = mock(async (..._a: any[]) => undefined);
mock.module('@/lib/dispatch-authority', () => ({ announceTaskCreated: mock(async () => undefined), wakeTask: mockWake }));
mock.module('@/lib/merge-policy', () => ({ resolvePolicy: () => ({ tier: 'agent-review', agentReview: { reviewerRole: 'reviewer' } }), RESOLVE_POLICY_MISSION_COLUMNS: {} }));
mock.module('@/lib/pr-review-request', () => ({ listWorkspaceRoles: async () => roles }));
mock.module('@/lib/pr-review-status', () => ({ pickReviewerRole: (p: any) => ({ role: p.available[0]?.slug ?? null }) }));
mock.module('@/lib/path-declaration', () => ({ conformanceManifest: (t: any) => t.pathManifest ?? null }));
mock.module('@/lib/dependency-bot-pr', () => ({ isDependencyBotPrContext: (c: any) => !!c?.dependencyBot }));
mock.module('@/lib/pr-scope-reconcile-trigger', () => ({ schedulePrScopeReconcile: () => {} }));
const mockCreateReviewer = mock(async (_p: any) => created);
const mockSupersedeFix = mock(async (_p: any) => ({ superseded: true }));
mock.module('@/lib/reviewer', () => ({ createReviewerTask: mockCreateReviewer, supersedeFixTaskOnApproval: mockSupersedeFix }));
const mockEscalateExhaustion = mock(async (..._a: any[]) => undefined);
mock.module('@/lib/auto-merge', () => ({ escalateReviewerExhaustion: mockEscalateExhaustion }));

const { __handlers, reviewEffectHandlers } = await import('./review-effects');

const D = (o: any = {}) => ({
  id: 'd1', workspaceId: 'ws1', ownerTaskId: 'owner-1', repoFullName: 'acme/w', prNumber: 7, baseRef: 'dev', state: 'CHANGES_REQUESTED',
  stateReason: null, version: 4, currentHeadSha: 'H1', currentRound: 1, maxRounds: 3, boundAttemptId: null, resumeState: null,
  trunkIncidentId: null, approvedHeads: [], approvalBasis: null, compositionHeads: [], ci: null, ciHeadSha: null, mergeable: null,
  mergeableHeadSha: null, mergedAt: null, mergeCommitSha: null, supersededByPr: null, ...o,
});
const round1 = { id: 'r1', round: 1, headSha: 'H1', kind: 'full' as const, status: 'decided' as const, verdict: 'request_changes' as const, effectiveVerdict: 'request_changes' as const, failureCount: 0, reviewerTaskId: 'reviewer-1' };
const E = (kind: string, payload: Record<string, unknown>) => ({ id: 'e1', deliveryId: 'd1', transitionId: 't1', kind, dedupeKey: 'k', payload, attemptCount: 1, delivery: null, transition: null }) as any;

beforeEach(() => {
  view = { delivery: D() as any, rounds: [round1], attempts: [] };
  applied.length = 0; ingested.length = 0; executed.length = 0; inserted.length = 0; notes.length = 0;
  existingTask = null; livePr = { state: 'open', merged: false, headSha: 'H1', headRepoFullName: 'acme/w', baseRef: 'dev' };
  roles = [{ slug: 'reviewer' }]; created = { id: 'reviewer-2' }; postResult = { posted: true };
  ghApi = (path) => { throw new Error(`no fake GitHub for ${path}`); }; workspaceReleaseConfig = null;
  ownerRow = { id: 'owner-1', title: 'Fix the thing', description: 'd', missionId: 'm1', pathManifest: ['a.ts'], backend: 'claude', context: {} };
  for (const m of [mockPostPrReview, mockAppend, mockWake, mockCreateReviewer, mockSupersedeFix, mockEscalateExhaustion]) m.mockClear();
});

describe('dispatch_fix (T8 then the fix task)', () => {
  test('allocates the ledger row first, then files ONE legacy-shaped fix task linked to the delivery and attempt', async () => {
    const r = await __handlers.dispatchFix(E('dispatch_fix', { roundId: 'r1', round: 1, headSha: 'H1', attemptNo: 1 }));
    expect(r).toEqual({ outcome: 'ok' });
    expect(applied.map((c) => c.type)).toEqual(['FixDispatched']);
    expect(applied[0]).toMatchObject({ roundId: 'r1', maxAttempts: 3, revalidation: { live: livePr, newerApprove: false } });
    expect(inserted).toHaveLength(1);
    const t = inserted[0];
    expect(t).toMatchObject({
      id: applied[0].taskId, deliveryId: 'd1', deliveryRole: 'fix', parentTaskId: 'owner-1', taskClass: 'attempt',
      reviewerRetryPrNumber: 7, reviewerRetryHeadSha: 'H1', status: 'pending',
    });
    expect(t.context).toMatchObject({ workflowAttemptId: 'a-new', workflowRoundId: 'r1', resumeBranch: 'feat/x', iteration: 1, maxIterations: 3, headSha: 'H1' });
    expect(t.context.failureContext.summary).toBe('check the caller task');
    expect(mockWake).toHaveBeenCalledWith(applied[0].taskId, 'review.fix_requested');
  });

  test('a redelivered effect whose attempt and task already exist files nothing (at-least-once)', async () => {
    view = { ...view, attempts: [{ id: 'a1', family: 'review_fix', attemptNo: 1, mode: 'agent', boundHeadSha: 'H1', triggerReason: 'r1', taskId: 'fix-1', status: 'queued', outcome: null, maxAttempts: 3, reportedShas: [] }] };
    existingTask = { id: 'fix-1' };
    expect(await __handlers.dispatchFix(E('dispatch_fix', { roundId: 'r1' }))).toEqual({ outcome: 'ok:task_exists' });
    expect(applied).toHaveLength(0);
    expect(inserted).toHaveLength(0);
  });

  test('the allocated attempt whose task insert crashed gets its task on the retry, under the SAME id', async () => {
    view = { ...view, attempts: [{ id: 'a1', family: 'review_fix', attemptNo: 1, mode: 'agent', boundHeadSha: 'H1', triggerReason: 'r1', taskId: 'fix-1', status: 'queued', outcome: null, maxAttempts: 3, reportedShas: [] }] };
    await __handlers.dispatchFix(E('dispatch_fix', { roundId: 'r1' }));
    expect(applied).toHaveLength(0);
    expect(inserted[0]).toMatchObject({ id: 'fix-1' });
  });

  test('a second attempt on the same head leaves the (PR, head) dedupe column empty; the ledger dedupes it', async () => {
    view = { ...view, attempts: [{ id: 'a0', family: 'review_fix', attemptNo: 1, mode: 'agent', boundHeadSha: 'H1', triggerReason: 'r1', taskId: 'fix-0', status: 'ended', outcome: 'failed', maxAttempts: 3, reportedShas: [] }] };
    await __handlers.dispatchFix(E('dispatch_fix', { roundId: 'r1' }));
    expect(inserted[0].reviewerRetryHeadSha).toBeNull();
  });

  test('the delivery moved on (approved, pushed) before the effect ran: nothing is allocated', async () => {
    view = { ...view, delivery: D({ state: 'AWAITING_REVIEW' }) as any };
    expect(await __handlers.dispatchFix(E('dispatch_fix', { roundId: 'r1' }))).toEqual({ outcome: 'skipped:state_moved' });
    expect(applied).toHaveLength(0);
  });
});

describe('dispatch_review', () => {
  test('creates the round\'s reviewer bound to the round head, linked to delivery and round', async () => {
    view = { delivery: D({ state: 'AWAITING_REVIEW', currentRound: 2, currentHeadSha: 'H2' }) as any, rounds: [round1, { ...round1, id: 'r2', round: 2, headSha: 'H2', kind: 'delta', status: 'queued', verdict: null, effectiveVerdict: null, reviewerTaskId: null }], attempts: [] };
    const r = await __handlers.dispatchReview(E('dispatch_review', { roundId: 'r2', round: 2, headSha: 'H2' }));
    expect(r).toEqual({ outcome: 'ok' });
    const p = mockCreateReviewer.mock.calls[0][0] as any;
    expect(p).toMatchObject({ headSha: 'H2', prNumber: 7, workflowRound: { deliveryId: 'd1', roundId: 'r2', round: 2 }, originalTask: { iteration: 1, maxIterations: 3 } });
    // Delta round: the prior decided verdict is the delta's base.
    expect(p.priorVerdict).toMatchObject({ headSha: 'H1', verdict: 'request-changes', feedback: 'check the caller task' });
    expect(mockWake).toHaveBeenCalledWith('reviewer-2', 'task.created');
  });

  test('a round already dispatched is not dispatched twice', async () => {
    view = { delivery: D({ state: 'AWAITING_REVIEW' }) as any, rounds: [{ ...round1, status: 'queued', reviewerTaskId: 'rev-x' }], attempts: [] };
    expect(await __handlers.dispatchReview(E('dispatch_review', { roundId: 'r1' }))).toEqual({ outcome: 'skipped:already_dispatched' });
    expect(mockCreateReviewer).not.toHaveBeenCalled();
  });

  describe('composed PRs (§5.9)', () => {
    const composed = (o: { headRef?: string; extraCommit?: boolean } = {}) => {
      workspaceReleaseConfig = { enabled: true, releaseBranch: 'dev', prodBranch: 'main' };
      const commits = [{ sha: 'SQ1', files: ['a.ts'], pr: 11 }, ...(o.extraCommit ? [{ sha: 'X1', files: ['b.ts'], pr: null }] : [])];
      ghApi = (path) => {
        if (path === '/repos/acme/w/pulls/7') return { head: { ref: o.headRef ?? 'dev' }, base: { ref: 'main' } };
        if (path.startsWith('/repos/acme/w/compare/main...H1')) return {
          merge_base_commit: { sha: 'B0' }, total_commits: commits.length,
          commits: commits.map((c) => ({ sha: c.sha, parents: [{ sha: 'B0' }], commit: { message: 'x' } })),
          files: commits.flatMap((c) => c.files).map((filename) => ({ filename })),
        };
        const c = commits.find((x) => path === `/repos/acme/w/commits/${x.sha}`);
        if (c) return { files: c.files.map((filename) => ({ filename })) };
        const pc = commits.find((x) => path === `/repos/acme/w/commits/${x.sha}/pulls`);
        if (pc) return pc.pr ? [{ number: pc.pr, merged_at: 't', base: { ref: 'dev' }, head: { sha: 'P11' } }] : [];
        throw new Error(`unexpected ${path}`);
      };
    };

    test('a release PR whose changes were all reviewed is attested and gets no second reviewer', async () => {
      composed();
      // The constituent's kernel delivery, read by the collector.
      const db = (await import('@buildd/core/db')).db as any;
      const realExec = db.execute;
      db.execute = async (q: any) => {
        const text = JSON.stringify(q.queryChunks?.map((c: any) => c.value ?? '').flat());
        if (text.includes('composition_constituents')) return { rows: [{ id: 'd11', pr_number: 11, approved_heads: ['P11'], rounds: [{ id: 'r11', head_sha: 'P11', status: 'decided', effective_verdict: 'approve' }] }] };
        return realExec(q);
      };
      try {
        view = { delivery: D({ state: 'AWAITING_REVIEW' }) as any, rounds: [{ ...round1, status: 'queued', verdict: null, effectiveVerdict: null, reviewerTaskId: null }], attempts: [] };
        expect(await __handlers.dispatchReview(E('dispatch_review', { roundId: 'r1' }))).toEqual({ outcome: 'ok:composition_attested' });
      } finally { db.execute = realExec; }
      expect(mockCreateReviewer).not.toHaveBeenCalled();
      expect(ingested[0]).toMatchObject({ kind: 'composition_attested', attestation: { prNumber: 7, aggregateHeadSha: 'H1', novelDelta: { result: 'none' } } });
    });

    test('an unverifiable composition (the constituent has no kernel review) with nothing else falls through to the full review', async () => {
      composed();
      view = { delivery: D({ state: 'AWAITING_REVIEW' }) as any, rounds: [{ ...round1, status: 'queued', verdict: null, effectiveVerdict: null, reviewerTaskId: null }], attempts: [] };
      expect(await __handlers.dispatchReview(E('dispatch_review', { roundId: 'r1' }))).toEqual({ outcome: 'ok' });
      expect(ingested).toHaveLength(0);
      expect(mockCreateReviewer).toHaveBeenCalledTimes(1);
    });

    test('an ordinary PR is never checked for composition', async () => {
      composed({ headRef: 'buildd/abc-feature' });
      view = { delivery: D({ state: 'AWAITING_REVIEW' }) as any, rounds: [{ ...round1, status: 'queued', verdict: null, effectiveVerdict: null, reviewerTaskId: null }], attempts: [] };
      expect(await __handlers.dispatchReview(E('dispatch_review', { roundId: 'r1' }))).toEqual({ outcome: 'ok' });
      expect(ingested).toHaveLength(0);
    });

    test('the composition delta round is reviewed scoped to its novel paths, without a second composition check', async () => {
      composed();
      const r2 = { ...round1, id: 'r2', round: 2, kind: 'delta' as const, status: 'queued' as const, verdict: null, effectiveVerdict: null, reviewerTaskId: null, scope: { composition: true, novelDeltaPaths: ['b.ts'] } };
      view = { delivery: D({ state: 'AWAITING_REVIEW', currentRound: 2 }) as any, rounds: [{ ...round1, status: 'superseded', verdict: null, effectiveVerdict: null }, r2], attempts: [] };
      expect(await __handlers.dispatchReview(E('dispatch_review', { roundId: 'r2' }))).toEqual({ outcome: 'ok' });
      expect(ingested).toHaveLength(0);
      expect((mockCreateReviewer.mock.calls[0][0] as any).compositionScope).toEqual({ novelDeltaPaths: ['b.ts'] });
    });
  });

  test('no role can run the review: the round fails (T27), it is never silently dropped', async () => {
    roles = [];
    view = { delivery: D({ state: 'AWAITING_REVIEW' }) as any, rounds: [{ ...round1, status: 'queued', reviewerTaskId: null }], attempts: [] };
    await __handlers.dispatchReview(E('dispatch_review', { roundId: 'r1' }));
    expect(applied[0]).toMatchObject({ type: 'ReviewRoundFailed', roundId: 'r1', reason: 'infra', maxContractRetries: 0 });
  });
});

describe('post_review (§8.4)', () => {
  test('posts at the round\'s own commit, never the PR\'s current head', async () => {
    view = { ...view, delivery: D({ currentHeadSha: 'H9' }) as any };
    await __handlers.postReview(E('post_review', { roundId: 'r1', commitId: 'H1', event: 'REQUEST_CHANGES' }));
    expect(mockPostPrReview.mock.calls[0][0]).toMatchObject({ headSha: 'H1', event: 'REQUEST_CHANGES', prNumber: 7 });
  });
  test('a failed post is recorded on the mission, not retried into a duplicate review', async () => {
    postResult = { posted: false, reason: 'bad token' };
    const r = await __handlers.postReview(E('post_review', { roundId: 'r1', commitId: 'H1', event: 'APPROVE' }));
    expect(r).toEqual({ outcome: 'failed_post:bad token' });
    expect(notes[0]).toMatchObject({ type: 'warning', missionId: 'm1' });
  });
});

describe('cancellations and escalation', () => {
  test('approve supersedes the open fix through the legacy supersession rules', async () => {
    await __handlers.cancelOpenAttempts(E('cancel_open_attempts', { reason: 'approved' }));
    expect(mockSupersedeFix.mock.calls[0][0]).toMatchObject({ originalTaskId: 'owner-1', prNumber: 7, repoFullName: 'acme/w' });
  });
  test('merge/close cancellations stay with the legacy webhook in this slice', async () => {
    expect(await __handlers.cancelOpenAttempts(E('cancel_open_attempts', { mergeCommitSha: 'M' }))).toEqual({ outcome: 'skipped:legacy_owns' });
  });
  test('review exhaustion escalates through the existing CAS-deduped helper', async () => {
    await __handlers.escalateExhaustion(E('escalate_exhaustion', { family: 'review_fix' }));
    expect(mockEscalateExhaustion).toHaveBeenCalledWith('owner-1', 'acme/w', 7, 'H1', 3, 'check the caller task');
  });
});

describe('push_recovery (§9)', () => {
  test('a head that arrived meanwhile is handed to T3, which decides whether it is proof', async () => {
    view = { ...view, delivery: D({ state: 'AWAITING_PUSH' }) as any };
    livePr = { ...livePr, headSha: 'L2' };
    expect(await __handlers.pushRecovery(E('push_recovery', { localHeadSha: 'L2', try: 1, maxTries: 3 }))).toEqual({ outcome: 'ok:head_observed' });
    expect(ingested[0]).toMatchObject({ kind: 'head_observed', prNumber: 7 });
  });
  test('nothing pushed yet: the next bounded try is scheduled', async () => {
    view = { ...view, delivery: D({ state: 'AWAITING_PUSH' }) as any };
    expect(await __handlers.pushRecovery(E('push_recovery', { localHeadSha: 'L2', try: 1, maxTries: 3 }))).toEqual({ outcome: 'ok:retry_2' });
    expect(applied).toHaveLength(0);
  });
  test('the last try exhausts recovery: a person is told (T22)', async () => {
    view = { ...view, delivery: D({ state: 'AWAITING_PUSH' }) as any };
    await __handlers.pushRecovery(E('push_recovery', { localHeadSha: 'L2', try: 3, maxTries: 3 }));
    expect(applied[0]).toMatchObject({ type: 'PushRecoveryExhausted', localHeadSha: 'L2' });
  });
});

test('every effect the fix-loop reducer can emit has a handler (none retries forever on "no handler")', () => {
  for (const k of ['dispatch_review', 'dispatch_fix', 'post_review', 'escalate_exhaustion', 'mission_note', 'notify', 'cancel_open_attempts',
    'push_recovery', 'render_activity', 'emit_pr_merged', 'wake_mission', 'release_attribution', 'finalize_mission_pr',
    'scan_supersession', 'project_supersession', 'verify_merge', 'gate_event']) {
    expect(typeof (reviewEffectHandlers as Record<string, unknown>)[k]).toBe('function');
  }
  // stamp_pr_rows is the fact-cache projection, composed in by withPrFactEffects (pr-fact-effects.test.ts).
  expect((reviewEffectHandlers as Record<string, unknown>).stamp_pr_rows).toBeUndefined();
});
