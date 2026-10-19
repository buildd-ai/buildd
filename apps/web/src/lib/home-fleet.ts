import { admitsToNeedsYou } from '@buildd/core/needs-you';
import { isOpenAsk } from './open-ask';
/**
 * Home's fleet queries: the runner snapshot (heartbeats × live workers) and
 * each slot's day history for the Agents panel, and the questions workers are
 * parked on for Needs you. Shaping lives in the pure module (`fleet-view.ts`);
 * this file only reads.
 *
 * Runner ↔ worker join: a runner claims with `runner = <its localUiUrl>` and
 * reports the same URL on the worker row (`workers.localUiUrl`); heartbeats are
 * unique per (account, localUiUrl). The same rows /api/workspaces/[id]/runners
 * reads, scoped here to the team's accounts and workspaces in one query.
 */
import { db } from '@buildd/core/db';
import { tasks, workerHeartbeats, workers } from '@buildd/core/db/schema';
import { and, desc, eq, gt, gte, inArray, isNotNull, or, sql } from 'drizzle-orm';
import { RUNNER_STALE_CUTOFF_MS, questionSessionEnded, type FleetSnapshot } from '@buildd/shared';
import { fleetHeartbeatScope } from './fleet-heartbeat-scope';
import { withLiveRunnerBeats } from './runner-beats';
import { FLEET_ONLINE_WINDOW_MS, buildFleetSnapshot, fleetCapacity, type FleetHeartbeatRow, type FleetWorkerRow } from './fleet-view';
import { idleWhileQueued, type IdleStretch, type QueuedInterval, type RunInterval } from './idle-while-queued';
import { taskShortLabel } from './segment-label';
import { LIVE_WORKER_STATUSES } from './task-presentation';
import { deriveRunEvidence } from '@buildd/core/run-evidence';
import { homeQuestionView } from './home-attention';
import type { UnifiedQuestion } from '@/app/app/(protected)/tasks/[id]/question-hero';

/** A worker parked on a question — the Needs-you stack answers it inline. */
export interface HomeFleetQuestion {
  workerId: string;
  taskId: string | null;
  missionId: string | null;
  label: string;
  runnerName: string | null;
  askedAt: string | null;
  question: UnifiedQuestion;
}

export interface HomeFleetData {
  fleet: FleetSnapshot;
}

/** How far back a slot's lane reaches. */
export const FLEET_WINDOW_MS = 8 * 3_600_000;
/** Most worker rows one Home render reads for the lanes. */
export const FLEET_WORKER_ROW_CAP = 400;

const EMPTY: HomeFleetData = {
  fleet: { runners: [], live: 0, capacity: 0, window: { from: 0, to: 0 } },
};

/** Most parked questions Home reads for Needs you. */
export const HOME_QUESTION_ROW_CAP = 50;

/**
 * The runners a team's fleet is made of: fresh heartbeats of the team's own
 * accounts or of accounts linked to its workspaces (`fleetHeartbeatScope`).
 * Home's fleet panel, Settings → Runners, Health › Runners and the mission
 * Lanes band all read this (then `fleetCapacity`), so their capacity is one number.
 */
export async function loadFleetHeartbeats(input: { teamId: string | null; wsIds: string[]; now: number }): Promise<FleetHeartbeatRow[]> {
  const query = fleetHeartbeatsQuery(input);
  return query ? withLiveRunnerBeats((await query) as FleetHeartbeatRow[]) : [];
}

/**
 * `loadFleetHeartbeats`' one statement, for a caller's batch; null when there
 * is no scope. The caller passes the rows through `withLiveRunnerBeats` (a
 * stored beat can be one write interval old, lib/runner-beats.ts).
 */
export function fleetHeartbeatsQuery(input: { teamId: string | null; wsIds: string[]; now: number }) {
  const { teamId, wsIds, now } = input;
  const scope = fleetHeartbeatScope({ teamId, wsIds });
  if (!scope) return null;
  return db
    .select({
      id: workerHeartbeats.id,
      accountId: workerHeartbeats.accountId,
      localUiUrl: workerHeartbeats.localUiUrl,
      maxConcurrentWorkers: workerHeartbeats.maxConcurrentWorkers,
      // An ephemeral run's share of capacity (fleetCapacity).
      activeWorkerCount: workerHeartbeats.activeWorkerCount,
      environment: workerHeartbeats.environment,
      lastHeartbeatAt: workerHeartbeats.lastHeartbeatAt,
    })
    .from(workerHeartbeats)
    .where(and(
      gt(workerHeartbeats.lastHeartbeatAt, new Date(now - RUNNER_STALE_CUTOFF_MS)),
      scope,
    ));
}

