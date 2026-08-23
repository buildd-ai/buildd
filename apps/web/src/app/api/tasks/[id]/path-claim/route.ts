import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import { and, eq, inArray, isNotNull, ne } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { verifyWorkspaceAccess, verifyAccountWorkspaceAccess } from '@/lib/team-access';
import { pathsOverlap } from '@buildd/core/path-overlap';

const FULL_UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
 *   The task's pathManifest is atomically extended with the new paths.
 *
 * Conflict — at least one path overlaps an active sibling task's manifest:
 *   409 { claimed: false, blockingTaskId: string, blockingTaskTitle: string, message: string }
 *   The caller should report blocked with the blockingTaskId so a dependsOn
 *   edge can be added before continuing.
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

  const task = await db.query.tasks.findFirst({
    where: eq(tasks.id, id),
    columns: { id: true, workspaceId: true, pathManifest: true, status: true, title: true },
  });

  if (!task) {
    return NextResponse.json({ error: 'Task not found' }, { status: 404 });
  }

  if (user && !apiAccount) {
    const access = await verifyWorkspaceAccess(user.id, task.workspaceId);
    if (!access) return NextResponse.json({ error: 'Task not found' }, { status: 404 });
  } else if (apiAccount) {
    const hasAccess = await verifyAccountWorkspaceAccess(apiAccount.id, task.workspaceId);
    if (!hasAccess) return NextResponse.json({ error: 'Task not found' }, { status: 404 });
  }

  if (!['pending', 'assigned', 'in_progress'].includes(task.status)) {
    return NextResponse.json(
      { error: `Cannot claim paths for a task with status "${task.status}"` },
      { status: 400 }
    );
  }

  // Find all active sibling tasks in the same workspace with a declared pathManifest
  const siblings = await db.query.tasks.findMany({
    where: and(
      eq(tasks.workspaceId, task.workspaceId),
      inArray(tasks.status, ['pending', 'assigned', 'in_progress']),
      isNotNull(tasks.pathManifest),
      ne(tasks.id, id),
    ),
    columns: { id: true, title: true, pathManifest: true },
  });

  // Return the first blocking sibling whose manifest overlaps the requested paths
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

  // No conflict: extend the task's pathManifest with any new paths
  const currentManifest = (task.pathManifest as string[] | null) ?? [];
  const existingSet = new Set(currentManifest);
  const newPaths = paths.filter((p) => !existingSet.has(p));

  if (newPaths.length > 0) {
    const updatedManifest = [...currentManifest, ...newPaths];
    await db
      .update(tasks)
      .set({ pathManifest: updatedManifest })
      .where(eq(tasks.id, id));
    return NextResponse.json({ claimed: true, pathManifest: updatedManifest });
  }

  return NextResponse.json({ claimed: true, pathManifest: currentManifest });
}
