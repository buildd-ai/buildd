import { describe, it, expect, mock, beforeEach } from 'bun:test';

const calls: unknown[][] = [];
mock.module('next/server', () => ({ after: () => { throw new Error('no request scope'); } }));
mock.module('@/lib/failure-pattern-sentinel-trigger', () => ({ scheduleFailurePatternSentinel: (ws: string) => calls.push(['sweep', ws]) }));
mock.module('@/lib/failure-pattern-sweep', () => ({
  reassessIncidentsNamingPr: async (ws: string, pr: number, source: string) => { calls.push(['reassess', ws, pr, source]); return []; },
}));
mock.module('@/modules', () => ({ SUBSCRIBERS: [] }));

const { emit } = await import('./core-emit');
const { failurePatternSubscribers } = await import('./failure-pattern-subscribers');

const closed = (merged: boolean) => ({
  type: 'pr.closed' as const, workspaceId: 'ws-1', prNumber: 77, merged, mergeIsNew: true, workerId: 'w', taskId: 't',
  headSha: 's', repoFullName: 'o/r', installationId: null,
});

beforeEach(() => { calls.length = 0; });

describe('failure-incident recovery reacts to a closed PR (failure-incident-recovery §12(a))', () => {
  it('a merged PR re-assesses the open incidents naming it, as the merge hook', async () => {
    await emit(closed(true), { subscribers: failurePatternSubscribers });
    expect(calls).toContainEqual(['reassess', 'ws-1', 77, 'merge_hook']);
  });

  it('a PR closed unmerged is a recovery moment too (the blocker is gone)', async () => {
    await emit(closed(false), { subscribers: failurePatternSubscribers });
    expect(calls).toContainEqual(['reassess', 'ws-1', 77, 'merge_hook']);
  });
});
