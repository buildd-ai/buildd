import { describe, it, expect, mock, beforeEach } from 'bun:test';

type WorkerRow = { prLifecycleStatus: string | null; prNumber: number | null; mergedAt: Date | null };

const baseTask = {
  loopConfig: { exitCondition: { type: 'pr_checks_green' }, maxLoops: 3, backoffMinutes: 0 } as Record<string, unknown>,
  loopIteration: 1,
  loopState: 'condition_unmet',
  startAt: null,
  context: {} as Record<string, unknown>,
};

// An interactive session's worker row carries no PR of its own.
const noPr: WorkerRow = { prLifecycleStatus: null, prNumber: null, mergedAt: null };

let taskRow = { ...baseTask };
let completingWorker: WorkerRow = noPr;
let priorPrWorker: WorkerRow | undefined;

mock.module('@buildd/core/db', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [taskRow] }) }) }),
    query: {
      workers: {
        // First lookup is by the completing worker's id; the second (with
        // orderBy) is the task's earlier worker that owns a PR.
        findFirst: async (q: { orderBy?: unknown }) => (q.orderBy ? priorPrWorker : completingWorker),
      },
    },
  },
}));
mock.module('@buildd/core/db/schema', () => ({ tasks: {}, workers: {} }));
// 92a439a6: the kernel delivery the loop task owns (null = none, legacy decides).
let ownerDelivery: { state: string; prNumber: number | null; mergedAt: string | null } | null = null;
mock.module('@/lib/workflow/delivery-view', () => ({ kernelOwnerDeliveryFacts: async () => ownerDelivery }));
mock.module('drizzle-orm', () => ({ eq: () => ({}), and: () => ({}), desc: () => ({}), isNotNull: () => ({}) }));

import { loopPolicy } from './loop-dispatcher-policy';

const input = {
  taskId: 't1',
  workerId: 'w1',
  workerBranch: 'buildd/feat',
  workerLastCommitSha: null,
  verificationEvidence: undefined,
  structuredOutput: undefined,
};

beforeEach(() => {
  ownerDelivery = null;
  taskRow = { ...baseTask, context: {} };
  completingWorker = noPr;
  priorPrWorker = undefined;
});

describe('loopPolicy with alreadyShippedIn', () => {
  it('holds (requeues) when the worker owns no PR', async () => {
    const v = await loopPolicy(input);
    expect(v?.kind).toBe('hold');
    expect(v?.kind === 'hold' && v.until).toBe('requeue');
  });

  it('passes when the task was completed against a merged PR', async () => {
    const v = await loopPolicy({ ...input, alreadyShippedPrNumber: 4359 });
    expect(v?.kind).toBe('pass');
  });
});

describe('loopPolicy pr_checks_green while CI is pending', () => {
  for (const status of ['ci_running', 'pr_open', null]) {
    it(`waits for the webhook without spending an attempt (${status ?? 'no status yet'})`, async () => {
      taskRow = { ...baseTask, loopIteration: 0, context: { loopHistory: [] } };
      completingWorker = { prLifecycleStatus: status, prNumber: 42, mergedAt: null };
      const before = Date.now();
      const v = await loopPolicy(input);
      if (v?.kind !== 'hold') throw new Error(`expected hold, got ${v?.kind}`);
      expect(v.until).toBe('webhook');
      expect(v.progress.iteration).toBe(0);
      expect(v.progress.history).toEqual([]);
      // Deferred to the wait expiry (240 min default) so no runner claims it first.
      expect(v.startAt!.getTime()).toBeGreaterThanOrEqual(before + 240 * 60_000);
      expect(v.retryContext.loopWebhookWait).toMatchObject({ prNumber: 42 });
      expect(v.retryContext.failureContext).toBeUndefined();
    });
  }

  it('waits rather than failing on the last attempt', async () => {
    taskRow = { ...baseTask, loopIteration: 2 };
    completingWorker = { prLifecycleStatus: 'ci_running', prNumber: 42, mergedAt: null };
    const v = await loopPolicy(input);
    expect(v?.kind === 'hold' && v.until).toBe('webhook');
    expect(v?.progress.iteration).toBe(2);
  });

  it('honours a configured waitExpiryMinutes', async () => {
    taskRow = { ...baseTask, loopConfig: { ...baseTask.loopConfig, waitExpiryMinutes: 30 } };
    completingWorker = { prLifecycleStatus: 'ci_running', prNumber: 42, mergedAt: null };
    const before = Date.now();
    const v = await loopPolicy(input);
    if (v?.kind !== 'hold') throw new Error('expected hold');
    expect(v.startAt!.getTime()).toBeLessThan(before + 31 * 60_000);
  });

  it('spends the attempt when the task already waited once on this PR', async () => {
    taskRow = { ...baseTask, loopIteration: 0, context: { loopWebhookWait: { prNumber: 42 } } };
    completingWorker = { prLifecycleStatus: 'ci_running', prNumber: 42, mergedAt: null };
    const v = await loopPolicy(input);
    if (v?.kind !== 'hold') throw new Error('expected hold');
    expect(v.until).toBe('requeue');
    expect(v.progress.iteration).toBe(1);
  });

  it('requeues when there is no PR at all, so the next session can open one', async () => {
    const v = await loopPolicy(input);
    expect(v?.kind === 'hold' && v.until).toBe('requeue');
    expect(v?.progress.iteration).toBe(2);
  });

  it('requeues when CI failed: there is work for the next session', async () => {
    completingWorker = { prLifecycleStatus: 'ci_failed', prNumber: 42, mergedAt: null };
    const v = await loopPolicy(input);
    expect(v?.kind === 'hold' && v.until).toBe('requeue');
  });
});

