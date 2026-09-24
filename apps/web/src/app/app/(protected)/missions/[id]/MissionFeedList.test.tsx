/**
 * MissionFeedList: the one task list on the mission page
 * (docs/design/mission-feed-mobile-continuity.md, "Grouping rules", W2, W3).
 * AC-2, AC-3 and AC-10 live here; the fold defaults and pinned caps come from
 * `buildMissionFeedGroups` and are asserted as rendered.
 */
import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import MissionFeedList, { flipDeltas } from './MissionFeedList';
import { fixtureMission, workTaskIds, FIXTURE_NOW } from './mission-feed.fixtures';
import type { MissionFeedTaskInput } from '@/lib/mission-pulse';

const render = (tasks: MissionFeedTaskInput[], extra: Partial<Parameters<typeof MissionFeedList>[0]> = {}) =>
  renderToStaticMarkup(<MissionFeedList missionId="mission-1" tasks={tasks} now={FIXTURE_NOW} {...extra} />);

const count = (html: string, needle: string) => html.split(needle).length - 1;
const rowCount = (html: string, id: string) => count(html, `data-testid="mission-task-row" data-task-id="${id}"`);
const slotCount = (html: string, id: string) => count(html, `data-testid="mission-task-slot" data-task-id="${id}"`);

describe('MissionFeedList — one list, every deliverable once (AC-2)', () => {
  for (const size of [3, 15, 45] as const) {
    it(`renders exactly one row per work task for a ${size}-task mission`, () => {
      const tasks = fixtureMission(size);
      const html = render(tasks);
      for (const id of workTaskIds(tasks)) expect(rowCount(html, id)).toBe(1);
      expect(count(html, 'data-testid="mission-task-row"')).toBe(workTaskIds(tasks).length);
    });
  }

  it('never renders an attempt or an orchestrator run as a row (D1)', () => {
    const html = render(fixtureMission(15));
    expect(rowCount(html, 'b1-retry')).toBe(0);
    expect(rowCount(html, 'plan')).toBe(0);
    // The attempt folds under its parent instead.
    expect(html).toContain('data-testid="mission-task-attempts"');
  });
});

describe('MissionFeedList — pinned groups and slot markers (AC-3)', () => {
  it('pins NEEDS YOU first and MOVING NOW second, before the phases', () => {
    const html = render(fixtureMission(15));
    const needs = html.indexOf('data-group="needs_you"');
    const moving = html.indexOf('data-group="moving"');
    const firstPhase = html.indexOf('data-group="phase"');
    expect(needs).toBeGreaterThan(-1);
    expect(needs).toBeLessThan(moving);
    expect(moving).toBeLessThan(firstPhase);
  });

  it('leaves exactly one slot marker in the phase of every pinned task, and no second row', () => {
    const html = render(fixtureMission(15));
    for (const id of ['b2', 'b3', 'b4']) {
      expect(slotCount(html, id)).toBe(1);
      expect(rowCount(html, id)).toBe(1);
    }
    expect(slotCount(html, 'b1')).toBe(0);
    expect(html).toContain('in Needs you');
    expect(html).toContain('in Moving now');
  });

  it('shows at most three NEEDS YOU rows, then +N more', () => {
    const tasks = Array.from({ length: 5 }, (_, i) => ({
      id: `ask-${i}`,
      title: `Example ask ${i}`,
      status: 'in_progress',
      taskClass: 'work',
      createdAt: new Date(FIXTURE_NOW - (10 - i) * 60_000).toISOString(),
      worker: { status: 'waiting_input' },
    }));
    const html = render(tasks);
    expect(html).toContain('+2 more');
    // Every row is still in the DOM (hash focus can reach it); two are hidden.
    expect(count(html, 'data-testid="mission-task-row"')).toBe(5);
    const needsGroup = html.slice(html.indexOf('data-group="needs_you"'));
    const visible = needsGroup.slice(0, needsGroup.indexOf('data-testid="mission-feed-overflow"'));
    expect(count(visible, 'data-testid="mission-task-row"')).toBe(3);
    expect(needsGroup).toMatch(/data-testid="mission-feed-overflow"[^>]*hidden/);
  });
});

describe('MissionFeedList — phase folding defaults', () => {
  it('folds a finished phase to its header, with the done count', () => {
    const html = render(fixtureMission(15));
    const header = html.slice(html.indexOf('data-phase-status="finished"'));
    expect(header).toContain('1 · THINK');
    expect(header).toContain('4/4');
    expect(html).toMatch(/data-phase-status="finished"[^>]*aria-expanded="false"/);
  });

  it('expands the current phase and caps a future phase at three rows with +N queued', () => {
    const html = render(fixtureMission(15));
    expect(html).toMatch(/data-phase-status="current"[^>]*aria-expanded="true"/);
    expect(html).toContain('+3 queued');
  });

  it('reads the phase header as its ordinal and label, from mission-legibility §4', () => {
    const html = render(fixtureMission(15));
    expect(html).toContain('2 · BUILD');
    expect(html).toContain('3 · CHECK');
  });

  it('renders no phase header for a mission where no task carries a phase (mission-legibility §4)', () => {
    const html = render(fixtureMission(3));
    expect(count(html, 'data-group="phase"')).toBe(1);
    expect(html).not.toContain('data-testid="mission-phase-header"');
  });

  it('never folds the rows of an unphased mission, even when every task is done', () => {
    const tasks = fixtureMission(3).map(t => ({ ...t, status: 'completed', worker: null }));
    const html = render(tasks);
    expect(html).not.toMatch(/<div hidden="">/);
    expect(count(html, 'data-testid="mission-task-row"')).toBe(3);
  });

  it('labels an unphased stretch of a phased mission as Unphased', () => {
    const tasks = [...fixtureMission(15), { ...fixtureMission(3)[2], id: 'loose' }];
    const html = render(tasks);
    expect(html).toContain('Unphased');
  });

  it('unfolds a collapsed phase when a row inside it is revealed by focus', () => {
    const html = render(fixtureMission(15), { revealedTaskIds: new Set(['th2']) });
    expect(html).toMatch(/data-phase-status="finished"[^>]*aria-expanded="true"/);
  });
});

describe('MissionFeedList — tap uniformity (AC-10)', () => {
  it('never opts a row out of the sheet', () => {
    const html = render(fixtureMission(45));
    expect(html).not.toContain('data-task-actionable');
    expect(html).toContain('data-testid="mission-feed"');
  });

  it('links a completed task with no PR to the sheet like any other row', () => {
    const html = render(fixtureMission(15));
    expect(html).toContain('href="/app/missions/mission-1?task=th1"');
  });

  it('carries ?from= onto every row link', () => {
    const html = render(fixtureMission(3), { from: 'home' });
    expect(html).toContain('href="/app/missions/mission-1?from=home&amp;task=u1"');
  });
});

describe('flipDeltas', () => {
  it('returns the previous-minus-next offset for rows that moved, and nothing for new or still rows', () => {
    const prev = new Map([['a', 0], ['b', 52], ['c', 104]]);
    const next = new Map([['a', 52], ['b', 0], ['c', 104], ['d', 156]]);
    expect([...flipDeltas(prev, next)]).toEqual([['a', -52], ['b', 52]]);
  });

  it('ignores sub-pixel jitter', () => {
    expect(flipDeltas(new Map([['a', 10]]), new Map([['a', 10.4]])).size).toBe(0);
  });
});
