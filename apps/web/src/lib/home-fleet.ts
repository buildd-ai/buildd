/**
 * Home's fleet queries: the runner snapshot (heartbeats × live workers), each
 * slot's day history, the ticker's events and the stat strip's counts.
 * Shaping lives in the pure modules (`fleet-view.ts`, `home-ticker.ts`);
 * this file only reads.
 *
 * Runner ↔ worker join: a runner claims with `runner = <its localUiUrl>` and
 * reports the same URL on the worker row (`workers.localUiUrl`); heartbeats are
 * unique per (account, localUiUrl). The same rows /api/workspaces/[id]/runners
 * reads, scoped here to the team's accounts and workspaces in one query.
 */
import { db } from '@buildd/core/db';
import { accounts, missions, tasks, workerHeartbeats, workers } from '@buildd/core/db/schema';
import { and, desc, eq, gt, gte, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { RUNNER_ONLINE_THRESHOLD_MS, RUNNER_STALE_CUTOFF_MS, type FleetSnapshot } from '@buildd/shared';
import { buildFleetSnapshot, type FleetHeartbeatRow, type FleetWorkerRow } from './fleet-view';
import { buildTickerEvents, type TickerEvent } from './home-ticker';
import { taskShortLabel } from './segment-label';
import { LIVE_WORKER_STATUSES } from './task-presentation';
import { workerProgressSql } from './worker-progress';
import { noRowOfPrMerged } from './pr-merge-stamp';

export interface HomeFleetStats {
  mergedToday: number;
  mergedPrNumbers: number[];
  /** Open PRs still waiting on CI — the platform's, not the owner's. */
  prsInCi: Array<{ prNumber: number; label: string }>;
  /** Fix attempts (CI / review) that completed today. */
  selfHealed: number;
}

/** A worker parked on a question — the Needs-you stack answers it inline. */
export interface HomeFleetQuestion {
  workerId: string;
  taskId: string | null;
  missionId: string | null;
  label: string;
  runnerName: string | null;
  askedAt: string | null;
  prompt: string;
  options: string[];
}

export interface HomeFleetData {
  fleet: FleetSnapshot;
  ticker: TickerEvent[];
  stats: HomeFleetStats;
  questions: HomeFleetQuestion[];
}

/** How far back a slot's lane reaches. */
export const FLEET_WINDOW_MS = 8 * 3_600_000;
/** Most worker rows one Home render reads for the lanes and the ticker. */
export const FLEET_WORKER_ROW_CAP = 400;

const EMPTY: HomeFleetData = {
  fleet: { runners: [], live: 0, capacity: 0, window: { from: 0, to: 0 } },
  ticker: [],
  stats: { mergedToday: 0, mergedPrNumbers: [], prsInCi: [], selfHealed: 0 },
  questions: [],
};

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
  const dayStartDate = new Date(dayStart);

  const wsArray = sql`array[${sql.join(wsIds.map(id => sql`${id}`), sql`, `)}]::text[]`;
  const teamAccountIds = teamId
    ? db.select({ id: accounts.id }).from(accounts).where(eq(accounts.teamId, teamId))
    : null;

  const [heartbeatRows, workerRows, ciRows, healedRows, doneMissions] = await Promise.all([
    db
      .select({
        id: workerHeartbeats.id,
        accountId: workerHeartbeats.accountId,
        localUiUrl: workerHeartbeats.localUiUrl,
        maxConcurrentWorkers: workerHeartbeats.maxConcurrentWorkers,
        environment: workerHeartbeats.environment,
        lastHeartbeatAt: workerHeartbeats.lastHeartbeatAt,
      })
      .from(workerHeartbeats)
      .where(and(
        gt(workerHeartbeats.lastHeartbeatAt, new Date(now - RUNNER_STALE_CUTOFF_MS)),
        or(
          sql`${workerHeartbeats.workspaceIds} ?| ${wsArray}`,
          teamAccountIds ? inArray(workerHeartbeats.accountId, teamAccountIds) : undefined,
        ),
      )),
    // No cap on live workers (every one is a slot); the history half is windowed.
    db
      .select({
        id: workers.id, accountId: workers.accountId, runner: workers.runner, localUiUrl: workers.localUiUrl,
        status: workers.status, startedAt: workers.startedAt, completedAt: workers.completedAt, updatedAt: workers.updatedAt,
        mergedAt: workers.mergedAt, prNumber: workers.prNumber, waitingFor: workers.waitingFor,
        linesAdded: workers.linesAdded, linesRemoved: workers.linesRemoved,
        progress: workerProgressSql,
        taskId: tasks.id, taskTitle: tasks.title, taskLabel: tasks.label, taskMode: tasks.mode,
        roleSlug: tasks.roleSlug, missionId: tasks.missionId, taskClass: tasks.taskClass,
      })
      .from(workers)
      .leftJoin(tasks, eq(workers.taskId, tasks.id))
      .where(and(
        inArray(workers.workspaceId, wsIds),
        or(
          inArray(workers.status, [...LIVE_WORKER_STATUSES]),
          gte(workers.startedAt, windowStart),
          gte(workers.mergedAt, dayStartDate),
        ),
      ))
      .orderBy(desc(workers.startedAt))
      .limit(FLEET_WORKER_ROW_CAP),
    db
      .select({ prNumber: workers.prNumber, taskTitle: tasks.title, taskLabel: tasks.label })
      .from(workers)
      .leftJoin(tasks, eq(workers.taskId, tasks.id))
      .where(and(
        inArray(workers.workspaceId, wsIds),
        isNotNull(workers.prNumber),
        isNull(workers.mergedAt),
        // A retry row that adopted a PR another row saw merge is not "in CI".
        noRowOfPrMerged(),
        inArray(workers.prLifecycleStatus, ['pr_open', 'ci_running']),
        gte(workers.updatedAt, new Date(now - 7 * 86_400_000)),
      ))
      .orderBy(desc(workers.updatedAt))
      .limit(20),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(tasks)
      .where(and(
        inArray(tasks.workspaceId, wsIds),
        eq(tasks.taskClass, 'attempt'),
        eq(tasks.status, 'completed'),
        gte(tasks.updatedAt, dayStartDate),
      )),
    teamId
      ? db
          .select({ id: missions.id, title: missions.title, completedAt: missions.completedAt })
          .from(missions)
          .where(and(eq(missions.teamId, teamId), eq(missions.status, 'completed'), gte(missions.completedAt, windowStart)))
          .limit(10)
      : Promise.resolve([] as Array<{ id: string; title: string; completedAt: Date | null }>),
  ]);

  const rows: FleetWorkerRow[] = workerRows.map(r => ({
    id: r.id, accountId: r.accountId, runner: r.runner, localUiUrl: r.localUiUrl, status: r.status,
    startedAt: r.startedAt, completedAt: r.completedAt, updatedAt: r.updatedAt, prNumber: r.prNumber,
    waitingFor: r.waitingFor as FleetWorkerRow['waitingFor'], progress: r.progress == null ? null : Number(r.progress),
    task: r.taskId ? {
      id: r.taskId, title: r.taskTitle ?? '', label: r.taskLabel, mode: r.taskMode,
      roleSlug: r.roleSlug, missionId: r.missionId, taskClass: r.taskClass,
    } : null,
  }));
  // Lanes: runs inside the window (plus every live one). A PR merged today
  // from an older run feeds the counts, not the lanes.
  const laneRows = rows.filter(r => r.startedAt && new Date(r.startedAt).getTime() >= windowStart.getTime() || (LIVE_WORKER_STATUSES as readonly string[]).includes(r.status));
  const fleet = buildFleetSnapshot(heartbeatRows as FleetHeartbeatRow[], laneRows, {
    now, roles, onlineThresholdMs: RUNNER_ONLINE_THRESHOLD_MS, maxWindowMs: FLEET_WINDOW_MS,
  });

  const runnerNameById = new Map<string, string>();
  for (const runner of fleet.runners) for (const slot of runner.slots) for (const bar of slot.lane.bars) runnerNameById.set(bar.id, runner.name);
  const ticker = buildTickerEvents(
    workerRows.map(r => ({
      id: r.id, status: r.status, startedAt: r.startedAt, completedAt: r.completedAt, updatedAt: r.updatedAt,
      mergedAt: r.mergedAt, prNumber: r.prNumber, linesAdded: r.linesAdded, linesRemoved: r.linesRemoved,
      runnerName: runnerNameById.get(r.id) ?? null,
      task: r.taskId ? { id: r.taskId, title: r.taskTitle ?? '', label: r.taskLabel, mode: r.taskMode, missionId: r.missionId } : null,
    })),
    doneMissions,
    { since: windowStart.getTime(), limit: 12 },
  );

  const merged = workerRows.filter(r => r.mergedAt && new Date(r.mergedAt).getTime() >= dayStart && r.prNumber);
  const mergedPrNumbers = [...new Set(merged.map(r => r.prNumber!))].sort((a, b) => b - a);
  const questions: HomeFleetQuestion[] = workerRows
    .filter(r => r.status === 'waiting_input' && (r.waitingFor as any)?.prompt)
    .sort((a, b) => new Date(a.updatedAt ?? 0).getTime() - new Date(b.updatedAt ?? 0).getTime())
    .map(r => {
      const wf = r.waitingFor as { prompt: string; options?: string[] };
      return {
        workerId: r.id, taskId: r.taskId, missionId: r.missionId,
        label: taskShortLabel({ title: r.taskTitle ?? '', label: r.taskLabel, mode: r.taskMode }).label,
        runnerName: runnerNameById.get(r.id) ?? null,
        askedAt: r.updatedAt ? new Date(r.updatedAt).toISOString() : null,
        prompt: wf.prompt,
        options: Array.isArray(wf.options) ? wf.options.filter((o): o is string => typeof o === 'string') : [],
      };
    });

  return {
    fleet,
    ticker,
    questions,
    stats: {
      mergedToday: mergedPrNumbers.length,
      mergedPrNumbers,
      prsInCi: ciRows
        // One entry per PR, however many rows carry it.
        .filter((r, i, all) => r.prNumber != null && all.findIndex(o => o.prNumber === r.prNumber) === i)
        .map(r => ({ prNumber: r.prNumber!, label: taskShortLabel({ title: r.taskTitle ?? '', label: r.taskLabel }).label })),
      selfHealed: healedRows[0]?.n ?? 0,
    },
  };
}
