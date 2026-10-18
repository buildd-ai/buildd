/**
 * An in-memory world of missions, tasks, workers and kernel delivery views,
 * and the `MissionSummaryInput` the real loader would read from it, for the
 * mission summary's tests (lib/mission-summary.test.ts,
 * lib/mission-summary-store.test.ts). Varied on purpose: a mission still
 * planning, a direct mission mid-build with an open PR, a mission-branch
 * mission with its mission PR, a held one, a scheduled one, a completed one.
 */
import { LIVE_WORKER_STATUSES } from '@buildd/shared';
import type { MissionSummaryInput } from './mission-summary';

export const NOW = Date.parse('2026-10-18T12:00:00Z');
const at = (minsAgo: number) => new Date(NOW - minsAgo * 60_000);

export interface World {
  missions: Array<Record<string, any>>;
  tasks: Array<Record<string, any>>;
  workers: Array<Record<string, any>>;
  /** Kernel DeliveryViews by owner task id. */
  deliveryViews: Map<string, Record<string, any>>;
}

const LIVE = new Set<string>(LIVE_WORKER_STATUSES);

const workspace = { name: 'acme', gitConfig: { defaultBranch: 'main' }, releaseConfig: null };

const mission = (id: string, over: Record<string, any> = {}) => ({
  id, title: `Mission ${id}`, status: 'active', workspaceId: 'ws-1', isHeld: false, armedAt: null, executor: null,
  startAt: null, orchestrationMode: 'auto', dependsOnMissionId: null, dependencyMetAt: null, criteriaEscalatedAt: null,
  goalCriteria: [], goalCriteriaState: null, completedAt: null, integrationBranchEnabled: false, workingBranch: null,
  mergePolicy: null, releasedAt: null, lastTaskStartedAt: null, createdAt: at(600), updatedAt: at(600),
  workspace, schedule: null, ...over,
});

const task = (id: string, missionId: string, over: Record<string, any> = {}) => ({
  id, missionId, title: `Build ${id}`, label: null, status: 'pending', taskClass: 'work', kind: 'engineering',
  mode: 'execution', category: 'feature', roleSlug: 'builder', createdAt: at(300), updatedAt: at(300),
  parentTaskId: null, creationSource: 'api', dependsOn: [], missionPhaseIndex: null, missionPhaseLabel: null,
  outputRequirement: 'pr_required', scheduleId: null, startAt: null, loopIteration: 0, loopConfig: null,
  loopState: null, stageContext: {}, context: {}, ...over,
});

const worker = (id: string, taskId: string, over: Record<string, any> = {}) => ({
  id, taskId, status: 'running', startedAt: at(60), createdAt: at(60), completedAt: null, updatedAt: at(5),
  turns: 3, exitCause: null, prUrl: null, prNumber: null, mergedAt: null, prLifecycleStatus: null,
  supersededByPrNumber: null, abandonedAt: null, ...over,
});

