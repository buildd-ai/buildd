import { describe, it, expect, mock, beforeEach } from 'bun:test';

const dispatched: unknown[] = [];
const handled: unknown[] = [];
let contextRow: unknown = { context: { specCriterionCheck: { subjectTaskId: 's' } } };
const SHA = 'a'.repeat(40);

mock.module('@buildd/core/db', () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => (contextRow ? [contextRow] : []) }) }) }) },
}));
mock.module('@/lib/specs/outcome', () => ({ currentPrHeadSha: async () => 'b'.repeat(40) }));
mock.module('@/lib/specs/criterion-checks', () => ({
  dispatchCriterionChecks: async (o: unknown) => { dispatched.push(o); return { dispatched: 1 }; },
  handleCriterionCheckOutcome: async (id: string, ev: unknown) => { handled.push([id, ev]); return { recorded: true }; },
  isCriterionCheckTask: (c: unknown) => !!(c as Record<string, unknown> | null)?.specCriterionCheck,
}));

const { specCheckSubscribers } = await import('./spec-check-subscribers');
const { emit } = await import('./core-emit');

beforeEach(() => { dispatched.length = 0; handled.length = 0; contextRow = { context: { specCriterionCheck: { subjectTaskId: 's' } } }; });

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
});
