/**
 * POST /api/workers/[id]/answer/capability
 *
 * ask_human's second call: mint the wait capability for the question this
 * interactive worker has open now, plus the shell command that uses it
 * (lib/answer-wait-capability.ts, docs/specs/answered-question-resume.md).
 *
 * Minting stamps a fresh ask id on the live question
 * (`waitingFor.waitCapId`, a jsonb_set gated on the worker still being parked,
 * so it never resurrects an answered question and never moves `updated_at`,
 * the park clock). The capability is bound to that id, so minting again, or a
 * new ask, retires the previous one. It expires with the park: park time +
 * 24 h, 4 h for a mission task (the waiting_input sweep's deadlines).
 *
 * Auth: the owner of the worker (the account or session that claimed it), or
 * a per-task token for its own task.
 */
import { NextRequest, NextResponse } from 'next/server';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { tasks, workers } from '@buildd/core/db/schema';
import { INTERACTIVE_WORKER_RUNNER } from '@buildd/shared';
import { authenticateTaskScopedCaller } from '@/lib/task-token-auth';
import { callerOwnsWorker } from '@/lib/worker-owner';
import { isUuid } from '@/lib/uuid';
import { appBaseUrl } from '@/lib/app-url';
import { parkedUntilFor } from '@/lib/worker-park';
import {
  answerWaitSigningAvailable,
  buildAnswerWaitCommand,
  newWaitAskId,
  signAnswerWaitCapability,
} from '@/lib/answer-wait-capability';
import { sqlWhere } from '@buildd/core/db/relational-sql';

export const dynamic = 'force-dynamic';

const notFound = () => NextResponse.json({ error: 'Worker not found' }, { status: 404 });
const noQuestion = () => NextResponse.json({ error: 'no_open_question', message: 'This worker has no open question to wait on: ask with ask_human first.' }, { status: 409 });

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const apiKey = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? null;
  const account = await authenticateTaskScopedCaller(apiKey, req);
  if (!account) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  if (!isUuid(id)) return notFound();

  const worker = await db.query.workers.findFirst({
    where: sqlWhere(eq(workers.id, id)),
    columns: { id: true, accountId: true, claimedByUserId: true, workspaceId: true, taskId: true, runner: true, status: true, waitingFor: true },
  });
  if (!worker || !callerOwnsWorker(account, worker)) return notFound();
  if (worker.runner !== INTERACTIVE_WORKER_RUNNER) {
    return NextResponse.json({ error: 'not_interactive', message: 'A runner-managed worker is resumed by its runner; there is nothing to wait on from a shell.' }, { status: 403 });
  }
  if (worker.status !== 'waiting_input' || !worker.waitingFor) return noQuestion();
  if (!answerWaitSigningAvailable()) {
    return NextResponse.json({ error: 'wait_capability_unavailable', message: 'This server cannot sign wait capabilities; wait with await_answer.' }, { status: 503 });
  }

  const askId = newWaitAskId();
  const [stamped] = await db.update(workers)
    .set({
      waitingFor: sql`jsonb_set(${workers.waitingFor}, '{waitCapId}', to_jsonb(${askId}::text))` as any,
    })
    .where(and(
      eq(workers.id, id),
      eq(workers.runner, INTERACTIVE_WORKER_RUNNER),
      eq(workers.status, 'waiting_input'),
      sql`${workers.waitingFor} IS NOT NULL`,
    ))
    .returning({ updatedAt: workers.updatedAt, taskId: workers.taskId });
  if (!stamped) return noQuestion();

  const task = stamped.taskId
    ? await db.query.tasks.findFirst({ where: sqlWhere(eq(tasks.id, stamped.taskId)), columns: { missionId: true } })
    : null;
  const expiresAt = parkedUntilFor(new Date(stamped.updatedAt), !!task?.missionId).getTime();
  if (expiresAt <= Date.now()) return noQuestion();

  const capability = signAnswerWaitCapability({ workerId: id, askId, expiresAt });
  if (!capability) {
    return NextResponse.json({ error: 'wait_capability_unavailable', message: 'This server cannot sign wait capabilities; wait with await_answer.' }, { status: 503 });
  }
  const waitUrl = `${appBaseUrl()}/api/workers/${id}/answer/wait`;
  return NextResponse.json({
    capability,
    waitUrl,
    waitCommand: buildAnswerWaitCommand({ waitUrl, capability, expiresAt }),
    expiresAt: new Date(expiresAt).toISOString(),
  });
}
