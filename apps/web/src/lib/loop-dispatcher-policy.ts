/**
 * Loops' loop-slot policy (lib/completion-policy.ts). A task with a
 * loopConfig is evaluated against its exit condition when its worker reports
 * completed: the ONLY place that evaluates the condition and advances
 * loopIteration (lib/loop-dispatcher.ts). Stale cleanup and webhooks never
 * call it.
 */
import { db } from '@buildd/core/db';
import { tasks, workers } from '@buildd/core/db/schema';
import { and, desc, eq, isNotNull } from 'drizzle-orm';
import type { LoopHistoryEntry } from '@buildd/shared';
import type { LoopInput, LoopVerdict } from '@/lib/completion-policy';
import { dispatchLoopIteration } from '@/lib/loop-dispatcher';
import { laterStartAt } from '@/lib/deferred-start';
import { sqlOrderBy, sqlWhere } from '@buildd/core/db/relational-sql';

/** PR states where CI has not reported yet: a check_suite webhook is still coming. */
const CHECKS_PENDING = new Set<string | null>([null, 'pr_open', 'ci_running']);

export async function loopPolicy(input: LoopInput): Promise<LoopVerdict> {
  const [loopData] = await db
    .select({
      loopConfig: tasks.loopConfig,
      loopIteration: tasks.loopIteration,
      loopState: tasks.loopState,
      startAt: tasks.startAt,
      context: tasks.context,
    })
    .from(tasks)
    .where(eq(tasks.id, input.taskId))
    .limit(1);
  const loopConfig = loopData?.loopConfig ?? null;
  if (!loopConfig) return null;

  const prColumns = { prLifecycleStatus: true, prNumber: true, mergedAt: true } as const;
  let prWorker = await db.query.workers.findFirst({
    where: sqlWhere(eq(workers.id, input.workerId)),
    columns: prColumns,
  });
  // A later session on the same task (a requeue, an interactive pickup) often
  // opens no PR of its own: the task's PR is the one an earlier worker opened.
  if (!prWorker?.prNumber) {
    prWorker = (await db.query.workers.findFirst({
      where: sqlWhere(and(eq(workers.taskId, input.taskId), isNotNull(workers.prNumber))),
      orderBy: sqlOrderBy(desc(workers.createdAt)),
      columns: prColumns,
    })) ?? prWorker;
  }
  const shipped = input.alreadyShippedPrNumber ?? null;
  const existingCtx = (loopData?.context ?? {}) as Record<string, unknown>;
  const existingHistory = (existingCtx.loopHistory as LoopHistoryEntry[] | undefined) ?? [];
  const currentIteration = loopData?.loopIteration ?? 0;
  const prNumber = shipped ?? prWorker?.prNumber ?? null;
  const prLifecycleStatus = shipped ? 'merged' : prWorker?.prLifecycleStatus ?? null;

  const r = dispatchLoopIteration({
    loopConfig,
    currentIteration,
    existingHistory,
    existingStartAt: loopData?.startAt ?? null,
    workerId: input.workerId,
    workerBranch: input.workerBranch,
    workerLastCommitSha: input.workerLastCommitSha,
    verificationEvidence: input.verificationEvidence,
    structuredOutput: input.structuredOutput,
    // A PR verified merged via alreadyShippedIn satisfies pr_checks_green /
    // pr_merged even though this worker never owned it.
    prLifecycleStatus,
    prNumber,
    workerMergedAt: shipped ? new Date() : prWorker?.mergedAt ?? null,
  });

  const progress = { iteration: r.loopIteration, history: r.loopHistory };
  if (r.kind === 'satisfied') return { kind: 'pass', progress };

  // pr_checks_green with a PR whose CI has not reported: nothing for another
  // session to do, so wait for the check_suite / merge webhook
  // (lib/loop-webhook.ts) instead of spending an attempt. The attempt count and
  // history stay as they were, and startAt is pushed out to the wait expiry so
  // no runner claims the task first. Once per PR: if the task comes back from
  // that wait still pending, it is evaluated normally and does spend one.
  const priorWait = existingCtx.loopWebhookWait as { prNumber?: number } | undefined;
  if (
    loopConfig.exitCondition.type === 'pr_checks_green' &&
    prNumber != null &&
    CHECKS_PENDING.has(prLifecycleStatus) &&
    priorWait?.prNumber !== prNumber
  ) {
    const now = new Date();
    const waitExpiryMinutes = loopConfig.waitExpiryMinutes ?? 240;
    return {
      kind: 'hold',
      until: 'webhook',
      progress: { iteration: currentIteration, history: existingHistory },
      startAt: laterStartAt(loopData?.startAt ?? null, new Date(now.getTime() + waitExpiryMinutes * 60_000)),
      retryContext: {
        ...existingCtx,
        loopWebhookWait: { prNumber, since: now.toISOString() },
        ...(input.workerBranch ? { resumeBranch: input.workerBranch } : {}),
        ...(input.workerLastCommitSha ? { lastCommitSha: input.workerLastCommitSha } : {}),
      },
    };
  }

  if (r.kind === 'exhausted') {
    return { kind: 'fail', reason: `Loop condition unmet after ${r.loopIteration} attempt(s)`, progress };
  }
  return {
    kind: 'hold',
    until: 'requeue',
    progress,
    startAt: r.effectiveStartAt,
    // The next attempt resumes the same branch and reads why the last one fell short.
    retryContext: {
      ...existingCtx,
      loopHistory: r.loopHistory,
      ...(r.resumeBranch ? { resumeBranch: r.resumeBranch } : {}),
      ...(r.lastCommitSha ? { lastCommitSha: r.lastCommitSha } : {}),
      failureContext: r.failureContext,
    },
  };
}
