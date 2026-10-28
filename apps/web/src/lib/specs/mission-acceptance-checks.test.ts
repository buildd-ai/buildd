import { describe, expect, it, mock } from 'bun:test';

const SHA = 'a'.repeat(40);
let dispatched: unknown[] = [];
let settledFor: string[] = [];
let settled = 0;
let available = true;
mock.module('./criterion-checks', () => ({
  dispatchCriterionChecks: async (input: unknown) => { dispatched.push(input); return { dispatched: 2 }; },
  settleFinishedCheckRuns: async (missionId: string) => { settledFor.push(missionId); return { settled, attempted: settled }; },
}));
mock.module('./mission-outcome', () => ({ resolveMissionCheckTarget: async () => available ? ({ headSha: SHA, branch: 'dev' }) : null }));
const { runFinalAcceptanceChecks } = await import('./mission-acceptance-checks');

describe('final acceptance checks', () => {
  it('does not launch checks against an unknown target', async () => {
    dispatched = []; settledFor = []; available = false;
    await runFinalAcceptanceChecks('verification-task', 'mission');
    expect(dispatched).toEqual([]);
  });
  it('dispatches every registered criterion command on the integrated result, including an existing final task', async () => {
    dispatched = []; settledFor = []; available = true;
    await runFinalAcceptanceChecks('verification-task', 'mission');
    expect(dispatched).toEqual([{ taskId: 'verification-task', headSha: SHA, headBranch: 'dev' }]);
  });
  // df808193: twenty runner check runs had finished with exit 0 at the integrated target and
  // only one had become a verdict row. Before anything new is filed, what already finished is settled.
  it('settles finished check runs whose verdict was never recorded before filing new ones, and says how many', async () => {
    dispatched = []; settledFor = []; settled = 20; available = true;
    try {
      const r = await runFinalAcceptanceChecks('verification-task', 'mission');
      expect(settledFor).toEqual(['mission']);
      expect(r).toMatchObject({ dispatched: 2, settled: 20 });
    } finally { settled = 0; }
  });
  it('settles finished runs even when no target can be resolved for new ones', async () => {
    dispatched = []; settledFor = []; settled = 1; available = false;
    try {
      const r = await runFinalAcceptanceChecks('verification-task', 'mission');
      expect(settledFor).toEqual(['mission']);
      expect(r).toMatchObject({ dispatched: 0, settled: 1 });
    } finally { settled = 0; }
  });
});
