/**
 * TaskSheet (docs/design/mission-feed-mobile-continuity.md W4, "Desktop
 * adaptation"): renders synchronously with a skeleton (AC-7), keeps
 * `task-header-status` on the badge (AC-19), opens for a completed task with no
 * PR (AC-10), and carries the micro masthead, "Next needing you" and "Open full
 * page".
 */
import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildMissionFeedGroups } from '@/lib/mission-feed-groups';
import { buildPulseSegments, type MissionFeedTaskInput } from '@/lib/mission-pulse';
import { DRAG_CLOSE_PX, TaskSheetView, shouldDragClose, type TaskSheetMission, type TaskSheetViewProps } from './TaskSheet';
import { eventTaskId, shouldPollSummary, type TaskPanelData } from './TaskPanel';
import { buildTaskSheetNav } from './task-sheet-nav';

// Illustrative fixtures only — no real mission or task data.
const ID = {
  th1: '11111111-1111-4111-8111-111111111111',
  b1: '22222222-2222-4222-8222-222222222222',
  b2: '33333333-3333-4333-8333-333333333333',
  b3: '44444444-4444-4444-8444-444444444444',
};
let clock = Date.UTC(2026, 0, 1);
function t(id: string, over: Partial<MissionFeedTaskInput> = {}): MissionFeedTaskInput {
  clock += 60_000;
  return { id, title: `Task ${id.slice(0, 4)}`, status: 'pending', taskClass: 'work', createdAt: new Date(clock), ...over };
}
const tasks: MissionFeedTaskInput[] = [
  t(ID.th1, { missionPhaseIndex: 0, missionPhaseLabel: 'THINK', status: 'completed' }),
  t(ID.b1, { missionPhaseIndex: 1, missionPhaseLabel: 'BUILD', status: 'in_progress', worker: { status: 'waiting_input' } }),
  t(ID.b2, { missionPhaseIndex: 1, missionPhaseLabel: 'BUILD', status: 'in_progress', worker: { status: 'running' } }),
  t(ID.b3, { missionPhaseIndex: 1, missionPhaseLabel: 'BUILD' }),
];
const mission: TaskSheetMission = {
  id: 'm1',
  title: 'Example mission',
  chip: { label: 'NEEDS YOU', cls: 'border-accent text-accent-text' },
  segments: buildPulseSegments(tasks),
  from: 'home',
};
const model = buildMissionFeedGroups(tasks);

function summaryData(over: Partial<TaskPanelData> = {}): TaskPanelData {
  return {
    id: ID.b2, title: 'Add a lease column', status: 'completed', description: null, mode: null, roleSlug: null,
    createdAt: new Date(clock).toISOString(), missionId: 'm1', backend: null, failover: null, worker: null,
    result: { summary: 'Shipped the column.', nextSuggestion: null }, lastError: null, blockedByCount: 0, ...over,
  };
}

function render(over: Partial<TaskSheetViewProps> = {}) {
  const taskId = over.taskId ?? ID.b2;
  const props: TaskSheetViewProps = {
    taskId,
    layout: 'sheet',
    mission,
    nav: buildTaskSheetNav(model, taskId, { missionId: 'm1', from: 'home' }),
    summary: { data: null, loading: true, error: null },
    onChanged: () => {},
    onClose: () => {},
    onStep: () => {},
    ...over,
  };
  return renderToStaticMarkup(<TaskSheetView {...props} />);
}

describe('TaskSheet — opens at once (AC-7)', () => {
  it('renders the sheet with a skeleton before /summary answers', () => {
    const html = render();
    expect(html).toContain('data-testid="mission-task-sheet"');
    expect(html).toContain('data-testid="task-sheet-skeleton"');
    expect(html).not.toContain('data-testid="task-header-status"');
  });

  it('mobile: a tall bottom sheet with a drag handle', () => {
    const html = render();
    expect(html).toContain('h-[88dvh]');
    expect(html).toContain('data-testid="task-sheet-handle"');
  });

  it('md+: docked at 420px, with no backdrop and no drag handle', () => {
    const html = render({ layout: 'docked' });
    expect(html).toContain('data-layout="docked"');
    expect(html).toContain('w-[420px]');
    expect(html).not.toContain('bg-black/50');
    expect(html).not.toContain('data-testid="task-sheet-handle"');
  });
});

