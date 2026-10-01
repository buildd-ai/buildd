/**
 * Path-claim coordination helpers — DB layer only.
 *
 * This module owns the stateful DB operations for path_claims and
 * path_claim_waiters. Pusher fan-out is the caller's responsibility
 * (apps/web routes) because Pusher lives in apps/web, not packages/core.
 *
 * Call sites:
 *   - POST / DELETE /api/tasks/[id]/path-claim (REST: acquire / narrow)
 *   - check_path_claim MCP tool (acquire, or narrow with release=true)
 *   - PATCH /api/workers/[id] (observed touches → lease; terminal status → release)
 *   - GitHub webhook (PR merged/closed → release)
 *   - stale-workers reaper (orphaned worker → release)
 *   - Workers claim route (path_claims backstop)
 */

import { LIVE_WORKER_STATUSES, OPEN_TASK_STATUSES, isLiveWorkerStatus, isTerminalTaskStatus } from '@buildd/shared';
import { db } from './db/client';
import { pathClaims, pathClaimWaiters, missionNotes, workers, tasks } from './db/schema';
import { and, eq, isNull, lt, inArray, sql } from 'drizzle-orm';
import {
  pathsOverlap,
  stripTrailingSep,
  findRegenerable,
  REPO_WIDE_SENTINEL,
} from './path-overlap';
import { expiredParkedTaskIds } from './path-claim-ttl';

// ── Types ────────────────────────────────────────────────────────────────────

export interface ClaimConflict {
  blockingTaskId: string;
  blockingPath: string;
}

export interface DeadlockResult {
  deadlock: true;
  cycle: string[];
}

export interface ReleaseResult {
  workspaceId: string;
  releasedPaths: string[];
  /** Waiting task IDs that were notified (notifiedAt stamped). */
  notifiedWaiters: string[];
  /**
   * Same waiters with the path each one was blocked on, so the `path_released`
   * message can name it. A waiter blocked on two paths appears twice.
   */
  waiters: Array<{ waitingTaskId: string; blockedPath: string }>;
}

// ── Path utilities ───────────────────────────────────────────────────────────

/**
 * Count the number of segments in a file path (split by '/', empty strings filtered).
 * Examples: 'packages/core/path-claim.ts' → 3, 'foo' → 1, '' → 0.
 */
export function countPathSegments(path: string): number {
  return path.split('/').filter(s => s.length > 0).length;
}

/** Strips any trailing slash from a path. Returns path unchanged if no trailing slash. */
export function normalizeTrailingSlash(path: string): string {
  return path.replace(/\/+$/, '');
}

/** Returns true if the path is non-empty after trimming whitespace. */
export function isNonEmptyPath(path: string): boolean {
  return path.trim().length > 0;
}

// ── Parked-holder TTL ────────────────────────────────────────────────────────

/**
 * Drop, in place, the holders in `byTask` whose every live worker has been
 * parked on a question past PARKED_HOLDER_TTL_MS (see path-claim-ttl.ts).
 * A task with no live worker keeps its claims — that is a finished worker
 * whose PR has not merged yet, and its edits are real. A failed lookup keeps
 * every claim: the safe error is to go on blocking.
 */
async function dropExpiredParkedHolders(byTask: Map<string, string[]>): Promise<void> {
  if (byTask.size === 0) return;
  try {
    const live = await db.query.workers.findMany({
      where: and(
        inArray(workers.taskId, [...byTask.keys()]),
        inArray(workers.status, LIVE_WORKER_STATUSES),
      ),
      columns: { taskId: true, status: true, updatedAt: true },
    });
    for (const taskId of expiredParkedTaskIds(live ?? [])) byTask.delete(taskId);
  } catch (err) {
    console.warn('[path-claim] parked-holder lookup failed; keeping all claims:', err);
  }
}

// ── Terminal-holder backstop ─────────────────────────────────────────────────

/**
 * Classify each of `taskIds` as a stale claim holder: the task itself is
 * terminal, or it has at least one known worker and every one of them is
 * terminal (no live worker left to finish the job). Either shape means the
 * terminal-transition write that was supposed to call `releaseAndNotify` did
 * not run — a leaked row, not a real lock.
 *
 * A taskId with NO worker rows at all is left alone rather than treated as
 * "all terminal" — that shape means the lookup missed it, not that it is
 * safe to drop; the safe default on missing data is to keep blocking.
 */
