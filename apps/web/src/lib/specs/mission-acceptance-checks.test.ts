import { describe, expect, it, mock } from 'bun:test';

const SHA = 'a'.repeat(40);
let dispatched: unknown[] = [];
let registered: unknown[] = [];
let available = true;
mock.module('./criterion-checks', () => ({ dispatchCriterionChecks: async (input: unknown) => { dispatched.push(input); return { dispatched: 2 }; } }));
mock.module('./registered-verification', () => ({ dispatchRegisteredVerification: async (input: unknown) => { registered.push(input); return { dispatched: 1 }; } }));
mock.module('./mission-outcome', () => ({ resolveMissionCheckTarget: async () => available ? ({ headSha: SHA, branch: 'dev' }) : null }));
const { runFinalAcceptanceChecks } = await import('./mission-acceptance-checks');

describe('final acceptance checks', () => {
  it('does not launch checks against an unknown target', async () => {
    dispatched = []; registered = []; available = false;
    await runFinalAcceptanceChecks('verification-task', 'mission');
    expect(dispatched).toEqual([]);
    expect(registered).toEqual([]);
  });
  it('dispatches every registered criterion command on the integrated result, including an existing final task', async () => {
    dispatched = []; registered = []; available = true;
    await runFinalAcceptanceChecks('verification-task', 'mission');
    expect(dispatched).toEqual([{ taskId: 'verification-task', headSha: SHA, headBranch: 'dev' }]);
    expect(registered).toEqual([{ taskId: 'verification-task', headSha: SHA }]);
  });
});
