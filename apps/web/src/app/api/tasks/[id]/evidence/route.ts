import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import type { EvidenceKind, TaskEvidenceListResponse, TaskEvidenceReadResponse } from '@buildd/shared';
import { eq } from 'drizzle-orm';
import { authenticateTaskScopedCaller, taskScopeAllowsWorkspace } from '@/lib/task-token-auth';
import { tokenWorkspaceAllowed } from '@buildd/core/token-scopes';
import { getCurrentUser } from '@/lib/auth-helpers';
import { verifyWorkspaceAccess, verifyAccountWorkspaceAccess } from '@/lib/team-access';
import { resolveTaskIdForCaller } from '@/lib/resolve-task-id';
import { isUuid } from '@/lib/uuid';
import {
  EVIDENCE_KINDS, EvidenceReadError, auditEvidenceRead, findTaskEvidenceObject, listTaskEvidenceObjects,
  openEvidenceObject, parseEvidenceReadParams, readEvidenceText, toEvidenceObjectSummary,
} from '@/lib/evidence-read';

const LIST_LIMIT = 200;
const READ_QUERY_KEYS = ['tail', 'grep', 'range', 'cursor'] as const;

// GET /api/tasks/[id]/evidence[?kind=]
//   Lists the task's evidence objects: those written for it and, for a root
//   task, those of its whole retry chain (root_task_id = id).
// GET /api/tasks/[id]/evidence?evidenceId=&tail=&grep=&range=&cursor=
//   Returns redacted text from one object, at most 64 KB, with `truncated` and
//   a `cursor`. The object must belong to [id] by task_id or root_task_id.
//   Never returns a presigned URL (docs/specs/byo-evidence-storage.md).
//
// `id` may be an 8+ character prefix, resolved within the caller's workspaces.
//
// A scoped token needs analytics:read (the read_evidence capability). With
// both a session and a bearer the account decides, as GET /api/tasks/[id] does.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: rawId } = await params;

  const user = await getCurrentUser();
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  // A per-task token reads evidence of any task in its own task's workspace.
  const apiAccount = await authenticateTaskScopedCaller(apiKey, req);

  if (!user && !apiAccount) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // authenticateApiKey checks a restricted token's workspace only for a full
  // task UUID in the path; a prefix id is resolved here, so check it here too.
  const canAccess = async (workspaceId: string): Promise<boolean> =>
    apiAccount
      ? tokenWorkspaceAllowed(apiAccount.workspaceIds, workspaceId) && taskScopeAllowsWorkspace(apiAccount, workspaceId)
        && verifyAccountWorkspaceAccess(apiAccount.id, workspaceId)
      : !!(await verifyWorkspaceAccess(user!.id, workspaceId));

  const resolved = await resolveTaskIdForCaller(rawId, canAccess);
  if (!resolved.ok) {
    return NextResponse.json(
      { error: resolved.error, ...(resolved.candidates ? { candidates: resolved.candidates } : {}) },
      { status: resolved.status },
    );
  }
  const id = resolved.id;

  const task = await db.query.tasks.findFirst({
    where: eq(tasks.id, id),
    columns: { id: true, workspaceId: true },
  });
  if (!task || !(await canAccess(task.workspaceId))) {
    return NextResponse.json({ error: 'Task not found' }, { status: 404 });
  }

  const sp = req.nextUrl.searchParams;
  const kind = sp.get('kind');
  if (kind && !EVIDENCE_KINDS.includes(kind as EvidenceKind)) {
    return NextResponse.json({ error: `kind must be one of: ${EVIDENCE_KINDS.join(', ')}` }, { status: 400 });
  }

  const actor = apiAccount ? { accountId: apiAccount.id } : { userId: user!.id };
  const scope = { id, workspaceId: task.workspaceId };

  const evidenceId = sp.get('evidenceId');
  if (!evidenceId) {
    const rows = await listTaskEvidenceObjects(scope, { limit: LIST_LIMIT, ...(kind ? { kind: kind as EvidenceKind } : {}) });
    const objects = rows.map(toEvidenceObjectSummary);
    auditEvidenceRead({
      surface: 'GET /api/tasks/:id/evidence', op: 'list', workspaceId: task.workspaceId, taskId: id,
      evidenceIds: objects.map(o => o.id), actor, ...(kind ? { query: { kind } } : {}),
    });
    const body: TaskEvidenceListResponse = {
      taskId: id,
      workspaceId: task.workspaceId,
      objects,
      ...(resolved.resolvedFrom ? { resolvedFrom: resolved.resolvedFrom } : {}),
    };
    return NextResponse.json(body);
  }

  if (!isUuid(evidenceId)) {
    return NextResponse.json({ error: 'evidenceId must be a full UUID' }, { status: 400 });
  }
  const parsed = parseEvidenceReadParams(sp);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const row = await findTaskEvidenceObject(scope, evidenceId);
  if (!row) {
    return NextResponse.json({ error: 'Evidence object not found for this task' }, { status: 404 });
  }

  let result;
  try {
    result = await readEvidenceText(await openEvidenceObject(row), parsed.options);
  } catch (err) {
    if (err instanceof EvidenceReadError) {
      return NextResponse.json({ error: err.message, evidenceId }, { status: err.status });
    }
    console.error('[evidence-read] decode failed:', err instanceof Error ? err.message : err);
    return NextResponse.json({ error: 'this evidence object could not be decoded (corrupt or not text)', evidenceId }, { status: 422 });
  }

  const query: Record<string, string> = {};
  for (const k of READ_QUERY_KEYS) {
    const v = sp.get(k);
    if (v) query[k] = v;
  }
  auditEvidenceRead({
    surface: 'GET /api/tasks/:id/evidence', op: 'read', workspaceId: task.workspaceId, taskId: id,
    evidenceIds: [row.id], actor, query, bytesReturned: Buffer.byteLength(result.text), truncated: result.truncated,
  });

  const body: TaskEvidenceReadResponse = {
    ...result,
    taskId: id,
    workspaceId: task.workspaceId,
    object: toEvidenceObjectSummary(row),
  };
  return NextResponse.json(body);
}
