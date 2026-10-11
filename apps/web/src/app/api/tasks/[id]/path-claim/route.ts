import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { verifyWorkspaceAccess, verifyAccountWorkspaceAccess } from '@/lib/team-access';
import { gateCallerOrigin } from '@/lib/gate-ledger';
import { checkPathClaim, narrowPathClaim, type PathClaimTask } from '@/lib/path-claim-check';

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
 *   200 { claimed: true, pathManifest: string[], revision: number | null }
 *   One locked statement leases every requested path this task does not hold
 *   yet — including paths already in its manifest — and appends the new ones
 *   to pathManifest. `revision` is the CAS token DELETE accepts.
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
type Auth = { user: Awaited<ReturnType<typeof getCurrentUser>>; apiAccount: Awaited<ReturnType<typeof authenticateApiKey>> };

async function authenticate(req: NextRequest): Promise<Auth | null> {
  const user = await getCurrentUser();
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const apiAccount = await authenticateApiKey(apiKey, req);
  return user || apiAccount ? { user, apiAccount } : null;
}

/** Workspace-scoped: the caller must reach the task's own workspace. */
function authorizeFor({ user, apiAccount }: Auth) {
  return async (task: PathClaimTask) => {
    if (user && !apiAccount) {
      return Boolean(await verifyWorkspaceAccess(user.id, task.workspaceId));
    }
    if (apiAccount) {
      return Boolean(await verifyAccountWorkspaceAccess(apiAccount, task.workspaceId));
    }
    return false;
  };
}

async function readJson(req: NextRequest): Promise<{ ok: true; body: unknown } | { ok: false }> {
  try {
    return { ok: true, body: await req.json() };
  } catch {
    return { ok: false };
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  if (!FULL_UUID_REGEX.test(id)) {
    return NextResponse.json({ error: 'taskId must be a full UUID' }, { status: 400 });
  }

  const auth = await authenticate(req);
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const parsed = await readJson(req);
  if (!parsed.ok) {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const body = parsed.body;

  const outcome = await checkPathClaim({
    taskId: id,
    paths: (body as any)?.paths,
    surface: 'POST /api/tasks/[id]/path-claim',
    callerOrigin: gateCallerOrigin(auth),
    authorize: authorizeFor(auth),
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
      return NextResponse.json({ claimed: true, pathManifest: outcome.pathManifest, revision: outcome.revision });
  }
}

/**
 * DELETE /api/tasks/[id]/path-claim
 *
 * Narrow a task's claimed scope: give paths back.
 *
 * Body: { paths: string[], reason?: string, expectedRevision?: number }
 *
 * Releases only this task's leases on `paths` — a directory also releases
 * every lease under it — removes them from the effective pathManifest, keeps
 * the original declaration in `pathDeclaration`, and sends `path_released`
 * (reason `narrowed`) only to tasks waiting on a released path.
 *
 *   200 { narrowed: true, pathManifest, releasedPaths, notifiedWaiters, revision }
 *   409 { error, currentRevision, retryable: true } — `expectedRevision` is
 *       stale: re-read and retry.
 *
 * Same auth as POST: the caller must have access to the task's workspace.
 * Shared with the check_path_claim MCP tool (`release: true`).
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  if (!FULL_UUID_REGEX.test(id)) {
    return NextResponse.json({ error: 'taskId must be a full UUID' }, { status: 400 });
  }

  const auth = await authenticate(req);
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const parsed = await readJson(req);
  if (!parsed.ok) {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const body = (parsed.body ?? {}) as Record<string, unknown>;

  const outcome = await narrowPathClaim({
    taskId: id,
    paths: body.paths,
    reason: body.reason,
    expectedRevision: body.expectedRevision,
    surface: 'DELETE /api/tasks/[id]/path-claim',
    callerOrigin: gateCallerOrigin(auth),
    authorize: authorizeFor(auth),
  });

  switch (outcome.kind) {
    case 'invalid_paths':
    case 'wildcard':
      return NextResponse.json({ error: outcome.error }, { status: 400 });
    case 'not_found':
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    case 'revision_conflict':
      return NextResponse.json({
        error: 'Path claims changed since expectedRevision; re-read and retry',
        currentRevision: outcome.currentRevision,
        retryable: true,
      }, { status: 409 });
    case 'narrowed':
      return NextResponse.json({
        narrowed: true,
        pathManifest: outcome.pathManifest,
        releasedPaths: outcome.releasedPaths,
        notifiedWaiters: outcome.notifiedWaiters,
        revision: outcome.revision,
      });
  }
}
