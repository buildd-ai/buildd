/**
 * Serial lane rows (`serial_lane_entries`) and the one read every surface uses
 * to see a lane: the claim route, check_path_claim, the start probe, explain,
 * the terminal Queue and the stuck-lane report (spec: Overlap scheduling,
 * Rule 1). Pure rules are in ./serial-lanes; the order is claim-order.ts
 * `laneOrderBy`.
 *
 * No transactions (neon-http): one holder per lane is the partial unique index
 * `serial_lane_entries_holder_idx`. Taking a lane is an upsert that sets
 * `held_at`; a second holder is a unique violation, read as "held".
 *
 * Holding is `held_at` checked against the task now: a member holds while it
 * took the lane and its task is claimed or running or has an open, unmerged PR. `syncLanes`
 * writes that back (ends rows whose task ended with no open PR, clears
 * `held_at` on a holder that went back to pending without a PR), so a merged
 * holder frees the lane on the next read even before any sweep runs.
 */
import { db } from '@buildd/core/db';
import { serialLaneEntries, tasks, workspaces } from '@buildd/core/db/schema';
import { and, eq, inArray, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import type { WorkspaceGitConfig } from '@buildd/core/db/schema';
import { LIVE_WORKER_STATUSES, TERMINAL_TASK_STATUSES } from '@buildd/shared';
import { laneOrderBy } from '@/lib/claim-order';
import { sqlWhere } from '@buildd/core/db/relational-sql';
import { isOwnPrRepair, laneKeysFor, lanePosition, lanesOf, stuckSince, type LaneMember, type LaneTask, type LaneView } from '@/lib/serial-lanes';
export { lanesOf, type LaneTask } from '@/lib/serial-lanes';

type Row = Record<string, unknown>;
async function rows<T extends Row = Row>(query: SQL): Promise<T[]> {
  const r = await db.execute(query);
  return ((r as { rows?: T[] }).rows ?? (Array.isArray(r) ? (r as T[]) : [])) as T[];
}

const toDate = (v: unknown): Date | null => (v == null ? null : v instanceof Date ? v : new Date(String(v)));
const truthy = (v: unknown): boolean => v === true || v === 't' || v === 'true';

const LIVE = sql.join(LIVE_WORKER_STATUSES.map(s => sql`${s}`), sql`, `);
const TERMINAL = sql.join(TERMINAL_TASK_STATUSES.map(s => sql`${s}`), sql`, `);
/** Statuses of a claimed task that has not ended. */
const CLAIMED = sql`'assigned', 'in_progress', 'review'`;

/** The task's latest worker with an open, unmerged PR (same rule as the open-PR snapshot). */
const openPrWorker = (taskRef: SQL) => sql`(
  SELECT w.pr_number, w.pr_url, w.last_commit_sha, w.pr_lifecycle_status
  FROM workers w
  WHERE w.task_id = ${taskRef}
    AND w.pr_url IS NOT NULL AND w.merged_at IS NULL
    AND COALESCE(w.pr_lifecycle_status, '') NOT IN ('closed', 'merged')
    AND w.status IN (${LIVE}, 'completed')
  ORDER BY w.created_at DESC
  LIMIT 1
)`;

/** TRUE while the entry's task is in a holding state: claimed, a live worker, or an open PR. */
const holdingStateSql = (taskRef: SQL, statusRef: SQL) => sql`(
  ${statusRef} IN (${CLAIMED})
  OR EXISTS (SELECT 1 FROM workers lw WHERE lw.task_id = ${taskRef} AND lw.status IN (${LIVE}))
  OR EXISTS ${openPrWorker(taskRef)}
)`;

/**
 * Claimable apart from the lane: pending, start passed, not held, declared
 * deps met (the claim's own gates). Loaded on use: the gate modules are
 * heavy, and a reader that never asks for readiness never needs them.
 */
async function readySql(now: Date): Promise<SQL> {
  const [{ depsGate }, { missionNotHeld, taskNotHeld }] = await Promise.all([
    import('@/app/api/workers/claim/deps-gate'),
    import('@/app/api/workers/claim/held-gate'),
  ]);
  return sql`(${tasks.status} = 'pending'
    AND COALESCE((${or(isNull(tasks.startAt), lte(tasks.startAt, now))}), false)
    AND COALESCE((${taskNotHeld()}), false)
    AND COALESCE((${missionNotHeld()}), false)
    AND COALESCE((${depsGate()}), false))`;
}

export type LaneSnapshot = Map<string, Map<string, LaneView>>;

export interface LaneRead {
  /** workspaceId → lane → view (members in lane order). */
  lanes: LaneSnapshot;
  /** Tasks a person released from a lane: their open PR no longer holds anyone (I-7). */
  releasedTaskIds: Set<string>;
}

/** Every open lane in these workspaces, in stored order, with holding and readiness derived now. */
export async function loadLanes(workspaceIds: string[], now: Date): Promise<LaneRead> {
  const out: LaneRead = { lanes: new Map(), releasedTaskIds: new Set() };
  if (workspaceIds.length === 0) return out;
  const wsList = sql.join(workspaceIds.map(id => sql`${id}::uuid`), sql`, `);
  const e = serialLaneEntries;
  const ready = await readySql(now);
  const found = await rows(sql`
    SELECT e.workspace_id, e.lane, e.task_id, e.claimable_since, e.held_at, e.activity_at,
           ${tasks.status} AS status, ${tasks.priority} AS priority, ${tasks.createdAt} AS created_at,
           (e.held_at IS NOT NULL AND ${holdingStateSql(sql`${tasks.id}`, sql`${tasks.status}`)}) AS holding,
           (${ready} OR (e.joined_via = 'edit' AND e.held_at IS NULL AND ${tasks.status} IN (${CLAIMED}))) AS ready,
           pr.pr_number, pr.pr_url,
           GREATEST(e.activity_at, e.held_at, (
             SELECT MAX(rf.submitted_at) FROM review_feedback rf
             WHERE rf.workspace_id = e.workspace_id AND rf.pr_number = pr.pr_number
           )) AS last_activity_at
    FROM ${e} e
    JOIN ${tasks} ON ${tasks.id} = e.task_id
    LEFT JOIN LATERAL ${openPrWorker(sql`e.task_id`)} pr ON true
    WHERE e.workspace_id IN (${wsList}) AND e.left_at IS NULL
    ORDER BY e.workspace_id, e.lane, ${sql.join(laneOrderBy({ claimableSince: sql`e.claimable_since` }, tasks), sql`, `)}
  `);
  for (const r of found) {
    const ws = String(r.workspace_id);
    const lane = String(r.lane);
    const byLane = out.lanes.get(ws) ?? new Map<string, LaneView>();
    out.lanes.set(ws, byLane);
    const view = byLane.get(lane) ?? { workspaceId: ws, lane, members: [] };
    byLane.set(lane, view);
    const member: LaneMember = {
      taskId: String(r.task_id),
      claimableSince: toDate(r.claimable_since),
      priority: r.priority == null ? null : Number(r.priority),
      createdAt: toDate(r.created_at) ?? now,
      heldAt: toDate(r.held_at),
      holding: truthy(r.holding),
      ready: truthy(r.ready),
      status: String(r.status),
      prNumber: r.pr_number == null ? null : Number(r.pr_number),
      prUrl: (r.pr_url as string | null) ?? null,
      lastActivityAt: toDate(r.last_activity_at),
    };
    view.members.push(member);
  }
  const released = await rows<{ task_id: string }>(sql`
    SELECT DISTINCT task_id FROM ${e} WHERE workspace_id IN (${wsList}) AND left_reason = 'released'
  `);
  for (const r of released) out.releasedTaskIds.add(String(r.task_id));
  return out;
}

/**
 * Bring the rows up to date for these workspaces:
 *  - `claimable` tasks (already claimable apart from the lane, e.g. the claim's
 *    candidates) join their lanes, stamped `claimable_since = now` the first
 *    time; a stamped row is never moved (I-3). A row that had ended is reopened
 *    with a fresh stamp: the task came back as new work.
 *  - Rows whose task ended with no open PR end (merged / closed / ended).
 *  - A holder that no longer holds (back to pending, no PR) gives up `held_at`
 *    and keeps its place (I-4).
 *  - Holder PR activity (head commit, CI state) is recorded for the stuck report.
 */
export async function syncLanes(input: { workspaceIds: string[]; claimable?: LaneTask[]; now: Date }): Promise<void> {
  const { workspaceIds, now } = input;
  if (workspaceIds.length === 0) return;
  const e = serialLaneEntries;
  const joins = (input.claimable ?? []).flatMap(t => lanesOf(t).map(lane => ({ workspaceId: t.workspaceId, lane, taskId: t.id })));
  if (joins.length > 0) {
    await db.insert(e)
      .values(joins.map(j => ({ ...j, claimableSince: now })))
      .onConflictDoUpdate({
        target: [e.workspaceId, e.lane, e.taskId],
        set: {
          claimableSince: sql`CASE WHEN ${e.leftAt} IS NOT NULL THEN excluded.claimable_since ELSE COALESCE(${e.claimableSince}, excluded.claimable_since) END`,
          leftAt: null,
          leftReason: null,
          releasedByUserId: null,
          heldAt: sql`CASE WHEN ${e.leftAt} IS NOT NULL THEN NULL ELSE ${e.heldAt} END`,
        },
        setWhere: sql`${e.leftAt} IS NOT NULL OR ${e.claimableSince} IS NULL`,
      });
  }
  const wsList = sql.join(workspaceIds.map(id => sql`${id}::uuid`), sql`, `);
  // Ended with no open PR: the row ends; the reason is what became of its last PR.
  await db.execute(sql`
    UPDATE ${e} SET left_at = ${now}, held_at = NULL,
      left_reason = CASE
        WHEN EXISTS (SELECT 1 FROM workers w WHERE w.task_id = ${e}.task_id AND w.merged_at IS NOT NULL) THEN 'merged'
        WHEN EXISTS (SELECT 1 FROM workers w WHERE w.task_id = ${e}.task_id AND w.pr_lifecycle_status = 'closed') THEN 'closed'
        ELSE 'ended' END
    FROM ${tasks}
    WHERE ${tasks.id} = ${e}.task_id AND ${e}.workspace_id IN (${wsList}) AND ${e}.left_at IS NULL
      AND ${tasks.status} IN (${TERMINAL})
      AND NOT EXISTS ${openPrWorker(sql`${e}.task_id`)}
  `);
  // A holder back in pending with no PR and no worker holds nothing; it keeps its place.
  await db.execute(sql`
    UPDATE ${e} SET held_at = NULL
    FROM ${tasks}
    WHERE ${tasks.id} = ${e}.task_id AND ${e}.workspace_id IN (${wsList})
      AND ${e}.left_at IS NULL AND ${e}.held_at IS NOT NULL
      AND NOT ${holdingStateSql(sql`${tasks.id}`, sql`${tasks.status}`)}
  `);
  // The holder PR's last observed change (I-7): a new head commit or CI state.
  await db.execute(sql`
    UPDATE ${e} SET activity_signature = pr.sig, activity_at = ${now}
    FROM (
      SELECT DISTINCT ON (w.task_id) w.task_id, COALESCE(w.last_commit_sha, '') || '|' || COALESCE(w.pr_lifecycle_status, '') AS sig
      FROM workers w
      WHERE w.workspace_id IN (${wsList}) AND w.pr_url IS NOT NULL AND w.merged_at IS NULL
      ORDER BY w.task_id, w.created_at DESC
    ) pr
    WHERE pr.task_id = ${e}.task_id AND ${e}.workspace_id IN (${wsList}) AND ${e}.left_at IS NULL
      AND ${e}.activity_signature IS DISTINCT FROM pr.sig
  `);
}

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string }; message?: string } | null;
  return e?.code === '23505' || e?.cause?.code === '23505' || /duplicate key|unique constraint|serial_lane_entries_holder_idx/i.test(e?.message ?? '');
}

