import { describe, it, expect, beforeEach, mock } from 'bun:test';

// ── Fetch mock (callback delivery) ────────────────────────────────────────────

type FetchCall = { url: string; init: RequestInit };
const fetchCalls: FetchCall[] = [];
let fetchShouldThrow = false;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  fetchCalls.length = 0;
  fetchShouldThrow = false;
  globalThis.fetch = (async (url: any, init: any = {}) => {
    fetchCalls.push({ url: String(url), init });
    if (fetchShouldThrow) throw new Error('connect ECONNREFUSED');
    return new Response('ok', { status: 200 });
  }) as typeof fetch;
});

const {
  derivePrReviewStatus,
  pickReviewerRole,
  firePrReviewCallback,
  REVIEW_CALLBACK_TIMEOUT_MS,
} = await import('./pr-review-status');

// ── Fixtures ──────────────────────────────────────────────────────────────────

function reviewTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 'review-task-1',
    status: 'in_progress',
    result: null,
    context: { prNumber: 42, iteration: 0, maxIterations: 3 },
    ...overrides,
  } as any;
}

function verdictResult(verdict: string, extra: Record<string, unknown> = {}) {
  return {
    structuredOutput: {
      verdict,
      confidence: 0.91,
      summary: 'Scoped to the path manifest, fully tested.',
      ...extra,
    },
  };
}

describe('derivePrReviewStatus — review progress', () => {
  it('reports not_requested when no reviewer task exists for the PR', () => {
    const status = derivePrReviewStatus({ reviewTask: null, worker: null });
    expect(status.state).toBe('not_requested');
    expect(status.terminal).toBe(false);
    expect(status.reviewTaskId).toBeNull();
  });

  it('maps a pending reviewer task to queued, and in-flight to reviewing', () => {
    expect(derivePrReviewStatus({ reviewTask: reviewTask({ status: 'pending' }) }).state).toBe('queued');
    expect(derivePrReviewStatus({ reviewTask: reviewTask({ status: 'in_progress' }) }).state).toBe('reviewing');
  });

  it('is not terminal while the review is still running', () => {
    for (const status of ['pending', 'in_progress'] as const) {
      expect(derivePrReviewStatus({ reviewTask: reviewTask({ status }) }).terminal).toBe(false);
    }
  });

  it('surfaces the verdict, confidence and summary once the review completes', () => {
    const status = derivePrReviewStatus({
      reviewTask: reviewTask({ status: 'completed', result: verdictResult('approve') }),
    });
    expect(status.state).toBe('approved');
    expect(status.verdict).toBe('approve');
    expect(status.confidence).toBe(0.91);
    expect(status.summary).toBe('Scoped to the path manifest, fully tested.');
    expect(status.terminal).toBe(true);
  });

  it('maps request-changes and escalate verdicts to their own states', () => {
    const changes = derivePrReviewStatus({
      reviewTask: reviewTask({
        status: 'completed',
        result: verdictResult('request-changes', { feedback: 'Add a regression test.' }),
      }),
    });
    expect(changes.state).toBe('changes_requested');
    expect(changes.feedback).toBe('Add a regression test.');
    expect(changes.iteration).toBe(0);
    expect(changes.maxIterations).toBe(3);

    const escalated = derivePrReviewStatus({
      reviewTask: reviewTask({
        status: 'completed',
        result: verdictResult('escalate', { escalationReason: 'Touches auth' }),
      }),
    });
    expect(escalated.state).toBe('escalated');
    expect(escalated.escalationReason).toBe('Touches auth');
  });

  it('treats a completed review with no verdict as a failed review, not an approval', () => {
    // The verdict only counts as structuredOutput — prose is dropped upstream.
    const status = derivePrReviewStatus({
      reviewTask: reviewTask({ status: 'completed', result: { summary: 'looks fine to me' } }),
    });
    expect(status.state).toBe('review_failed');
    expect(status.verdict).toBeNull();
    expect(status.terminal).toBe(true);
  });

  it('maps a failed or cancelled reviewer task to review_failed', () => {
    for (const s of ['failed', 'cancelled'] as const) {
      const status = derivePrReviewStatus({ reviewTask: reviewTask({ status: s }) });
      expect(status.state).toBe('review_failed');
      expect(status.terminal).toBe(true);
    }
  });
});