/** `fleetCapacity` over `loadFleetHeartbeats`, with Home's online threshold. */
export async function loadFleetCapacity(input: { teamId: string | null; wsIds: string[]; now: number }): Promise<number> {
  return fleetCapacity(await loadFleetHeartbeats(input), { now: input.now, onlineThresholdMs: FLEET_ONLINE_WINDOW_MS });
}

/**
 * The fleet alone: fresh heartbeats × the workers live on them, no history.
 * Settings → Runners leads with this; Home's full loader adds the lanes,
 * ticker and counts on top of the same two reads.
 */
export async function loadFleetSnapshot(input: { teamId: string | null; wsIds: string[]; now: number }): Promise<FleetSnapshot> {
  const { wsIds, now } = input;
  if (wsIds.length === 0) return EMPTY.fleet;
  const [heartbeatRows, liveRows] = await Promise.all([
    loadFleetHeartbeats(input),
    db
      .select({
        id: workers.id, accountId: workers.accountId, runner: workers.runner, localUiUrl: workers.localUiUrl,
        status: workers.status, startedAt: workers.startedAt, completedAt: workers.completedAt, updatedAt: workers.updatedAt,
        prNumber: workers.prNumber, error: workers.error,
        taskId: tasks.id, taskTitle: tasks.title, taskLabel: tasks.label, taskMode: tasks.mode,
        roleSlug: tasks.roleSlug, missionId: tasks.missionId, taskClass: tasks.taskClass,
      })
      .from(workers)
      .leftJoin(tasks, eq(workers.taskId, tasks.id))
      .where(and(inArray(workers.workspaceId, wsIds), inArray(workers.status, [...LIVE_WORKER_STATUSES])))
      .orderBy(desc(workers.startedAt))
      .limit(FLEET_WORKER_ROW_CAP),
  ]);
  const rows: FleetWorkerRow[] = liveRows.map(r => ({
    id: r.id, accountId: r.accountId, runner: r.runner, localUiUrl: r.localUiUrl, status: r.status,
    startedAt: r.startedAt, completedAt: r.completedAt, updatedAt: r.updatedAt, prNumber: r.prNumber, error: r.error,
    task: r.taskId ? {
      id: r.taskId, title: r.taskTitle ?? '', label: r.taskLabel, mode: r.taskMode,
      roleSlug: r.roleSlug, missionId: r.missionId, taskClass: r.taskClass,
    } : null,
  }));
  return buildFleetSnapshot(heartbeatRows, rows, { now, onlineThresholdMs: FLEET_ONLINE_WINDOW_MS, maxWindowMs: FLEET_WINDOW_MS });
}

