/**
 * The checks list's Code review row (docs/specs/task-page.md §Code review
 * detail): it opens to the round's findings or a truthful account of why
 * there are none, never to a bare "This review run".
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import TaskChecks from './TaskChecks';
import { deriveTaskChecks, REVIEW_FINDINGS_ANCHOR, type ChecksInput, type ReviewFindings } from '@/lib/task-checks';
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

describe('TaskChecks — the review status link lands on the findings (R-43)', () => {
  const ID = `id="${REVIEW_FINDINGS_ANCHOR}"`;
  test('the anchor sits inside the Code review disclosure, so following the link opens it to the findings', () => {
    const html = render(V({ state: 'CHANGES_REQUESTED', rounds: [R({ status: 'decided', verdict: 'request_changes', effectiveVerdict: 'request_changes' })] }), {
      findings: { rev1: { prose: 'Rename the flag.', verdict: 'request_changes', status: 'completed' } },
    });
    const li = reviewItem(html);
    expect(html.split(ID)).toHaveLength(2);
    const details = li.indexOf('<details');
    const anchor = li.indexOf(ID);
    expect(details).toBeGreaterThanOrEqual(0);
    expect(anchor).toBeGreaterThan(li.indexOf('</summary>'));
    expect(anchor).toBeLessThan(li.indexOf('task-check-findings'));
  });
  test('a review row with nothing to open still carries the anchor, once', () => {
    const html = render(V({ rounds: [] }));
    expect(html.split(ID)).toHaveLength(2);
    expect(reviewItem(html)).toContain(ID);
  });
});

// Task Page AC-28 / AC-29 (Living Spec b84aa682 r4): the rule mobile-decision-flow §3.7 states for
// the mission timeline, applied here. A review that blocks is open without a tap, with its verdict,
// the round and each open finding once; an approved or merged review stays a closed disclosure.
describe('TaskChecks — a blocking review is open, an approved one is not', () => {
  const { deriveDeliveryView } = require('@/lib/workflow/projections') as typeof import('@/lib/workflow/projections');
  const delivery = {
    id: 'd1', workspaceId: 'w1', ownerTaskId: 't1', repoFullName: 'example/app', prNumber: 4562, baseRef: 'dev',
    stateReason: null, version: 5, currentHeadSha: HEAD, currentRound: 2, maxRounds: 3,
    boundAttemptId: null, resumeState: null, trunkIncidentId: null, approvedHeads: [], approvalBasis: null,
    compositionHeads: [], ci: null, ciHeadSha: null, mergeable: null, mergeableHeadSha: null, mergedAt: null,
    mergeCommitSha: null, supersededByPr: null,
  } as const;
  const finding = {
    id: 'round1abcd:0', originRoundId: 'round1abcd', originRound: 1, originHeadSha: 'H1', ordinal: 0, path: 'src/a.ts', line: 4, title: 'off by one',
    required: true, status: 'open' as const, lastRound: 2, addressedBySha: null, closedByRoundId: null, closedBy: null, closedReason: null, deferredToTaskId: null,
    remedyClass: 'code_fix' as const, restatedCount: 2,
  };
  const rc = R({ id: 'r2', round: 2, status: 'decided', verdict: 'request_changes', effectiveVerdict: 'request_changes' });
  const viewOf = (d: Partial<typeof delivery> & { state: string }, rounds = [rc], findings = [finding]) =>
    deriveDeliveryView({ view: { delivery: { ...delivery, ...d } as never, rounds, attempts: [], findings } })!;

  for (const [name, d] of [
    ['changes requested', { state: 'CHANGES_REQUESTED' }],
    ['a review escalation', { state: 'ESCALATED', stateReason: 'review_escalated' }],
    ['a spent review budget', { state: 'ESCALATED', stateReason: 'review_exhausted' }],
  ] as const) {
    test(`${name}: open without a tap, the round and each open finding once`, () => {
      const li = reviewItem(render(viewOf(d as never)));
      expect(li).toMatch(/<details[^>]*\sopen=""/);
      expect(li).toContain('Round 2 · head 9adf94e');
      expect(li).toContain('2 of 3 review rounds spent');
      expect(li).toContain('src/a.ts:4: off by one');
      expect(li).toContain('restated 2 times');
      expect(li.split('off by one').length).toBe(2);
    });
  }

  test('a failed round: open, and says the run ended without a verdict', () => {
    const li = reviewItem(render(viewOf({ state: 'AWAITING_REVIEW' }, [R({ id: 'r2', round: 2, status: 'failed' })], [])));
    expect(li).toMatch(/<details[^>]*\sopen=""/);
    expect(li).toContain('The review run ended before giving a verdict');
  });

  test('approved: a closed disclosure that opens on tap or at the findings anchor', () => {
    const ok = R({ id: 'r2', round: 2, status: 'decided', verdict: 'approve', effectiveVerdict: 'approve' });
    const li = reviewItem(render(viewOf({ state: 'APPROVED', approvedHeads: [HEAD] as never, approvalBasis: 'verdict' as never }, [ok], [])));
    expect(li).toContain('<details');
    expect(li).not.toMatch(/<details[^>]*\sopen=""/);
    expect(li).toContain(`id="${REVIEW_FINDINGS_ANCHOR}"`);
  });

  test('merged: closed', () => {
    const ok = R({ id: 'r2', round: 2, status: 'decided', verdict: 'approve', effectiveVerdict: 'approve' });
    const li = reviewItem(render(viewOf({ state: 'MERGED' }, [ok], [])));
    expect(li).not.toMatch(/<details[^>]*\sopen=""/);
  });
});
