/**
 * CondensedTimeline test suite — covers:
 * I-8:  SegmentStrip in collapsed disclosure rows (§3.4)
 * §3.6: Bookkeeping footer
 * §3.7: Approved verdict collapses to chip
 * §3.8: Wave-banded done section
 */
import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import CondensedTimeline from './CondensedTimeline';
import type { CondensedTimelineProps, CondensedTimelineTask, BookkeepingTask } from './CondensedTimeline';
import type { ChainUnit } from '@/lib/condensed-timeline';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeTask(id: string, overrides: Partial<CondensedTimelineTask> = {}): CondensedTimelineTask {
  return {
    id,
    title: `Task ${id}`,
    status: 'pending',
    taskCreatedAt: '2025-01-01T00:00:00Z',
    taskUpdatedAt: '2025-01-01T00:00:00Z',
    roleColor: '#8A8478',
    chain: null,
    latestWorker: null,
    taskType: null,
    reviewerNote: null,
    reviewerTaskHref: null,
    reviewerRetryTask: null,
    ...overrides,
  };
}

const makeSeg = (taskId: string, state = 'solid' as const) => ({ taskId, state });
const toChain = (task: CondensedTimelineTask): ChainUnit<CondensedTimelineTask> => ({
  head: task,
  tail: [],
  shape: 'standalone',
});

const emptyGroups = {
  waitingOnYou: [],
  running: [],
  nextQueued: [],
  blocked: [],
  done: [],
  failed: [],
};

const baseProps: CondensedTimelineProps = {
  groups: emptyGroups,
  segments: [],
  effectivePolicyTier: 'human',
  policyLabel: 'Human Gate',
  missionId: 'mission-1',
  allTasksCount: 0,
  missionCompleted: false,
  bookkeepingTasks: [],
  view: 'timeline',
  prsMerged: 0,
  prsOpen: 0,
  completedTasks: 0,
  totalTasks: 0,
};

// ─── I-8: SegmentStrip in collapsed disclosure rows ───────────────────────────

describe('CondensedTimeline — I-8: SegmentStrip in collapsed disclosure rows', () => {

  it('renders a SegmentStrip on the collapsed done band disclosure row', () => {
    const doneTasks = [
      makeTask('t1', { status: 'completed' }),
      makeTask('t2', { status: 'completed' }),
    ];
    const html = renderToStaticMarkup(
      <CondensedTimeline
        {...baseProps}
        groups={{ ...emptyGroups, done: doneTasks.map(toChain) }}
        segments={[makeSeg('t1'), makeSeg('t2')]}
        allTasksCount={2}
      />,
    );
    expect(html).toContain('height:4px');
    expect(html).toContain('max-width:80px');
  });

  it('strip on done/failed row uses only done+failed task segments (not all segments)', () => {
    const doneTasks = [makeTask('done1', { status: 'completed' })];
    const failedTasks = [makeTask('fail1', { status: 'failed' })];
    const html = renderToStaticMarkup(
      <CondensedTimeline
        {...baseProps}
        groups={{ ...emptyGroups, done: doneTasks.map(toChain), failed: failedTasks.map(toChain) }}
        segments={[
          makeSeg('done1', 'solid'),
          makeSeg('fail1', 'notch'),
        ]}
        allTasksCount={2}
      />,
    );
    expect(html).toContain('height:4px');
    expect(html).toContain('max-width:80px');
  });

  it('renders a SegmentStrip on the collapsed "N more queued" disclosure row', () => {
    const queuedTasks = Array.from({ length: 5 }, (_, i) => makeTask(`q${i}`, { status: 'pending' }));
    const html = renderToStaticMarkup(
      <CondensedTimeline
        {...baseProps}
        groups={{ ...emptyGroups, nextQueued: queuedTasks.map(toChain) }}
        segments={queuedTasks.map(t => makeSeg(t.id, 'empty'))}
        allTasksCount={5}
      />,
    );
    expect(html).toContain('height:4px');
    expect(html).toContain('max-width:80px');
  });

  it('does NOT add a SegmentStrip overflow button when ≤3 queued tasks (no overflow)', () => {
    const queuedTasks = Array.from({ length: 3 }, (_, i) => makeTask(`q${i}`, { status: 'pending' }));
    const html = renderToStaticMarkup(
      <CondensedTimeline
        {...baseProps}
        groups={{ ...emptyGroups, nextQueued: queuedTasks.map(toChain) }}
        segments={queuedTasks.map(t => makeSeg(t.id, 'empty'))}
        allTasksCount={3}
      />,
    );
    expect(html).not.toContain('height:4px');
    expect(html).not.toContain('max-width:80px');
  });

  // The section-level blocked collapse was retired by the chain grouping pass (spec §5).
  // Blocked tasks are always shown; only individual chains collapse when >4 tail members.
  it('does NOT render a SegmentStrip for the blocked section — collapse retired by chain grouping', () => {
    const blockedTasks = Array.from({ length: 3 }, (_, i) => makeTask(`b${i}`, { status: 'pending' }));
    const html = renderToStaticMarkup(
      <CondensedTimeline
        {...baseProps}
        groups={{ ...emptyGroups, blocked: blockedTasks.map(toChain) }}
        segments={blockedTasks.map(t => makeSeg(t.id, 'empty'))}
        allTasksCount={3}
      />,
    );
    expect(html).not.toContain('height:4px');
    expect(html).not.toContain('max-width:80px');
  });

  it('does not render a SegmentStrip when there are no segments for a group', () => {
    const doneTasks = [makeTask('t1', { status: 'completed' })];
    const html = renderToStaticMarkup(
      <CondensedTimeline
        {...baseProps}
        groups={{ ...emptyGroups, done: doneTasks.map(toChain) }}
        segments={[]}
        allTasksCount={1}
      />,
    );
    expect(html).not.toContain('height:4px');
    expect(html).not.toContain('max-width:80px');
  });
});

