import { NextRequest, NextResponse } from 'next/server';
import { isUuid } from '@/lib/uuid';
import { db } from '@buildd/core/db';
import { evidenceObjects, workers } from '@buildd/core/db/schema';
import { and, eq } from 'drizzle-orm';
import { authenticateTaskScopedCaller, taskScopeAllowsWorker } from '@/lib/task-token-auth';
import { confirmEvidenceUpload } from '@/lib/evidence-confirm';
import type { EvidenceObjectRow } from '@/lib/evidence-read';

/**
 * POST /api/workers/[id]/evidence/[evidenceId]/confirm
 *
 * The runner calls this after a 2xx PUT to the URL evidence-upload-url signed.
 * The server HEADs the object on the row's own backend and settles the row:
 * `stored` when it exists with the signed size, `failed` when it is missing or
 * a different size (see lib/evidence-confirm.ts). Until then the row is
 * `pending` and the read routes refuse it.
 *
 * Authorization matches evidence-upload-url: the caller's account owns the
 * worker and shares its team (a per-task token: the worker on its own task),
 * and the evidence row must be this worker's.
 *
 * Idempotent: a row that is no longer pending is reported as it stands.
 * Never a 5xx: a bucket that cannot be checked right now is a 424 and the row
 * stays pending (the indexer's reaper settles it later).
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; evidenceId: string }> }
) {
  const { id, evidenceId } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: 'Worker not found' }, { status: 404 });
  }
  if (!isUuid(evidenceId)) {
    return NextResponse.json({ error: 'Evidence object not found' }, { status: 404 });
  }

  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const account = await authenticateTaskScopedCaller(apiKey, req);
  if (!account) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const worker = await db.query.workers.findFirst({
      where: eq(workers.id, id),
      columns: { id: true, accountId: true, workspaceId: true, taskId: true },
      with: { workspace: { columns: { teamId: true } } },
    });
    if (!worker) {
      return NextResponse.json({ error: 'Worker not found' }, { status: 404 });
    }
    if (!worker.accountId || worker.accountId !== account.id || !taskScopeAllowsWorker(account, worker)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    if (!worker.workspaceId || !worker.workspace?.teamId || worker.workspace.teamId !== account.teamId) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const row = (await db.query.evidenceObjects.findFirst({
      where: and(eq(evidenceObjects.id, evidenceId), eq(evidenceObjects.workerId, worker.id)),
    })) as EvidenceObjectRow | undefined;
    // Checked on the row too: the predicate is the scope, this is the proof.
    if (!row || row.id !== evidenceId || row.workerId !== worker.id) {
      return NextResponse.json({ error: 'Evidence object not found' }, { status: 404 });
    }

    const result = await confirmEvidenceUpload(row);
    const body = {
      evidenceId,
      uploadState: result.uploadState,
      bytes: result.bytes,
      ...(result.reason ? { reason: result.reason } : {}),
    };
    return NextResponse.json(body, { status: result.uploadState === 'pending' ? 424 : 200 });
  } catch {
    return NextResponse.json({ error: 'Evidence storage unavailable', evidenceId, uploadState: 'pending' }, { status: 424 });
  }
}
