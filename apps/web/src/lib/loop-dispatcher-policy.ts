/**
 * Loops' loop-slot policy (lib/completion-policy.ts). A task with a
 * loopConfig is evaluated against its exit condition when its worker reports
 * completed: the ONLY place that evaluates the condition and advances
 * loopIteration (lib/loop-dispatcher.ts). Stale cleanup and webhooks never
 * call it.
 */
import { db } from '@buildd/core/db';
import { tasks, workers } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import type { LoopHistoryEntry } from '@buildd/shared';
import type { LoopInput, LoopVerdict } from '@/lib/completion-policy';
import { dispatchLoopIteration } from '@/lib/loop-dispatcher';

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

  const freshWorker = await db.query.workers.findFirst({
    where: eq(workers.id, input.workerId),
    columns: { prLifecycleStatus: true, prNumber: true, mergedAt: true },
  });
  const existingCtx = (loopData?.context ?? {}) as Record<string, unknown>;
  const existingHistory = (existingCtx.loopHistory as LoopHistoryEntry[] | undefined) ?? [];

  const r = dispatchLoopIteration({
    loopConfig,
    currentIteration: loopData?.loopIteration ?? 0,
    existingHistory,
    existingStartAt: loopData?.startAt ?? null,
    workerId: input.workerId,
    workerBranch: input.workerBranch,
    workerLastCommitSha: input.workerLastCommitSha,
    verificationEvidence: input.verificationEvidence,
    structuredOutput: input.structuredOutput,
    prLifecycleStatus: freshWorker?.prLifecycleStatus ?? null,
    prNumber: freshWorker?.prNumber ?? null,
    workerMergedAt: freshWorker?.mergedAt ?? null,
  });

  const progress = { iteration: r.loopIteration, history: r.loopHistory };
  if (r.kind === 'satisfied') return { kind: 'pass', progress };
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
