/**
 * The one implementation of "check_path_claim": a worker that discovers it
 * needs files outside its declared pathManifest asks whether they are free,
 * and either gets them (manifest extended, path_claims rows inserted) or is
 * told who holds them and registered as a waiter. Its inverse,
 * `narrowPathClaim`, gives paths back.
 *
 * Two entry points call this — the MCP `check_path_claim` tool and
 * POST /api/tasks/[id]/path-claim. They used to carry separate copies, and the
 * MCP copy drifted: it never recorded a gate event, so every refusal an agent
 * hit was invisible to the gate ledger, and it told waiters something
 * different from the REST copy. Entry points now only authenticate and map the
 * returned outcome onto their own transport.
 *
 * Ownership goes through `acquirePathClaims` / `narrowPathClaims` in
 * packages/core/path-claim.ts: one locked statement decides, so two callers
 * can never both acquire overlapping paths, and a path that is already in the
 * manifest still gets its lease.
 */
import { isOpenTaskStatus } from '@buildd/shared';
import { db } from '@buildd/core/db';
import { tasks, missionNotes } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import {
  acquirePathClaims,
  narrowPathClaims,
  registerWaiter,
} from '@buildd/core/path-claim';
import { isAdvisoryManifest } from '@buildd/core/path-overlap';
import { GATE_SLUGS, fireGateEvent, type GateCallerOrigin } from '@/lib/gate-ledger';
import { recordPathDeclaration } from '@/lib/path-declaration-ledger';
import { deliverPathReleased } from '@/lib/path-claim-release';

export const PATH_CLAIM_WILDCARD_ERROR =
  'Wildcard claims are not supported. Declare specific paths. Use maxConcurrentTasks=1 at the mission level to serialize broad tasks.';

export interface PathClaimTask {
  id: string;
  workspaceId: string;
  missionId: string | null;
  status: string;
}

export type PathClaimCheckOutcome =
  | { kind: 'invalid_paths'; error: string }
  | { kind: 'wildcard'; error: string }
  | { kind: 'not_found' }
  | { kind: 'bad_status'; error: string }
  | { kind: 'claimed'; pathManifest: string[]; revision: number | null }
  | { kind: 'conflict'; body: Record<string, unknown> };

export interface PathClaimCheckInput {
  taskId: string;
  paths: unknown;
  /** Recorded on the gate ledger row, e.g. 'mcp:check_path_claim'. */
  surface: string;
  callerOrigin: GateCallerOrigin;
  /**
   * Caller-side access check, run once the task is loaded. Returning false
   * yields `not_found` so an entry point never confirms a task it can't see.
   */
  authorize?: (task: PathClaimTask) => Promise<boolean>;
}

function waiterMessage(
  blockingTaskId: string,
  blocker: { title: string | null; missionId: string | null } | undefined,
  isCrossMission: boolean,
): string {
  const who = `"${blocker?.title ?? blockingTaskId.slice(0, 8)}" (${blockingTaskId.slice(0, 8)})`;
  const where = isCrossMission ? ` in a different mission (${blocker!.missionId!.slice(0, 8)})` : '';
  // The path_released worker message is what actually reaches an agent (see
  // releaseAndNotify). The workspace-channel Pusher event has no agent-side
  // subscriber, so naming it here sent waiters to watch for nothing.
  return `Paths overlap with task ${who}${where}. You are registered as a waiter — a path_released message is delivered on your next update_progress check-in when the path is free.`;
}

function validPaths(rawPaths: unknown): rawPaths is string[] {
  return Array.isArray(rawPaths)
    && rawPaths.length > 0
    && rawPaths.every((p: unknown) => typeof p === 'string' && p.trim() !== '');
}

const INVALID_PATHS = { kind: 'invalid_paths', error: 'paths must be a non-empty array of non-empty strings' } as const;

