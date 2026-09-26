import { missions } from '@buildd/core/db/schema';
import { and, desc, eq, lt, ne, or, type SQL } from 'drizzle-orm';
import type { FlightStripTask, FlightStripWorker } from '@buildd/core/mission-helpers';

/**
 * Query-shape helpers for the missions list (docs/design/mission-flight-strip.md
 * Rules P-2 and P-4). Split out from the page component so the `with` shape
 * itself is assertable in a unit test (AC-12) without a database — the
 * completed-missions query must SKIP the extra flight-strip fan-out columns
 * by construction, not by a runtime branch that happens to not use them.
 */

export const COMPLETED_MISSIONS_PAGE_SIZE = 20;

export const MISSION_BASE_COLUMNS = {
  id: true, title: true, description: true, status: true, teamId: true, workspaceId: true,
  orchestrationMode: true, costBudgetUsd: true, dependsOnMissionId: true, dependencyMetAt: true,
  mergePolicy: true, startAt: true, isHeld: true, initiativeId: true, priority: true,
  goalCriteria: true, goalCriteriaState: true, lastTaskStartedAt: true, createdAt: true,
  updatedAt: true, criteriaEscalatedAt: true, completedAt: true, workingBranch: true,
  integrationBranchEnabled: true,
} as const;

export const MISSION_TASK_BASE_COLUMNS = {
  id: true, title: true, status: true, result: true, createdAt: true, updatedAt: true, kind: true,
  mode: true, creationSource: true, category: true, parentTaskId: true, dependsOn: true,
  scheduleId: true, startAt: true, loopIteration: true, taskClass: true, createdByWorkerId: true,
  createdByAccountId: true,
} as const;

export const MISSION_WORKER_BASE_COLUMNS = {
  id: true, status: true, startedAt: true, completedAt: true, updatedAt: true, turns: true,
  prUrl: true, mergedAt: true, prNumber: true, prLifecycleStatus: true, supersededByPrNumber: true,
} as const;

const MISSION_WITH_SHARED = {
  workspace: { columns: { id: true, name: true, gitConfig: true, releaseConfig: true } } as const,
  initiative: { columns: { id: true, title: true } } as const,
  schedule: { columns: { id: true, nextRunAt: true, lastRunAt: true, cronExpression: true, lastDeferralReason: true, lastDeferredAt: true, maxConcurrentFromSchedule: true, totalRuns: true } } as const,
};

const taskOrderBy = (t: any, { desc }: any) => [desc(t.updatedAt)];
/** Newest attempt first, so a live re-claim is always inside the per-task limit. */
const workerOrderBy = (w: any, { desc }: any) => [desc(w.startedAt), desc(w.updatedAt)];

/**
 * Rule P-3 governs cost here (bounded by workspace maxConcurrentTasks), so
 * this half is deliberately NOT limited. Adds `roleSlug` (tasks) and
 * `exitCause` (workers) on top of the base columns — the two fields the
 * live flight-strip computation needs (Rule A-1/A-2) that nothing else on
 * this page reads — plus the phase fields that order the card's pulse.
 * Completed cards are compact (no pulse), so the completed query skips them.
 */
export function buildActiveMissionsQueryArgs(missionsWhere: SQL | undefined) {
  return {
    where: and(missionsWhere, ne(missions.status, 'completed')),
    orderBy: [desc(missions.priority), desc(missions.lastTaskStartedAt), desc(missions.updatedAt)],
    columns: MISSION_BASE_COLUMNS,
    with: {
      ...MISSION_WITH_SHARED,
      tasks: {
        // Phase fields order the card's pulse (lib/mission-card-view.ts).
        columns: { ...MISSION_TASK_BASE_COLUMNS, roleSlug: true, missionPhaseIndex: true, missionPhaseLabel: true },
        orderBy: taskOrderBy,
        with: {
          workers: {
            // waitingFor: the list card answers a parked question inline.
            columns: { ...MISSION_WORKER_BASE_COLUMNS, exitCause: true, waitingFor: true },
            limit: 5,
            orderBy: workerOrderBy,
          },
        },
      },
    },
  };
}