describe('TaskSheet — body', () => {
  it('keeps task-header-status on the status badge (AC-19)', () => {
    const html = render({ summary: { data: summaryData(), loading: false, error: null } });
    expect(html).toMatch(/data-testid="task-header-status" data-status="completed"/);
  });

  it('a completed task with no PR opens the sheet with its summary (AC-10)', () => {
    const html = render({ summary: { data: summaryData(), loading: false, error: null } });
    expect(html).toContain('Shipped the column.');
    expect(html).not.toContain('data-testid="task-sheet-skeleton"');
  });

  it('the phase action comes first: a queued task offers Run now', () => {
    const html = render({ summary: { data: summaryData({ status: 'pending', result: null }), loading: false, error: null } });
    expect(html).toContain('data-testid="task-action-zone"');
    expect(html).toContain('Run now');
  });
});

describe('TaskSheet — header and footer (W4)', () => {
  it('the micro masthead names the mission, rings this task on the pulse and shows n / N · phase', () => {
    const html = render();
    expect(html).toContain('data-size="micro"');
    expect(html).toContain('Example mission');
    expect(html).toMatch(new RegExp(`data-task-id="${ID.b2}"[^>]*data-ringed="true"`));
    expect(html).toContain('3 / 4 · 2 BUILD');
  });

  it('‹ › are real links to the pulse-order siblings', () => {
    const html = render();
    expect(html).toContain(`href="/app/missions/m1?from=home&amp;task=${ID.b1}"`);
    expect(html).toContain(`href="/app/missions/m1?from=home&amp;task=${ID.b3}"`);
  });

  it('Next needing you crosses into NEEDS YOU', () => {
    const html = render();
    expect(html).toMatch(new RegExp(`data-testid="task-sheet-next-needing-you" href="/app/missions/m1\\?from=home&amp;task=${ID.b1}"`));
  });

  it('Open full page carries the mission back-link context', () => {
    const html = render();
    expect(html).toContain(`href="/app/tasks/${ID.b2}?from=mission&amp;missionId=m1"`);
  });

  it('without mission context the sheet still opens (no masthead, plain full-page link)', () => {
    const html = render({ mission: null, nav: buildTaskSheetNav(null, ID.b2, { missionId: '' }) });
    expect(html).toContain('data-testid="mission-task-sheet"');
    expect(html).not.toContain('data-size="micro"');
    expect(html).toContain(`href="/app/tasks/${ID.b2}"`);
  });
});

describe('pure helpers', () => {
  it('a drag past the threshold closes; a nudge does not', () => {
    expect(shouldDragClose(DRAG_CLOSE_PX + 1)).toBe(true);
    expect(shouldDragClose(DRAG_CLOSE_PX)).toBe(false);
    expect(shouldDragClose(-200)).toBe(false);
  });

  it('the /summary poll rests while hidden or while Pusher is connected', () => {
    expect(shouldPollSummary({ hidden: false, realtime: false })).toBe(true);
    expect(shouldPollSummary({ hidden: true, realtime: false })).toBe(false);
    expect(shouldPollSummary({ hidden: false, realtime: true })).toBe(false);
  });

  it('eventTaskId reads thin and legacy payloads', () => {
    expect(eventTaskId({ taskId: 'a' })).toBe('a');
    expect(eventTaskId({ task: { id: 'b' } })).toBe('b');
    expect(eventTaskId({ worker: { taskId: 'c' } })).toBe('c');
    expect(eventTaskId(null)).toBeNull();
  });
});
