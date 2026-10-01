import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { verifyWorkspaceAccess } from '@/lib/team-access';
import { isUuid } from '@/lib/uuid';
import {
  EvidenceReadError, auditEvidenceRead, findTaskEvidenceObject, generateEvidenceDownloadUrl,
} from '@/lib/evidence-read';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store, max-age=0' };
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

// GET /api/evidence/download?taskId=&evidenceId=
//   The dashboard's per-click download of one stored evidence object: a
//   presigned GET on the object's own backend, valid for minutes.
//
//   Session only. An API key is not accepted (it is never even looked up), and
//   this route is in no chat registry, CHAT_ROUTES entry or MCP action: chat
//   and agents read evidence as redacted text through
//   GET /api/tasks/[id]/evidence and never see a bucket URL
//   (docs/specs/byo-evidence-storage.md, "Read paths").
//
//   Returns JSON { url, expiresAt, filename } rather than a redirect, so the
//   page can show a refusal (409 not stored, 410 gone, 502 backend) inline
//   next to the row instead of navigating to a bare error body, and so the
//   link is minted only when the person clicks, never prefetched with the page.
export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return json({ error: 'Unauthorized' }, 401);

  const sp = req.nextUrl.searchParams;
  const taskId = sp.get('taskId') ?? '';
  const evidenceId = sp.get('evidenceId') ?? '';
  if (!isUuid(taskId) || !isUuid(evidenceId)) {
    return json({ error: 'taskId and evidenceId must be full UUIDs' }, 400);
  }

  const task = await db.query.tasks.findFirst({
    where: eq(tasks.id, taskId),
    columns: { id: true, workspaceId: true },
  });
  if (!task || !(await verifyWorkspaceAccess(user.id, task.workspaceId))) {
    return json({ error: 'Task not found' }, 404);
  }

  const row = await findTaskEvidenceObject({ id: task.id, workspaceId: task.workspaceId }, evidenceId);
  if (!row) return json({ error: 'Evidence object not found for this task' }, 404);

  let link;
  try {
    link = await generateEvidenceDownloadUrl(row);
  } catch (err) {
    if (err instanceof EvidenceReadError) return json({ error: err.message, evidenceId }, err.status);
    console.error('[evidence-download] sign failed:', err instanceof Error ? err.message : err);
    return json({ error: 'could not create a download link', evidenceId }, 502);
  }

  auditEvidenceRead({
    surface: 'GET /api/evidence/download', op: 'download', workspaceId: task.workspaceId, taskId: task.id,
    evidenceIds: [row.id], actor: { userId: user.id }, bytesReturned: 0,
  });
  return json(link);
}