export type TakeLanes =
  | { ok: true; heldAt: Date; taken: string[] }
  | { ok: false; lane: string };

/**
 * Take every lane, all or nothing (I-1). A lane already held by another task
 * is a unique violation on the holder index: what was taken is given back and
 * the lane is named. Other errors throw.
 */
export async function takeLanes(input: { workspaceId: string; taskId: string; lanes: string[]; now: Date; via?: 'manifest' | 'edit' }): Promise<TakeLanes> {
  const { workspaceId, taskId, now } = input;
  const e = serialLaneEntries;
  const taken: string[] = [];
  for (const lane of input.lanes) {
    try {
      await db.insert(e)
        .values({ workspaceId, lane, taskId, claimableSince: now, heldAt: now, joinedVia: input.via ?? 'manifest' })
        .onConflictDoUpdate({
          target: [e.workspaceId, e.lane, e.taskId],
          set: { heldAt: sql`COALESCE(${e.heldAt}, ${now}::timestamptz)`, leftAt: null, leftReason: null, releasedByUserId: null, claimableSince: sql`COALESCE(${e.claimableSince}, excluded.claimable_since)` },
        });
      taken.push(lane);
    } catch (err) {
      if (!isUniqueViolation(err)) {
        if (taken.length) await giveBackLanes({ workspaceId, taskId, lanes: taken, heldAt: now }).catch(() => {});
        throw err;
      }
      if (taken.length) await giveBackLanes({ workspaceId, taskId, lanes: taken, heldAt: now });
      return { ok: false, lane };
    }
  }
  return { ok: true, heldAt: now, taken };
}