export interface CompletedMissionCursor {
  completedAt: string;
  id: string;
}

export function encodeCompletedCursor(cursor: CompletedMissionCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeCompletedCursor(raw: string | undefined | null): CompletedMissionCursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (parsed && typeof parsed.completedAt === 'string' && typeof parsed.id === 'string') {
      return { completedAt: parsed.completedAt, id: parsed.id };
    }
  } catch {
    // Malformed/tampered cursor — treat as no cursor (first page) rather than 500.
  }
  return null;
}

/**
 * Rule P-2: completed missions read `flightStripCache` directly and skip the
 * flight-strip fan-out entirely — `roleSlug`/`exitCause` are absent from this
 * query's `with` shape by construction (AC-12), not filtered out after the
 * fact. Rule P-4: bounded + keyset-paginated on (completedAt, id) descending,
 * requesting one extra row so the caller can detect `hasMore` without a
 * second count query.
 */
export function buildCompletedMissionsQueryArgs(missionsWhere: SQL | undefined, cursor: CompletedMissionCursor | null) {
  const cursorClause = cursor
    ? or(
        lt(missions.completedAt, new Date(cursor.completedAt)),
        and(eq(missions.completedAt, new Date(cursor.completedAt)), lt(missions.id, cursor.id)),
      )
    : undefined;
  return {
    where: and(missionsWhere, eq(missions.status, 'completed'), cursorClause),
    orderBy: [desc(missions.completedAt), desc(missions.id)],
    limit: COMPLETED_MISSIONS_PAGE_SIZE + 1,
    columns: { ...MISSION_BASE_COLUMNS, flightStripCache: true },
    with: {
      ...MISSION_WITH_SHARED,
      tasks: {
        columns: MISSION_TASK_BASE_COLUMNS,
        orderBy: taskOrderBy,
        with: {
          workers: {
            columns: MISSION_WORKER_BASE_COLUMNS,
            limit: 5,
            orderBy: workerOrderBy,
          },
        },
      },
    },
  };
}

/** Adapts the nested `tasks -> workers` shape either query returns into the
 * flat two-array input `computeMissionFlightStrip` consumes. `taskId` isn't
 * selected on the workers sub-relation (it's implicit in the nesting), so
 * it's set here from the parent task instead. Split out from the page
 * component so the mapping itself is testable without a database. */
export function adaptFlightStripInputs(taskRows: any[]): { tasks: FlightStripTask[]; workers: FlightStripWorker[] } {
  const tasks: FlightStripTask[] = taskRows.map((t: any) => ({
    id: t.id, status: t.status, taskClass: t.taskClass, roleSlug: t.roleSlug ?? null, kind: t.kind, title: t.title,
  }));
  const workers: FlightStripWorker[] = taskRows.flatMap((t: any) =>
    (t.workers || []).map((w: any) => ({
      id: w.id, taskId: t.id, status: w.status, startedAt: w.startedAt, completedAt: w.completedAt,
      updatedAt: w.updatedAt, exitCause: w.exitCause ?? null,
    })),
  );
  return { tasks, workers };
}

/** Pure pagination trim: the query asks for PAGE_SIZE+1 rows so this can tell
 * "more exist" from "that was the last page" without a second round trip. */
export function paginateCompletedMissions<T extends { completedAt: Date | string | null; id: string }>(
  rows: T[],
  pageSize: number = COMPLETED_MISSIONS_PAGE_SIZE,
): { items: T[]; nextCursor: string | null } {
  if (rows.length <= pageSize) return { items: rows, nextCursor: null };
  const items = rows.slice(0, pageSize);
  const last = items[items.length - 1]!;
  if (last.completedAt == null) return { items, nextCursor: null };
  return {
    items,
    nextCursor: encodeCompletedCursor({ completedAt: new Date(last.completedAt).toISOString(), id: last.id }),
  };
}
