import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { evidenceObjects, workers } from '@buildd/core/db/schema';
import type { EvidenceKind, EvidenceLookupResponse } from '@buildd/shared';
import { and, desc, eq, inArray, or, type SQL } from 'drizzle-orm';
import { authenticateTaskScopedCaller, taskScopeAllowsWorkspace } from '@/lib/task-token-auth';
import { getCurrentUser } from '@/lib/auth-helpers';
import { verifyWorkspaceAccess, verifyAccountWorkspaceAccess } from '@/lib/team-access';
import { isUuid } from '@/lib/uuid';
import { EVIDENCE_KINDS, auditEvidenceRead, toEvidenceObjectSummary, type EvidenceObjectRow } from '@/lib/evidence-read';

const LIST_LIMIT = 200;
const TASK_LIMIT = 50;

// GET /api/evidence?workspaceId=&prNumber=&kind=
//   Resolves a PR number to the evidence of the tasks behind it: objects
//   recorded against the PR (a CI job log), and objects of every task whose
//   worker opened it, including their retry chains.
// GET /api/evidence?workspaceId=&evidenceId=
//   One object's pointer, so a caller holding only an evidence id can find
//   the task to read it through (GET /api/tasks/:id/evidence), or, for a
//   runner-hosted Scout run's command log, the run
//   (GET /api/quality-scout/runs/:id/evidence).
//
// Listing only; text is read through the task route, which checks lineage.
// A scoped token needs analytics:read and, if restricted, workspaceId among its
// workspaces (both checked in authenticateApiKey). With both a session and a
// bearer the account decides, as GET /api/tasks/[id] does.
export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  // A per-task token lists evidence only in its own task's workspace.
  const apiAccount = await authenticateTaskScopedCaller(apiKey, req);
  if (!user && !apiAccount) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const sp = req.nextUrl.searchParams;
  const workspaceId = sp.get('workspaceId');
  if (!workspaceId || !isUuid(workspaceId)) {
    return NextResponse.json({ error: 'workspaceId (a full UUID) is required' }, { status: 400 });
  }
  const allowed = apiAccount
    ? taskScopeAllowsWorkspace(apiAccount, workspaceId) && await verifyAccountWorkspaceAccess(apiAccount.id, workspaceId)
    : !!(await verifyWorkspaceAccess(user!.id, workspaceId));
  if (!allowed) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });

  const kind = sp.get('kind');
  if (kind && !EVIDENCE_KINDS.includes(kind as EvidenceKind)) {
    return NextResponse.json({ error: `kind must be one of: ${EVIDENCE_KINDS.join(', ')}` }, { status: 400 });
  }
  const actor = apiAccount ? { accountId: apiAccount.id } : { userId: user!.id };

  const evidenceId = sp.get('evidenceId');
  if (evidenceId) {
    if (!isUuid(evidenceId)) return NextResponse.json({ error: 'evidenceId must be a full UUID' }, { status: 400 });
    const row = (await db.query.evidenceObjects.findFirst({
      where: and(eq(evidenceObjects.id, evidenceId), eq(evidenceObjects.workspaceId, workspaceId)),
    })) as EvidenceObjectRow | undefined;
    if (!row || row.id !== evidenceId || row.workspaceId !== workspaceId) {
      return NextResponse.json({ error: 'Evidence object not found' }, { status: 404 });
    }
    auditEvidenceRead({ surface: 'GET /api/evidence', op: 'list', workspaceId, taskId: row.taskId, evidenceIds: [row.id], actor });
    const body: EvidenceLookupResponse = {
      // A Scout run's object has no task: `objects[0].scoutRunId` names the run to read it through.
      workspaceId, prNumber: row.prNumber ?? null, taskIds: row.taskId ? [row.taskId] : [], objects: [toEvidenceObjectSummary(row)],
    };
    return NextResponse.json(body);
  }

  const prRaw = sp.get('prNumber');
  const prNumber = prRaw && /^\d{1,9}$/.test(prRaw) ? Number(prRaw) : NaN;
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    return NextResponse.json({ error: 'prNumber (a positive integer) or evidenceId is required' }, { status: 400 });
  }

  const workerRows = await db.query.workers.findMany({
    where: and(eq(workers.workspaceId, workspaceId), eq(workers.prNumber, prNumber)),
    columns: { taskId: true },
    limit: TASK_LIMIT,
  });
  const taskIds = [...new Set(workerRows.map(w => w.taskId).filter((t): t is string => !!t))];

  const scope: SQL[] = [eq(evidenceObjects.prNumber, prNumber)];
  if (taskIds.length) scope.push(inArray(evidenceObjects.taskId, taskIds), inArray(evidenceObjects.rootTaskId, taskIds));
  const rows = (await db.query.evidenceObjects.findMany({
    where: and(
      eq(evidenceObjects.workspaceId, workspaceId),
      or(...scope),
      ...(kind ? [eq(evidenceObjects.kind, kind as EvidenceKind)] : []),
    ),
    orderBy: [desc(evidenceObjects.createdAt)],
    limit: LIST_LIMIT,
  })) as EvidenceObjectRow[];

  const ids = new Set(taskIds);
  const objects = rows
    .filter(r => r.workspaceId === workspaceId
      && (r.prNumber === prNumber || (!!r.taskId && ids.has(r.taskId)) || (!!r.rootTaskId && ids.has(r.rootTaskId)))
      && (!kind || r.kind === kind))
    .map(toEvidenceObjectSummary);

  auditEvidenceRead({
    surface: 'GET /api/evidence', op: 'list', workspaceId, prNumber,
    evidenceIds: objects.map(o => o.id), actor, ...(kind ? { query: { kind } } : {}),
  });

  const body: EvidenceLookupResponse = { workspaceId, prNumber, taskIds, objects };
  return NextResponse.json(body);
}