describe('derivePrReviewStatus — PR outcome', () => {
  it('reports the merge state from the worker that owns the PR', () => {
    const status = derivePrReviewStatus({
      reviewTask: reviewTask({ status: 'completed', result: verdictResult('approve') }),
      worker: { taskId: 'task-1', prLifecycleStatus: 'merged', mergedAt: new Date('2026-09-03T12:22:52Z') },
    });
    expect(status.prState).toBe('merged');
    expect(status.merged).toBe(true);
    expect(status.adoptedTaskId).toBe('task-1');
  });

  it('a merged or closed PR is terminal even mid-review — nothing more will happen', () => {
    for (const lifecycle of ['merged', 'closed'] as const) {
      const status = derivePrReviewStatus({
        reviewTask: reviewTask({ status: 'in_progress' }),
        worker: { taskId: 'task-1', prLifecycleStatus: lifecycle, mergedAt: null },
      });
      expect(status.terminal).toBe(true);
      expect(status.prState).toBe(lifecycle);
    }
  });

  it('waitFor=merge keeps waiting on an approval that has not landed yet', () => {
    const approved = {
      reviewTask: reviewTask({ status: 'completed', result: verdictResult('approve') }),
      worker: { taskId: 'task-1', prLifecycleStatus: 'ci_running' as const, mergedAt: null },
      autoMergeExpected: true,
    };
    expect(derivePrReviewStatus({ ...approved, waitFor: 'verdict' }).terminal).toBe(true);
    expect(derivePrReviewStatus({ ...approved, waitFor: 'merge' }).terminal).toBe(false);
  });

  it('waitFor=merge stops on an approval the policy will never merge', () => {
    // gateCondition=approve-only: buildd approves, a human presses merge. A
    // caller waiting on the merge would otherwise poll until it timed out.
    const status = derivePrReviewStatus({
      reviewTask: reviewTask({ status: 'completed', result: verdictResult('approve') }),
      worker: { taskId: 'task-1', prLifecycleStatus: 'ci_green', mergedAt: null },
      autoMergeExpected: false,
      waitFor: 'merge',
    });
    expect(status.terminal).toBe(true);
    expect(status.mergeBlocked).toBe('awaiting_human');
  });

  it('waitFor=merge stops on an escalation or a failed review', () => {
    for (const result of [verdictResult('escalate'), null]) {
      const status = derivePrReviewStatus({
        reviewTask: reviewTask({ status: result ? 'completed' : 'failed', result }),
        worker: { taskId: 'task-1', prLifecycleStatus: 'pr_open', mergedAt: null },
        waitFor: 'merge',
      });
      expect(status.terminal).toBe(true);
    }
  });

  it('waitFor=merge keeps waiting through a request-changes retry loop', () => {
    // request-changes dispatches a fix task on the same branch; the PR can
    // still reach a merge, so a merge-waiter must not stop here.
    const status = derivePrReviewStatus({
      reviewTask: reviewTask({ status: 'completed', result: verdictResult('request-changes') }),
      worker: { taskId: 'task-1', prLifecycleStatus: 'pr_open', mergedAt: null },
      waitFor: 'merge',
    });
    expect(status.terminal).toBe(false);
  });
});

describe('pickReviewerRole', () => {
  const roles = [
    { slug: 'builder', isRole: true },
    { slug: 'reviewer', isRole: true },
    { slug: 'organizer', isRole: true },
  ];

  it('prefers an explicitly requested role that exists in the workspace', () => {
    expect(pickReviewerRole({ requested: 'organizer', policyRole: 'builder', available: roles })).toEqual({
      role: 'organizer',
      source: 'requested',
    });
  });

  it('rejects a requested role the workspace does not have, rather than silently substituting', () => {
    const picked = pickReviewerRole({ requested: 'ghost', policyRole: 'builder', available: roles });
    expect(picked.role).toBeNull();
    expect(picked.error).toContain('ghost');
    expect(picked.error).toContain('builder');
  });

  it('falls back to the policy reviewer role, then a reviewer-ish role', () => {
    expect(pickReviewerRole({ policyRole: 'builder', available: roles }).role).toBe('builder');
    expect(pickReviewerRole({ available: roles }).role).toBe('reviewer');
    expect(pickReviewerRole({ available: [{ slug: 'builder', isRole: true }] }).role).toBe('builder');
  });

  it('errors when the workspace has no roles at all', () => {
    const picked = pickReviewerRole({ available: [] });
    expect(picked.role).toBeNull();
    expect(picked.error).toContain('no roles');
  });
});

describe('firePrReviewCallback', () => {
  const payload = { prNumber: 42, state: 'approved' as const, terminal: true };

  it('POSTs the review status as JSON', async () => {
    const ok = await firePrReviewCallback('https://example.test/hook', payload as any);
    expect(ok).toBe(true);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.url).toBe('https://example.test/hook');
    expect(fetchCalls[0]!.init.method).toBe('POST');
    expect((fetchCalls[0]!.init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(fetchCalls[0]!.init.body as string)).toMatchObject({ prNumber: 42, state: 'approved' });
    expect(fetchCalls[0]!.init.signal).toBeDefined();
  });

  it('never throws when the callback endpoint is unreachable', async () => {
    fetchShouldThrow = true;
    expect(await firePrReviewCallback('https://example.test/hook', payload as any)).toBe(false);
  });

  it('refuses a non-https callback URL so a verdict is never posted in the clear', async () => {
    expect(await firePrReviewCallback('http://example.test/hook', payload as any)).toBe(false);
    expect(await firePrReviewCallback('not-a-url', payload as any)).toBe(false);
    expect(fetchCalls).toHaveLength(0);
  });

  it('bounds the delivery attempt so a hanging endpoint cannot stall the caller', () => {
    expect(REVIEW_CALLBACK_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
  });
});
