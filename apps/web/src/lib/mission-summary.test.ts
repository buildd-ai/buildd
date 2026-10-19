import { describe, expect, it } from 'bun:test';
import { MISSION_SUMMARY_VERSION } from '@buildd/shared';
import * as missionHelpers from '@buildd/core/mission-helpers';
import { canonicalSummaryJson, computeMissionSummary, homeReadingOf, summariesEqual } from './mission-summary';
import { deliveryAtRead, projectMissionDelivery, toDeliveryRow } from './delivery-projection';
import { deriveLocalStrand, LOCAL_SESSION_QUIET_MS } from './local-strand';
import { buildMissionCardView } from './mission-card-view';
import { buildMissionListCard, type ListMissionRow } from './mission-list-card';
import { missionDeliveryFacts } from './mission-delivery-facts';
import type { MissionVisualReviewState } from './workflow/visual-review-state';
import { assembleMissionStages } from './mission-stage-assemble';
import { summarizeMissionForCard, type MissionCardRow } from './mission-card-view';
import { inputsFromWorld, makeWorld, NOW } from './mission-summary.fixtures';
import { taskRowsStripProjection } from './mission-strip-order';

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

describe('computeMissionSummary: Home\'s reading (3ef37387 R-13)', () => {
  const rowsOf = (id: string) => {
    const input = inputsFromWorld(makeWorld(), [id]).get(id)!;
    const tasks = input.taskRows.map(t => ({ ...t, workers: input.workerRows.filter(w => w.taskId === t.id) }));
    return { input, row: { ...input.missionRows[0], tasks } as unknown as ListMissionRow };
  };

  it('the delivery row is the projection Home built from the same rows, its tasks kept as the strip', () => {
    for (const id of ['m-build', 'm-branch', 'm-held', 'm-plan']) {
      const { row } = rowsOf(id);
      const m = row as unknown as Record<string, any>;
      const live = projectMissionDelivery({
        id, title: m.title, status: m.status, href: `/app/missions/${id}`, isHeld: m.isHeld, armedAt: m.armedAt,
        integrationBranch: m.integrationBranchEnabled === true, tasks: row.tasks as never,
        ...missionDeliveryFacts(row as never, undefined, NOW),
      }, missionHelpers);
      expect(homeReadingOf(summaryOf(id)).delivery).toEqual(toDeliveryRow(live));
    }
  });

  it('the card facts are the list card Home built: kind, counts, held and done', () => {
    for (const id of ['m-build', 'm-held', 'm-done', 'm-cron']) {
      const { input, row } = rowsOf(id);
      const card = summarizeMissionForCard(row as unknown as MissionCardRow, { now: NOW, liveWorkers: input.liveWorkers });
      const model = buildMissionListCard(row, buildMissionCardView(row, { from: 'home', now: NOW, summary: card }), card, { now: NOW });
      const home = homeReadingOf(summaryOf(id)).card;
      expect(home).toMatchObject({ kind: model.kind, done: model.counts.done, total: model.counts.total, held: model.held, strand: model.strand, donePrs: model.done?.prs ?? null });
    }
    expect(homeReadingOf(summaryOf('m-held')).card).toMatchObject({ kind: 'held', listed: true, held: { ready: 1 } });
    expect(homeReadingOf(summaryOf('m-done')).card).toMatchObject({ kind: 'done', donePrs: 1 });
    expect(homeReadingOf(summaryOf('m-build')).card.listed).toBe(true);
  });

  it('a quiet mission names its cause; a moving or closed one has none', () => {
    expect(homeReadingOf(summaryOf('m-held')).quietCause).toBe('not started');
    expect(homeReadingOf(summaryOf('m-plan')).quietCause).toBe('being planned');
    expect(homeReadingOf(summaryOf('m-build')).quietCause).toBeNull();
    expect(homeReadingOf(summaryOf('m-done')).quietCause).toBeNull();
  });

  it('the visual review read by the loader reaches the delivery line and is stored for the merge gate', () => {
    const world = makeWorld();
    const input = inputsFromWorld(world, ['m-branch']).get('m-branch')!;
    expect(computeMissionSummary(input, NOW).visualReview).toBeNull();
    const review = { status: 'queued', holdReason: 'waiting for a browser runner', blocked: undefined } as unknown as MissionVisualReviewState;
    const s = computeMissionSummary({ ...input, visualReview: review }, NOW);
    expect(s.visualReview).toEqual(review as never);
    expect(homeReadingOf(s).delivery.visualOpen).toMatchObject({ text: 'Visual review queued' });
  });
});

