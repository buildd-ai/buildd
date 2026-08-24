/**
 * Path-claim coordination helpers — DB layer only.
 *
 * This module owns the stateful DB operations for path_claims and
 * path_claim_waiters. Pusher fan-out is the caller's responsibility
 * (apps/web routes) because Pusher lives in apps/web, not packages/core.
 *
 * Call sites:
 *   - POST /api/tasks/[id]/path-claim (REST)
 *   - check_path_claim MCP tool
 *   - PATCH /api/workers/[id] (terminal status → release)
 *   - GitHub webhook (PR merged/closed → release)
 *   - stale-workers reaper (orphaned worker → release)
 *   - Workers claim route (path_claims backstop)
 */

import { db } from './db/client';
import { pathClaims, pathClaimWaiters, missionNotes } from './db/schema';
import { and, eq, isNull, lt, inArray } from 'drizzle-orm';
import { pathsOverlap } from './path-overlap';

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

  for (const [taskId, claimedPaths] of claimsByTask) {
    if (pathsOverlap(paths, claimedPaths)) {
      // Find the first specific overlapping path for the error message
      const normalize = (p: string) => p.replace(/\/+$/, '');
      const normPaths = paths.map(normalize);
      const firstOverlap = claimedPaths.find(cp => {
        const ncp = normalize(cp);
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
 * overlaps an active held lock.
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
  return byTask;
}

// ── Claim insertion ──────────────────────────────────────────────────────────

/**
 * Insert path_claims rows for each new path. Paths already claimed by this
 * task are skipped (idempotent). Returns the paths that were inserted.
 */
export async function insertClaims(
  workspaceId: string,
  taskId: string,
  paths: string[],
): Promise<string[]> {
  if (paths.length === 0) return [];

  // Fetch existing active claims for this task to avoid inserting duplicates
  const existing = await db.query.pathClaims.findMany({
    where: and(
      eq(pathClaims.taskId, taskId),
      isNull(pathClaims.releasedAt),
    ),
    columns: { path: true },
  });
  const existingPaths = new Set(existing.map(r => r.path));
  const newPaths = paths.filter(p => !existingPaths.has(p));

  if (newPaths.length === 0) return [];

  await db.insert(pathClaims).values(
    newPaths.map(path => ({ workspaceId, taskId, path })),
  );
  return newPaths;
}

// ── Release ──────────────────────────────────────────────────────────────────

/**
 * Soft-delete all active path_claims for a task and stamp notifiedAt on
 * all pending waiters. Returns release info for the caller to fan out via Pusher.
 *
 * Returns null if the task had no active claims.
 */
export async function releaseClaims(taskId: string): Promise<ReleaseResult | null> {
  const activeClaims = await db.query.pathClaims.findMany({
    where: and(
      eq(pathClaims.taskId, taskId),
      isNull(pathClaims.releasedAt),
    ),
    columns: { id: true, workspaceId: true, path: true },
  });

  if (activeClaims.length === 0) return null;

  const now = new Date();
  const claimIds = activeClaims.map(c => c.id);
  await db
    .update(pathClaims)
    .set({ releasedAt: now })
    .where(inArray(pathClaims.id, claimIds));

  const workspaceId = activeClaims[0].workspaceId;
  const releasedPaths = activeClaims.map(c => c.path);

  // Stamp notifiedAt on pending waiters for this task
  const pendingWaiters = await db.query.pathClaimWaiters.findMany({
    where: and(
      eq(pathClaimWaiters.blockingTaskId, taskId),
      isNull(pathClaimWaiters.notifiedAt),
    ),
    columns: { id: true, waitingTaskId: true },
  });

  if (pendingWaiters.length > 0) {
    await db
      .update(pathClaimWaiters)
      .set({ notifiedAt: now })
      .where(inArray(pathClaimWaiters.id, pendingWaiters.map(w => w.id)));
  }

  return {
    workspaceId,
    releasedPaths,
    notifiedWaiters: pendingWaiters.map(w => w.waitingTaskId),
  };
}

// ── Waiter registration ──────────────────────────────────────────────────────

/**
 * Register waitingTaskId as a waiter on blockingTaskId for the given path.
 *
 * Performs a BFS deadlock check before inserting. If the new edge would
 * close a cycle in the waiter graph, returns a DeadlockResult.
 *
 * The UNIQUE constraint on (blockingTaskId, waitingTaskId, blockedPath)
 * makes duplicate registrations idempotent.
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

  try {
    await db.insert(pathClaimWaiters).values({
      workspaceId,
      blockingTaskId,
      waitingTaskId,
      blockedPath,
    });
  } catch {
    // Unique constraint violation — already registered; idempotent
  }

  return { registered: true };
}

/**
 * BFS: can we reach newBlockingTaskId starting from newWaitingTaskId by
 * following existing (waitingTaskId → blockingTaskId) edges?
 *
 * If yes, adding edge (newBlockingTaskId → newWaitingTaskId) would create
 * a cycle. Returns the cycle path if found, null otherwise.
 */
async function detectDeadlockCycle(
  newBlockingTaskId: string,
  newWaitingTaskId: string,
): Promise<string[] | null> {
  const visited = new Set<string>([newWaitingTaskId]);
  const queue: Array<{ taskId: string; path: string[] }> = [
    { taskId: newWaitingTaskId, path: [newWaitingTaskId] },
  ];

  while (queue.length > 0) {
    const { taskId, path } = queue.shift()!;

    // Where is taskId currently waiting? Follow waiting → blocking edges.
    const waitingOn = await db.query.pathClaimWaiters.findMany({
      where: eq(pathClaimWaiters.waitingTaskId, taskId),
      columns: { blockingTaskId: true },
    });

    for (const { blockingTaskId } of waitingOn) {
      if (blockingTaskId === newBlockingTaskId) {
        return [...path, newBlockingTaskId];
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