describe("loopPolicy resolves the task's own PR from an earlier worker", () => {
  it('passes when a second worker with no PR completes after the task PR merged', async () => {
    completingWorker = noPr;
    priorPrWorker = { prLifecycleStatus: 'merged', prNumber: 77, mergedAt: new Date() };
    const v = await loopPolicy(input);
    expect(v?.kind).toBe('pass');
  });

  it("waits on the earlier worker's PR while its CI runs", async () => {
    completingWorker = noPr;
    priorPrWorker = { prLifecycleStatus: 'ci_running', prNumber: 77, mergedAt: null };
    const v = await loopPolicy(input);
    expect(v?.kind === 'hold' && v.until).toBe('webhook');
    expect(v?.kind === 'hold' && v.retryContext.loopWebhookWait).toMatchObject({ prNumber: 77 });
  });
});

// 92a439a6 (#5179): the owner loop spent its attempts while the kernel was reviewing and refreshing its PR.
describe('loopPolicy on a kernel owner while the kernel owns the PR', () => {
  const owned = (state: string, o: Partial<NonNullable<typeof ownerDelivery>> = {}) => {
    ownerDelivery = { state, prNumber: 42, mergedAt: null, ...o };
    taskRow = { ...baseTask, loopIteration: 2, context: { loopHistory: [], loopWebhookWait: { prNumber: 42 } } };
  };

  for (const state of ['AWAITING_REVIEW', 'REPAIRING', 'LANDING', 'APPROVED', 'BLOCKED_ON_TRUNK']) {
    it(`holds for the delivery without spending an iteration, across repeated completions (${state})`, async () => {
      owned(state);
      completingWorker = { prLifecycleStatus: 'ci_running', prNumber: 42, mergedAt: null };
      for (let i = 0; i < 3; i++) {
        const v = await loopPolicy(input);
        if (v?.kind !== 'hold') throw new Error(`expected hold, got ${v?.kind}`);
        expect(v.until).toBe('webhook');
        expect(v.progress.iteration).toBe(2);
        expect(v.retryContext.failureContext).toBeUndefined();
      }
    });
  }

  it('holds even when no worker row carries the PR (the delivery does)', async () => {
    owned('REPAIRING');
    const v = await loopPolicy(input);
    expect(v?.kind === 'hold' && v.until).toBe('webhook');
  });

  it('a MERGED delivery satisfies pr_checks_green and pr_merged', async () => {
    owned('MERGED', { mergedAt: '2026-10-18T10:00:00Z' });
    expect((await loopPolicy(input))?.kind).toBe('pass');
    taskRow = { ...taskRow, loopConfig: { exitCondition: { type: 'pr_merged' }, maxLoops: 3, backoffMinutes: 0 } };
    expect((await loopPolicy(input))?.kind).toBe('pass');
  });

  it('a delivery waiting on the owner (WORKING) is evaluated as before', async () => {
    owned('WORKING');
    completingWorker = { prLifecycleStatus: 'ci_failed', prNumber: 42, mergedAt: null };
    expect((await loopPolicy(input))?.kind).toBe('fail');
  });

  // fe45dc7d (#5539): the delivery escalated to a person, and the loop kept running passes that
  // pushed commits the kernel ignored, then failed the task "exhausted" over the escalation.
  it('an ESCALATED delivery stands the loop down: no pass dispatched, no iteration spent, no failure', async () => {
    owned('ESCALATED');
    completingWorker = { prLifecycleStatus: 'ci_failed', prNumber: 42, mergedAt: null };
    for (const iteration of [2, 3]) {
      taskRow = { ...taskRow, loopIteration: iteration };
      const v = await loopPolicy(input);
      if (v?.kind !== 'defer') throw new Error(`expected defer, got ${v?.kind}`);
      expect(v.progress.iteration).toBe(iteration);
      expect(v.deliveryState).toBe('ESCALATED');
    }
  });

  it('an ESCALATED delivery that has since merged still satisfies the loop', async () => {
    owned('MERGED', { mergedAt: '2026-10-18T10:00:00Z' });
    expect((await loopPolicy(input))?.kind).toBe('pass');
  });

  it('a structured-predicate loop ignores the delivery', async () => {
    owned('AWAITING_REVIEW');
    taskRow = { ...taskRow, loopConfig: { exitCondition: { type: 'structured_predicate', path: '/ok', op: 'eq', value: true }, maxLoops: 3, backoffMinutes: 0 } };
    expect((await loopPolicy(input))?.kind).toBe('fail');
  });
});