/** A claim that took lanes then lost its race gives back exactly what it set (`held_at` = its own stamp). */
export async function giveBackLanes(input: { workspaceId: string; taskId: string; lanes: string[]; heldAt: Date }): Promise<void> {
  if (input.lanes.length === 0) return;
  const e = serialLaneEntries;
  await db.update(e).set({ heldAt: null }).where(and(
    eq(e.workspaceId, input.workspaceId), eq(e.taskId, input.taskId), inArray(e.lane, input.lanes),
    sql`${e.heldAt} = ${input.heldAt}::timestamptz`,
  ));
}

/** Join a lane without taking it (a task that edits a lane path while another holds it, I-5). */
export async function joinLane(input: { workspaceId: string; taskId: string; lane: string; now: Date; via: 'manifest' | 'edit' }): Promise<void> {
  const e = serialLaneEntries;
  await db.insert(e)
    .values({ workspaceId: input.workspaceId, lane: input.lane, taskId: input.taskId, claimableSince: input.now, joinedVia: input.via })
    .onConflictDoUpdate({
      target: [e.workspaceId, e.lane, e.taskId],
      set: { leftAt: null, leftReason: null, releasedByUserId: null, claimableSince: sql`COALESCE(${e.claimableSince}, excluded.claimable_since)` },
      setWhere: sql`${e.leftAt} IS NOT NULL OR ${e.claimableSince} IS NULL`,
    });
}