describe('computeMissionSummary: the stored Home delivery has no clock in it (3ef37387 R-13 / AC-2)', () => {
  const localWorld = () => {
    const w = makeWorld();
    // A local mission whose one pending task was filed just now, with no session on it.
    Object.assign(w.missions.find(m => m.id === 'm-held')!, { executor: 'local', isHeld: false });
    Object.assign(w.tasks.find(t => t.id === 't-h1')!, { createdAt: new Date(NOW), updatedAt: new Date(NOW) });
    return w;
  };
  const deliveryAt = (now: number) => homeReadingOf(summaryOf('m-held', localWorld(), now)).delivery;

  it('a summary computed at T is the summary computed any time later, until an input changes', () => {
    expect(canonicalSummaryJson(deliveryAt(NOW))).toBe(canonicalSummaryJson(deliveryAt(NOW + LOCAL_SESSION_QUIET_MS + 60_000)));
    expect(canonicalSummaryJson(deliveryAt(NOW))).toBe(canonicalSummaryJson(deliveryAt(NOW + 5 * 86_400_000)));
  });

  it('read at T + the quiet window, it equals a fresh compute there', () => {
    const later = NOW + LOCAL_SESSION_QUIET_MS + 60_000;
    const read = deliveryAtRead(deliveryAt(NOW), later);
    const fresh = deliveryAtRead(deliveryAt(later), later);
    expect(read).toEqual(fresh);
    expect(read.exception?.text).toBe('No session is running it');
    expect(read.next).toMatch(/^Waiting for your session \(none for /);
  });

  it('read before the window it is still waiting; read after it matches the live projection', () => {
    expect(deliveryAtRead(deliveryAt(NOW), NOW).exception?.text).toBe('Waiting for your session');
    const input = inputsFromWorld(localWorld(), ['m-held']).get('m-held')!;
    const tasks = input.taskRows.map(t => ({ ...t, workers: input.workerRows.filter(w => w.taskId === t.id) }));
    const row = { ...input.missionRows[0], tasks } as unknown as ListMissionRow;
    const m = row as unknown as Record<string, any>;
    for (const later of [NOW, NOW + LOCAL_SESSION_QUIET_MS + 60_000]) {
      const live = projectMissionDelivery({
        id: 'm-held', title: m.title, status: m.status, href: '/app/missions/m-held', isHeld: m.isHeld, armedAt: m.armedAt,
        integrationBranch: false, tasks: row.tasks as never,
        ...missionDeliveryFacts(row as never, undefined, later),
      }, missionHelpers);
      const { quietSince: _q, ...read } = deliveryAtRead(deliveryAt(NOW), later);
      const { strip: _s, ...liveRow } = toDeliveryRow(live);
      const { strip: _r, ...readRow } = read;
      expect(readRow).toEqual(liveRow);
    }
    expect(deriveLocalStrand({ executor: 'local', status: 'active', tasks: tasks as never, now: NOW })).not.toBeNull();
  });
});

describe('computeMissionSummary: the missions list\'s reading (3ef37387 R-2, R-13)', () => {
  it('the strip is the mission page\'s strip over the same rows, in its order', () => {
    for (const id of ['m-build', 'm-branch', 'm-held', 'm-plan']) {
      const input = inputsFromWorld(makeWorld(), [id]).get(id)!;
      const tasks = input.taskRows.map(t => ({ ...t, workers: input.workerRows.filter(w => w.taskId === t.id) }));
      const projection = taskRowsStripProjection(tasks as never);
      expect(summaryOf(id).list.strip).toEqual(projection.order.flatMap(t => projection.states.get(t) ?? []));
    }
    expect(summaryOf('m-build').list.strip.length).toBe(4);
  });

  it('last advanced is the latest task update or task start, and null with neither', () => {
    // t-b3 moved 40 minutes ago, after the mission's last start an hour ago.
    expect(summaryOf('m-build').list.lastAdvancedAt).toBe(new Date(NOW - 40 * 60_000).toISOString());
    const world = makeWorld();
    world.tasks = world.tasks.filter(t => t.missionId !== 'm-held');
    expect(summaryOf('m-held', world).list.lastAdvancedAt).toBeNull();
  });

  it('only a recurring open mission has a next run; a check-in schedule is not recurring work', () => {
    expect(summaryOf('m-cron').list.nextRunAt).toBe(new Date(NOW + 30 * 60_000).toISOString());
    expect(summaryOf('m-build').list.nextRunAt).toBeNull();
    const world = makeWorld();
    const cron = world.missions.find(m => m.id === 'm-cron')! as { schedule: { taskTemplate: unknown } };
    cron.schedule.taskTemplate = { context: { heartbeat: true } };
    expect(summaryOf('m-cron', world).list.nextRunAt).toBeNull();
  });
});

describe('computeMissionSummary: the mission PR\'s stored verdict', () => {
  it('Home\'s card reads the verdict, as the card builders read it with one', () => {
    const input = inputsFromWorld(makeWorld(), ['m-branch']).get('m-branch')!;
    const verdict = { owner: 'machine' as const, reason: 'Checking whether another PR carries it' };
    const tasks = input.taskRows.map(t => ({ ...t, workers: input.workerRows.filter(w => w.taskId === t.id) }));
    const withVerdict = summarizeMissionForCard({ ...input.missionRows[0], escalationGateVerdict: verdict, tasks } as unknown as MissionCardRow, { now: NOW, liveWorkers: input.liveWorkers });
    expect(withVerdict.state.escalationGateVerdict).toEqual(verdict);
    const s = computeMissionSummary({ ...input, escalationGateVerdict: verdict }, NOW);
    expect(homeReadingOf(s).card.listed).toBe(withVerdict.liveWorkers > 0 || ['running', 'attention', 'review'].includes(withVerdict.group));
    // The list fields stay the list's reading, without the verdict.
    expect(s.group).toBe('review');
    expect(s.needsYou).toBe(true);
  });
});

describe('computeMissionSummary: the mission PR\'s work holder', () => {
  it('is null once every deliverable landed, and names an open task PR while one is not', () => {
    expect(summaryOf('m-branch').missionPrWorkHolder).toBeNull();
    const world = makeWorld();
    Object.assign(world.workers.find(w => w.id === 'w-r2')!, { mergedAt: null, prLifecycleStatus: 'pr_open' });
    expect(summaryOf('m-branch', world).missionPrWorkHolder).toContain('1 task PR(s) still open on the integration branch: PR #22');
  });

  it('is null for a mission without an integration branch', () => {
    expect(summaryOf('m-build').missionPrWorkHolder).toBeNull();
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
