import { describe, expect, it } from 'bun:test';
import { MISSION_SUMMARY_VERSION } from '@buildd/shared';
import { canonicalSummaryJson, computeMissionSummary, summariesEqual } from './mission-summary';
import { assembleMissionStages } from './mission-stage-assemble';
import { summarizeMissionForCard, type MissionCardRow } from './mission-card-view';
import { inputsFromWorld, makeWorld, NOW } from './mission-summary.fixtures';

const summaryOf = (id: string, world = makeWorld(), now = NOW) => computeMissionSummary(inputsFromWorld(world, [id]).get(id)!, now);

describe('computeMissionSummary: one answer, from the derivations the surfaces already run (R-24)', () => {
  it('the stage is the one GET /api/missions/stages derives live from the same rows', () => {
    const world = makeWorld();
    for (const m of world.missions) {
      const input = inputsFromWorld(world, [m.id]).get(m.id)!;
      // The live loader never reads the card digest as `context`; the summary strips it the same way.
      const live = assembleMissionStages({ ...input, taskRows: input.taskRows.map(({ context: _c, ...t }) => t) as never }).get(m.id);
      expect(computeMissionSummary(input, NOW).stage).toEqual(live!);
    }
  });

  it('progress, health and group are the card Home and the missions list build', () => {
    const world = makeWorld();
    const input = inputsFromWorld(world, ['m-build']).get('m-build')!;
    const tasks = input.taskRows.map(t => ({ ...t, workers: input.workerRows.filter(w => w.taskId === t.id) }));
    const card = summarizeMissionForCard({ ...input.missionRows[0], tasks } as unknown as MissionCardRow, { now: NOW, liveWorkers: input.liveWorkers });
    const s = computeMissionSummary(input, NOW);
    expect(s.progress).toEqual({ done: card.completedTasks, total: card.totalTasks, percent: card.progress });
    expect(s.health).toBe(card.health);
    expect(s.group).toBe(card.group);
    expect(s.healthSignal).toBe(card.healthState);
    expect(s.stateKind).toBe(card.state.kind);
  });

  it('a mission still planning: no deliverables, planning stage, nothing counted as progress (8e137fdb I-11, I-12)', () => {
    const s = summaryOf('m-plan');
    expect(s.stage.step).toBe('planning');
    expect(s.progress).toEqual({ done: 0, total: 0, percent: 0 });
    expect(s.taskCounts).toEqual({ pending: 1 });
    expect(s.delivery).toBeNull();
  });

  it('mid-build: only the merged PR is done, the live worker counts, the open PR is the current delivery', () => {
    const s = summaryOf('m-build');
    expect(s.v).toBe(MISSION_SUMMARY_VERSION);
    expect(s.stage.step).toBe('building');
    expect(s.progress).toEqual({ done: 1, total: 4, percent: 25 });
    expect(s.health).toBe('active');
    expect(s.liveWorkers).toBe(1);
    expect(s.hasPendingDeliverableWork).toBe(true);
    expect(s.taskCounts).toEqual({ completed: 2, in_progress: 1, pending: 1 });
    expect(s.delivery).toEqual({ source: 'task_pr', prNumber: 12, prUrl: 'https://github.com/acme/app/pull/12', state: 'open' });
  });

  it('a mission branch: its mission PR is the delivery, and merging it is the owner\'s next step', () => {
    const s = summaryOf('m-branch');
    expect(s.stage.step).toBe('delivering');
    expect(s.progress.percent).toBe(100);
    expect(s.delivery).toEqual({ source: 'mission_pr', prNumber: 30, prUrl: 'https://github.com/acme/app/pull/30', state: 'open' });
    expect(s.needsYou).toBe(true);
  });

  it('held, scheduled and shipped missions read as the list reads them', () => {
    expect(summaryOf('m-held')).toMatchObject({ health: 'held', group: 'paused', stage: { step: 'on_hold' } });
    expect(summaryOf('m-cron')).toMatchObject({ health: 'on-schedule', group: 'scheduled' });
    expect(summaryOf('m-done')).toMatchObject({ health: 'shipped', group: 'completed', stage: { step: 'delivered' }, taskCounts: { cancelled: 1, completed: 1 } });
  });

  it('a closed, unmerged PR is never done (8e137fdb I-2, AC-3)', () => {
    const world = makeWorld();
    Object.assign(world.workers.find(w => w.id === 'w-b2')!, { prLifecycleStatus: 'closed', updatedAt: new Date(NOW - 60_000) });
    const s = summaryOf('m-build', world);
    expect(s.progress.done).toBe(1);
    // No PR is open any more: the delivery is the newest one, read as closed, never merged.
    expect(s.delivery).toMatchObject({ prNumber: 12, state: 'closed' });
  });

  it('a kernel delivery that merged lands its task over the stale worker row', () => {
    const world = makeWorld();
    world.deliveryViews.set('t-b2', { ownerTaskId: 't-b2', prNumber: 12, repoFullName: 'acme/app', state: 'MERGED', prState: null, mergedAt: new Date(NOW - 60_000).toISOString(), headline: null });
    expect(summaryOf('m-build', world).progress).toEqual({ done: 2, total: 4, percent: 50 });
  });

  it('last activity is the latest task start or update, else the mission\'s own update', () => {
    expect(summaryOf('m-build').lastActivityAt).toBe(new Date(NOW - 40 * 60_000).toISOString());
    const world = makeWorld();
    world.tasks = world.tasks.filter(t => t.missionId !== 'm-held');
    expect(summaryOf('m-held', world).lastActivityAt).toBe(new Date(NOW - 600 * 60_000).toISOString());
  });

  it('is deterministic for the same rows and clock', () => {
    const world = makeWorld();
    for (const m of world.missions) expect(canonicalSummaryJson(summaryOf(m.id, world))).toBe(canonicalSummaryJson(summaryOf(m.id, world)));
  });
});

describe('summariesEqual', () => {
  it('ignores key order (jsonb does not keep it) and undefined keys', () => {
    const a = summaryOf('m-build');
    const reordered = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(a).reverse())));
    expect(summariesEqual(a, reordered)).toBe(true);
    expect(summariesEqual(a, { ...a, progress: { ...a.progress, done: 2 } })).toBe(false);
    expect(summariesEqual(null, null)).toBe(true);
    expect(summariesEqual(a, null)).toBe(false);
  });
});
