/**
 * POST /api/workers/[id]/reattach
 *
 * A cloud --once runner started with `--resume-worker <id>` takes over a
 * worker that an earlier container parked (docs/design/cloudflare-sandbox-
 * runner.md, Phase 2 "Resumable runs"). One atomic
 *
 *   UPDATE workers SET parked_until = NULL, updated_at = now()
 *   WHERE id = $1 AND account_id = <caller> AND status IN ('waiting_input', 'running')
 *     AND parked_until > now()
 *   RETURNING ...
 *
 * Zero rows is a refusal (409): already re-attached, expired, never parked,
 * not yours. It never creates a worker row, so the claim route's live-worker
 * guard keeps meaning "one live run per task". Auth: the runner API key of the
 * account that owns the worker, or the per-task token of that worker's task.
 */
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workers } from '@buildd/core/db/schema';
import { authenticateTaskScopedCaller } from '@/lib/task-token-auth';
import { isUuid } from '@/lib/uuid';
import { reattachWhere } from '@/lib/worker-park';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const apiKey = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? null;
  // A per-task token may take over only its own task's worker (reattachWhere's taskId).
  const account = await authenticateTaskScopedCaller(apiKey);
  if (!account) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (account.level === 'trigger') return NextResponse.json({ error: 'Trigger tokens cannot re-attach workers' }, { status: 403 });

  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: 'Worker not found' }, { status: 404 });

  const now = new Date();
  const [worker] = await db
    .update(workers)
    .set({ parkedUntil: null, updatedAt: now })
    .where(reattachWhere(id, account.id, now, account.taskScope?.taskId))
    .returning({ id: workers.id, taskId: workers.taskId, status: workers.status });

  if (!worker) {
    return NextResponse.json(
      { error: 'not_parked', message: 'This worker is not parked for your account (already re-attached, expired, or never parked).' },
      { status: 409 },
    );
  }
  return NextResponse.json({ worker });
}
