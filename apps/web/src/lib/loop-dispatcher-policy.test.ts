import { describe, it, expect, mock } from 'bun:test';

const taskRow = {
  loopConfig: { exitCondition: { type: 'pr_checks_green' }, maxLoops: 3, backoffMinutes: 0 },
  loopIteration: 1,
  loopState: 'condition_unmet',
  startAt: null,
  context: {},
};

mock.module('@buildd/core/db', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [taskRow] }) }) }),
    // An interactive session's worker row carries no PR of its own.
    query: { workers: { findFirst: async () => ({ prLifecycleStatus: null, prNumber: null, mergedAt: null }) } },
  },
}));
mock.module('@buildd/core/db/schema', () => ({ tasks: {}, workers: {} }));
mock.module('drizzle-orm', () => ({ eq: () => ({}) }));

import { loopPolicy } from './loop-dispatcher-policy';

const input = {
  taskId: 't1',
  workerId: 'w1',
  workerBranch: null,
  workerLastCommitSha: null,
  verificationEvidence: undefined,
  structuredOutput: undefined,
};

describe('loopPolicy with alreadyShippedIn', () => {
  it('holds (requeues) when the worker owns no PR', async () => {
    const v = await loopPolicy(input);
    expect(v?.kind).toBe('hold');
  });

  it('passes when the task was completed against a merged PR', async () => {
    const v = await loopPolicy({ ...input, alreadyShippedPrNumber: 4359 });
    expect(v?.kind).toBe('pass');
  });
});
