/**
 * I-8: SegmentStrip in collapsed disclosure rows.
 *
 * Spec §3.4 — collapsed group disclosure rows render a shared <SegmentStrip
 * continuous height={4} maxWidth={80} /> at their right edge, representing
 * only the tasks in that group. No per-surface renderer; no client-side
 * segment computation.
 */
import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import CondensedTimeline from './CondensedTimeline';
import type { CondensedTimelineProps, CondensedTimelineTask } from './CondensedTimeline';

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
    reviewerNote: null,
    reviewerTaskHref: null,
    ...overrides,
  };
}

const makeSeg = (taskId: string, state = 'solid' as const) => ({ taskId, state });

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
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('CondensedTimeline — I-8: SegmentStrip in collapsed disclosure rows', () => {

  // ── Done / Failed disclosure row ─────────────────────────────────────────

  it('renders a SegmentStrip on the collapsed done+failed disclosure row', () => {
    const doneTasks = [
      makeTask('t1', { status: 'completed' }),
      makeTask('t2', { status: 'completed' }),
    ];
    const html = renderToStaticMarkup(
      <CondensedTimeline
        {...baseProps}
        groups={{ ...emptyGroups, done: doneTasks }}
        segments={[makeSeg('t1'), makeSeg('t2')]}
        allTasksCount={2}
      />,
    );
    // Continuous SegmentStrip with height={4} and maxWidth={80} produces these styles
    expect(html).toContain('height:4px');
    expect(html).toContain('max-width:80px');
  });

  it('strip on done/failed row uses only done+failed task segments (not all segments)', () => {
    const doneTasks = [makeTask('done1', { status: 'completed' })];
    const failedTasks = [makeTask('fail1', { status: 'failed' })];
    // Give each group a segment; the done+failed button should show both
    const html = renderToStaticMarkup(
      <CondensedTimeline
        {...baseProps}
        groups={{ ...emptyGroups, done: doneTasks, failed: failedTasks }}
        segments={[
          makeSeg('done1', 'solid'),
          makeSeg('fail1', 'notch'),
        ]}
        allTasksCount={2}
      />,
    );
    // Strip is present (has the two segment colors)
    expect(html).toContain('height:4px');
    expect(html).toContain('max-width:80px');
  });

  // ── Next-queued overflow disclosure row ───────────────────────────────────

  it('renders a SegmentStrip on the collapsed "N more queued" disclosure row', () => {
    // 5 queued tasks — first 3 visible, last 2 behind the overflow button
    const queuedTasks = Array.from({ length: 5 }, (_, i) => makeTask(`q${i}`, { status: 'pending' }));
    const html = renderToStaticMarkup(
      <CondensedTimeline
        {...baseProps}
        groups={{ ...emptyGroups, nextQueued: queuedTasks }}
        segments={queuedTasks.map(t => makeSeg(t.id, 'empty'))}
        allTasksCount={5}
      />,
    );
    expect(html).toContain('height:4px');
    expect(html).toContain('max-width:80px');
  });

  it('does NOT add a SegmentStrip overflow button when ≤3 queued tasks (no overflow)', () => {
    // Exactly 3 queued tasks — all visible, no overflow button
    const queuedTasks = Array.from({ length: 3 }, (_, i) => makeTask(`q${i}`, { status: 'pending' }));
    const html = renderToStaticMarkup(
      <CondensedTimeline
        {...baseProps}
        groups={{ ...emptyGroups, nextQueued: queuedTasks }}
        segments={queuedTasks.map(t => makeSeg(t.id, 'empty'))}
        allTasksCount={3}
      />,
    );
    // No disclosure button at all → no strip
    expect(html).not.toContain('height:4px');
    expect(html).not.toContain('max-width:80px');
  });

  // ── Blocked disclosure row (≥3 tasks) ────────────────────────────────────

  it('renders a SegmentStrip on the collapsed blocked disclosure row when ≥3 blocked tasks', () => {
    const blockedTasks = Array.from({ length: 3 }, (_, i) => makeTask(`b${i}`, { status: 'pending' }));
    const html = renderToStaticMarkup(
      <CondensedTimeline
        {...baseProps}
        groups={{ ...emptyGroups, blocked: blockedTasks }}
        segments={blockedTasks.map(t => makeSeg(t.id, 'empty'))}
        allTasksCount={3}
      />,
    );
    expect(html).toContain('height:4px');
    expect(html).toContain('max-width:80px');
  });

  it('does NOT render a SegmentStrip for the blocked section when ≤2 blocked tasks (always expanded)', () => {
    // ≤2 blocked → always expanded inline, no disclosure button
    const blockedTasks = [
      makeTask('b1', { status: 'pending' }),
      makeTask('b2', { status: 'pending' }),
    ];
    const html = renderToStaticMarkup(
      <CondensedTimeline
        {...baseProps}
        groups={{ ...emptyGroups, blocked: blockedTasks }}
        segments={blockedTasks.map(t => makeSeg(t.id, 'empty'))}
        allTasksCount={2}
      />,
    );
    // Always-expanded: no disclosure button → no strip
    expect(html).not.toContain('height:4px');
    expect(html).not.toContain('max-width:80px');
  });

  // ── Single-renderer guard ─────────────────────────────────────────────────

  it('does not render a SegmentStrip when there are no segments for a group', () => {
    // Done tasks exist but no segments provided for them → SegmentStrip returns null
    const doneTasks = [makeTask('t1', { status: 'completed' })];
    const html = renderToStaticMarkup(
      <CondensedTimeline
        {...baseProps}
        groups={{ ...emptyGroups, done: doneTasks }}
        segments={[]} // no segments for t1
        allTasksCount={1}
      />,
    );
    // SegmentStrip with empty segments array returns null
    expect(html).not.toContain('height:4px');
    expect(html).not.toContain('max-width:80px');
  });
});
