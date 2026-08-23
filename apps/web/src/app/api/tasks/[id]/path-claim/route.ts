import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import { and, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm';
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
 *   The task's pathManifest is atomically extended with the new paths via CAS.
 *
 * Conflict — at least one path overlaps an active sibling task's manifest:
 *   409 { claimed: false, blockingTaskId: string, blockingTaskTitle: string, message: string }
 *   The caller should report blocked with the blockingTaskId so a dependsOn
 *   edge can be added before continuing.
 *
 * Siblings are scoped to the same mission when the task has a missionId;
 * otherwise the check falls back to workspace scope.
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
    // Scope siblings to the same mission when the task has one; fall back to
    // workspace scope for tasks that are not under any mission.
    const siblings = await db.query.tasks.findMany({
      where: and(
        eq(tasks.workspaceId, currentTask.workspaceId),
        currentTask.missionId ? eq(tasks.missionId, currentTask.missionId) : undefined,
        inArray(tasks.status, ['pending', 'assigned', 'in_progress']),
        isNotNull(tasks.pathManifest),
        ne(tasks.id, id),
      ),
      columns: { id: true, title: true, pathManifest: true },
    });

    for (const sibling of siblings) {
      if (!sibling.pathManifest?.length) continue;
      if (pathsOverlap(paths, sibling.pathManifest as string[])) {
        return NextResponse.json(
          {
            claimed: false,
            blockingTaskId: sibling.id,
            blockingTaskTitle: sibling.title,
            message: `Paths overlap with sibling task "${sibling.title}" (${sibling.id.slice(0, 8)}). Report blocked with blockingTaskId so a dependsOn edge can be added.`,
          },
          { status: 409 }
        );
      }
    }

    const existingManifest = (currentTask.pathManifest as string[] | null) ?? [];
    const existingSet = new Set(existingManifest);
    const newPaths = paths.filter((p) => !existingSet.has(p));

    if (newPaths.length === 0) {
      return NextResponse.json({ claimed: true, pathManifest: existingManifest });
    }

    const updatedManifest = [...existingManifest, ...newPaths];

    // Atomic CAS: write only if pathManifest hasn't changed since we read it.
    // Two concurrent workers racing on the same unclaimed path will both
    // attempt this UPDATE; only one wins — the other retries.
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