/** Interactive sessions online now in these workspaces, or null when the read fails. */
async function loadSessionsOnline(wsIds: string[], now: number): Promise<number | null> {
  try {
    const { listLocalSessions, countInteractiveSessions } = await import('./local-session-view');
    return countInteractiveSessions(await listLocalSessions({ workspaceIds: wsIds, now: new Date(now) }));
  } catch (err) {
    console.warn('[home-fleet] sessions online read failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Every worker parked on a question in these workspaces, with its task: one
 * statement for Home's batch. `homeQuestionsFrom` keeps the ones Needs you
 * admits and names each one's runner.
 */
export function homeQuestionWorkersQuery(wsIds: string[]) {
  return db
    .select({
      id: workers.id, accountId: workers.accountId, runner: workers.runner, localUiUrl: workers.localUiUrl,
      status: workers.status, startedAt: workers.startedAt, updatedAt: workers.updatedAt, waitingFor: workers.waitingFor,
      // The context fallback for a card whose brief was lost.
      error: workers.error,
      taskId: tasks.id, taskStatus: tasks.status, taskTitle: tasks.title, taskLabel: tasks.label, taskMode: tasks.mode,
      roleSlug: tasks.roleSlug, missionId: tasks.missionId, taskClass: tasks.taskClass,
    })
    .from(workers)
    .leftJoin(tasks, eq(workers.taskId, tasks.id))
    .where(and(inArray(workers.workspaceId, wsIds), eq(workers.status, 'waiting_input'), isNotNull(workers.waitingFor)))
    .orderBy(workers.updatedAt)
    .limit(HOME_QUESTION_ROW_CAP);
}

export type HomeQuestionWorkerRow = Awaited<ReturnType<typeof homeQuestionWorkersQuery>>[number];

/** The parked workers Needs you admits: an open ask whose park a disposition hands to a person. */
export function admittedQuestionRows(rows: readonly HomeQuestionWorkerRow[], now: number): HomeQuestionWorkerRow[] {
  return rows.filter(r => isOpenAsk(r.taskStatus, r.status) && admitsToNeedsYou(r.waitingFor as Record<string, unknown> | null, now));
}

/**
 * Needs you's questions, oldest first, each named with the runner it waits on
 * (the fleet snapshot's own runner ↔ worker match), and whether any runner is
 * connected. `superseded`: tasks whose question recovery superseded.
 */
export function homeQuestionsFrom(input: {
  heartbeats: readonly FleetHeartbeatRow[];
  rows: readonly HomeQuestionWorkerRow[];
  superseded: ReadonlySet<string>;
  now: number;
}): { questions: HomeFleetQuestion[]; runnerConnected: boolean } {
  const { heartbeats, now } = input;
  const asking = admittedQuestionRows(input.rows, now).filter(r => !(r.taskId && input.superseded.has(r.taskId)));
  const lanes: FleetWorkerRow[] = asking.map(r => ({
    id: r.id, accountId: r.accountId, runner: r.runner, localUiUrl: r.localUiUrl, status: r.status,
    startedAt: r.startedAt, completedAt: null, updatedAt: r.updatedAt, prNumber: null,
    waitingFor: r.waitingFor as FleetWorkerRow['waitingFor'], error: r.error, phase: 'Claimed',
    task: r.taskId ? { id: r.taskId, title: r.taskTitle ?? '', label: r.taskLabel, mode: r.taskMode, roleSlug: r.roleSlug, missionId: r.missionId, taskClass: r.taskClass } : null,
  }));
  const fleet = buildFleetSnapshot(heartbeats as FleetHeartbeatRow[], lanes, {
    now, roles: new Map(), onlineThresholdMs: FLEET_ONLINE_WINDOW_MS, maxWindowMs: FLEET_WINDOW_MS, sessionsOnline: null,
  });
  const runnerNameById = new Map<string, string>();
  for (const runner of fleet.sessions ? [...fleet.runners, fleet.sessions] : fleet.runners) {
    for (const slot of runner.slots) for (const bar of slot.lane.bars) runnerNameById.set(bar.id, runner.name);
  }
  const questions = asking
    .slice()
    .sort((a, b) => new Date(a.updatedAt ?? 0).getTime() - new Date(b.updatedAt ?? 0).getTime())
    .flatMap(r => {
      const question = homeQuestionView({ waitingFor: r.waitingFor, error: r.waitingFor ? r.error : null, taskTitle: r.taskTitle });
      if (!question) return [];
      return [{
        workerId: r.id, taskId: r.taskId, missionId: r.missionId,
        label: taskShortLabel({ title: r.taskTitle ?? '', label: r.taskLabel, mode: r.taskMode }).label,
        runnerName: runnerNameById.get(r.id) ?? null,
        askedAt: r.updatedAt ? new Date(r.updatedAt).toISOString() : null,
        question,
      }];
    });
  return { questions, runnerConnected: fleet.runners.length > 0 };
}

/**
 * The Agents panel's fleet: fresh heartbeats × the workers live on them, and
 * each slot's lane over the window. Home streams it in after the page shows.
 */
export async function loadHomeFleet(input: {
  teamId: string | null;
  wsIds: string[];
  now: number;
  dayStart: number;
  roles: ReadonlyMap<string, { name: string; color: string | null }>;
}): Promise<HomeFleetData> {
  const { teamId, wsIds, now, dayStart, roles } = input;
  if (wsIds.length === 0) return EMPTY;
  const windowStart = new Date(Math.max(now - FLEET_WINDOW_MS, Math.min(dayStart, now - 30 * 60_000)));

  const [heartbeatRows, workerRows, sessionsOnline] = await Promise.all([
    loadFleetHeartbeats({ teamId, wsIds, now }),
    // No cap on live workers (every one is a slot); the history half is windowed.
    db
      .select({
        id: workers.id, accountId: workers.accountId, runner: workers.runner, localUiUrl: workers.localUiUrl,
        status: workers.status, startedAt: workers.startedAt, completedAt: workers.completedAt, updatedAt: workers.updatedAt,
        mergedAt: workers.mergedAt, prNumber: workers.prNumber, waitingFor: workers.waitingFor,
        // Only beside a question: the context fallback for a card whose brief was lost.
        error: sql<string | null>`case when ${workers.waitingFor} is not null then ${workers.error} end`,
        createdAt: workers.createdAt, milestones: workers.milestones, dirtyWorktree: workers.dirtyWorktree,
        observedTouches: workers.observedTouches, lastCommitSha: workers.lastCommitSha, commitCount: workers.commitCount,
        prUrl: workers.prUrl, prIsDraft: workers.prIsDraft, prLifecycleStatus: workers.prLifecycleStatus,
        outputRequirement: tasks.outputRequirement,
        taskStatus: tasks.status, taskId: tasks.id, taskTitle: tasks.title, taskLabel: tasks.label, taskMode: tasks.mode,
        roleSlug: tasks.roleSlug, missionId: tasks.missionId, taskClass: tasks.taskClass,
      })
      .from(workers)
      .leftJoin(tasks, eq(workers.taskId, tasks.id))
      .where(and(
        inArray(workers.workspaceId, wsIds),
        or(
          inArray(workers.status, [...LIVE_WORKER_STATUSES]),
          gte(workers.startedAt, windowStart),
        ),
      ))
      .orderBy(desc(workers.startedAt))
      .limit(FLEET_WORKER_ROW_CAP),
    // The sessions lane's "N online" caption. Best effort: the lane still
    // draws its live claims without it.
    loadSessionsOnline(wsIds, now),
  ]);

  const rows: FleetWorkerRow[] = workerRows.map(r => ({
    id: r.id, accountId: r.accountId, runner: r.runner, localUiUrl: r.localUiUrl, status: r.status,
    startedAt: r.startedAt, completedAt: r.completedAt, updatedAt: r.updatedAt, prNumber: r.prNumber,
    waitingFor: r.waitingFor as FleetWorkerRow['waitingFor'], error: r.error,
    phase: deriveRunEvidence(r).phases.filter(p => p.state === 'done' || p.state === 'current' || p.state === 'failed').at(-1)?.label ?? 'Claimed',
    task: r.taskId ? {
      id: r.taskId, title: r.taskTitle ?? '', label: r.taskLabel, mode: r.taskMode,
      roleSlug: r.roleSlug, missionId: r.missionId, taskClass: r.taskClass,
    } : null,
  }));
  // Lanes: runs inside the window (plus every live one).
  const laneRows = rows.filter(r => r.startedAt && new Date(r.startedAt).getTime() >= windowStart.getTime() || (LIVE_WORKER_STATUSES as readonly string[]).includes(r.status));
  const fleet = buildFleetSnapshot(heartbeatRows as FleetHeartbeatRow[], laneRows, {
    now, roles, onlineThresholdMs: FLEET_ONLINE_WINDOW_MS, maxWindowMs: FLEET_WINDOW_MS, sessionsOnline,
  });
  return { fleet };
}

/**
 * What `idleWhileQueued` reads for a window: every run's span (runner slots
 * and sessions both count as busy) and each claimable task's wait. A task is
 * waiting from creation to its first run; one with `dependsOn` is held by
 * something else, not by a slot, so it is left out. Capped like the lanes.
 */
export async function loadQueueHistory(input: { wsIds: string[]; from: number; now: number }): Promise<{ runs: RunInterval[]; queued: QueuedInterval[] }> {
  const { wsIds, from, now } = input;
  if (wsIds.length === 0) return { runs: [], queued: [] };
  const fromDate = new Date(from);
  const [runRows, taskRows] = await Promise.all([
    db
      .select({ startedAt: workers.startedAt, completedAt: workers.completedAt, updatedAt: workers.updatedAt, status: workers.status, error: workers.error })
      .from(workers)
      .where(and(
        inArray(workers.workspaceId, wsIds),
        isNotNull(workers.startedAt),
        or(inArray(workers.status, [...LIVE_WORKER_STATUSES]), gte(workers.updatedAt, fromDate)),
      ))
      .limit(FLEET_WORKER_ROW_CAP * 2),
    db
      .select({
        createdAt: tasks.createdAt,
        status: tasks.status,
        firstStart: sql<Date | null>`(select min(${workers.startedAt}) from ${workers} where ${workers.taskId} = ${tasks.id})`,
      })
      .from(tasks)
      .where(and(
        inArray(tasks.workspaceId, wsIds),
        sql`coalesce(jsonb_array_length(${tasks.dependsOn}), 0) = 0`,
        or(
          eq(tasks.status, 'pending'),
          gte(tasks.updatedAt, fromDate),
        ),
      ))
      .limit(FLEET_WORKER_ROW_CAP * 2),
  ]);
  const live = new Set<string>(LIVE_WORKER_STATUSES);
  const runs: RunInterval[] = runRows.map(r => ({
    start: new Date(r.startedAt!).getTime(),
    // A question whose session ended stopped using its slot at its last write.
    end: live.has(r.status) && !questionSessionEnded(r) ? null : new Date(r.completedAt ?? r.updatedAt ?? now).getTime(),
  }));
  const queued: QueuedInterval[] = [];
  for (const t of taskRows) {
    const created = new Date(t.createdAt).getTime();
    if (t.firstStart) queued.push({ from: created, to: new Date(t.firstStart).getTime() });
    else if (t.status === 'pending') queued.push({ from: created, to: null });
  }
  return { runs, queued };
}

/**
 * Health › Runners' lanes: the fleet with its recent runs (not just the live
 * ones) and the stretches every slot sat idle while work waited. Lean on
 * purpose: no ticker, counts or questions, and only the runners page calls it.
 */
export async function loadRunnersFleet(input: { teamId: string | null; wsIds: string[]; now: number; viewerId?: string | null }): Promise<{ fleet: FleetSnapshot; idle: IdleStretch[] }> {
  const { teamId, wsIds, now, viewerId } = input;
  if (wsIds.length === 0) return { fleet: EMPTY.fleet, idle: [] };
  const windowStart = now - FLEET_WINDOW_MS;
  const [heartbeatRows, workerRows, history] = await Promise.all([
    loadFleetHeartbeats({ teamId, wsIds, now }),
    db
      .select({
        id: workers.id, accountId: workers.accountId, ownerId: workers.claimedByUserId, taskOwnerId: tasks.createdByUserId, runner: workers.runner, localUiUrl: workers.localUiUrl,
        status: workers.status, startedAt: workers.startedAt, completedAt: workers.completedAt, updatedAt: workers.updatedAt,
        prNumber: workers.prNumber, mergedAt: workers.mergedAt, waitingFor: workers.waitingFor, error: workers.error,
        taskId: tasks.id, taskTitle: tasks.title, taskLabel: tasks.label, taskMode: tasks.mode,
        roleSlug: tasks.roleSlug, missionId: tasks.missionId, taskClass: tasks.taskClass,
      })
      .from(workers)
      .leftJoin(tasks, eq(workers.taskId, tasks.id))
      .where(and(
        inArray(workers.workspaceId, wsIds),
        or(inArray(workers.status, [...LIVE_WORKER_STATUSES]), gte(workers.startedAt, new Date(windowStart))),
      ))
      .orderBy(desc(workers.startedAt))
      .limit(FLEET_WORKER_ROW_CAP),
    loadQueueHistory({ wsIds, from: windowStart, now }),
  ]);
  // A run that stopped (a session limit, say) whose task merged later, from
  // this run or another: the merged PR, so the run reads "merged as #N".
  const taskIds = [...new Set(workerRows.map(r => r.taskId).filter((id): id is string => !!id))];
  const mergedRows = taskIds.length === 0 ? [] : await db
    .select({ taskId: workers.taskId, prNumber: workers.prNumber })
    .from(workers)
    .where(and(inArray(workers.taskId, taskIds), isNotNull(workers.mergedAt), isNotNull(workers.prNumber)));
  const mergedPrByTask = new Map(mergedRows.map(r => [r.taskId, r.prNumber]));
  const rows: FleetWorkerRow[] = workerRows.map(r => ({
    id: r.id, accountId: r.accountId, ownerId: r.ownerId, taskOwnerId: r.taskOwnerId, runner: r.runner, localUiUrl: r.localUiUrl, status: r.status,
    startedAt: r.startedAt, completedAt: r.completedAt, updatedAt: r.updatedAt, prNumber: r.prNumber,
    mergedAt: r.mergedAt, waitingFor: r.waitingFor as FleetWorkerRow['waitingFor'], error: r.error,
    taskMergedPr: r.taskId ? mergedPrByTask.get(r.taskId) ?? null : null,
    task: r.taskId ? {
      id: r.taskId, title: r.taskTitle ?? '', label: r.taskLabel, mode: r.taskMode,
      roleSlug: r.roleSlug, missionId: r.missionId, taskClass: r.taskClass,
    } : null,
  }));
  const fleet = buildFleetSnapshot(heartbeatRows as FleetHeartbeatRow[], rows, {
    now, onlineThresholdMs: FLEET_ONLINE_WINDOW_MS, maxWindowMs: FLEET_WINDOW_MS, viewerId,
  });
  const from = Math.max(fleet.window.from, windowStart);
  return { fleet, idle: idleWhileQueued({ ...history, from, to: now }) };
}