async function findTerminalHolders(taskIds: string[]): Promise<Set<string>> {
  const [holderTasks, holderWorkers] = await Promise.all([
    db.query.tasks.findMany({
      where: inArray(tasks.id, taskIds),
      columns: { id: true, status: true },
    }),
    db.query.workers.findMany({
      where: inArray(workers.taskId, taskIds),
      columns: { taskId: true, status: true },
    }),
  ]);
  const statusByTask = new Map(holderTasks.map(t => [t.id, t.status]));
  const workerStatusesByTask = new Map<string, string[]>();
  for (const w of holderWorkers) {
    if (!w.taskId) continue;
    const existing = workerStatusesByTask.get(w.taskId) ?? [];
    existing.push(w.status);
    workerStatusesByTask.set(w.taskId, existing);
  }

  const terminal = new Set<string>();
  for (const taskId of taskIds) {
    const status = statusByTask.get(taskId);
    const terminalTask = isTerminalTaskStatus(status);
    const workerStatuses = workerStatusesByTask.get(taskId);
    const allWorkersTerminal = Boolean(workerStatuses?.length)
      && workerStatuses!.every(s => !isLiveWorkerStatus(s));
    if (terminalTask || allWorkersTerminal) terminal.add(taskId);
  }
  return terminal;
}

/**
 * Drop, in place, the holders in `byTask` identified by `findTerminalHolders`
 * as stale.
 *
 * This is defense in depth, not the fix: it only hides a stale row from THIS
 * read, it does not clear `released_at`. The reaper (path-claims maintenance
 * sweep) clears the underlying rows so a leak does not have to be rediscovered
 * by every caller forever. Logged so a leak stays visible instead of quietly
 * self-healing at the read layer while the root cause goes unnoticed.
 */
async function dropTerminalHolders(byTask: Map<string, string[]>): Promise<void> {
  if (byTask.size === 0) return;
  try {
    const taskIds = [...byTask.keys()];
    const terminal = await findTerminalHolders(taskIds);
    for (const taskId of terminal) {
      console.warn(
        `[path-claim] dropping stale claim(s) held by task ${taskId} — ` +
        `should have been released on its terminal transition`,
      );
      byTask.delete(taskId);
    }
  } catch (err) {
    console.warn('[path-claim] terminal-holder lookup failed; keeping all claims:', err);
  }
}

/**
 * Find every taskId whose ownership state should already have been cleared by
 * its terminal transition (see `dropTerminalHolders`), across every workspace:
 * a stale holder of an active path_claims row, or a stale blocker that still
 * has an un-notified waiter — a waiter re-armed after a failed delivery once
 * the claims were already gone. Used by the maintenance sweep to actually
 * clear the rows and wake the waiters; `dropTerminalHolders` only hides them
 * from a single read.
 */
export async function findStaleClaimHolderTaskIds(): Promise<string[]> {
  const [activeClaims, pendingWaiters] = await Promise.all([
    db.query.pathClaims.findMany({
      where: isNull(pathClaims.releasedAt),
      columns: { taskId: true },
    }),
    db.query.pathClaimWaiters.findMany({
      where: isNull(pathClaimWaiters.notifiedAt),
      columns: { blockingTaskId: true },
    }),
  ]);
  const taskIds = [...new Set([
    ...activeClaims.map(c => c.taskId),
    ...(pendingWaiters ?? []).map(w => w.blockingTaskId),
  ])];
  if (taskIds.length === 0) return [];

  const terminal = await findTerminalHolders(taskIds);
  return [...terminal];
}

// ── Conflict detection ───────────────────────────────────────────────────────

/**
 * Check whether any of the given paths are already held by an active claim
 * in this workspace (excluding claims owned by the requesting task itself).
 *
 * Returns the first conflict found, or null if all paths are free.
 * Uses pathsOverlap() for prefix matching.
 *
 * NOTE: '**' wildcard paths must be rejected by the caller before this
 * function is invoked — they are not meaningful as held locks.
 */
export async function checkPathClaimConflict(
  workspaceId: string,
  requestingTaskId: string,
  paths: string[],
): Promise<ClaimConflict | null> {
  const activeClaims = await db.query.pathClaims.findMany({
    where: and(
      eq(pathClaims.workspaceId, workspaceId),
      isNull(pathClaims.releasedAt),
    ),
    columns: { taskId: true, path: true },
  });

  // Group paths by taskId for efficient pathsOverlap() calls
  const claimsByTask = new Map<string, string[]>();
  for (const row of activeClaims) {
    if (row.taskId === requestingTaskId) continue; // own claims never block self
    const existing = claimsByTask.get(row.taskId) ?? [];
    existing.push(row.path);
    claimsByTask.set(row.taskId, existing);
  }
  await dropExpiredParkedHolders(claimsByTask);
  await dropTerminalHolders(claimsByTask);

  for (const [taskId, claimedPaths] of claimsByTask) {
    if (pathsOverlap(paths, claimedPaths)) {
      // Find the first specific overlapping path for the error message
      const normPaths = paths.map(stripTrailingSep);
      const firstOverlap = claimedPaths.find(cp => {
        const ncp = stripTrailingSep(cp);
        return normPaths.some(p => p === ncp || p.startsWith(ncp + '/') || ncp.startsWith(p + '/'));
      }) ?? claimedPaths[0];
      return { blockingTaskId: taskId, blockingPath: firstOverlap };
    }
  }

  return null;
}

/**
 * Returns all active path_claims for a workspace, grouped by taskId.
 * Used by the claim route backstop to defer tasks whose pathManifest
 * overlaps an active held lock. Holders parked on a question past the TTL
 * are omitted (see path-claim-ttl.ts).
 */