// ─── §3.5: Density tiers — Summary vs Timeline ───────────────────────────────
// Note: Summary/Timeline tab switching is now handled by MissionTabs (the parent).
// CondensedTimeline renders only the view specified by the `view` prop.

describe('CondensedTimeline — §3.5 density tiers', () => {
  it('renders PR roll-up in Summary view', () => {
    const html = renderToStaticMarkup(
      <CondensedTimeline
        {...baseProps}
        view="summary"
        allTasksCount={10}
        prsMerged={5}
        prsOpen={2}
      />,
    );
    expect(html).toContain('5 PRs merged');
    expect(html).toContain('2 open');
  });

  it('shows Waiting on you section in Summary view', () => {
    const waitingTask = makeTask('w1', { status: 'completed' });
    const html = renderToStaticMarkup(
      <CondensedTimeline
        {...baseProps}
        view="summary"
        allTasksCount={10}
        groups={{ ...emptyGroups, waitingOnYou: [toChain(waitingTask)] }}
      />,
    );
    expect(html).toContain('Waiting on you');
    expect(html).toContain('Task w1');
  });

  it('shows "Waiting on" status line for running tasks in Summary view', () => {
    const runningTask = makeTask('r1', { status: 'in_progress' });
    const html = renderToStaticMarkup(
      <CondensedTimeline
        {...baseProps}
        view="summary"
        allTasksCount={5}
        groups={{ ...emptyGroups, running: [toChain(runningTask)] }}
      />,
    );
    expect(html).toContain('Waiting on:');
    expect(html).toContain('1 task running');
  });

  it('renders TimelineView when view=timeline', () => {
    const runningTask = makeTask('r1', { status: 'in_progress' });
    const html = renderToStaticMarkup(
      <CondensedTimeline
        {...baseProps}
        view="timeline"
        allTasksCount={1}
        groups={{ ...emptyGroups, running: [toChain(runningTask)] }}
      />,
    );
    // Running tasks are always visible (not collapsed) in the timeline view
    expect(html).toContain('Task r1');
  });

  it('does NOT render MissionProgressBar inside Summary view (progress bar lives in page header)', () => {
    const seg = makeSeg('t1', 'solid');
    const html = renderToStaticMarkup(
      <CondensedTimeline
        {...baseProps}
        view="summary"
        allTasksCount={5}
        completedTasks={3}
        totalTasks={5}
        segments={[seg]}
      />,
    );
    // Progress bar with segment strip is NOT inside the SummaryView instance.
    // It lives in the page header card (page.tsx) to avoid double-rendering.
    expect(html).not.toContain('height:8px');
  });

  it('shows "No actions needed" only when criteria are passing and nothing is in flight', () => {
    const html = renderToStaticMarkup(
      <CondensedTimeline
        {...baseProps}
        view="summary"
        allTasksCount={5}
      />,
    );
    expect(html).toContain('No actions needed');
  });

  it('does NOT show "No actions needed" when criteriaBlockingReason is set', () => {
    const html = renderToStaticMarkup(
      <CondensedTimeline
        {...baseProps}
        view="summary"
        allTasksCount={5}
        criteriaBlockingReason="criterion failing: all_prs_merged"
      />,
    );
    expect(html).not.toContain('No actions needed');
    expect(html).toContain('Completion blocked');
  });
});

