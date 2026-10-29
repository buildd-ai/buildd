import { describe, it, expect, mock, beforeEach } from 'bun:test';

const dispatched: unknown[] = [];
const handled: unknown[] = [];
let contextRow: unknown = { context: { specCriterionCheck: { subjectTaskId: 's' } } };
const SHA = 'a'.repeat(40);
// A batch outcome that has not finished yet, and the work handed to after().
const deferred: Array<() => unknown> = [];
const realNextServer = await import('next/server');
mock.module('next/server', () => ({ ...realNextServer, after: (fn: () => unknown) => { deferred.push(fn); } }));

mock.module('@buildd/core/db', () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => (contextRow ? [contextRow] : []) }) }) }) },
}));
mock.module('@/lib/specs/outcome', () => ({ currentPrHeadSha: async () => 'b'.repeat(40), recordAuditedVerdict: async () => ({ ok: true, verdictId: 'v' }) }));
mock.module('@/lib/specs/criterion-checks', () => ({
  dispatchCriterionChecks: async (o: unknown) => { dispatched.push(o); return { dispatched: 1 }; },
  handleCriterionCheckOutcome: async (id: string, ev: unknown) => { handled.push([id, ev]); return { recorded: true }; },
  isCriterionCheckTask: (c: unknown) => { const r = c as Record<string, unknown> | null; return !!(r?.specCriterionCheck || r?.specCriterionBatch); },
  registerMissionVerdictRecorder: () => {},
}));

const { specCheckSubscribers, awaitBatchOutcome } = await import('./spec-check-subscribers');
const { emit } = await import('./core-emit');

beforeEach(() => { dispatched.length = 0; handled.length = 0; deferred.length = 0; contextRow = { context: { specCriterionCheck: { subjectTaskId: 's' } } }; });

const worker = { id: 'w1', workspaceId: 'ws1', taskId: 't1' };

describe('specCheckSubscribers', () => {
  it('a PR opened ready dispatches checks for its head and branch; without a head in the event, the kernel head', async () => {
    await emit({ type: 'pr.review_ready', installationId: 1, repoFullName: 'o/r', pr: { number: 2, headRef: 'buildd/x', headSha: SHA, additions: 1, deletions: 0 }, worker }, { subscribers: specCheckSubscribers });
    await emit({ type: 'pr.review_ready', installationId: 1, repoFullName: 'o/r', pr: { number: 2, headRef: 'buildd/x', additions: 1, deletions: 0 }, worker }, { subscribers: specCheckSubscribers });
    expect(dispatched).toEqual([
      { taskId: 't1', headSha: SHA, headBranch: 'buildd/x' },
      { taskId: 't1', headSha: 'b'.repeat(40), headBranch: 'buildd/x' },
    ]);
  });

  it('a push dispatches for the new head; a draft or a task-less worker does not', async () => {
    const pr = { number: 2, headSha: SHA, htmlUrl: 'u', baseRef: 'dev', body: null, draft: false };
    const w = { id: 'w1', workspaceId: 'ws1', taskId: 't1' as string | null, branch: 'buildd/x' };
    await emit({ type: 'pr.synchronized', installationId: 1, repoFullName: 'o/r', pr, worker: w }, { subscribers: specCheckSubscribers });
    await emit({ type: 'pr.synchronized', installationId: 1, repoFullName: 'o/r', pr: { ...pr, draft: true }, worker: w }, { subscribers: specCheckSubscribers });
    await emit({ type: 'pr.synchronized', installationId: 1, repoFullName: 'o/r', pr, worker: { ...w, taskId: null } }, { subscribers: specCheckSubscribers });
    expect(dispatched).toEqual([{ taskId: 't1', headSha: SHA, headBranch: 'buildd/x' }]);
  });

  it('only a check run report is turned into a verdict', async () => {
    const report = { type: 'worker.reported' as const, taskId: 'v1', workerId: 'w', workspaceId: 'ws1', missionId: null, status: 'completed' as const, finalStatus: 'completed' as const, releaseHeld: false, structuredOutput: null, verificationEvidence: { outcome: 'ok' } };
    await emit(report, { subscribers: specCheckSubscribers });
    contextRow = { context: {} };
    await emit({ ...report, taskId: 'v2' }, { subscribers: specCheckSubscribers });
    expect(handled).toEqual([['v1', { outcome: 'ok' }]]);
  });

  // One verdict per criterion, each reading the mission target: a large batch
  // must not hold the runner's completing PATCH past its client timeout.
  it('a batch report is turned into its verdicts too', async () => {
    contextRow = { context: { specCriterionBatch: { missionId: 'm', subjectTaskId: 's', headSha: SHA, checks: [] } } };
    const report = { type: 'worker.reported' as const, taskId: 'b1', workerId: 'w', workspaceId: 'ws1', missionId: 'm', status: 'completed' as const, finalStatus: 'completed' as const, releaseHeld: false, structuredOutput: null, verificationEvidence: { conditionType: 'criterion_batch' } };
    await emit(report, { subscribers: specCheckSubscribers });
    expect(handled).toEqual([['b1', { conditionType: 'criterion_batch' }]]);
    expect(deferred).toHaveLength(0);
  });

  it('a batch outcome past its budget finishes after the reply, not inside it', async () => {
    let finish!: () => void;
    let finished = false;
    const outcome = new Promise<void>((resolve) => { finish = resolve; }).then(() => { finished = true; });
    await awaitBatchOutcome(outcome, 'b1', 10);
    expect(finished).toBe(false);
    expect(deferred).toHaveLength(1);
    finish();
    await deferred[0]();
    expect(finished).toBe(true);
  });

  it('a batch outcome that fails within its budget is logged, never thrown', async () => {
    await awaitBatchOutcome(Promise.reject(new Error('target unreadable')), 'b1', 1_000);
    expect(deferred).toHaveLength(0);
  });

  it('R-6: registered checks have no PR subscriber of their own; the criterion-check dispatch is the one PR ready/push entry', () => {
    expect(specCheckSubscribers.map(s => s.label)).toEqual(['spec-checks-on-open', 'spec-checks-on-push', 'late-runner-evidence', 'spec-check-outcome']);
  });
});