/**
 * A person releases a lane's holder (I-7, AC-9). The row ends as `released`
 * with who did it; the holder's open PR then holds nobody, so position 1 may
 * claim. Returns false when that task was not in the lane.
 */
export async function releaseLaneHolder(input: { workspaceId: string; lane: string; taskId: string; userId: string; now: Date }): Promise<boolean> {
  const e = serialLaneEntries;
  const updated = await db.update(e)
    .set({ leftAt: input.now, leftReason: 'released', releasedByUserId: input.userId, heldAt: null })
    .where(and(eq(e.workspaceId, input.workspaceId), eq(e.lane, input.lane), eq(e.taskId, input.taskId), isNull(e.leftAt)))
    .returning({ id: e.id });
  return updated.length > 0;
}

export interface StuckLane {
  workspaceId: string;
  lane: string;
  holderTaskId: string;
  prNumber: number | null;
  prUrl: string | null;
  quietSince: Date;
  /** The task first in line behind it, if any. */
  nextTaskId: string | null;
}

/** Holders whose PR has had no activity for 24h, from a lane read (I-7). */
export function stuckLanesOf(read: LaneRead, now: Date): StuckLane[] {
  const out: StuckLane[] = [];
  for (const byLane of read.lanes.values()) {
    for (const view of byLane.values()) {
      for (const holder of view.members.filter(m => m.holding)) {
        const quietSince = stuckSince(holder, now);
        if (!quietSince) continue;
        const next = view.members.find(m => !m.holding) ?? null;
        out.push({ workspaceId: view.workspaceId, lane: view.lane, holderTaskId: holder.taskId, prNumber: holder.prNumber, prUrl: holder.prUrl, quietSince, nextTaskId: next?.taskId ?? null });
      }
    }
  }
  return out;
}

