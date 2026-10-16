import { describe, it, expect, mock, beforeEach } from 'bun:test';

/** What each update's set() was given, and what the next returning() yields (a won claim by default). */
const sets: any[] = [];
let returningRows: Array<Array<{ id: string }>> = [];
const updateSpy = mock(() => ({ set: (v: any) => { sets.push(v); return { where: () => ({ returning: async () => returningRows.shift() ?? [{ id: 't1' }] }) }; } }));
const emit = mock(async (_e: any) => {});

mock.module('next/server', () => ({ after: (fn: () => void) => fn() }));
mock.module('@buildd/core/db', () => ({ db: { update: updateSpy, query: { workers: { findFirst: async () => null } } } }));
mock.module('@buildd/core/db/schema', () => ({ tasks: {}, workspaces: {} }));
mock.module('drizzle-orm', () => {
  const sql: any = () => ({});
  sql.raw = () => ({});
  sql.join = () => ({});
  return { and: () => ({}), eq: () => ({}), ne: () => ({}), sql };
});
mock.module('@/lib/core-emit', () => ({ emit }));
mock.module('@/lib/model-policy-outcomes', () => ({ reportTaskPolicyOutcome: async () => {} }));
mock.module('@/lib/task-dependencies', () => ({ checkDependsOnResolved: async () => {}, resolveCompletedTask: async () => {} }));
mock.module('@/lib/interactive-detach', () => ({ detachInteractiveWorkersOfEndedTasks: async () => {} }));
mock.module('@/lib/pusher', () => ({ triggerEvent: async () => {}, channels: { workspace: () => 'c' }, events: { WORKER_PROGRESS: 'p' } }));
mock.module('@/lib/work-tracker', () => ({ postWorkTrackerCompletionUpdate: async () => {} }));
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
  taskTransition: taskTransition ?? legacyCompleteTaskOnMerge({ prUrl: 'u', prNumber: 1, runner }),
});
const events = () => emit.mock.calls.map((c) => c[0] as any);

describe('runMergedPrWork completion', () => {
  beforeEach(() => { updateSpy.mockClear(); emit.mockClear(); sets.length = 0; returningRows = []; });

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

  // S4b review finding 2: the effect is at-least-once. A retry after a throw past the completion
  // block must not re-post the tracker comment or re-run resolveCompletedTask.
  it('a retried effect whose completion already ran skips the one-shot block', async () => {
    returningRows = [[]]; // the once-marker was claimed by the first attempt
    await runMergedPrWork(input('runner-1', 'flipped'));
    expect(events().some((e) => e.type === 'task.completed')).toBe(false);
    // The merge's own fan-out still runs (deduped downstream by its key).
    expect(events().find((e) => e.type === 'task.pr_merged').transition).toBe('flipped');
  });

  it('a kernel answer of already_completed fires no completion', async () => {
    await runMergedPrWork(input('runner-1', 'already_completed'));
    expect(sets).toEqual([]);
    expect(events().some((e) => e.type === 'task.completed')).toBe(false);
    expect(events().find((e) => e.type === 'task.pr_merged').transition).toBe('already_completed');
  });
});
