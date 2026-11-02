import { describe, it, expect, mock, beforeEach } from 'bun:test';

/** What each update's set() was given, and what the next returning() yields (a won claim by default). */
const sets: any[] = [];
let returningRows: Array<Array<{ id: string }>> = [];
const updateSpy = mock(() => ({ set: (v: any) => { sets.push(v); return { where: () => ({ returning: async () => returningRows.shift() ?? [{ id: 't1' }] }) }; } }));
const emit = mock(async (_e: any) => {});

mock.module('next/server', () => ({ after: (fn: () => void) => fn() }));
/** The PR's worker carries a linked tracker issue, so the completion comment is observable. */
mock.module('@buildd/core/db', () => ({ db: { update: updateSpy, query: {
  workers: { findFirst: async () => ({ id: 'w1', task: { id: 't1', workspaceId: 'ws', externalIssueId: 'LIN-1', externalIssueUrl: null } }) },
  workspaces: { findFirst: async () => ({ teamId: 'team', workTrackerConfig: { provider: 'linear' } }) },
} } }));
mock.module('@buildd/core/db/schema', () => ({ tasks: {}, workspaces: {} }));
mock.module('drizzle-orm', () => {
  const sql: any = () => ({});
  sql.raw = () => ({});
  sql.join = () => ({});
  return { and: () => ({}), eq: () => ({}), ne: () => ({}), sql };
});
mock.module('@/lib/core-emit', () => ({ emit }));
mock.module('@/lib/model-policy-outcomes', () => ({ reportTaskPolicyOutcome: async () => {} }));
const resolveCompletedTask = mock(async (_id: string, _ws: string) => {});
mock.module('@/lib/task-dependencies', () => ({ checkDependsOnResolved: async () => {}, resolveCompletedTask }));
mock.module('@/lib/interactive-detach', () => ({ detachInteractiveWorkersOfEndedTasks: async () => {} }));
mock.module('@/lib/pusher', () => ({ triggerEvent: async () => {}, channels: { workspace: () => 'c', workspaceActivity: () => 'c' }, events: { WORKER_PROGRESS: 'p' } }));
const trackerPost = mock(async (_p: any) => {});
mock.module('@/lib/work-tracker', () => ({ postWorkTrackerCompletionUpdate: trackerPost }));
mock.module('@/lib/path-claim-release', () => ({ releaseAndNotify: async () => {} }));
mock.module('@/lib/pr-merge-stamp', () => ({ stampPrMergedOnAllRows: async () => {} }));
mock.module('@/lib/repo-scope', () => ({ workerOwnsPr: () => ({}), workerOwnsPrUrl: () => ({}) }));
mock.module('@/lib/task-open-prs', () => ({ otherOpenPrsOfTask: async () => [] }));

const { runMergedPrWork } = await import('./pr-merged-work');
const { legacyCompleteTaskOnMerge } = await import('./pr-merged-legacy-task');

const input = (runner: string, taskTransition?: any) => ({
  worker: { id: 'w1', workspaceId: 'ws', taskId: 't1', runner },
  task: { id: 't1', status: 'in_progress', workspaceId: 'ws', missionId: null, taskClass: null, release: null, loopState: null },
  repoFullName: 'o/r', prNumber: 1, prUrl: 'u', prHtmlUrl: 'u', baseRef: 'dev', headSha: 's',
  installationId: null, mergedAt: new Date(), mergeIsNew: true, stamp: false,
  taskTransition: taskTransition ?? legacyCompleteTaskOnMerge({ repoFullName: 'o/r', prUrl: 'u', prNumber: 1, runner }),
});
const events = () => emit.mock.calls.map((c) => c[0] as any);

describe('runMergedPrWork completion', () => {
  beforeEach(() => { updateSpy.mockClear(); emit.mockClear(); resolveCompletedTask.mockClear(); trackerPost.mockClear(); sets.length = 0; returningRows = []; });

  it('does not complete a task held by an interactive session', async () => {
    await runMergedPrWork(input('mcp'));
    expect(updateSpy).not.toHaveBeenCalled();
    const merged = emit.mock.calls.map((c) => c[0]).find((e: any) => e.type === 'task.pr_merged');
    expect(merged.transition).toBe('not_flipped');
  });

  it('still completes a runner-held task', async () => {
    await runMergedPrWork(input('runner-1'));
    expect(updateSpy).toHaveBeenCalled();
  });

  // S4b (AC-2): for a kernel-owned PR the T17 statement already wrote the task; this work only reports it.
  it('a transition the kernel decided writes no task status and still runs the completion side effects', async () => {
    await runMergedPrWork(input('runner-1', 'flipped'));
    // The only write is the once-marker on context, never status or result.
    expect(sets.every((v) => !('status' in v) && !('result' in v) && 'context' in v)).toBe(true);
    expect(events().find((e) => e.type === 'task.completed')).toMatchObject({ via: 'merge', taskId: 't1' });
    expect(events().find((e) => e.type === 'task.pr_merged').transition).toBe('flipped');
  });

  // S4b review: the effect is at-least-once. Only the tracker comment (a person sees it twice) is
  // behind the once-marker; the fan-out and resolveCompletedTask run on every attempt, because a
  // function killed after the claim would otherwise lose them for good.
  it('first attempt: the fan-out runs and the tracker comment is posted once', async () => {
    await runMergedPrWork(input('runner-1', 'flipped'));
    await new Promise((r) => setTimeout(r, 0));
    expect(events().some((e) => e.type === 'task.completed')).toBe(true);
    expect(resolveCompletedTask).toHaveBeenCalledTimes(1);
    expect(trackerPost).toHaveBeenCalledTimes(1);
  });

  it('a retry after a kill past the claim still runs the fan-out, and does not re-post the comment', async () => {
    returningRows = [[]]; // the killed attempt already set the marker
    await runMergedPrWork(input('runner-1', 'flipped'));
    await new Promise((r) => setTimeout(r, 0));
    expect(events().find((e) => e.type === 'task.completed')).toMatchObject({ via: 'merge', taskId: 't1' });
    expect(resolveCompletedTask).toHaveBeenCalledTimes(1);
    expect(trackerPost).not.toHaveBeenCalled();
    expect(events().find((e) => e.type === 'task.pr_merged').transition).toBe('flipped');
  });

  it('a kernel answer of already_completed fires no completion', async () => {
    await runMergedPrWork(input('runner-1', 'already_completed'));
    expect(sets).toEqual([]);
    expect(events().some((e) => e.type === 'task.completed')).toBe(false);
    expect(events().find((e) => e.type === 'task.pr_merged').transition).toBe('already_completed');
  });

  // The surface-audit evidence writer (visual-qa:surface-evidence-on-merge) reads the merged PR from
  // this one event, so it must name the repo, installation and merged head on both callers' path.
  it('emits pr.closed with what the merged surface-evidence writer needs', async () => {
    await runMergedPrWork({ ...input('runner-1', 'flipped'), installationId: 7 });
    expect(events().find((e) => e.type === 'pr.closed')).toMatchObject({
      merged: true, prNumber: 1, repoFullName: 'o/r', installationId: 7, headSha: 's',
    });
  });
});
