/**
 * POST /api/workers/[id]/answer  { waitSeconds? (0-45, default 40) }
 *
 * Backs the `await_answer` MCP action: an interactive session (claim_task from
 * a person's own session, runner = 'mcp') that parked its worker with
 * ask_human waits here for the answer. Long-polls server-side, like
 * get_pr_review, for at most 45 s (the serverless limit); a timeout comes back
 * as `timedOut: true` and the session calls again.
 *
 * The answer is read from what /respond recorded — tasks.context.answerDelivery
 * and the worker's instruction-history entry — not only from the capped
 * worker-message queue (lib/await-answer.ts). This route does not ack it: the
 * caller acks by id through PATCH /api/workers/[id] `workerMessagesDelivered`,
 * the same ack receive_messages sends, so the answer is returned once.
 *
 * Each call on a parked worker is also the session's poll heartbeat
 * (waitingFor.sessionSeenAt): a session that stops calling is treated as gone
 * by /respond, whose answer then goes cold.
 *
 * Auth: the owner of the worker (the account or session that claimed it), or a
 * per-task token for its own task.
 */
import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { tasks, workers } from '@buildd/core/db/schema';
import { authenticateTaskScopedCaller } from '@/lib/task-token-auth';
import { callerOwnsWorker } from '@/lib/worker-owner';
import { isUuid } from '@/lib/uuid';
import { recordInteractiveSessionSeen } from '@/lib/interactive-worker-liveness';
import {
  clampAwaitSeconds,
  readInteractiveAnswer,
  waitForInteractiveAnswer,
  type AnswerReadState,
} from '@/lib/await-answer';
import { INTERACTIVE_WORKER_RUNNER } from '@buildd/shared';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const notFound = () => NextResponse.json({ error: 'Worker not found' }, { status: 404 });

const WORKER_COLUMNS = {
  id: true,
  accountId: true,
  claimedByUserId: true,
  taskId: true,
  runner: true,
  status: true,
  waitingFor: true,
  instructionHistory: true,
  continuationTaskId: true,
} as const;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const apiKey = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? null;
  const account = await authenticateTaskScopedCaller(apiKey, req);
  if (!account) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  if (!isUuid(id)) return notFound();

  const first = await db.query.workers.findFirst({ where: eq(workers.id, id), columns: WORKER_COLUMNS });
  if (!first || !callerOwnsWorker(account, first)) return notFound();

  let body: { waitSeconds?: unknown } = {};
  try {
    body = (await req.json()) ?? {};
  } catch {
    // An empty or malformed body is a default wait, not an error.
  }
  const waitSeconds = clampAwaitSeconds(body.waitSeconds);

  // The heartbeat, once per call: a call holds at most 45 s, so a session that
  // calls back to back is never seen as older than one wait.
  if (first.runner === INTERACTIVE_WORKER_RUNNER && first.status === 'waiting_input') {
    await recordInteractiveSessionSeen(id);
  }

  const readTaskContext = async (taskId: string | null) => (taskId
    ? (await db.query.tasks.findFirst({ where: eq(tasks.id, taskId), columns: { context: true } }))?.context ?? null
    : null);

  let row: typeof first | undefined = first;
  let reads = 0;
  const read = async (): Promise<AnswerReadState> => {
    if (reads++ > 0) row = await db.query.workers.findFirst({ where: eq(workers.id, id), columns: WORKER_COLUMNS });
    if (!row) return { state: 'not_waiting', reasonCode: 'session_ended', message: 'This worker no longer exists.' };
    return readInteractiveAnswer({ worker: row, taskContext: await readTaskContext(row.taskId ?? null) });
  };

  const { result, timedOut } = await waitForInteractiveAnswer({ waitSeconds, read });
  return NextResponse.json({ ...result, timedOut, workerId: id });
}
