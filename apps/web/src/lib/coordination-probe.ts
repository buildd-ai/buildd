/**
 * Read-only probe: which coordination gates would the next claim defer this
 * task for, right now? Loads the claim route's own snapshot for the task's
 * workspace and mission (`claim/coordination-snapshot`) and evaluates the
 * claim route's own predicates (`claim/coordination-gates`), so `/start` can
 * refuse with the real blocker instead of accepting a start no runner will
 * take.
 *
 * Every dependency edge still in `dependsOn` is a declared dependency no
 * force lifts: guessed edges are gone (spec: Overlap scheduling, R-1, R-4),
 * and nothing here re-guesses one. Whether an edge still holds is the claim's
 * own SQL predicate (`dependencySatisfied`). A stored soft overlap holds
 * nothing at claim any more (R-2), so it is not a reason here either.
 *
 * Never throws: a probe failure returns `null` (unknown) and the caller falls
 * back to today's behaviour rather than blocking a start on a read error.
 */
import { lanesOf, loadLanes } from '@/lib/serial-lanes-store';
import { db } from '@buildd/core/db';
import { gateEvents, tasks, workers } from '@buildd/core/db/schema';
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { getActiveClaimsByWorkspace } from '@buildd/core/path-claim';
import { makeWaitingReason, orderWaitingReasons, type WaitingReason } from '@buildd/core/waiting-reason';
import { dependencySatisfied } from '@/app/api/workers/claim/deps-gate';
import { checkMissionLocal } from '@/app/api/workers/claim/held-gate';
import { BYPASS_DEPS_GATE_KEY, BYPASS_HELD_GATE_KEY, hasBypassFlag } from '@/lib/bypass-flags';
import { evaluateCoordinationGates } from '@/app/api/workers/claim/coordination-gates';
import { loadMissionCoordination, loadOpenPrTasksByWorkspace } from '@/app/api/workers/claim/coordination-snapshot';
import { ORDERED_BEHIND_REASON } from '@/app/api/workers/claim/claim-plan-store';
import { GATE_SLUGS } from '@buildd/core/gate-events';
import { LIVE_WORKER_STATUSES } from '@buildd/shared';
import { sqlWhere } from '@buildd/core/db/relational-sql';

/**
 * `ordered_behind` is written once per (task, blocker), never refreshed, so
 * the blocker's liveness is what says it still applies; this only bounds the read.
 */
const ORDERED_BEHIND_FRESH_MS = 6 * 60 * 60 * 1000;

export interface ProbeTask {
  id: string;
  workspaceId: string;
  missionId?: string | null;
  pathManifest?: unknown;
  category?: unknown;
  context?: unknown;
  outputRequirement?: unknown;
  [k: string]: unknown;
}

export interface ProbeOptions {
  /** Skip the local-mission reason (the caller already lifted or reported it). */
  skipMissionLocal?: boolean;
}

export async function probeCoordination(task: ProbeTask, now: Date = new Date(), opts: ProbeOptions = {}): Promise<WaitingReason[] | null> {
  try {
    const missionId = (task.missionId as string | null) ?? null;
    const [openPrByWs, activeClaims, missionData, orderedRow, laneRead] = await Promise.all([
      loadOpenPrTasksByWorkspace([task.workspaceId]),
      getActiveClaimsByWorkspace(task.workspaceId).catch(() => null),
      missionId ? loadMissionCoordination([missionId]) : Promise.resolve(null),
      db.select({ detail: gateEvents.detail, occurredAt: gateEvents.occurredAt })
        .from(gateEvents)
        .where(and(
          eq(gateEvents.taskId, task.id),
          eq(gateEvents.gate, GATE_SLUGS.CLAIM_LOOP_DEFERRAL),
          eq(gateEvents.reason, ORDERED_BEHIND_REASON),
          gte(gateEvents.occurredAt, new Date(now.getTime() - ORDERED_BEHIND_FRESH_MS)),
        ))
        .orderBy(desc(gateEvents.occurredAt))
        .limit(1)
        .then(rows => rows[0] ?? null)
        .catch(() => null),
      // The claim route's own lane read and order (a failed read: no lane position, the open-PR check still speaks).
      lanesOf(task as never).length > 0 ? loadLanes([task.workspaceId], now).catch(() => null) : Promise.resolve(null),
    ]);

    const orderedDetail = (orderedRow?.detail ?? null) as Record<string, unknown> | null;
    const orderedBehind = typeof orderedDetail?.blockedBy === 'string'
      ? {
          blockedBy: orderedDetail.blockedBy,
          edge: typeof orderedDetail.edge === 'string' ? orderedDetail.edge : null,
          since: orderedRow?.occurredAt ? new Date(orderedRow.occurredAt).toISOString() : null,
        }
      : null;

    const candidateHolders = [
      ...(activeClaims ? [...activeClaims.keys()] : []),
      ...(orderedBehind ? [orderedBehind.blockedBy] : []),
    ].filter(id => id !== task.id);
    const liveRows = candidateHolders.length > 0
      ? await db.query.workers.findMany({
          where: sqlWhere(and(inArray(workers.taskId, candidateHolders), inArray(workers.status, [...LIVE_WORKER_STATUSES]))),
          columns: { taskId: true },
        })
      : [];

    const reasons = evaluateCoordinationGates(task, {
      openPrTasks: openPrByWs.get(task.workspaceId) ?? [],
      activeClaims,
      mission: missionId ? (missionData?.missionClaimMap.get(missionId) ?? null) : null,
      missionActiveCount: missionId ? (missionData?.missionActiveCountMap.get(missionId) ?? 0) : 0,
      orderedBehind,
      liveTaskIds: new Set(liveRows.map(r => r.taskId).filter((id): id is string => !!id)),
      now,
      lanes: laneRead ? { views: laneRead.lanes.get(task.workspaceId) ?? new Map(), releasedTaskIds: laneRead.releasedTaskIds } : null,
    });
    const [depReasons, localReason] = await Promise.all([
      dependencyReasons(task),
      opts.skipMissionLocal ? Promise.resolve(null) : missionLocalReason(task),
    ]);
    return await withTaskLabels(orderWaitingReasons([
      ...(localReason ? [localReason] : []),
      ...depReasons,
      ...reasons,
    ]));
  } catch (err) {
    console.warn(`[coordination-probe] task ${task.id}: probe failed, start proceeds unprobed:`, (err as Error)?.message ?? err);
    return null;
  }
}

