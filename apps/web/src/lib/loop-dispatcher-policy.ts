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

/**
 * 92a439a6: kernel delivery states where the PR's next move is the kernel's (a review, a repair,
 * the landing), not the owner session's. Another owner session has nothing to do there.
 */
const KERNEL_OWNS_NEXT_MOVE = new Set(['AWAITING_REVIEW', 'REPAIRING', 'LANDING', 'APPROVED', 'BLOCKED_ON_TRUNK']);

/** The kernel delivery this loop task owns (null = none, or released to legacy). Never throws. */
async function ownerDelivery(task: { deliveryId?: string | null; deliveryRole?: string | null }): Promise<{ state: string; prNumber: number | null; mergedAt: string | null } | null> {
  if (!task.deliveryId || task.deliveryRole !== 'owner') return null;
  try {
    const { kernelDeliveryById } = await import('@/lib/workflow/authority');
    const id = await kernelDeliveryById(task.deliveryId);
    if (!id) return null;
    const { loadView } = await import('@/lib/workflow/kernel');
    const d = (await loadView({ deliveryId: id })).delivery;
    return d ? { state: d.state, prNumber: d.prNumber, mergedAt: d.mergedAt } : null;
  } catch {
    return null;
  }
}

export async function loopPolicy(input: LoopInput): Promise<LoopVerdict> {
  const [loopData] = await db
    .select({
      loopConfig: tasks.loopConfig,
      loopIteration: tasks.loopIteration,
      loopState: tasks.loopState,
      startAt: tasks.startAt,
      context: tasks.context,
      deliveryId: tasks.deliveryId,
      deliveryRole: tasks.deliveryRole,
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
  // 92a439a6: a PR condition on a kernel owner reads the delivery too. MERGED satisfies it; while the
  // kernel owns the next move the loop holds for it below instead of spending an iteration.
  const prCondition = loopConfig.exitCondition.type === 'pr_checks_green' || loopConfig.exitCondition.type === 'pr_merged';
  const delivery = prCondition && !shipped ? await ownerDelivery(loopData ?? {}) : null;
  const deliveryMerged = delivery?.state === 'MERGED';
  const prNumber = shipped ?? prWorker?.prNumber ?? delivery?.prNumber ?? null;
  const prLifecycleStatus = shipped || deliveryMerged ? 'merged' : prWorker?.prLifecycleStatus ?? null;

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
    workerMergedAt: shipped ? new Date() : prWorker?.mergedAt ?? (deliveryMerged ? new Date(delivery!.mergedAt ?? Date.now()) : null),
  });

  const progress = { iteration: r.loopIteration, history: r.loopHistory };
  if (r.kind === 'satisfied') return { kind: 'pass', progress };

  /** Wait for the webhook: no iteration spent, startAt pushed to the wait expiry so no runner claims it first. */
  const webhookHold = (wait: Record<string, unknown>): LoopVerdict => {
    const now = new Date();
    const waitExpiryMinutes = loopConfig.waitExpiryMinutes ?? 240;
    return {
      kind: 'hold',
      until: 'webhook',
      progress: { iteration: currentIteration, history: existingHistory },
      startAt: laterStartAt(loopData?.startAt ?? null, new Date(now.getTime() + waitExpiryMinutes * 60_000)),
      retryContext: {
        ...existingCtx,
        loopWebhookWait: { prNumber, since: now.toISOString(), ...wait },
        ...(input.workerBranch ? { resumeBranch: input.workerBranch } : {}),
        ...(input.workerLastCommitSha ? { lastCommitSha: input.workerLastCommitSha } : {}),
      },
    };
  };
  // 92a439a6: the kernel is reviewing, repairing or landing this PR. An owner session that
  // completes meanwhile (a requeue with nothing to do) spends nothing, however often it happens:
  // the merge or check_suite webhook (lib/loop-webhook.ts) settles the loop. Unlike the CI wait
  // below, not once per PR: each completion while the kernel owns the PR is the same wait.
  if (delivery && KERNEL_OWNS_NEXT_MOVE.has(delivery.state)) return webhookHold({ deliveryState: delivery.state });

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
    return webhookHold({});
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
