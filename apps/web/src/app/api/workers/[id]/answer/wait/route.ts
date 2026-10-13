/**
 * POST /api/workers/[id]/answer/wait  { waitSeconds? (0-45, default 40) }
 * Header: x-buildd-wait-cap: <wait capability>
 *
 * What ask_human's `waitCommand` calls from a plain shell, so an interactive
 * session can wait for its answer in a background command at no model cost
 * (docs/specs/answered-question-resume.md). The only credential accepted is
 * the wait capability ask_human minted (lib/answer-wait-capability.ts): one
 * worker, one ask, expiring with the park. No API key, OAuth token or task
 * token is read here.
 *
 * Answers status only, never the answer or the question:
 *   200 { answered: true, state: 'answered' }        the session reads it with await_answer
 *   200 { answered: false, state: 'waiting', retryAfter }   long-poll ran out; call again
 *   200 { answered: false, state: 'ended', reason }   the worker ended
 *   401 { error, reason }   no / bad / expired capability, or 'superseded': a newer
 *                           ask replaced this question, or its answer was already read
 *   403 not an interactive worker; 404 no such worker
 *
 * Long-polls like await_answer (45 s clamp), bounded by the capability's
 * expiry. Each call on a parked worker is the session's poll heartbeat
 * (recordInteractiveSessionSeen), which never moves the park clock.
 */
import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { tasks, workers } from '@buildd/core/db/schema';
import { isUuid } from '@/lib/uuid';
import { recordInteractiveSessionSeen } from '@/lib/interactive-worker-liveness';
import { clampAwaitSeconds, waitForInteractiveAnswer } from '@/lib/await-answer';
import {
  ANSWER_WAIT_CAP_HEADER,
  answerWaitStatus,
  verifyAnswerWaitCapability,
  type AnswerWaitStatus,
} from '@/lib/answer-wait-capability';
import { sqlWhere } from '@buildd/core/db/relational-sql';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const WORKER_COLUMNS = {
  id: true,
  taskId: true,
  runner: true,
  status: true,
  waitingFor: true,
  instructionHistory: true,
  continuationTaskId: true,
} as const;

const refused = (reason: string) => NextResponse.json({ error: 'invalid_wait_capability', reason }, { status: 401 });

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: 'Worker not found', reason: 'gone' }, { status: 404 });

  const cap = verifyAnswerWaitCapability(req.headers.get(ANSWER_WAIT_CAP_HEADER), id);
  if (!cap.ok) return refused(cap.reason);

  let body: { waitSeconds?: unknown } = {};
  try {
    body = (await req.json()) ?? {};
  } catch {
    // An empty or malformed body is a default wait.
  }
  const untilExpiry = Math.max(0, (cap.expiresAt - Date.now()) / 1000);
  const waitSeconds = Math.min(clampAwaitSeconds(body.waitSeconds), untilExpiry);

  const loadWorker = () => db.query.workers.findFirst({ where: sqlWhere(eq(workers.id, id)), columns: WORKER_COLUMNS });
  const readStatus = async (row: Awaited<ReturnType<typeof loadWorker>>): Promise<AnswerWaitStatus | null> => {
    if (!row) return null;
    const taskContext = row.taskId
      ? (await db.query.tasks.findFirst({ where: sqlWhere(eq(tasks.id, row.taskId)), columns: { context: true } }))?.context ?? null
      : null;
    return answerWaitStatus({ worker: row, taskContext, askId: cap.askId });
  };

  const first = await loadWorker();
  if (!first) return NextResponse.json({ error: 'Worker not found', reason: 'gone' }, { status: 404 });
  let status = await readStatus(first);
  if (status?.state === 'not_interactive') {
    return NextResponse.json({ error: 'not_interactive', reason: 'not_interactive' }, { status: 403 });
  }

  if (status?.state === 'waiting') {
    // The heartbeat, once per call (a call holds at most 45 s).
    await recordInteractiveSessionSeen(id);
    let reads = 0;
    await waitForInteractiveAnswer({
      waitSeconds,
      read: async () => {
        if (reads++ > 0) status = await readStatus(await loadWorker());
        return status?.state === 'waiting'
          ? { state: 'waiting' }
          : { state: 'not_waiting', reasonCode: 'no_question', message: '' };
      },
    });
  }

  if (!status) return NextResponse.json({ error: 'Worker not found', reason: 'gone' }, { status: 404 });
  switch (status.state) {
    case 'answered':
      return NextResponse.json({ answered: true, state: 'answered' });
    case 'waiting':
      return NextResponse.json({ answered: false, state: 'waiting', retryAfter: 1 });
    case 'ended':
      return NextResponse.json({ answered: false, state: 'ended', reason: status.reason });
    default:
      return refused('superseded');
  }
}
