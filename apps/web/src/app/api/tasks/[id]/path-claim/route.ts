import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { tasks, missionNotes } from '@buildd/core/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { verifyWorkspaceAccess, verifyAccountWorkspaceAccess } from '@/lib/team-access';
import {
  checkPathClaimConflict,
  insertClaims,
  registerWaiter,
} from '@buildd/core/path-claim';

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
 *   The task's pathManifest is atomically extended with the new paths via CAS.
 *   path_claims rows are inserted for each new path.
 *
 * Conflict — at least one path overlaps an active path_claims row:
 *   409 { claimed: false, blockingTaskId: string, blockingTaskTitle: string,
 *          blockingMissionId: string | null, message: string,
 *          deadlock?: true, cycle?: string[] }
 *   The caller is automatically registered as a waiter. On release a
 *   path_claim_released Pusher event fires on the workspace channel.
 *
 * Siblings are scoped to the workspace (not restricted to the same mission).
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

  // Wildcard claims are not supported — '**' is advisory-only and must not
  // become a held lock that blocks the entire workspace.
  if (paths.includes('**')) {
    return NextResponse.json(
      { error: 'Wildcard claims are not supported. Declare specific paths. Use maxConcurrentTasks=1 at the mission level to serialize broad tasks.' },
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

  for (let attempt = 0; attempt < MAX_CLAIM_RETRIES; attempt++) {
    // Check active path_claims rows for conflicts (workspace-scoped).
    // This replaces the old tasks.pathManifest sibling scan — held locks are
    // now in path_claims, not inferred from manifest + status combinations.
    const conflict = await checkPathClaimConflict(
      currentTask.workspaceId,
      id,
      paths,
    );

    if (conflict) {
      // Fetch blocker details for the response
      const blocker = await db.query.tasks.findFirst({
        where: eq(tasks.id, conflict.blockingTaskId),
        columns: { id: true, title: true, missionId: true },
      });

      // Auto-register as waiter (deadlock check included)
      const waiterResult = await registerWaiter(
        conflict.blockingTaskId,
        id,
        conflict.blockingPath,
        currentTask.workspaceId,
      );

      const isCrossMission =
        blocker?.missionId !== null &&
        blocker?.missionId !== undefined &&
        currentTask.missionId !== null &&
        currentTask.missionId !== undefined &&
        blocker?.missionId !== currentTask.missionId;

      const message = isCrossMission
        ? `Paths overlap with task "${blocker?.title ?? conflict.blockingTaskId.slice(0, 8)}" (${conflict.blockingTaskId.slice(0, 8)}) in a different mission (${blocker?.missionId!.slice(0, 8)}). You have been registered as a waiter — a path_claim_released Pusher event will fire on the workspace channel when the path is free.`
        : `Paths overlap with task "${blocker?.title ?? conflict.blockingTaskId.slice(0, 8)}" (${conflict.blockingTaskId.slice(0, 8)}). You have been registered as a waiter — a path_claim_released Pusher event will fire on the workspace channel when the path is free.`;

      const response: Record<string, unknown> = {
        claimed: false,
        blockingTaskId: conflict.blockingTaskId,
        blockingTaskTitle: blocker?.title ?? null,
        blockingMissionId: blocker?.missionId ?? null,
        message,
      };

      if ('deadlock' in waiterResult && waiterResult.deadlock) {
        response.deadlock = true;
        response.cycle = waiterResult.cycle;
        // Post a warning for human resolution (best-effort)
        if (currentTask.missionId) {
          try {
            await db.insert(missionNotes).values({
              missionId: currentTask.missionId,
              taskId: id,
              authorType: 'system',
              type: 'warning',
              title: 'Deadlock detected in path claims',
              body: `Tasks ${waiterResult.cycle.map((t: string) => t.slice(0, 8)).join(' → ')} form a circular wait. Cancel one task to resolve.`,
              status: 'open',
            });
          } catch { /* non-fatal */ }
        }
      }

      return NextResponse.json(response, { status: 409 });
    }

    const existingManifest = (currentTask.pathManifest as string[] | null) ?? [];
    const existingSet = new Set(existingManifest);
    const newPaths = paths.filter((p) => !existingSet.has(p));

    if (newPaths.length === 0) {
      return NextResponse.json({ claimed: true, pathManifest: existingManifest });
    }

    const updatedManifest = [...existingManifest, ...newPaths];

    // Atomic CAS: write only if pathManifest hasn't changed since we read it.
    // This serializes concurrent calls from the same task and prevents double-insertion.
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
      // Insert path_claims rows for the newly claimed paths
      await insertClaims(currentTask.workspaceId, id, newPaths);
      return NextResponse.json({ claimed: true, pathManifest: updatedManifest });
    }

    // CAS failed — another concurrent call modified the manifest. Re-read and retry.
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
