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

describe('loopPolicy pr_checks_green webhook wait', () => {
  it('returns webhook wait when pr_checks_green and checks are ci_running', async () => {
    mock.module('@buildd/core/db', () => ({
      db: {
        select: () => ({ from: () => ({ where: () => ({ limit: async () => [taskRow] }) }) }),
        query: { workers: { findFirst: async () => ({ prLifecycleStatus: 'ci_running', prNumber: 42, mergedAt: null }) } },
      },
    }));
    const v = await loopPolicy({ ...input, workerBranch: 'buildd/feat' });
    expect(v?.kind).toBe('hold');
    expect(v?.until).toBe('webhook');
  });

  it('returns webhook wait when pr_checks_green and prLifecycleStatus is null (unknown)', async () => {
    mock.module('@buildd/core/db', () => ({
      db: {
        select: () => ({ from: () => ({ where: () => ({ limit: async () => [taskRow] }) }) }),
        query: { workers: { findFirst: async () => ({ prLifecycleStatus: null, prNumber: 42, mergedAt: null }) } },
      },
    }));
    const v = await loopPolicy({ ...input, workerBranch: 'buildd/feat' });
    expect(v?.kind).toBe('hold');
    expect(v?.until).toBe('webhook');
  });

  it('preserves loopIteration on webhook wait (no increment)', async () => {
    mock.module('@buildd/core/db', () => ({
      db: {
        select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ ...taskRow, loopIteration: 0 }] }) }) }),
        query: { workers: { findFirst: async () => ({ prLifecycleStatus: 'ci_running', prNumber: 42, mergedAt: null }) } },
      },
    }));
    const v = await loopPolicy({ ...input, workerBranch: 'buildd/feat' });
    expect(v?.progress.iteration).toBe(1); // Iterator incremented in loopHistory but task iteration stays same
  });
});
