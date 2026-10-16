/**
 * POST /api/cron/waiting-input-sweep
 *
 * Declared trigger for the `waiting_input` reclaim sweep.
 *
 * A worker that asks the user a question and never gets an answer sits in
 * `waiting_input` forever. `cleanupStuckWaitingInput` is what reclaims it:
 * 4 hours for mission tasks, 24 hours for standalone ones. Until this route
 * existed, that sweep had exactly one non-test caller — `POST /api/tasks/cleanup`
 * — whose only automatic driver was each runner's own 30-minute cleanup timer
 * (apps/runner/src/workers.ts). Two consequences:
 *
 *   1. The sweep was global (no accountId), so one healthy runner on any account
 *      fired the timeout for every other tenant's waiting workers. That is fixed
 *      in lib/stale-workers.ts by making `accountId` a required argument.
 *   2. With the sweep correctly scoped, an account whose runners are ALL down has
 *      nothing to reclaim its stuck workers — which is exactly the situation the
 *      timeout exists for. A runner-driven timeout cannot be the only trigger for
 *      a timeout about runners being unavailable.
 *
 * This route closes (2): it resolves the accounts that actually have candidate
 * workers and calls the account-scoped sweep once per account, so coverage no
 * longer depends on any runner being alive. It is origin-scoped under /api/cron/
 * and therefore declared in cron-manifest.json, which `scripts/cron-coverage.test.ts`
 * enforces — a trigger that silently stops firing is a reviewable diff.
 *
 * Auth: Bearer CRON_SECRET (the external scheduler cannot send `x-vercel-cron`,
 * and Vercel-native crons do not fire in this project).
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workers } from '@buildd/core/db/schema';
import { and, eq, isNotNull, lt, or } from 'drizzle-orm';
import { INTERACTIVE_WORKER_RUNNER } from '@buildd/shared';
import { cleanupStuckWaitingInput, cleanupUnreadInteractiveAnswers, cleanupUnresumedAnswers } from '@/lib/stale-workers';
import { INTERACTIVE_ANSWER_READ_DEADLINE_MS } from '@/lib/answer-resume';
import { withCronRun, type CronReport } from '@/lib/cron-run';
import { sqlWhere } from '@buildd/core/db/relational-sql';

export const maxDuration = 60;

/**
 * Candidate pre-filter: the FINEST threshold the sweep itself applies
 * (WAITING_INPUT_MISSION_STALE_MS = 4h). Anything younger cannot be reclaimed by
 * either threshold, so there is no point waking the per-account sweep for it.
 * The real 4h/24h decision stays in cleanupStuckWaitingInput — this only picks
 * which accounts are worth a pass.
 */
const CANDIDATE_CUTOFF_MS = 4 * 60 * 60 * 1000;

export async function POST(req: NextRequest) {
  return withCronRun('waiting-input-sweep', req, report => runCronJob(req, report));
}

async function runCronJob(req: NextRequest, report: CronReport): Promise<NextResponse> {

  const cutoff = new Date(Date.now() - CANDIDATE_CUTOFF_MS);

  const candidates = await db.query.workers.findMany({
    where: sqlWhere(and(eq(workers.status, 'waiting_input'), lt(workers.updatedAt, cutoff))),
    columns: { accountId: true },
  });

  const accountIds = [
    ...new Set(candidates.map(w => w.accountId).filter(Boolean)),
  ] as string[];

  let failedWorkers = 0;
  let retriedTasks = 0;
  let errors = 0;

  for (const accountId of accountIds) {
    try {
      const result = await cleanupStuckWaitingInput(accountId);
      failedWorkers += result.failedWorkers;
      retriedTasks += result.retriedTasks;
    } catch (err) {
      // Non-fatal: one account's bad row must not starve every other account.
      errors++;
      console.error(`[Cron] waiting-input-sweep failed for account ${accountId}:`, err);
    }
  }

  // Answers nobody has read: one queued for a parked runner session that never
  // acknowledged it (cleanupUnresumedAnswers), or one sent back to an
  // interactive session that went quiet (cleanupUnreadInteractiveAnswers).
  // Both sweeps otherwise run only from a runner's own cleanup timer, which is
  // exactly what is missing when the account's runners are down. The
  // pre-filter is loose on purpose; the deadlines live in the sweeps.
  const answerCandidates = await db.query.workers.findMany({
    where: sqlWhere(or(
      and(eq(workers.status, 'waiting_input'), isNotNull(workers.pendingInstructions)),
      and(
        eq(workers.status, 'running'),
        eq(workers.runner, INTERACTIVE_WORKER_RUNNER),
        lt(workers.updatedAt, new Date(Date.now() - INTERACTIVE_ANSWER_READ_DEADLINE_MS)),
      ),
    )),
    columns: { accountId: true },
  });
  const answerAccountIds = [
    ...new Set(answerCandidates.map(w => w.accountId).filter(Boolean)),
  ] as string[];

  let answersDegraded = 0;
  for (const accountId of answerAccountIds) {
    try {
      answersDegraded += (await cleanupUnresumedAnswers(accountId)).degraded;
      answersDegraded += (await cleanupUnreadInteractiveAnswers(accountId)).degraded;
    } catch (err) {
      errors++;
      console.error(`[Cron] waiting-input-sweep answer sweep failed for account ${accountId}:`, err);
    }
  }

  console.log(
    `[Cron] waiting-input-sweep: accounts=${accountIds.length} failedWorkers=${failedWorkers} retriedTasks=${retriedTasks} answerAccounts=${answerAccountIds.length} answersDegraded=${answersDegraded} errors=${errors}`,
  );

  const result = { accountsSwept: accountIds.length, failedWorkers, retriedTasks, answerAccountsSwept: answerAccountIds.length, answersDegraded, errors };
  // Nothing stuck is the normal, healthy state, so changed=0 with errors=0 is
  // fine. Reclaiming a worker, retrying a task or moving an answer is the real work.
  report({ processed: accountIds.length + answerAccountIds.length, changed: failedWorkers + retriedTasks + answersDegraded, errors, result });
  return NextResponse.json(result);
}
