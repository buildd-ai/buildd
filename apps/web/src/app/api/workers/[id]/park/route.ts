/**
 * POST   /api/workers/[id]/park   mark a worker parked by a cloud --once runner
 * DELETE /api/workers/[id]/park   clear the mark
 *
 * docs/design/cloudflare-sandbox-runner.md, Phase 2 "Resumable runs". The
 * runner POSTs after it has uploaded the park bundle (branch, uncommitted
 * work, transcript, worker record) and just before it exits with code 4. The
 * server picks the expiry: park time + 24 h, or 4 h for a mission task (the
 * waiting_input timeouts), so the existing cleanupStuckWaitingInput path takes
 * over unchanged once it passes. While parked, the worker satisfies the answer
 * path's freshness gate (answer-resume.ts) and is exempt from the offline-
 * runner sweep (stale-workers.ts).
 *
 * DELETE is the restore-failure path: a resume that cannot apply the bundle
 * clears the park and exits without re-attaching, and the queued answer is
 * degraded by cleanupUnresumedAnswers into the cold continuation it would
 * have been.
 *
 * Auth: the runner API key of the account that owns the worker, or the
 * per-task token of that worker's task (confined to that task's worker).
 */
import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { workers } from '@buildd/core/db/schema';
import { authenticateTaskScopedCaller } from '@/lib/task-token-auth';
import { callerOwnsWorker } from '@/lib/worker-owner';
import { isUuid } from '@/lib/uuid';
import { parkWhere, parkedUntilFor, unparkWhere } from '@/lib/worker-park';

export const dynamic = 'force-dynamic';

async function authorize(req: NextRequest) {
  const apiKey = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? null;
  const account = await authenticateTaskScopedCaller(apiKey, req);
  if (!account) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  if (account.level === 'trigger') return { error: NextResponse.json({ error: 'Trigger tokens cannot park workers' }, { status: 403 }) };
  return { account };
}

const notFound = () => NextResponse.json({ error: 'Worker not found' }, { status: 404 });

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authorize(req);
  if ('error' in auth) return auth.error;
  const { account } = auth;
  const { id } = await params;
  if (!isUuid(id)) return notFound();

  const worker = await db.query.workers.findFirst({
    where: eq(workers.id, id),
    columns: { id: true, accountId: true, claimedByUserId: true, workspaceId: true, taskId: true, status: true },
    with: { task: { columns: { missionId: true } } },
  });
  if (!worker || !callerOwnsWorker(account, worker)) return notFound();

  const now = new Date();
  const until = parkedUntilFor(now, !!(worker as { task?: { missionId?: string | null } | null }).task?.missionId);
  const [parked] = await db
    .update(workers)
    .set({ parkedUntil: until, updatedAt: now })
    .where(parkWhere(id, account))
    .returning({ id: workers.id, parkedUntil: workers.parkedUntil });
  if (!parked) return NextResponse.json({ error: 'not_parkable', status: worker.status }, { status: 409 });
  return NextResponse.json({ parkedUntil: until.toISOString() });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authorize(req);
  if ('error' in auth) return auth.error;
  const { id } = await params;
  if (!isUuid(id)) return notFound();
  const [cleared] = await db
    .update(workers)
    .set({ parkedUntil: null })
    .where(unparkWhere(id, auth.account))
    .returning({ id: workers.id });
  if (!cleared) return notFound();
  return NextResponse.json({ ok: true });
}