/** Workspaces with an open lane row (for the sweep and the sentinel). */
export async function workspacesWithLanes(): Promise<string[]> {
  const found = await db.selectDistinct({ id: serialLaneEntries.workspaceId }).from(serialLaneEntries).where(isNull(serialLaneEntries.leftAt));
  return found.map(r => r.id);
}

/**
 * The sweep (maintenance cron): every unfinished task whose manifest is in a
 * lane gets its row, ready ones are stamped, and ended holders are let go.
 * In-flight lane work that predates the lanes shows up here too.
 */
export async function sweepLanes(now: Date): Promise<{ workspaces: number; joined: number }> {
  const ready = await readySql(now);
  const open = await db
    .select({
      id: tasks.id, workspaceId: tasks.workspaceId, pathManifest: tasks.pathManifest, taskClass: tasks.taskClass,
      conflictRetryPrNumber: tasks.conflictRetryPrNumber, ciRetryPrNumber: tasks.ciRetryPrNumber, reviewerRetryPrNumber: tasks.reviewerRetryPrNumber,
      gitConfig: workspaces.gitConfig, ready: sql<boolean>`${ready}`,
    })
    .from(tasks)
    .innerJoin(workspaces, eq(workspaces.id, tasks.workspaceId))
    .where(and(sql`${tasks.status} NOT IN (${TERMINAL})`, sql`${tasks.pathManifest} IS NOT NULL`));
  const inLane = open
    .map(t => ({ ...t, workspace: { gitConfig: t.gitConfig as WorkspaceGitConfig | null } }))
    .filter(t => lanesOf(t as LaneTask).length > 0);
  const e = serialLaneEntries;
  const unstamped = inLane.filter(t => !truthy(t.ready));
  if (unstamped.length > 0) {
    // Not claimable yet: a row with no stamp, so it shows in the lane after everyone who was.
    await db.insert(e)
      .values(unstamped.flatMap(t => lanesOf(t as LaneTask).map(lane => ({ workspaceId: t.workspaceId, lane, taskId: t.id, claimableSince: null }))))
      .onConflictDoNothing();
  }
  const workspaceIds = [...new Set([...inLane.map(t => t.workspaceId), ...(await workspacesWithLanes())])];
  await syncLanes({ workspaceIds, claimable: inLane.filter(t => truthy(t.ready)) as LaneTask[], now });
  // In-flight lane work with no recorded holder (claimed before lanes existed):
  // the first such task per lane is recorded as its holder; the rest are
  // still held by the claim's open-PR and lease checks until they land.
  if (workspaceIds.length > 0) {
    const wsList = sql.join(workspaceIds.map(id => sql`${id}::uuid`), sql`, `);
    const unrecorded = await rows<{ workspace_id: string; lane: string; task_id: string }>(sql`
      SELECT e.workspace_id, e.lane, e.task_id FROM ${e} e JOIN ${tasks} ON ${tasks.id} = e.task_id
      WHERE e.workspace_id IN (${wsList}) AND e.left_at IS NULL AND e.held_at IS NULL
        AND ${holdingStateSql(sql`${tasks.id}`, sql`${tasks.status}`)}
        AND NOT EXISTS (SELECT 1 FROM ${e} h WHERE h.workspace_id = e.workspace_id AND h.lane = e.lane AND h.held_at IS NOT NULL AND h.left_at IS NULL)
      ORDER BY e.workspace_id, e.lane, ${tasks.createdAt}
    `);
    for (const r of unrecorded) {
      await takeLanes({ workspaceId: String(r.workspace_id), taskId: String(r.task_id), lanes: [String(r.lane)], now }).catch(() => null);
    }
  }
  return { workspaces: workspaceIds.length, joined: inLane.length };
}

