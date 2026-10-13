/**
 * The checks list's Code review row (docs/specs/task-page.md §Code review
 * detail): it opens to the round's findings or a truthful account of why
 * there are none, never to a bare "This review run".
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import TaskChecks from './TaskChecks';
import { deriveTaskChecks, type ChecksInput, type ReviewFindings } from '@/lib/task-checks';
import type { DeliveryView } from '@/lib/workflow/projections';

type RoundSnapshot = DeliveryView['rounds'][number];

const HEAD = '9adf94e000000';
const R = (o: Partial<RoundSnapshot> = {}): RoundSnapshot => ({
  id: 'r1', round: 1, headSha: HEAD, kind: 'full', status: 'queued', verdict: null, effectiveVerdict: null, failureCount: 0, reviewerTaskId: 'rev1', ...o,
});
const V = (o: Partial<ChecksInput> = {}): ChecksInput => ({
  state: 'AWAITING_REVIEW', stateReason: null, prNumber: 4562, headSha: HEAD, prState: 'awaiting_ci',
  rounds: [], ledger: [], approvedCurrentHead: false, approvalBasis: null, ...o,
});
const DECIDED = R({ status: 'decided', verdict: 'approve', effectiveVerdict: 'approve' });

function render(v: ChecksInput, o: { findings?: Record<string, ReviewFindings>; current?: string; unavailable?: boolean } = {}) {
  return renderToStaticMarkup(
    <TaskChecks
      checks={deriveTaskChecks(v)}
      prNumber={v.prNumber}
      prUrl="https://github.com/example/app/pull/4562"
      headSha={v.headSha}
      findings={new Map(Object.entries(o.findings ?? {}))}
      findingsUnavailable={o.unavailable}
      currentTaskId={o.current ?? 'rev1'}
    />,
  );
}

/** The Code review <li>, from its opening tag to the next row. */
const reviewItem = (html: string) => {
  const start = html.indexOf('data-check="review"');
  const end = html.indexOf('data-check="tests"');
  return html.slice(start, end > start ? end : undefined);
};

describe('TaskChecks — Code review detail', () => {
  test('self, queued: a disclosure saying the review is queued with no findings yet, on round 1 at head 9adf94e', () => {
    const li = reviewItem(render(V({ rounds: [R()] }), { findings: { rev1: { prose: null, verdict: null, status: 'pending' } } }));
    expect(li).toContain('<details');
    expect(li).toContain('Review queued · no findings yet');
    expect(li).toContain('Round 1 · head 9adf94e');
    expect(li).not.toContain('This review run');
    expect(li).not.toContain('Open review run');
  });

  test('self, running: says in progress, no findings, no invented start time', () => {
    const li = reviewItem(render(V({ rounds: [R({ status: 'reviewing' })] }), { findings: { rev1: { prose: null, verdict: null, status: 'in_progress' } } }));
    expect(li).toContain('Review in progress · no findings yet');
    expect(li).not.toMatch(/started|ago/i);
  });

  test('self, completed with findings: the prose renders and there is no link to this page', () => {
    const li = reviewItem(render(V({ state: 'APPROVED', rounds: [DECIDED], approvedCurrentHead: true }), {
      findings: { rev1: { prose: 'Renumber is detected as a renumber.\n\nNo blocking findings.', verdict: 'approve', status: 'completed' } },
    }));
    expect(li).toContain('data-testid="task-check-findings"');
    expect(li).toContain('No blocking findings.');
    expect(li).not.toContain('This review run');
    expect(li).not.toContain('/app/tasks/rev1');
  });

  test('another task\'s review: findings plus the 44px "Open review run" link', () => {
    const li = reviewItem(render(V({ rounds: [DECIDED] }), { current: 'deliverable', findings: { rev1: { prose: 'Looks right.', verdict: 'approve', status: 'completed' } } }));
    expect(li).toMatch(/<a class="[^"]*min-h-11[^"]*" href="\/app\/tasks\/rev1">Open review run ›/);
  });

  test('missing output: says the review left no written findings and never "Approved" in the detail', () => {
    const li = reviewItem(render(V({ rounds: [DECIDED] }), { findings: { rev1: { prose: null, verdict: null, status: 'completed' } } }));
    expect(li).toContain('The review finished without written findings');
    const detail = li.slice(li.indexOf('</summary>'));
    expect(detail).not.toMatch(/approv/i);
  });

  test('failed retrieval: explicit, with a Try again link back to this page', () => {
    const li = reviewItem(render(V({ rounds: [DECIDED] }), { unavailable: true }));
    expect(li).toContain('Couldn’t load the review’s findings');
    expect(li).toMatch(/data-testid="task-check-review-retry"[^>]*class="[^"]*min-h-11/);
    expect(li).toContain('href="/app/tasks/rev1"');
  });

  test('stale round: the head-A approval is history, so the current row is not a disclosure and shows none of its findings', () => {
    const html = render(V({ rounds: [R({ ...DECIDED, headSha: 'aaaaaaa1111' })] }), { current: 'deliverable', findings: { rev1: { prose: 'Old findings on head A.', verdict: 'approve', status: 'completed' } } });
    const li = reviewItem(html);
    expect(li).toContain('Awaiting review');
    expect(li).not.toContain('<details');
    expect(li).not.toContain('Old findings on head A.');
    expect(html).toContain('data-testid="task-checks-history"');
  });

  test('a row with nothing to add is not expandable', () => {
    const li = reviewItem(render(V({ approvalBasis: 'policy' })));
    expect(li).toContain('Not required by policy');
    expect(li).not.toContain('<details');
  });
});
