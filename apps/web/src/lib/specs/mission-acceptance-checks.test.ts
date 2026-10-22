import { describe, expect, it, mock } from 'bun:test';

const SHA = 'a'.repeat(40);
let dispatched: unknown[] = [];
let registered: unknown[] = [];
let available = true;
let registeredFails = false;
mock.module('./criterion-checks', () => ({ dispatchCriterionChecks: async (input: unknown) => { dispatched.push(input); return { dispatched: 2 }; } }));
mock.module('./registered-verification', () => ({ dispatchRegisteredVerification: async (input: unknown) => {
  registered.push(input);
  if (registeredFails) throw new Error('store unavailable');
  return { results: [], coverage: [], refused: [] };
} }));
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
  });
  it('R-7: runs the registered verify checks through the shared coordinator at the same integrated target', async () => {
    dispatched = []; registered = []; available = true; registeredFails = false;
    await runFinalAcceptanceChecks('verification-task', 'mission');
    expect(registered).toEqual([{ taskId: 'verification-task', headSha: SHA }]);
  });
  it('a registered-check failure never stops the command checks', async () => {
    dispatched = []; registered = []; available = true; registeredFails = true;
    await runFinalAcceptanceChecks('verification-task', 'mission');
    expect(dispatched).toHaveLength(1);
    registeredFails = false;
  });
});