export async function checkPathClaim(input: PathClaimCheckInput): Promise<PathClaimCheckOutcome> {
  const { taskId, surface, callerOrigin } = input;
  if (!validPaths(input.paths)) return INVALID_PATHS;
  const paths = input.paths;

  const task = await db.query.tasks.findFirst({
    where: eq(tasks.id, taskId),
    columns: { id: true, workspaceId: true, missionId: true, pathManifest: true, status: true },
  });

  // '**' is advisory-only and must never become a held lock that blocks the
  // whole workspace. isAdvisoryManifest is the single definition of "scope
  // not declared" (packages/core/path-overlap.ts).
  if (isAdvisoryManifest(paths)) {
    fireGateEvent({
      gate: GATE_SLUGS.PATH_CLAIM,
      surface,
      outcome: 'rejected',
      reason: PATH_CLAIM_WILDCARD_ERROR,
      workspaceId: task?.workspaceId ?? null,
      missionId: task?.missionId ?? null,
      taskId: task?.id ?? null,
      callerOrigin,
      detail: { pathCount: paths.length },
    });
    return { kind: 'wildcard', error: PATH_CLAIM_WILDCARD_ERROR };
  }

  if (!task) return { kind: 'not_found' };
  if (input.authorize && !(await input.authorize(task))) return { kind: 'not_found' };

  if (!isOpenTaskStatus(task.status)) {
    return { kind: 'bad_status', error: `Cannot claim paths for a task with status "${task.status}"` };
  }

  // Held locks live in path_claims (workspace-scoped), not inferred from
  // tasks.pathManifest — so a path already in the manifest is acquired too.
  const acquired = await acquirePathClaims({ workspaceId: task.workspaceId, taskId, paths, declare: true });

  // The task closed between the read above and the locked write (a cancel
  // racing this call). Nothing was leased.
  if (acquired.kind === 'task_closed') {
    return { kind: 'bad_status', error: 'Cannot claim paths: the task is no longer open' };
  }

  if (acquired.kind === 'conflict') {
    const { conflict } = acquired;
    const blocker = await db.query.tasks.findFirst({
      where: eq(tasks.id, conflict.blockingTaskId),
      columns: { id: true, title: true, missionId: true },
    });

    const waiterResult = await registerWaiter(
      conflict.blockingTaskId,
      taskId,
      conflict.blockingPath,
      task.workspaceId,
    );

    const isCrossMission =
      blocker?.missionId != null &&
      task.missionId != null &&
      blocker.missionId !== task.missionId;

    const hasDeadlock = 'deadlock' in waiterResult && waiterResult.deadlock;

    let message = waiterMessage(conflict.blockingTaskId, blocker, isCrossMission);
    if (hasDeadlock) {
      message += ` DEADLOCK DETECTED: A circular wait cycle exists (${waiterResult.cycle.length} tasks involved). A waiter will never be notified. You must either: (1) cancel this task and retry later, (2) have the blocking task cancel, or (3) use mission-level maxConcurrentTasks=1 to serialize conflicting tasks.`;
    }

    const body: Record<string, unknown> = {
      claimed: false,
      blockingTaskId: conflict.blockingTaskId,
      blockingTaskTitle: blocker?.title ?? null,
      blockingMissionId: blocker?.missionId ?? null,
      // The holder's lease (may be a directory) and every requested path that
      // is held. A declaration is all-or-nothing, so nothing was granted; the
      // list lets an enforcing runner deny the held paths by name and keep the
      // free ones queued (conflict-aware-orchestration.md §2).
      blockingPath: conflict.blockingPath,
      blockedPaths: acquired.blocked.map(b => ({ path: b.path, blockingTaskId: b.blockingTaskId, blockingPath: b.blockingPath })),
      message,
    };

    if (hasDeadlock) {
      body.deadlock = true;
      body.cycle = waiterResult.cycle;
      if (task.missionId) {
        try {
          await db.insert(missionNotes).values({
            missionId: task.missionId,
            taskId,
            authorType: 'system',
            type: 'warning',
            title: 'Deadlock detected in path claims',
            body: `Tasks ${waiterResult.cycle.map((t: string) => t.slice(0, 8)).join(' → ')} form a circular wait. Cancel one task to resolve.`,
            status: 'open',
          });
        } catch { /* non-fatal */ }
      }
    }

    // A real blocker and a circular wait look the same to a caller that only
    // sees claimed:false; the ledger row keeps the distinction.
    fireGateEvent({
      gate: GATE_SLUGS.PATH_CLAIM,
      surface,
      outcome: 'deferred',
      reason: 'paths overlap an active claim held by another task',
      workspaceId: task.workspaceId,
      missionId: task.missionId,
      taskId: task.id,
      callerOrigin,
      detail: {
        blockingTaskId: conflict.blockingTaskId,
        blockingPath: conflict.blockingPath,
        crossMission: isCrossMission,
        deadlock: body.deadlock === true,
      },
    });

    recordPathDeclaration({
      result: 'denied', provenance: 'check_path_claim', surface, workspaceId: task.workspaceId,
      missionId: task.missionId, taskId: task.id, callerOrigin, pathCount: paths.length,
      detail: { blockedCount: acquired.blocked.length },
    });
    return { kind: 'conflict', body };
  }

  fireGateEvent({
    gate: GATE_SLUGS.PATH_CLAIM, surface, outcome: 'accepted',
    reason: 'paths successfully claimed', workspaceId: task.workspaceId,
    missionId: task.missionId, taskId: task.id, callerOrigin,
    detail: { claimResult: 'claimed', pathCount: paths.length, leased: acquired.inserted.length },
  });
  recordPathDeclaration({
    result: 'succeeded', provenance: 'check_path_claim', surface, workspaceId: task.workspaceId,
    missionId: task.missionId, taskId: task.id, callerOrigin, pathCount: paths.length,
    detail: { leased: acquired.inserted.length },
  });
  return {
    kind: 'claimed',
    pathManifest: acquired.pathManifest ?? (task.pathManifest as string[] | null) ?? [],
    revision: acquired.revision,
  };
}

