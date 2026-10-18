/**
 * An owner end that leaves the delivery APPROVED (a verdict kept while the owner worked, now applied)
 * wakes the landing sweep for that PR: the landing door deferred while the delivery was WORKING, and
 * nothing else re-evaluates it. Any other outcome wakes nothing.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

const realKernel = await import('./kernel');
const realAuthority = await import('./authority');
const realFacts = await import('./github-facts');

let toState: string;
let result: string;
mock.module('./kernel', () => ({
  ...realKernel,
  loadView: async () => ({ delivery: { id: 'd1', state: 'WORKING', currentHeadSha: 'H1', repoFullName: 'acme/w', prNumber: 7, baseRef: 'dev' }, attempts: [], findings: [] }),
  applyCommand: async () => ({ result, decision: { toState, attempts: [] } }),
}));
mock.module('./authority', () => ({ ...realAuthority, kernelDeliveryById: async () => 'd1' }));
mock.module('./github-facts', () => ({ ...realFacts, workspaceRepo: async () => ({ installationId: 1, repoFullName: 'acme/w', gitConfig: null }) }));

const { attemptEnded } = await import('./seam');

let due: string[];
const reader = {
  readPr: async () => ({ state: 'open', merged: false, headSha: 'H1', headRepoFullName: 'acme/w', baseRef: 'dev', updatedAt: 'u', mergedAt: null }),
  checkRuns: async () => ({ complete: true, failing: [] as string[] }),
};
const deps = {
  reader: () => reader, repoFor: async () => ({ installationId: 1, repoFullName: 'acme/w', gitConfig: null }), drain: async () => null,
  exec: async () => ({ rows: [] }), markLandingDue: async (m: string) => { due.push(m); },
} as never;
const task = { id: 't1', workspaceId: 'w1', deliveryId: 'd1', deliveryRole: 'owner', context: {} };
const end = () => attemptEnded({ task, workerId: 'wk1', status: 'completed', localHeadSha: 'H1', commitCount: 1, source: 'runner' }, deps);

beforeEach(() => { due = []; result = 'applied'; toState = 'APPROVED'; });

describe('attemptEnded: waking landing', () => {
  test('an owner end that leaves the delivery APPROVED marks its PR due', async () => {
    await end();
    expect(due).toEqual(['w1:7']);
  });

  test('an end into review wakes nothing', async () => {
    toState = 'AWAITING_REVIEW';
    await end();
    expect(due).toEqual([]);
  });

  test('a command that applied nothing wakes nothing', async () => {
    result = 'stale';
    await end();
    expect(due).toEqual([]);
  });
});
