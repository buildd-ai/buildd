import { describe, it, expect, mock } from 'bun:test';

mock.module('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
}));

const { resolveRejectOutcome } = await import('./PlanReviewPanel');

/**
 * Rejecting a plan has two genuinely different outcomes, and the panel has to
 * tell them apart from the response alone.
 *
 * An ordinary planning cycle respawns a revised planning task, and the reviewer
 * is sent to it. A doc-fix task's plan is an OPTIONAL net-enhancement proposal
 * whose rejection creates nothing — the docs-only PR already shipped, and the
 * reason is retained on the ledger rows instead. That response carries
 * `taskId: null`, so a panel that unconditionally announces a revised task and
 * navigates to it says something untrue and lands on /app/tasks/null.
 */
describe('resolveRejectOutcome', () => {
  it('sends an ordinary rejection to the revised planning task it just created', () => {
    const outcome = resolveRejectOutcome({ taskId: 'task-revised' });
    expect(outcome.navigateTo).toBe('task-revised');
    expect(outcome.text).toContain('revised task created');
  });

  it('reports a rejected proposal as closed, retained, and navigates nowhere', () => {
    const outcome = resolveRejectOutcome({ taskId: null, proposalRejected: true });
    expect(outcome.navigateTo).toBeNull();
    expect(outcome.text).not.toContain('revised task');
    // The two facts a human needs: the reason is kept, and the docs PR stands.
    expect(outcome.text).toContain('reason is kept');
    expect(outcome.text).toContain('documentation');
  });

  it('never navigates to a missing task id, whatever flags the response carries', () => {
    expect(resolveRejectOutcome({}).navigateTo).toBeNull();
    expect(resolveRejectOutcome({ taskId: null }).navigateTo).toBeNull();
  });
});