export async function getActiveClaimsByWorkspace(
  workspaceId: string,
): Promise<Map<string, string[]>> {
  const activeClaims = await db.query.pathClaims.findMany({
    where: and(
      eq(pathClaims.workspaceId, workspaceId),
      isNull(pathClaims.releasedAt),
    ),
    columns: { taskId: true, path: true },
  });

  const byTask = new Map<string, string[]>();
  for (const row of activeClaims) {
    const existing = byTask.get(row.taskId) ?? [];
    existing.push(row.path);
    byTask.set(row.taskId, existing);
  }
  await dropExpiredParkedHolders(byTask);
  await dropTerminalHolders(byTask);
  return byTask;
}

// ── Serialized ownership writes ──────────────────────────────────────────────
//
// Acquisition, narrowing and terminal release all go through `db.batch`, which
// on neon-http is ONE non-interactive transaction. Its first statement takes a
// transaction-scoped advisory lock keyed by workspace; the second does the
// write. Under READ COMMITTED each statement takes its own snapshot, so the
// write runs after the lock and sees every row the previous holder committed.
//
// Why the lock and not a unique index: overlap is by prefix. `apps/web` and
// `apps/web/page.tsx` are different rows, so no index can refuse the second;
// two single-statement check-then-inserts would each miss the other's row.
//
// Why release takes it too: a cancel commits the task status and then releases.
// An acquisition that read the task open could otherwise insert after the
// release's snapshot and resurrect a lease on a cancelled task. With both under
// one lock, and the acquisition re-checking the task's status inside its locked
// statement, whichever runs second sees the other's effect.
//
// Every statement is tagged (`-- path_claims:<op>`) and takes one JSON
// argument, bound once as the `args` CTE. __tests__/path-claim-ownership.test.ts
// runs the protocol against a model keyed on those tags and asserts the SQL
// text separately.

/**
 * The lock every ownership write takes first. Keyed by the workspace's
 * canonical uuid text — resolved from the task when only a task is known — so
 * a caller-supplied id and a row-derived one always take the same lock.
 */
function workspaceLock(key: { workspaceId: string } | { taskId: string }) {
  return db.execute(sql`-- path_claims:lock
WITH args AS (SELECT ${JSON.stringify(key)}::jsonb AS a)
SELECT pg_advisory_xact_lock(hashtext('path_claims'), hashtext(COALESCE(
  (a->>'workspaceId')::uuid::text,
  (SELECT t.workspace_id::text FROM tasks t WHERE t.id = (a->>'taskId')::uuid)
)))
FROM args`);
}

type RawRow = Record<string, unknown>;

async function runLocked(
  key: { workspaceId: string } | { taskId: string },
  statement: ReturnType<typeof db.execute>,
): Promise<RawRow | undefined> {
  const [, result] = await db.batch([workspaceLock(key), statement]);
  return ((result as { rows?: RawRow[] })?.rows ?? [])[0];
}