/** Replace "task 1a2b3c4d" blocker labels with the blocker's title. */
async function withTaskLabels(reasons: WaitingReason[]): Promise<WaitingReason[]> {
  const ids = [...new Set(reasons.filter(r => r.blocker?.type === 'task').map(r => r.blocker!.id))];
  if (ids.length === 0) return reasons;
  const rows = await db.query.tasks.findMany({ where: sqlWhere(inArray(tasks.id, ids)), columns: { id: true, title: true } }).catch(() => []);
  const titles = new Map(rows.map(r => [r.id, r.title as string | null]));
  return reasons.map(r => {
    const title = r.blocker?.type === 'task' ? titles.get(r.blocker.id) : null;
    if (!title) return r;
    const label = title.length > 60 ? `${title.slice(0, 57)}…` : title;
    return { ...r, blocker: { ...r.blocker!, label: `“${label}”` } };
  });
}


const DEP_CAP = 25;
const LIVE_TASK_STATUSES = new Set(['assigned', 'in_progress']);

/**
 * Dependency edges that still hold, each a `dep_declared` reason (never
 * forceable) naming the dependency and its status. "Still holds" is the
 * claim route's own per-edge SQL predicate.
 */
async function dependencyReasons(task: ProbeTask): Promise<WaitingReason[]> {
  const deps = ((task.dependsOn as string[] | null) ?? []).filter(id => id !== task.id).slice(0, DEP_CAP);
  if (deps.length === 0) return [];
  if (hasBypassFlag(task.context as Record<string, unknown> | null, BYPASS_DEPS_GATE_KEY)) return [];
  const unmet = await unsatisfiedDeps(task.id, deps);
  if (unmet.size === 0) return [];
  const rows = await db.query.tasks.findMany({ where: sqlWhere(inArray(tasks.id, [...unmet])), columns: { id: true, status: true } }).catch(() => []);
  const statusOf = new Map(rows.map(r => [r.id, r.status as string]));
  return deps.filter(id => unmet.has(id)).map(id => makeWaitingReason('dep_declared', {
    because: 'it was declared as a dependency',
    blocker: {
      type: 'task',
      id,
      label: `task ${id.slice(0, 8)}`,
      href: `/app/tasks/${id}`,
      live: LIVE_TASK_STATUSES.has(statusOf.get(id) ?? ''),
      ...(statusOf.has(id) ? { status: statusOf.get(id)! } : {}),
    },
    provenance: { source: 'task_context', derivedFrom: 'tasks.dependsOn' },
  }));
}

/** The dependency ids the claim's dependency gate would still hold this task on. */
async function unsatisfiedDeps(taskId: string, deps: string[]): Promise<Set<string>> {
  const cols = Object.fromEntries(deps.map((id, i) => [`d${i}`, sql<boolean>`${dependencySatisfied(sql`${id}::uuid`)}`]));
  const rows = await db.select(cols as Record<string, ReturnType<typeof sql<boolean>>>).from(tasks).where(eq(tasks.id, taskId)).limit(1);
  const row = (rows[0] ?? {}) as Record<string, unknown>;
  return new Set(deps.filter((_, i) => row[`d${i}`] !== true && row[`d${i}`] !== 't'));
}

/** A local mission's task: runners never claim it unless a person hands it over. */
async function missionLocalReason(task: ProbeTask): Promise<WaitingReason | null> {
  const missionId = (task.missionId as string | null) ?? null;
  if (!missionId) return null;
  if (hasBypassFlag(task.context as Record<string, unknown> | null, BYPASS_HELD_GATE_KEY)) return null;
  if (!(await checkMissionLocal(missionId).catch(() => false))) return null;
  return makeWaitingReason('mission_local', {
    because: 'its mission runs in a person\'s own session, so runners do not pick up its tasks',
    blocker: { type: 'mission', id: missionId, label: 'a mission run from your session', href: `/app/missions/${missionId}` },
    provenance: { source: 'probe', derivedFrom: "missions.executor='local'" },
  });
}