/** A fresh, varied world. Each call returns new objects, so a test may mutate it. */
export function makeWorld(): World {
  return {
    missions: [
      // Planning: an organizer queued, no deliverables yet.
      mission('m-plan'),
      // Direct, mid-build: one landed, one with an open PR, one running, one pending.
      mission('m-build', { lastTaskStartedAt: at(60) }),
      // Mission branch: its task PRs merged into the branch, the mission PR open.
      mission('m-branch', { integrationBranchEnabled: true, workingBranch: 'mission/m-branch' }),
      // Held by its owner.
      mission('m-held', { isHeld: true }),
      // Recurring, with a schedule.
      mission('m-cron', { schedule: { id: 's-1', nextRunAt: at(-30), lastRunAt: at(30), cronExpression: '*/30 * * * *', lastDeferralReason: null, lastDeferredAt: null, maxConcurrentFromSchedule: 1, totalRuns: 4, taskTemplate: null } }),
      // Shipped.
      mission('m-done', { status: 'completed', completedAt: at(120) }),
    ],
    tasks: [
      task('t-plan-org', 'm-plan', { title: 'Plan the mission', mode: 'planning', roleSlug: 'organizer', kind: 'coordination', outputRequirement: 'none', taskClass: 'bookkeeping' }),
      task('t-b1', 'm-build', { status: 'completed', updatedAt: at(200) }),
      task('t-b2', 'm-build', { status: 'completed', updatedAt: at(90) }),
      task('t-b3', 'm-build', { status: 'in_progress', updatedAt: at(40) }),
      task('t-b4', 'm-build', { status: 'pending', dependsOn: ['t-b3'] }),
      task('t-r1', 'm-branch', { status: 'completed' }),
      task('t-r2', 'm-branch', { status: 'completed' }),
      task('t-r-pr', 'm-branch', { title: 'Ship mission: m-branch', taskClass: 'bookkeeping', status: 'completed', roleSlug: null, outputRequirement: 'none' }),
      task('t-h1', 'm-held', { status: 'pending' }),
      task('t-c1', 'm-cron', { status: 'completed', scheduleId: 's-1', outputRequirement: 'none' }),
      task('t-d1', 'm-done', { status: 'completed' }),
      task('t-d2', 'm-done', { status: 'cancelled' }),
    ],
    workers: [
      worker('w-b1', 't-b1', { status: 'completed', completedAt: at(200), prUrl: 'https://github.com/acme/app/pull/11', prNumber: 11, mergedAt: at(190), prLifecycleStatus: 'merged' }),
      worker('w-b2', 't-b2', { status: 'completed', completedAt: at(90), prUrl: 'https://github.com/acme/app/pull/12', prNumber: 12, prLifecycleStatus: 'pr_open' }),
      worker('w-b3', 't-b3', { status: 'running' }),
      worker('w-r1', 't-r1', { status: 'completed', prUrl: 'https://github.com/acme/app/pull/21', prNumber: 21, mergedAt: at(100), prLifecycleStatus: 'merged' }),
      worker('w-r2', 't-r2', { status: 'completed', prUrl: 'https://github.com/acme/app/pull/22', prNumber: 22, mergedAt: at(80), prLifecycleStatus: 'merged' }),
      worker('w-r-pr', 't-r-pr', { status: 'completed', prUrl: 'https://github.com/acme/app/pull/30', prNumber: 30, prLifecycleStatus: 'pr_open' }),
      worker('w-c1', 't-c1', { status: 'completed' }),
      worker('w-d1', 't-d1', { status: 'completed', prUrl: 'https://github.com/acme/app/pull/40', prNumber: 40, mergedAt: at(130), prLifecycleStatus: 'merged' }),
    ],
    deliveryViews: new Map(),
  };
}

/** What `loadMissionSummaryInputs` would return for these missions, read from the world as it stands. */
export function inputsFromWorld(world: World, missionIds: readonly string[]): Map<string, MissionSummaryInput> {
  const out = new Map<string, MissionSummaryInput>();
  for (const id of missionIds) {
    const m = world.missions.find(x => x.id === id);
    if (!m) continue;
    const own = world.tasks.filter(t => t.missionId === id).map(t => ({ ...t }));
    const ownIds = new Set(own.map(t => t.id));
    const ws = world.workers.filter(w => ownIds.has(w.taskId)).map(w => ({ ...w }));
    out.set(id, {
      missionRows: [{ ...m }],
      taskRows: own as MissionSummaryInput['taskRows'],
      workerRows: ws as MissionSummaryInput['workerRows'],
      deliveries: new Map(),
      deliveryViews: new Map([...world.deliveryViews].filter(([k]) => ownIds.has(k))),
      foreignIdsByMission: new Map(),
      foreignDeps: new Map(),
      releasedEdges: new Map(),
      liveWorkers: ws.filter(w => LIVE.has(w.status)).length,
    });
  }
  return out;
}

/** The mission a task, worker or PR belongs to, as the store's resolver reads it. */
export function resolveInWorld(world: World, t: { taskIds: string[]; workerIds: string[]; prUrls: string[]; workspacePrs: Array<{ workspaceId: string; prNumber: number }> }): string[] {
  const missions = new Set<string>();
  for (const id of t.taskIds) { const m = world.tasks.find(x => x.id === id)?.missionId; if (m) missions.add(m); }
  for (const w of world.workers) {
    const hit = t.workerIds.includes(w.id) || (w.prUrl && t.prUrls.includes(w.prUrl))
      || t.workspacePrs.some(p => p.prNumber === w.prNumber && world.missions.find(m => m.id === world.tasks.find(x => x.id === w.taskId)?.missionId)?.workspaceId === p.workspaceId);
    if (!hit) continue;
    const m = world.tasks.find(x => x.id === w.taskId)?.missionId;
    if (m) missions.add(m);
  }
  return [...missions];
}
