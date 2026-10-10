import { describe, expect, it, mock } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';

// "Why this?" mounts its body only while open; render it open.
mock.module('@/components/ui/Disclosure', () => ({
  default: ({ summary, children }: { summary: ReactNode; children: ReactNode }) => <div>{summary}{children}</div>,
}));

const { default: TaskVerdictBlock } = await import('./TaskVerdictBlock');
import type { StoredVerdictDecision, TaskVerdict } from '@/lib/task-verdict';

const verdict: TaskVerdict = {
  state: 'failed',
  headline: 'The run stopped before a PR.',
  cause: null,
  actions: [],
  causeKey: 'failed:run',
  failingChecks: [],
  wordedBy: 'model',
};

const decision = {
  v: '1',
  fingerprint: 'f',
  state: 'failed',
  causeKey: 'failed:run',
  at: '2026-01-01T00:00:00.000Z',
  model: 'demo-model',
  wording: null,
  mismatchDiagnosis: null,
  traceClasses: {},
  decisionIds: [{ kind: 'headline', id: 'aaaaaaaa-0000-4000-8000-000000000000', status: 'applied' }],
} as unknown as StoredVerdictDecision;

const render = (showDecisionRows?: boolean) =>
  renderToStaticMarkup(<TaskVerdictBlock verdict={verdict} decision={decision} displayStatus="failed" showDecisionRows={showDecisionRows} />);

describe('TaskVerdictBlock "Why this?"', () => {
  it('names no decision-ledger rows to a team member: the ledger moved to the admin app', () => {
    const html = render();
    expect(html).toContain('The wording and actions were chosen by the decision model');
    expect(html).not.toContain('data-testid="task-verdict-decisions"');
    expect(html).not.toContain('Decision ledger');
  });

  it('lists the ledger rows for the platform owner', () => {
    const html = render(true);
    expect(html).toContain('data-testid="task-verdict-decisions"');
    expect(html).toContain('Decision ledger: task_verdict');
  });
});
