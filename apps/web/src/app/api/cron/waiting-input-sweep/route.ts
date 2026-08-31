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
import { and, eq, lt } from 'drizzle-orm';
import { cleanupStuckWaitingInput } from '@/lib/stale-workers';

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
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (token !== cronSecret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const cutoff = new Date(Date.now() - CANDIDATE_CUTOFF_MS);

  const candidates = await db.query.workers.findMany({
    where: and(eq(workers.status, 'waiting_input'), lt(workers.updatedAt, cutoff)),
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

  console.log(
    `[Cron] waiting-input-sweep: accounts=${accountIds.length} failedWorkers=${failedWorkers} retriedTasks=${retriedTasks} errors=${errors}`,
  );

  return NextResponse.json({
    accountsSwept: accountIds.length,
    failedWorkers,
    retriedTasks,
    errors,
  });
}
