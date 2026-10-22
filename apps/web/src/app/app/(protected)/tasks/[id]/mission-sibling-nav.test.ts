/**
 * The task page mission bar's position and stepping (`‹ 4 / 15 · 2 BUILD ›`).
 * Numbering follows pulse order; pinned groups never reorder it (Grouping
 * rules §6). Each step is the sibling's task page (spec d25d923d R-1).
 */
import { describe, expect, it } from 'bun:test';
import { buildMissionFeedGroups } from '@/lib/mission-feed-groups';
import type { MissionFeedTaskInput } from '@/lib/mission-pulse';
import { buildMissionSiblingNav } from './mission-sibling-nav';

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

describe('buildMissionSiblingNav', () => {
  it('n / N and the phase read in pulse order, with the phase ordinal', () => {
    const nav = buildMissionSiblingNav(mission(), 'b2', hrefs);
    expect(nav.position).toMatchObject({ n: 4, total: 5, phaseLabel: '2 BUILD' });
  });

  it('‹ › are the pulse-order siblings, as their task pages with the back context', () => {
    const nav = buildMissionSiblingNav(mission(), 'b1', hrefs);
    expect(nav.prevTaskId).toBe('th2');
    expect(nav.nextTaskId).toBe('b2');
    expect(nav.position?.prevHref).toBe('/app/tasks/th2?from=home&missionId=m1');
    expect(nav.position?.nextHref).toBe('/app/tasks/b2?from=home&missionId=m1');
  });

  it('the ends have no sibling in that direction', () => {
    const first = buildMissionSiblingNav(mission(), 'th1', hrefs);
    const last = buildMissionSiblingNav(mission(), 'b3', hrefs);
    expect(first.prevTaskId).toBeNull();
    expect(first.position?.prevHref).toBeNull();
    expect(last.nextTaskId).toBeNull();
    expect(last.position?.nextHref).toBeNull();
  });

  it('a task outside the feed (bookkeeping, a folded attempt) opens with no position', () => {
    const nav = buildMissionSiblingNav(mission(), 'not-a-row', hrefs);
    expect(nav.position).toBeNull();
    expect(nav.prevTaskId).toBeNull();
    expect(nav.nextTaskId).toBeNull();
  });

  it('with no model at all the header degrades to nothing, never throws', () => {
    expect(buildMissionSiblingNav(null, 'b1', hrefs)).toEqual({ position: null, prevTaskId: null, nextTaskId: null });
  });
});
