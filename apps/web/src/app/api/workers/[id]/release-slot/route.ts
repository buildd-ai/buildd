/**
 * POST /api/workers/[id]/release-slot
 *
 * Free the slot an interactive (claim_task, runner = 'mcp') worker holds. The
 * session runs on someone's own machine, so buildd cannot stop it; this only
 * detaches the worker row: out of the live set, its concurrency seat and path
 * claims released. A terminal task keeps its status and its PR. An open task
 * goes back to pending. Idempotent: a repeat answers `released: false`.
 *
 * Runner-backed workers are refused (400): "Stop agent" reaches them.
 *
 * Auth: signed-in user holding force_reassign_task in the worker's team
 * (owner/admin by default). Body (optional): { reason?: string }.
 */
import { NextRequest, NextResponse } from 'next/server';
import { isUuid } from '@/lib/uuid';
import { db } from '@buildd/core/db';
import { workers } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { holdsInWorkspace } from '@/lib/team-access';
import { detachInteractiveWorker } from '@/lib/interactive-detach';
import { isInteractiveWorker } from '@/lib/interactive-worker-liveness';

export const dynamic = 'force-dynamic';

const MAX_REASON = 200;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  // A non-simple request, so another origin cannot fire it from a plain form.
  if (!req.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    return NextResponse.json({ error: 'Content-Type must be application/json' }, { status: 415 });
  }

  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: 'Worker not found' }, { status: 404 });
  }

  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const rawReason = typeof body?.reason === 'string' ? body.reason.trim() : '';
  const reason = rawReason ? rawReason.slice(0, MAX_REASON) : 'released from the task page';

  const worker = await db.query.workers.findFirst({
    where: eq(workers.id, id),
    columns: { id: true, workspaceId: true, runner: true },
  });
  if (!worker) {
    return NextResponse.json({ error: 'Worker not found' }, { status: 404 });
  }

  if (!(await holdsInWorkspace(user.id, worker.workspaceId, 'force_reassign_task'))) {
    return NextResponse.json({ error: 'Only a team owner or admin can release a slot' }, { status: 403 });
  }

  if (!isInteractiveWorker(worker.runner)) {
    return NextResponse.json({ error: 'This agent runs on a runner. Use Stop agent instead.' }, { status: 400 });
  }

  const result = await detachInteractiveWorker({
    workerId: id,
    actor: { kind: 'user', userId: user.id, label: user.name || 'a team admin' },
    reason,
  });

  return NextResponse.json({
    ok: true,
    released: result.detached,
    workerStatus: result.workerStatus ?? null,
    taskStatus: result.taskStatus ?? null,
  });
}