// ── Narrowing ────────────────────────────────────────────────────────────────

export type PathClaimNarrowOutcome =
  | { kind: 'invalid_paths'; error: string }
  | { kind: 'wildcard'; error: string }
  | { kind: 'not_found' }
  | { kind: 'revision_conflict'; currentRevision: number }
  | {
    kind: 'narrowed';
    pathManifest: string[] | null;
    releasedPaths: string[];
    notifiedWaiters: string[];
    revision: number;
  };

export interface PathClaimNarrowInput {
  taskId: string;
  paths: unknown;
  /** Why the scope shrank — recorded on the task's declaration history. */
  reason?: unknown;
  /** CAS token from a previous claim/narrow response; omit to narrow unconditionally. */
  expectedRevision?: unknown;
  surface: string;
  callerOrigin: GateCallerOrigin;
  authorize?: (task: PathClaimTask) => Promise<boolean>;
}

/**
 * Give paths back: release only this task's leases on them (and under them),
 * drop them from its effective pathManifest, keep the original declaration,
 * and deliver `path_released` only to waiters blocked on a released path.
 *
 * Shared by DELETE /api/tasks/[id]/path-claim and check_path_claim with
 * `release: true`. Scoped to the task's own workspace; the entry point's
 * `authorize` decides who may act on the task.
 */
export async function narrowPathClaim(input: PathClaimNarrowInput): Promise<PathClaimNarrowOutcome> {
  const { taskId, surface, callerOrigin } = input;
  if (!validPaths(input.paths)) return INVALID_PATHS;
  const paths = input.paths;
  if (isAdvisoryManifest(paths)) return { kind: 'wildcard', error: PATH_CLAIM_WILDCARD_ERROR };

  const expectedRevision = input.expectedRevision;
  if (expectedRevision != null && (!Number.isInteger(expectedRevision) || (expectedRevision as number) < 0)) {
    return { kind: 'invalid_paths', error: 'expectedRevision must be a non-negative integer' };
  }
  const reason = typeof input.reason === 'string' && input.reason.trim() ? input.reason.trim().slice(0, 500) : null;

  const task = await db.query.tasks.findFirst({
    where: eq(tasks.id, taskId),
    columns: { id: true, workspaceId: true, missionId: true, status: true },
  });
  if (!task) return { kind: 'not_found' };
  if (input.authorize && !(await input.authorize(task))) return { kind: 'not_found' };

  const result = await narrowPathClaims({
    workspaceId: task.workspaceId,
    taskId,
    paths,
    surface,
    reason,
    expectedRevision: (expectedRevision as number | null | undefined) ?? null,
  });
  if (result.kind === 'not_found') return result;
  if (result.kind === 'revision_conflict') return result;

  await deliverPathReleased(taskId, result, 'narrowed');

  fireGateEvent({
    gate: GATE_SLUGS.PATH_CLAIM, surface, outcome: 'accepted',
    reason: 'paths narrowed', workspaceId: task.workspaceId,
    missionId: task.missionId, taskId: task.id, callerOrigin,
    detail: {
      claimResult: 'narrowed',
      pathCount: paths.length,
      released: result.releasedPaths.length,
      wokenWaiters: result.notifiedWaiters.length,
    },
  });

  return {
    kind: 'narrowed',
    pathManifest: result.pathManifest,
    releasedPaths: result.releasedPaths,
    notifiedWaiters: [...new Set(result.notifiedWaiters)],
    revision: result.revision,
  };
}
