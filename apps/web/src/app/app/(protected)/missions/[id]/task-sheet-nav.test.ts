/**
 * The sheet header's position and stepping (W4: `‹ 4 / 15 · 2 BUILD ›`,
 * "Next needing you"). Numbering follows pulse order; pinned groups never
 * reorder it (Grouping rules §6).
 */
import { describe, expect, it } from 'bun:test';
import { buildMissionFeedGroups } from '@/lib/mission-feed-groups';
import type { MissionFeedTaskInput } from '@/lib/mission-pulse';
import { buildTaskSheetNav, toMissionFeedTaskInput } from './task-sheet-nav';

// Illustrative fixtures only — no real mission or task data.
let clock = Date.UTC(2026, 0, 1);
function t(id: string, over: Partial<MissionFeedTaskInput> = {}): MissionFeedTaskInput {
  clock += 60_000;
  return { id, title: `Task ${id}`, status: 'pending', taskClass: 'work', createdAt: new Date(clock), ...over };
}
const THINK = { missionPhaseIndex: 0, missionPhaseLabel: 'THINK' };
const BUILD = { missionPhaseIndex: 1, missionPhaseLabel: 'BUILD' };
const asking = { status: 'in_progress', worker: { status: 'waiting_input' } } as const;

function mission() {
  return buildMissionFeedGroups([
    t('th1', { ...THINK, status: 'completed' }),
    t('th2', { ...THINK, status: 'completed' }),
    t('b1', { ...BUILD, ...asking }),
    t('b2', { ...BUILD, status: 'in_progress', worker: { status: 'running' } }),
    t('b3', { ...BUILD, ...asking }),
  ]);
}
const hrefs = { missionId: 'm1', from: 'home' as const };

describe('buildTaskSheetNav', () => {
  it('n / N and the phase read in pulse order, with the phase ordinal', () => {
    const nav = buildTaskSheetNav(mission(), 'b2', hrefs);
    expect(nav.position).toMatchObject({ n: 4, total: 5, phaseLabel: '2 BUILD' });
  });

  it('‹ › are the pulse-order siblings, as real sheet links', () => {
    const nav = buildTaskSheetNav(mission(), 'b1', hrefs);
    expect(nav.prevTaskId).toBe('th2');
    expect(nav.nextTaskId).toBe('b2');
    expect(nav.position?.prevHref).toBe('/app/missions/m1?from=home&task=th2');
    expect(nav.position?.nextHref).toBe('/app/missions/m1?from=home&task=b2');
  });

  it('the ends have no sibling in that direction', () => {
    const first = buildTaskSheetNav(mission(), 'th1', hrefs);
    const last = buildTaskSheetNav(mission(), 'b3', hrefs);
    expect(first.prevTaskId).toBeNull();
    expect(first.position?.prevHref).toBeNull();
    expect(last.nextTaskId).toBeNull();
    expect(last.position?.nextHref).toBeNull();
  });

  it('Next needing you crosses into NEEDS YOU and skips the task already open', () => {
    expect(buildTaskSheetNav(mission(), 'b2', hrefs).nextNeedingYou).toEqual({ taskId: 'b1', title: 'Task b1' });
    expect(buildTaskSheetNav(mission(), 'b1', hrefs).nextNeedingYou).toEqual({ taskId: 'b3', title: 'Task b3' });
  });

  it('a task outside the feed (bookkeeping, a folded attempt) opens with no position', () => {
    const nav = buildTaskSheetNav(mission(), 'not-a-row', hrefs);
    expect(nav.position).toBeNull();
    expect(nav.prevTaskId).toBeNull();
    expect(nav.nextTaskId).toBeNull();
  });

  it('with no model at all the header degrades to nothing, never throws', () => {
    expect(buildTaskSheetNav(null, 'b1', hrefs)).toEqual({ position: null, prevTaskId: null, nextTaskId: null, nextNeedingYou: null });
  });
});

describe('toMissionFeedTaskInput', () => {
  it('keeps only what the feed model reads, with the latest worker', () => {
    const input = toMissionFeedTaskInput({
      id: 'a', title: 'A', status: 'in_progress', createdAt: '2026-01-01T00:00:00Z', taskClass: 'work',
      missionPhaseIndex: 1, missionPhaseLabel: 'BUILD', dependsOn: ['z'], roleSlug: 'builder',
      result: { summary: 'large payload' }, context: { big: true },
      workers: [
        { status: 'running', prNumber: 7, prUrl: 'https://example.invalid/pr/7', startedAt: '2026-01-01T00:01:00Z', artifacts: [{ content: 'x' }] },
        { status: 'failed' },
      ],
    });
    expect(input).toEqual({
      id: 'a', title: 'A', status: 'in_progress', createdAt: '2026-01-01T00:00:00Z', updatedAt: null,
      taskClass: 'work', parentTaskId: null, mode: null, kind: null, roleSlug: 'builder', category: null,
      creationSource: null, dependsOn: ['z'], missionPhaseIndex: 1, missionPhaseLabel: 'BUILD',
      worker: {
        status: 'running', startedAt: '2026-01-01T00:01:00Z', updatedAt: null, prNumber: 7,
        prUrl: 'https://example.invalid/pr/7', prLifecycleStatus: null, mergedAt: null,
      },
    });
  });

  it('a task that never ran has a null worker', () => {
    expect(toMissionFeedTaskInput({ id: 'a', title: 'A', status: 'pending', createdAt: '2026-01-01T00:00:00Z' }).worker).toBeNull();
  });
});
