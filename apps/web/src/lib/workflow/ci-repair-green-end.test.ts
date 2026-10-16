/**
 * 38442d17: a CI repair that ended without a push (cancelled by a person, lost) while the head it was
 * bound to reads green is not a failed attempt: attemptEnded tells the kernel CI is green and queues no
 * further fix. Anything else (not green, another head, a completed end) goes to the retry ledger.
 * The same scenario against real Postgres is in tests/db/workflow-seam.test.ts.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

const realKernel = await import('./kernel');
const realAuthority = await import('./authority');
const realFacts = await import('./github-facts');

let commands: Array<Record<string, unknown>> = [];
let view: Record<string, unknown>;
mock.module('./kernel', () => ({
  ...realKernel,
  loadView: async () => view,
  applyCommand: async (cmd: Record<string, unknown>) => {
    commands.push(cmd);
    return { result: 'applied', decision: { toState: cmd.type === 'CiGreenObserved' ? 'APPROVED' : 'REPAIRING', attempts: [] } };
  },
}));
mock.module('./authority', () => ({ ...realAuthority, kernelDeliveryById: async () => 'd1' }));
mock.module('./github-facts', () => ({ ...realFacts, workspaceRepo: async () => ({ installationId: 1, repoFullName: 'acme/w', gitConfig: null }) }));

const { attemptEnded } = await import('./seam');

let liveHead: string;
let green: boolean | null;
const reader = {
  readPr: async () => ({ state: 'open', merged: false, headSha: liveHead, headRepoFullName: 'acme/w', baseRef: 'dev', updatedAt: 'u', mergedAt: null }),
  checkRuns: async () => ({ complete: true, failing: [] as string[] }),
  ciGreen: async () => green,
};
const deps = { reader: () => reader, repoFor: async () => ({ installationId: 1, repoFullName: 'acme/w', gitConfig: null }), drain: async () => null } as never;
const task = { id: 't1', workspaceId: 'w1', deliveryId: 'd1', deliveryRole: 'ci_fix', context: { workflowAttemptId: 'a1' } };
const end = (status: 'completed' | 'failed' | 'lost' | 'unproven') =>
  attemptEnded({ task, workerId: 'wk1', status, localHeadSha: null, commitCount: 0, source: 'sweep:cancelled' }, deps);
const types = () => commands.map((c) => c.type);

beforeEach(() => {
  commands = [];
  liveHead = 'H1';
  green = true;
  view = {
    delivery: { state: 'REPAIRING', boundAttemptId: 'a1', currentHeadSha: 'H1', repoFullName: 'acme/w', prNumber: 7, baseRef: 'dev' },
    attempts: [{ id: 'a1', family: 'ci', boundHeadSha: 'H1', reportedShas: [] }],
    findings: [],
  };
});

describe('attemptEnded: a CI repair that ended without a push', () => {
  test.each(['lost', 'failed'] as const)('%s on the bound head that now reads green applies CiGreenObserved and files no retry', async (status) => {
    const r = await end(status);
    expect(r).toMatchObject({ handled: true, result: { result: 'applied', decision: { toState: 'APPROVED' } } });
    expect(types()).toEqual(['CiGreenObserved']);
    expect(commands[0]).toMatchObject({ headSha: 'H1', allPassing: true });
  });

  test.each([
    ['ciGreen false', () => { green = false; }],
    ['ciGreen unknown', () => { green = null; }],
    ['a different live head', () => { liveHead = 'H2'; }],
  ])('%s falls through to the retry ledger', async (_n, arrange) => {
    arrange();
    await end('lost');
    expect(types()).toEqual(['AttemptEnded']);
  });

  test('a completed end never takes the branch, even on a green head', async () => {
    await end('completed');
    expect(types()).toEqual(['AttemptEnded']);
  });
});