// ─── §3.6: Bookkeeping footer ─────────────────────────────────────────────────

describe('CondensedTimeline — §3.6 bookkeeping footer', () => {
  const makeBookkeeping = (id: string, updatedAt: string): BookkeepingTask => ({
    id,
    title: `[reviewer] Task ${id}`,
    taskUpdatedAt: updatedAt,
    latestWorker: null,
  });

  it('renders bookkeeping footer when bookkeepingTasks is non-empty', () => {
    const html = renderToStaticMarkup(
      <CondensedTimeline
        {...baseProps}
        groups={{ ...emptyGroups, done: [toChain(makeTask('t1', { status: 'completed' }))] }}
        bookkeepingTasks={[makeBookkeeping('b1', '2025-01-01T00:00:00Z')]}
        allTasksCount={1}
      />,
    );
    expect(html).toContain('orchestrator');
  });

  it('shows count of bookkeeping runs in footer', () => {
    const html = renderToStaticMarkup(
      <CondensedTimeline
        {...baseProps}
        groups={{ ...emptyGroups, done: [toChain(makeTask('t1', { status: 'completed' }))] }}
        bookkeepingTasks={[
          makeBookkeeping('b1', '2025-01-01T00:00:00Z'),
          makeBookkeeping('b2', '2025-01-02T00:00:00Z'),
          makeBookkeeping('b3', '2025-01-03T00:00:00Z'),
        ]}
        allTasksCount={1}
      />,
    );
    expect(html).toContain('3 orchestrator runs');
  });

  it('does NOT render bookkeeping footer when bookkeepingTasks is empty', () => {
    const html = renderToStaticMarkup(
      <CondensedTimeline
        {...baseProps}
        groups={{ ...emptyGroups, done: [toChain(makeTask('t1', { status: 'completed' }))] }}
        bookkeepingTasks={[]}
        allTasksCount={1}
      />,
    );
    expect(html).not.toContain('orchestrator');
  });
});

// ─── §3.7: Approved verdict collapses to chip ─────────────────────────────────

