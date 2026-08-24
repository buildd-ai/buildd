import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { tasks, pathClaims, pathClaimWaiters } from '@buildd/core/db/schema';
import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { verifyWorkspaceAccess, verifyAccountWorkspaceAccess } from '@/lib/team-access';
import { pathsOverlap } from '@buildd/core/path-overlap';

const FULL_UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_CLAIM_RETRIES = 3;

/**
 * POST /api/tasks/[id]/path-claim
 *
 * Mid-task path-claim check for workers that discover they need to touch files
 * outside their declared pathManifest.
 *
 * Body: { paths: string[] }
 *
 * Success — all paths are unclaimed by active sibling tasks:
 *   200 { claimed: true, pathManifest: string[] }
 *   One path_claims row is inserted per new path, and the task's pathManifest
 *   is atomically extended via CAS for backward compatibility.
 *
 * Conflict — at least one path overlaps an active path_claims row held by a sibling:
 *   409 { claimed: false, blockingTaskId: string, blockingTaskTitle: string,
 *          blockingMissionId: string | null, message: string }
 *   The requesting task is registered as a waiter in path_claim_waiters so it
 *   can be notified when the blocking task releases its claims.
 *
 * Siblings are scoped to the workspace (not restricted to the same mission).
 * The ** wildcard is rejected with 400 — wildcard claims are not supported.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  if (!FULL_UUID_REGEX.test(id)) {
    return NextResponse.json({ error: 'taskId must be a full UUID' }, { status: 400 });
  }

  const user = await getCurrentUser();
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const apiAccount = await authenticateApiKey(apiKey);

  if (!user && !apiAccount) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const rawPaths = (body as any)?.paths;
  if (
    !Array.isArray(rawPaths) ||
    rawPaths.length === 0 ||
    rawPaths.some((p: unknown) => typeof p !== 'string' || p.trim() === '')
  ) {
    return NextResponse.json(
      { error: 'paths must be a non-empty array of non-empty strings' },
      { status: 400 }
    );
  }
  const paths = rawPaths as string[];

  // The ** sentinel is advisory-only — it cannot be held as a specific lock.
  if (paths.includes('**')) {
    return NextResponse.json(
      { error: 'Wildcard ** claims are not supported. Declare specific paths.' },
      { status: 400 }
    );
  }

  let currentTask = await db.query.tasks.findFirst({
    where: eq(tasks.id, id),
    columns: { id: true, workspaceId: true, missionId: true, pathManifest: true, status: true, title: true },
  });

  if (!currentTask) {
    return NextResponse.json({ error: 'Task not found' }, { status: 404 });
  }

  if (user && !apiAccount) {
    const access = await verifyWorkspaceAccess(user.id, currentTask.workspaceId);
    if (!access) return NextResponse.json({ error: 'Task not found' }, { status: 404 });
  } else if (apiAccount) {
    const hasAccess = await verifyAccountWorkspaceAccess(apiAccount.id, currentTask.workspaceId);
    if (!hasAccess) return NextResponse.json({ error: 'Task not found' }, { status: 404 });
  }

  if (!['pending', 'assigned', 'in_progress'].includes(currentTask.status)) {
    return NextResponse.json(
      { error: `Cannot claim paths for a task with status "${currentTask.status}"` },
      { status: 400 }
    );
  }

  // Capture workspaceId once — currentTask may be re-assigned in the CAS retry loop.
  const workspaceId = currentTask.workspaceId;

  // Fetch all active path_claims in this workspace, excluding the caller's own claims.
  // One row per (taskId, path) — group by taskId in application code to apply pathsOverlap.
  const activeClaims = await db.query.pathClaims.findMany({
    where: and(
      eq(pathClaims.workspaceId, currentTask.workspaceId),
      isNull(pathClaims.releasedAt),
      ne(pathClaims.taskId, id),
    ),
    columns: { taskId: true, path: true },
  });

  // Group claim paths by taskId for pathsOverlap check.
  const claimsByTask = new Map<string, string[]>();
  for (const claim of activeClaims) {
    const existing = claimsByTask.get(claim.taskId) ?? [];
    existing.push(claim.path);
    claimsByTask.set(claim.taskId, existing);
  }

  for (const [claimTaskId, claimPaths] of claimsByTask) {
    if (pathsOverlap(paths, claimPaths)) {
      // Fetch the blocking task's metadata for the response message.
      const blockingTask = await db.query.tasks.findFirst({
        where: eq(tasks.id, claimTaskId),
        columns: { id: true, title: true, missionId: true },
      });

      const blockingMissionId = blockingTask?.missionId ?? null;
      const isCrossMission =
        blockingMissionId !== null &&
        currentTask.missionId !== null &&
        blockingMissionId !== currentTask.missionId;
      const message = isCrossMission
        ? `Paths overlap with task "${blockingTask?.title}" (${claimTaskId.slice(0, 8)}) in a different mission (${blockingMissionId!.slice(0, 8)}). Report blocked with blockingTaskId and blockingMissionId — a dependsOn edge across missions is a significant coordination decision; escalate to a human or the organizer.`
        : `Paths overlap with sibling task "${blockingTask?.title}" (${claimTaskId.slice(0, 8)}). Report blocked with blockingTaskId so a dependsOn edge can be added.`;

      // Register the caller as a waiter for each overlapping path on the blocking task.
      const overlappingPaths = paths.filter((p) => claimPaths.some((cp) => pathsOverlap([p], [cp])));
      if (overlappingPaths.length > 0) {
        await db
          .insert(pathClaimWaiters)
          .values(
            overlappingPaths.map((p) => ({
              workspaceId,
              blockingTaskId: claimTaskId,
              waitingTaskId: id,
              blockedPath: p,
            }))
          )
          .onConflictDoNothing();
      }

      return NextResponse.json(
        {
          claimed: false,
          blockingTaskId: claimTaskId,
          blockingTaskTitle: blockingTask?.title ?? null,
          blockingMissionId,
          message,
        },
        { status: 409 }
      );
    }
  }

  for (let attempt = 0; attempt < MAX_CLAIM_RETRIES; attempt++) {
    const existingManifest = (currentTask.pathManifest as string[] | null) ?? [];
    const existingSet = new Set(existingManifest);
    const newPaths = paths.filter((p) => !existingSet.has(p));

    if (newPaths.length === 0) {
      return NextResponse.json({ claimed: true, pathManifest: existingManifest });
    }

    const updatedManifest = [...existingManifest, ...newPaths];

    // Atomic CAS: write only if pathManifest hasn't changed since we read it.
    // Retained for backward compatibility — the claim-route declared-intent backstop
    // and siblingTaskManifests injection still read tasks.pathManifest.
    const [updated] = await db
      .update(tasks)
      .set({ pathManifest: updatedManifest })
      .where(
        and(
          eq(tasks.id, id),
          sql`path_manifest IS NOT DISTINCT FROM ${JSON.stringify(existingManifest)}::jsonb`,
        )
      )
      .returning({ id: tasks.id });

    if (updated) {
      // Insert one path_claims row per new path (idempotent via ON CONFLICT DO NOTHING).
      await db
        .insert(pathClaims)
        .values(
          newPaths.map((p) => ({
            workspaceId,
            taskId: id,
            path: p,
          }))
        )
        .onConflictDoNothing();

      return NextResponse.json({ claimed: true, pathManifest: updatedManifest });
    }

    // CAS failed — another worker modified the manifest concurrently.
    // Re-read the task and retry (up to MAX_CLAIM_RETRIES times).
    if (attempt < MAX_CLAIM_RETRIES - 1) {
      const refreshed = await db.query.tasks.findFirst({
        where: eq(tasks.id, id),
        columns: { id: true, workspaceId: true, missionId: true, pathManifest: true, status: true, title: true },
      });
      if (!refreshed) {
        return NextResponse.json({ error: 'Task not found' }, { status: 404 });
      }
      currentTask = refreshed;
    }
  }

  return NextResponse.json(
    { error: 'Concurrent update conflict. Please retry the path claim.' },
    { status: 409 }
  );
}