const jsonArray = <T>(v: unknown): T[] => {
  if (Array.isArray(v)) return v as T[];
  if (typeof v === 'string') {
    try { const parsed = JSON.parse(v); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
  }
  return [];
};

/** Trim, strip trailing separators, drop blanks and duplicates. Order-preserving. */
export function normalizeClaimPaths(paths: string[]): string[] {
  const out: string[] = [];
  for (const raw of paths) {
    if (typeof raw !== 'string') continue;
    const p = normalizeTrailingSlash(raw.trim());
    if (isNonEmptyPath(p) && !out.includes(p)) out.push(p);
  }
  return out;
}

// ── Acquisition ──────────────────────────────────────────────────────────────

export interface AcquireInput {
  workspaceId: string;
  taskId: string;
  paths: string[];
  /**
   * true: a declaration — append granted paths to `tasks.pathManifest`, and
   * grant nothing unless every path is free (check_path_claim).
   * false: observed touches — lease each free path, leave the manifest alone.
   */
  declare: boolean;
}

export type AcquireResult =
  | { kind: 'acquired'; inserted: string[]; blocked: BlockedPath[]; pathManifest: string[] | null; revision: number | null }
  | { kind: 'conflict'; conflict: ClaimConflict; blocked: BlockedPath[] }
  | { kind: 'task_closed' };

export interface BlockedPath {
  path: string;
  blockingTaskId: string;
  blockingPath: string;
}

/**
 * Active holders of overlapping paths, split into the ones that really block
 * and the ones `dropExpiredParkedHolders` / `dropTerminalHolders` discount.
 * The discounted set is handed to the locked statement so it can re-check the
 * table without re-deriving liveness in SQL — any holder NOT in it that has
 * appeared since this read still blocks.
 */
async function readHolders(workspaceId: string, taskId: string) {
  const rows = await db.query.pathClaims.findMany({
    where: and(eq(pathClaims.workspaceId, workspaceId), isNull(pathClaims.releasedAt)),
    columns: { taskId: true, path: true },
  });
  const byTask = new Map<string, string[]>();
  for (const row of rows) {
    if (row.taskId === taskId) continue;
    const existing = byTask.get(row.taskId) ?? [];
    existing.push(row.path);
    byTask.set(row.taskId, existing);
  }
  const all = [...byTask.keys()];
  await dropExpiredParkedHolders(byTask);
  await dropTerminalHolders(byTask);
  return { live: byTask, discounted: all.filter(id => !byTask.has(id)) };
}

function firstBlocked(paths: string[], live: Map<string, string[]>): BlockedPath[] {
  const out: BlockedPath[] = [];
  for (const path of paths) {
    for (const [holder, held] of live) {
      const hit = held.find(h => pathsOverlap([path], [h]));
      if (hit) { out.push({ path, blockingTaskId: holder, blockingPath: hit }); break; }
    }
  }
  return out;
}

/**
 * Exclusively acquire edit leases on `paths` for `taskId`, within its workspace.
 *
 * Two phases. An unlocked read discounts stale holders (terminal, or parked
 * past the TTL) and answers the common conflict without taking a lock. Then
 * one locked statement re-checks prefix overlap against the live table, checks
 * the owning task is still open, inserts the missing leases — including for
 * paths already in the manifest but never leased — and, for a declaration,
 * appends to the manifest and snapshots the original declaration. Only that
 * statement decides; the read never grants anything.
 *
 * '**' must be rejected by the caller — it is not a lease.
 */
export async function acquirePathClaims(input: AcquireInput): Promise<AcquireResult> {
  const { workspaceId, taskId, declare } = input;
  const paths = normalizeClaimPaths(input.paths);
  if (paths.length === 0) {
    return { kind: 'acquired', inserted: [], blocked: [], pathManifest: null, revision: null };
  }

  const { live, discounted } = await readHolders(workspaceId, taskId);
  const early = firstBlocked(paths, live);
  if (declare && early.length > 0) {
    return { kind: 'conflict', conflict: toConflict(early[0]), blocked: early };
  }

  const row = await runLocked({ workspaceId }, db.execute(sql`-- path_claims:acquire
WITH args AS (SELECT ${JSON.stringify({
    workspaceId,
    taskId,
    paths,
    ignoreHolders: discounted,
    allOrNothing: declare,
    declare,
    openStatuses: OPEN_TASK_STATUSES,
  })}::jsonb AS a),
req AS (
  SELECT DISTINCT p AS path FROM args, jsonb_array_elements_text(a->'paths') AS p
),
owner AS (
  SELECT t.id FROM tasks t, args
  WHERE t.id = (a->>'taskId')::uuid
    AND t.workspace_id = (a->>'workspaceId')::uuid
    AND t.status IN (SELECT jsonb_array_elements_text(a->'openStatuses'))
),
blocked AS (
  SELECT DISTINCT ON (req.path) req.path, pc.task_id AS blocking_task_id, pc.path AS blocking_path
  FROM req, args, path_claims pc
  WHERE pc.workspace_id = (a->>'workspaceId')::uuid
    AND pc.released_at IS NULL
    AND pc.task_id <> (a->>'taskId')::uuid
    AND NOT ((a->'ignoreHolders') @> to_jsonb(pc.task_id::text))
    AND (rtrim(pc.path, '/') = req.path
      OR starts_with(req.path, rtrim(pc.path, '/') || '/')
      OR starts_with(rtrim(pc.path, '/'), req.path || '/'))
  ORDER BY req.path, pc.claimed_at, pc.id
),
grantable AS (
  SELECT req.path FROM req, args
  WHERE EXISTS (SELECT 1 FROM owner)
    AND NOT EXISTS (SELECT 1 FROM blocked b WHERE b.path = req.path)
    AND (NOT (a->>'allOrNothing')::boolean OR NOT EXISTS (SELECT 1 FROM blocked))
),
ins AS (
  INSERT INTO path_claims (workspace_id, task_id, path)
  SELECT (a->>'workspaceId')::uuid, (a->>'taskId')::uuid, g.path FROM grantable g, args
  WHERE NOT EXISTS (
    SELECT 1 FROM path_claims own
    WHERE own.task_id = (a->>'taskId')::uuid
      AND own.released_at IS NULL
      AND rtrim(own.path, '/') = g.path
  )
  RETURNING path
),
declared AS (
  SELECT g.path FROM grantable g, args, tasks t
  WHERE (a->>'declare')::boolean
    AND t.id = (a->>'taskId')::uuid
    AND NOT (COALESCE(t.path_manifest, '[]'::jsonb) @> to_jsonb(g.path))
),
upd AS (
  UPDATE tasks t SET
    path_manifest = CASE WHEN EXISTS (SELECT 1 FROM declared)
      THEN COALESCE(t.path_manifest, '[]'::jsonb) || (SELECT jsonb_agg(d.path ORDER BY d.path) FROM declared d)
      ELSE t.path_manifest END,
    path_declaration = COALESCE(t.path_declaration, jsonb_build_object(
      'declared', t.path_manifest, 'source', 'runtime', 'snapshotAt', now())),
    path_claim_revision = t.path_claim_revision + 1
  FROM args
  WHERE t.id = (a->>'taskId')::uuid
    AND (EXISTS (SELECT 1 FROM ins) OR EXISTS (SELECT 1 FROM declared))
  RETURNING t.path_manifest, t.path_claim_revision
)
SELECT
  EXISTS (SELECT 1 FROM owner) AS owner_open,
  COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'path', b.path, 'blockingTaskId', b.blocking_task_id, 'blockingPath', b.blocking_path)) FROM blocked b), '[]'::jsonb) AS blocked,
  COALESCE((SELECT jsonb_agg(i.path) FROM ins i), '[]'::jsonb) AS inserted,
  COALESCE((SELECT u.path_manifest FROM upd u),
    (SELECT t.path_manifest FROM tasks t, args WHERE t.id = (a->>'taskId')::uuid)) AS path_manifest,
  COALESCE((SELECT u.path_claim_revision FROM upd u),
    (SELECT t.path_claim_revision FROM tasks t, args WHERE t.id = (a->>'taskId')::uuid)) AS revision`));

  if (!row || !row.owner_open) return { kind: 'task_closed' };
  const blocked = jsonArray<BlockedPath>(row.blocked);
  if (declare && blocked.length > 0) {
    return { kind: 'conflict', conflict: toConflict(blocked[0]), blocked };
  }
  return {
    kind: 'acquired',
    inserted: jsonArray<string>(row.inserted),
    blocked,
    pathManifest: (row.path_manifest as string[] | null) ?? null,
    revision: row.revision == null ? null : Number(row.revision),
  };
}

function toConflict(b: BlockedPath): ClaimConflict {
  return { blockingTaskId: b.blockingTaskId, blockingPath: b.blockingPath };
}

/**
 * Promote observed git-diff touches into held leases for a task.
 *
 * This is the join between the two halves of one mechanism that shipped as two.
 * `path_claims` owns the **gate**: the layer-2 backstop in POST
 * /api/workers/claim defers a pending task whose `pathManifest` overlaps a live
 * lease, so the second agent never starts. §6d `observedTouches` owns the
 * **signal**: the runner reports every touched path on every sync, no
 * declaration required. Feeding the signal into the gate is what makes the gate
 * load-bearing — including for a `'**'` task, whose *touches* are concrete
 * regardless of what its manifest said.
 *
 * It goes through `acquirePathClaims` like a declaration does: a path another
 * live task already holds is NOT leased (the touch has happened, so §6d's
 * message is the signal there, not a second lease on the same surface), and a
 * task that is no longer open leases nothing. Unlike a declaration, each free
 * path is leased on its own and the manifest is left alone.
 *
 * Two things it deliberately does not lease:
 *  - **Regenerable paths.** A lease on `docs/specs/INDEX.md` or the drizzle
 *    journal would defer every task that regenerates them. A generated file is
 *    not a mutex. Migration SQL files are not in that registry and are leased.
 *  - **The repo-wide sentinel.** `'**'` means "scope undeclared", never "I hold
 *    every file".
 *
 * Returns the paths newly leased (empty when everything was filtered, blocked
 * or already held).
 */
export async function claimObservedPaths(
  workspaceId: string,
  taskId: string,
  observedPaths: string[],
): Promise<string[]> {
  return (await acquireObservedPaths(workspaceId, taskId, observedPaths)).inserted;
}

/**
 * `claimObservedPaths`, also returning what it could not lease: every observed
 * path a live holder already has, with that holder. For an observed touch the
 * write has already happened, so a blocked path is a checkpoint collision
 * (conflict-aware-orchestration.md §2) — the worker PATCH reports it back so
 * an enforcing runner can stop and defer. Terminal and expired-parked holders
 * are discounted exactly as for a declaration; a closed observer gets nothing.
 */
export async function acquireObservedPaths(
  workspaceId: string,
  taskId: string,
  observedPaths: string[],
): Promise<{ inserted: string[]; blocked: BlockedPath[] }> {
  if (observedPaths.length === 0) return { inserted: [], blocked: [] };

  const lockable = normalizeClaimPaths(
    observedPaths.filter(raw => typeof raw === 'string' && raw.trim() !== REPO_WIDE_SENTINEL),
  ).filter(path => !findRegenerable(path));
  if (lockable.length === 0) return { inserted: [], blocked: [] };

  const result = await acquirePathClaims({ workspaceId, taskId, paths: lockable, declare: false });
  return result.kind === 'acquired'
    ? { inserted: result.inserted, blocked: result.blocked }
    : { inserted: [], blocked: [] };
}

// ── Narrowing ────────────────────────────────────────────────────────────────

export interface NarrowInput {
  workspaceId: string;
  taskId: string;
  /** Paths to give back. A directory also gives back every lease under it. */
  paths: string[];
  /** Recorded on the narrowing, e.g. 'mcp:check_path_claim'. */
  surface: string;
  reason?: string | null;
  /** CAS token: refuse unless the task's pathClaimRevision still equals this. */
  expectedRevision?: number | null;
}

export type NarrowResult =
  | { kind: 'not_found' }
  | { kind: 'revision_conflict'; currentRevision: number }
  | ({ kind: 'narrowed'; pathManifest: string[] | null; revision: number } & ReleaseResult);

/** Most recent narrowings kept on `tasks.path_declaration`. */
export const MAX_RECORDED_NARROWINGS = 20;

/**
 * Selectively release this task's leases on `paths` (and under them), remove
 * them from its effective `pathManifest`, record the narrowing next to the
 * original declaration, and stamp only the waiters blocked on a released path.
 *
 * Workspace-scoped: a task outside `workspaceId` is `not_found`. Allowed on a
 * task in any status — it only ever gives ownership back. Waiter delivery is
 * the caller's (see apps/web/src/lib/path-claim-release.ts).
 *
 * dependsOn is not touched. Edges inferred at creation are recorded in
 * `path_declaration.inferredDependsOn`; removing them is a separate decision.
 */
export async function narrowPathClaims(input: NarrowInput): Promise<NarrowResult> {
  const { workspaceId, taskId } = input;
  const paths = normalizeClaimPaths(input.paths);
  const row = await runLocked({ workspaceId }, db.execute(sql`-- path_claims:narrow
WITH args AS (SELECT ${JSON.stringify({
    workspaceId,
    taskId,
    paths,
    surface: input.surface,
    reason: input.reason ?? null,
    expectedRevision: input.expectedRevision ?? null,
    maxNarrowings: MAX_RECORDED_NARROWINGS,
  })}::jsonb AS a),
drop_req AS (
  SELECT DISTINCT p AS path FROM args, jsonb_array_elements_text(a->'paths') AS p
),
owner AS (
  SELECT t.id, t.path_claim_revision, t.path_manifest FROM tasks t, args
  WHERE t.id = (a->>'taskId')::uuid
    AND t.workspace_id = (a->>'workspaceId')::uuid
),
ok AS (
  SELECT o.id FROM owner o, args
  WHERE jsonb_typeof(a->'expectedRevision') IS DISTINCT FROM 'number'
    OR o.path_claim_revision = (a->>'expectedRevision')::int
),
rel AS (
  UPDATE path_claims pc SET released_at = now()
  FROM args
  WHERE pc.task_id = (a->>'taskId')::uuid
    AND pc.released_at IS NULL
    AND EXISTS (SELECT 1 FROM ok)
    AND EXISTS (SELECT 1 FROM drop_req d
      WHERE rtrim(pc.path, '/') = d.path OR starts_with(rtrim(pc.path, '/'), d.path || '/'))
  RETURNING pc.path
),
entries AS (
  SELECT x.m, x.ord,
    EXISTS (SELECT 1 FROM drop_req d
      WHERE rtrim(x.m, '/') = d.path OR starts_with(rtrim(x.m, '/'), d.path || '/')) AS dropped
  FROM owner o, jsonb_array_elements_text(o.path_manifest) WITH ORDINALITY AS x(m, ord)
),
upd AS (
  UPDATE tasks t SET
    path_manifest = CASE WHEN t.path_manifest IS NULL THEN NULL ELSE COALESCE(
      (SELECT jsonb_agg(e.m ORDER BY e.ord) FROM entries e WHERE NOT e.dropped), '[]'::jsonb) END,
    path_declaration = COALESCE(t.path_declaration, jsonb_build_object(
      'declared', t.path_manifest, 'source', 'runtime', 'snapshotAt', now()))
      || jsonb_build_object('narrowings', (
        SELECT COALESCE(jsonb_agg(n.e ORDER BY n.o), '[]'::jsonb)
        FROM jsonb_array_elements(
          COALESCE(t.path_declaration->'narrowings', '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
            'at', now(), 'dropped', a->'paths', 'surface', a->>'surface', 'reason', a->'reason'))
        ) WITH ORDINALITY AS n(e, o)
        WHERE n.o > jsonb_array_length(COALESCE(t.path_declaration->'narrowings', '[]'::jsonb)) + 1
          - (a->>'maxNarrowings')::int
      )),
    path_claim_revision = t.path_claim_revision + 1
  FROM args
  WHERE t.id = (a->>'taskId')::uuid
    AND EXISTS (SELECT 1 FROM ok)
    AND (EXISTS (SELECT 1 FROM rel) OR EXISTS (SELECT 1 FROM entries WHERE dropped))
  RETURNING t.path_manifest, t.path_claim_revision
),
woken AS (
  UPDATE path_claim_waiters w SET notified_at = now()
  FROM args
  WHERE w.blocking_task_id = (a->>'taskId')::uuid
    AND w.notified_at IS NULL
    AND EXISTS (SELECT 1 FROM rel r WHERE rtrim(r.path, '/') = rtrim(w.blocked_path, '/'))
  RETURNING w.waiting_task_id, w.blocked_path
)
SELECT
  EXISTS (SELECT 1 FROM owner) AS found,
  EXISTS (SELECT 1 FROM ok) AS revision_ok,
  COALESCE((SELECT u.path_claim_revision FROM upd u), (SELECT o.path_claim_revision FROM owner o)) AS revision,
  COALESCE((SELECT u.path_manifest FROM upd u), (SELECT o.path_manifest FROM owner o)) AS path_manifest,
  COALESCE((SELECT jsonb_agg(r.path) FROM rel r), '[]'::jsonb) AS released_paths,
  COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'waitingTaskId', k.waiting_task_id, 'blockedPath', k.blocked_path)) FROM woken k), '[]'::jsonb) AS waiters`));

  if (!row || !row.found) return { kind: 'not_found' };
  const revision = Number(row.revision ?? 0);
  if (!row.revision_ok) return { kind: 'revision_conflict', currentRevision: revision };
  const waiters = jsonArray<{ waitingTaskId: string; blockedPath: string }>(row.waiters);
  return {
    kind: 'narrowed',
    workspaceId,
    pathManifest: (row.path_manifest as string[] | null) ?? null,
    revision,
    releasedPaths: jsonArray<string>(row.released_paths),
    notifiedWaiters: waiters.map(w => w.waitingTaskId),
    waiters,
  };
}

// ── Release ──────────────────────────────────────────────────────────────────

/**
 * Soft-delete all active path_claims for a task and stamp notifiedAt on all
 * of its pending waiters, under the same workspace lock as acquisition (see
 * "Serialized ownership writes"). Returns release info for the caller to fan
 * out.
 *
 * Waiters are woken even when no lease is left to release: this only runs on a
 * terminal (or reassigning) transition, when the task holds nothing, and a
 * waiter re-armed after a failed delivery has no other way to be found again —
 * so a repeated terminal event is what retries it.
 *
 * Returns null when nothing was released and nobody was waiting.
 */
export async function releaseClaims(taskId: string): Promise<ReleaseResult | null> {
  const row = await runLocked({ taskId }, db.execute(sql`-- path_claims:release
WITH args AS (SELECT ${JSON.stringify({ taskId })}::jsonb AS a),
rel AS (
  UPDATE path_claims pc SET released_at = now()
  FROM args
  WHERE pc.task_id = (a->>'taskId')::uuid AND pc.released_at IS NULL
  RETURNING pc.workspace_id, pc.path
),
bump AS (
  UPDATE tasks t SET path_claim_revision = t.path_claim_revision + 1
  FROM args
  WHERE t.id = (a->>'taskId')::uuid AND EXISTS (SELECT 1 FROM rel)
  RETURNING t.path_claim_revision
),
woken AS (
  UPDATE path_claim_waiters w SET notified_at = now()
  FROM args
  WHERE w.blocking_task_id = (a->>'taskId')::uuid AND w.notified_at IS NULL
  RETURNING w.workspace_id, w.waiting_task_id, w.blocked_path
)
SELECT
  COALESCE((SELECT r.workspace_id FROM rel r LIMIT 1), (SELECT k.workspace_id FROM woken k LIMIT 1)) AS workspace_id,
  COALESCE((SELECT jsonb_agg(r.path) FROM rel r), '[]'::jsonb) AS released_paths,
  COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'waitingTaskId', k.waiting_task_id, 'blockedPath', k.blocked_path)) FROM woken k), '[]'::jsonb) AS waiters`));

  const releasedPaths = jsonArray<string>(row?.released_paths);
  const waiters = jsonArray<{ waitingTaskId: string; blockedPath: string }>(row?.waiters);
  if (!row?.workspace_id || (releasedPaths.length === 0 && waiters.length === 0)) return null;

  return {
    workspaceId: String(row.workspace_id),
    releasedPaths,
    notifiedWaiters: waiters.map(w => w.waitingTaskId),
    waiters,
  };
}

/**
 * Undo the `notifiedAt` stamp for one waiter so a later release — or the
 * 60-minute starvation check, which also filters on `notifiedAt IS NULL` — can
 * find it again.
 *
 * `releaseClaims` stamps every pending waiter before delivery is attempted,
 * which is what keeps two concurrent releases from double-notifying. The cost
 * is that a delivery failure is permanent: the row is no longer pending, the
 * claims are already released so a repeat call short-circuits, and waiter rows
 * are never deleted. Re-arming on failure trades a possible duplicate message
 * for a guaranteed-visible one.
 */
export async function rearmWaiter(
  blockingTaskId: string,
  waitingTaskId: string,
): Promise<void> {
  await db
    .update(pathClaimWaiters)
    .set({ notifiedAt: null })
    .where(and(
      eq(pathClaimWaiters.blockingTaskId, blockingTaskId),
      eq(pathClaimWaiters.waitingTaskId, waitingTaskId),
    ));
}

// ── Waiter registration ──────────────────────────────────────────────────────

/**
 * Register waitingTaskId as a waiter on blockingTaskId for the given path.
 *
 * Performs a BFS deadlock check before inserting. If the new edge would
 * close a cycle in the waiter graph, returns a DeadlockResult.
 *
 * The UNIQUE constraint on (blockingTaskId, waitingTaskId, blockedPath)
 * makes duplicate registrations idempotent; a duplicate re-arms the row.
 */
export async function registerWaiter(
  blockingTaskId: string,
  waitingTaskId: string,
  blockedPath: string,
  workspaceId: string,
): Promise<DeadlockResult | { registered: boolean }> {
  const cycle = await detectDeadlockCycle(blockingTaskId, waitingTaskId);
  if (cycle) {
    return { deadlock: true, cycle };
  }

  // Re-registering re-arms: a waiter woken by a narrowing that then collides
  // with the same holder again must be pending again, or the holder's next
  // release would skip it (release only wakes rows with notified_at IS NULL).
  try {
    await db.insert(pathClaimWaiters).values({
      workspaceId,
      blockingTaskId,
      waitingTaskId,
      blockedPath,
    }).onConflictDoUpdate({
      target: [pathClaimWaiters.blockingTaskId, pathClaimWaiters.waitingTaskId, pathClaimWaiters.blockedPath],
      set: { notifiedAt: null },
    });
  } catch (err) {
    console.warn('[path-claim] waiter registration failed:', err);
  }

  return { registered: true };
}

/**
 * BFS: adding the edge newWaitingTaskId → newBlockingTaskId ("waits on")
 * closes a cycle iff newBlockingTaskId already, transitively, waits on
 * newWaitingTaskId. Walk the blocker's pending waits looking for the waiter.
 * Returns the cycle (waiter → blocker → … → waiter) if found, null otherwise.
 *
 * Only pending edges (notifiedAt IS NULL) count: a notified waiter is no
 * longer waiting. Walking from the waiter instead — as this once did — found
 * the very edge being re-registered and reported every retry as a deadlock.
 */
async function detectDeadlockCycle(
  newBlockingTaskId: string,
  newWaitingTaskId: string,
): Promise<string[] | null> {
  const visited = new Set<string>([newBlockingTaskId]);
  const queue: Array<{ taskId: string; path: string[] }> = [
    { taskId: newBlockingTaskId, path: [newWaitingTaskId, newBlockingTaskId] },
  ];

  while (queue.length > 0) {
    const { taskId, path } = queue.shift()!;

    // Where is taskId currently waiting? Follow waiting → blocking edges.
    const waitingOn = await db.query.pathClaimWaiters.findMany({
      where: and(
        eq(pathClaimWaiters.waitingTaskId, taskId),
        isNull(pathClaimWaiters.notifiedAt),
      ),
      columns: { blockingTaskId: true },
    });

    for (const { blockingTaskId } of waitingOn) {
      if (blockingTaskId === newWaitingTaskId) {
        return [...path, newWaitingTaskId];
      }
      if (!visited.has(blockingTaskId)) {
        visited.add(blockingTaskId);
        queue.push({ taskId: blockingTaskId, path: [...path, blockingTaskId] });
      }
    }
  }

  return null;
}

// ── Starvation guard ─────────────────────────────────────────────────────────

const STARVATION_THRESHOLD_MINUTES = 60;

/**
 * Post mission notes for any waiters in this workspace that have been
 * un-notified for more than STARVATION_THRESHOLD_MINUTES.
 *
 * Called from the existing cleanup cron — no new cron required.
 */
export async function checkStarvation(workspaceId: string): Promise<void> {
  const cutoff = new Date(Date.now() - STARVATION_THRESHOLD_MINUTES * 60 * 1000);

  const starved = await db.query.pathClaimWaiters.findMany({
    where: and(
      eq(pathClaimWaiters.workspaceId, workspaceId),
      isNull(pathClaimWaiters.notifiedAt),
      lt(pathClaimWaiters.registeredAt, cutoff),
    ),
    columns: { waitingTaskId: true, blockingTaskId: true, blockedPath: true },
    with: {
      waitingTask: { columns: { missionId: true, title: true } },
    },
    limit: 10,
  });

  for (const w of starved) {
    const missionId = (w.waitingTask as any)?.missionId;
    if (!missionId) continue;
    try {
      await db.insert(missionNotes).values({
        missionId,
        taskId: w.waitingTaskId,
        authorType: 'system',
        type: 'warning',
        title: 'Path claim starvation detected',
        body: `Task "${(w.waitingTask as any)?.title ?? w.waitingTaskId.slice(0, 8)}" has been waiting more than ${STARVATION_THRESHOLD_MINUTES} minutes for path "${w.blockedPath}" held by task ${w.blockingTaskId.slice(0, 8)}. Consider cancelling one task or using mission-level maxConcurrentTasks=1.`,
        status: 'open',
      });
    } catch { /* non-fatal */ }
  }
}
