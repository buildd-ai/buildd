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
    expect(outcome.text).toContain('revised task');
  });

  it('reports a rejected proposal as closed, retained, and navigates nowhere', () => {
    const outcome = resolveRejectOutcome({ taskId: null, proposalRejected: true });
    expect(outcome.navigateTo).toBeNull();
    expect(outcome.text).not.toContain('revised task');
    // The two facts a human needs: the reason is kept, and the docs PR stands.
    expect(outcome.text).toContain('reason stays');
    expect(outcome.text).toContain('documentation');
  });

  it('never navigates to a missing task id, whatever flags the response carries', () => {
    expect(resolveRejectOutcome({}).navigateTo).toBeNull();
    expect(resolveRejectOutcome({ taskId: null }).navigateTo).toBeNull();
  });
});

const { renderToStaticMarkup } = await import('react-dom/server');
const { PlanStepDescription, PLAN_STEP_PREVIEW_CHARS } = await import('./PlanReviewPanel');

// Step descriptions were a bare <p>: markdown showed as raw `**` and backticks,
// a long path or URL ran off a phone screen, and a long step pushed the
// Approve / Reject buttons far below the fold.
describe('PlanStepDescription', () => {
  it('renders markdown instead of raw syntax', () => {
    const html = renderToStaticMarkup(<PlanStepDescription content={'Touch **only** `src/lib/example.ts`'} />);
    expect(html).toContain('<strong>only</strong>');
    expect(html).toContain('<code');
    expect(html).not.toContain('**only**');
  });

  it('lets long unbroken paths wrap anywhere', () => {
    const html = renderToStaticMarkup(<PlanStepDescription content="apps/example/src/some/deeply/nested/directory/structure/file-name.ts" />);
    expect(html).toContain('[overflow-wrap:anywhere]');
  });

  it('shows short descriptions in full with no toggle', () => {
    const html = renderToStaticMarkup(<PlanStepDescription content="Add the column." />);
    expect(html).not.toContain('Show more');
  });

  it('clamps long descriptions behind a "Show more" toggle', () => {
    const html = renderToStaticMarkup(<PlanStepDescription content={'word '.repeat(PLAN_STEP_PREVIEW_CHARS)} />);
    expect(html).toContain('line-clamp-4');
    expect(html).toContain('Show more');
    expect(html).toContain('aria-expanded="false"');
  });
});