describe('CondensedTimeline — §3.7 verdict collapse', () => {
  const approvedTask = makeTask('t1', {
    status: 'completed',
    reviewerNote: {
      type: 'reviewer_approved',
      title: 'Approved (confidence 0.92)',
      body: 'Looks good',
      status: 'active',
      supersededByPrNumber: null,
    },
    reviewerTaskHref: null,
  });

  it('renders confidence chip instead of full verdict prose for approved verdicts', () => {
    const html = renderToStaticMarkup(
      <CondensedTimeline
        {...baseProps}
        groups={{ ...emptyGroups, waitingOnYou: [toChain(approvedTask)] }}
        allTasksCount={1}
      />,
    );
    // Chip: ✓ 0.92 — collapsed by default
    expect(html).toContain('✓');
    expect(html).toContain('0.92');
    // Full verdict prose should NOT appear (collapsed)
    expect(html).not.toContain('Looks good');
    expect(html).not.toContain('Merging automatically');
  });

  it('suppresses PR status line for approved verdicts (chip is the only affordance)', () => {
    const approvedWithPr = makeTask('t1-pr', {
      status: 'completed',
      latestWorker: {
        id: 'w1',
        status: 'completed',
        prUrl: 'https://github.com/repo/pull/42',
        prNumber: 42,
        prLifecycleStatus: 'pr_open',
        mergedAt: null,
        completedAt: null,
        startedAt: null,
        currentAction: null,
        branch: 'my-branch',
        waitingFor: null,
      },
      reviewerNote: {
        type: 'reviewer_approved',
        title: 'Approved (confidence 0.88)',
        body: 'LGTM',
        status: 'active',
        supersededByPrNumber: null,
      },
      reviewerTaskHref: null,
    });
    const html = renderToStaticMarkup(
      <CondensedTimeline
        {...baseProps}
        groups={{ ...emptyGroups, waitingOnYou: [toChain(approvedWithPr)] }}
        allTasksCount={1}
      />,
    );
    // Chip shows; PR line (#42) should not appear as a separate element
    expect(html).toContain('✓');
    expect(html).not.toContain('#42');
  });

  it('renders Changes Requested verdict fully expanded (not collapsed)', () => {
    const changesTask = makeTask('t2', {
      status: 'completed',
      reviewerNote: {
        type: 'reviewer_request_changes',
        title: 'Changes Requested (iteration 1/3)',
        body: 'Please fix the handler',
        status: 'active',
        supersededByPrNumber: null,
      },
      reviewerTaskHref: null,
    });
    const html = renderToStaticMarkup(
      <CondensedTimeline
        {...baseProps}
        groups={{ ...emptyGroups, waitingOnYou: [toChain(changesTask)] }}
        allTasksCount={1}
      />,
    );
    // Full verdict visible — not collapsed to chip
    expect(html).toContain('Changes Requested');
    expect(html).toContain('Please fix the handler');
  });

  it('shows "queued" status when reviewer retry task is pending', () => {
    const changesTask = makeTask('t-cr-queued', {
      status: 'completed',
      reviewerNote: {
        type: 'reviewer_request_changes',
        title: 'Changes Requested (iteration 1/3)',
        body: 'Fix the imports',
        status: 'active',
        supersededByPrNumber: null,
      },
      reviewerRetryTask: {
        id: 'retry-task-1',
        status: 'pending',
        title: '[reviewer retry #1] Build something',
        prNumber: null,
      },
    });
    const html = renderToStaticMarkup(
      <CondensedTimeline
        {...baseProps}
        groups={{ ...emptyGroups, waitingOnYou: [toChain(changesTask)] }}
        allTasksCount={1}
      />,
    );
    expect(html).toContain('retry #1');
    expect(html).toContain('queued');
    expect(html).not.toContain('done');
    expect(html).not.toContain('failed');
  });

  it('shows "running" status when reviewer retry task is in-progress', () => {
    const changesTask = makeTask('t-cr-running', {
      status: 'completed',
      reviewerNote: {
        type: 'reviewer_request_changes',
        title: 'Changes Requested (iteration 1/3)',
        body: 'Fix the imports',
        status: 'active',
        supersededByPrNumber: null,
      },
      reviewerRetryTask: {
        id: 'retry-task-2',
        status: 'running',
        title: '[reviewer retry #1] Build something',
        prNumber: null,
      },
    });
    const html = renderToStaticMarkup(
      <CondensedTimeline
        {...baseProps}
        groups={{ ...emptyGroups, waitingOnYou: [toChain(changesTask)] }}
        allTasksCount={1}
      />,
    );
    expect(html).toContain('retry #1');
    expect(html).toContain('running');
  });

  it('shows "done" status with PR number when reviewer retry task completed', () => {
    const changesTask = makeTask('t-cr-done', {
      status: 'completed',
      reviewerNote: {
        type: 'reviewer_request_changes',
        title: 'Changes Requested (iteration 1/3)',
        body: 'Fix the imports',
        status: 'active',
        supersededByPrNumber: null,
      },
      reviewerRetryTask: {
        id: 'retry-task-3',
        status: 'completed',
        title: '[reviewer retry #1] Build something',
        prNumber: 1968,
      },
    });
    const html = renderToStaticMarkup(
      <CondensedTimeline
        {...baseProps}
        groups={{ ...emptyGroups, waitingOnYou: [toChain(changesTask)] }}
        allTasksCount={1}
      />,
    );
    expect(html).toContain('retry #1');
    expect(html).toContain('done');
    expect(html).toContain('#1968');
  });

  it('shows "failed" status when reviewer retry task failed', () => {
    const changesTask = makeTask('t-cr-failed', {
      status: 'completed',
      reviewerNote: {
        type: 'reviewer_request_changes',
        title: 'Changes Requested (iteration 1/3)',
        body: 'Fix the imports',
        status: 'active',
        supersededByPrNumber: null,
      },
      reviewerRetryTask: {
        id: 'retry-task-4',
        status: 'failed',
        title: '[reviewer retry #1] Build something',
        prNumber: null,
      },
    });
    const html = renderToStaticMarkup(
      <CondensedTimeline
        {...baseProps}
        groups={{ ...emptyGroups, waitingOnYou: [toChain(changesTask)] }}
        allTasksCount={1}
      />,
    );
    expect(html).toContain('retry #1');
    expect(html).toContain('failed');
  });

  it('renders escalated verdict fully expanded', () => {
    const escalatedTask = makeTask('t3', {
      status: 'completed',
      reviewerNote: {
        type: 'reviewer_escalated',
        title: 'Escalated',
        body: 'Human review needed',
        status: 'active',
        supersededByPrNumber: null,
      },
      reviewerTaskHref: null,
    });
    const html = renderToStaticMarkup(
      <CondensedTimeline
        {...baseProps}
        groups={{ ...emptyGroups, waitingOnYou: [toChain(escalatedTask)] }}
        allTasksCount={1}
      />,
    );
    expect(html).toContain('Escalated to you');
    expect(html).toContain('Human review needed');
  });
});
