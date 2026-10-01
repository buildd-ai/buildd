import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { verifyWorkspaceAccess, verifyAccountWorkspaceAccess } from '@/lib/team-access';
import { gateCallerOrigin } from '@/lib/gate-ledger';
import { checkPathClaim } from '@/lib/path-claim-check';

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
  const apiAccount = await authenticateApiKey(apiKey, req);

  if (!user && !apiAccount) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const outcome = await checkPathClaim({
    taskId: id,
    paths: (body as any)?.paths,
    surface: 'POST /api/tasks/[id]/path-claim',
    callerOrigin: gateCallerOrigin({ apiAccount, user }),
    authorize: async (task) => {
      if (user && !apiAccount) {
        return Boolean(await verifyWorkspaceAccess(user.id, task.workspaceId));
      }
      if (apiAccount) {
        return Boolean(await verifyAccountWorkspaceAccess(apiAccount.id, task.workspaceId));
      }
      return false;
    },
  });

  switch (outcome.kind) {
    case 'invalid_paths':
    case 'wildcard':
    case 'bad_status':
      return NextResponse.json({ error: outcome.error }, { status: 400 });
    case 'not_found':
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    case 'conflict':
      return NextResponse.json(outcome.body, { status: 409 });
    case 'claimed':
      return NextResponse.json({ claimed: true, pathManifest: outcome.pathManifest });
  }
}