export type EditLaneOutcome =
  | { kind: 'ok'; took: string[]; heldAt: Date }
  | { kind: 'held'; lane: string; holderTaskId: string; position: number; prNumber: number | null; prUrl: string | null };

/**
 * A running task edits lane paths (I-5, check_path_claim). Per lane: its own
 * lane goes on; a free lane is taken (joined by edit); a lane another task
 * holds is joined as a waiter and the holder and this task's position are
 * returned. A pending task ahead does not stop a running one: only a holder
 * does. Own-PR repairs are in no lane (I-6).
 */
export async function laneAtEdit(input: { task: LaneTask; paths: string[]; now: Date }): Promise<EditLaneOutcome> {
  const { task, now } = input;
  if (isOwnPrRepair(task)) return { kind: 'ok', took: [], heldAt: now };
  const ws = await db.query.workspaces.findFirst({ where: sqlWhere(eq(workspaces.id, task.workspaceId)), columns: { gitConfig: true } });
  const lanes = laneKeysFor(input.paths, (ws?.gitConfig as WorkspaceGitConfig | null) ?? null);
  if (lanes.length === 0) return { kind: 'ok', took: [], heldAt: now };
  await syncLanes({ workspaceIds: [task.workspaceId], now });
  const read = await loadLanes([task.workspaceId], now);
  const took: string[] = [];
  for (const lane of lanes) {
    const view = read.lanes.get(task.workspaceId)?.get(lane) ?? { workspaceId: task.workspaceId, lane, members: [] };
    const self = view.members.find(m => m.taskId === task.id);
    if (self?.holding) continue;
    let holder = view.members.find(m => m.holding && m.taskId !== task.id) ?? null;
    if (!holder) {
      const res = await takeLanes({ workspaceId: task.workspaceId, taskId: task.id, lanes: [lane], now, via: 'edit' });
      if (res.ok) { took.push(lane); continue; }
      const again = await loadLanes([task.workspaceId], now);
      holder = again.lanes.get(task.workspaceId)?.get(lane)?.members.find(m => m.holding && m.taskId !== task.id) ?? null;
      if (!holder) throw new Error(`lane ${lane} refused a take with no holder`);
    }
    await joinLane({ workspaceId: task.workspaceId, taskId: task.id, lane, now, via: 'edit' });
    const after = await loadLanes([task.workspaceId], now);
    const joined = after.lanes.get(task.workspaceId)?.get(lane) ?? view;
    if (took.length) await giveBackLanes({ workspaceId: task.workspaceId, taskId: task.id, lanes: took, heldAt: now });
    return { kind: 'held', lane, holderTaskId: holder.taskId, position: lanePosition(joined, task.id), prNumber: holder.prNumber, prUrl: holder.prUrl };
  }
  return { kind: 'ok', took, heldAt: now };
}
