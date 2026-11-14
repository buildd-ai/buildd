/**
 * A review held by a usage wall (provider-failover spec, "A usage wall is a
 * wait"): the reviewer task is back in the queue until the reset, and the
 * PR's `Buildd / Review approval` status says so — pending, with the cause and
 * the time — never "review unavailable" or "a person has to decide".
 *
 * The worker PATCH route calls this from its budget branch. The kernel hears
 * nothing about a walled review (no attempt ended), so this write is what
 * replaces the head's "waiting for its review" line until the review reruns
 * and the kernel publishes its verdict.
 */
import { githubApi } from '@/lib/github';
import { LANDING_STATUS_CONTEXT } from '@buildd/workflow-kernel/landing-gate';
import { reviewBudgetWaitDescription } from './provider-wall';

/** A reviewer task's context: what the review is for and where its status goes. */
export function isReviewerTaskContext(ctx: Record<string, unknown> | null | undefined): boolean {
  return !!ctx && typeof ctx.reviewerFor === 'string' && ctx.reviewerFor.length > 0;
}

type Api = (installationId: number, path: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<unknown>;

/**
 * Write the pending budget-wait status on the reviewed head. Answers whether
 * anything was written: false when the context lacks the repo, head or
 * installation (an old reviewer row), never throws for that.
 */
export async function publishReviewBudgetWait(
  o: { context: Record<string, unknown>; resetsAt: Date },
  deps: { api?: Api } = {},
): Promise<boolean> {
  const repoFullName = typeof o.context.repoFullName === 'string' ? o.context.repoFullName : '';
  const headSha = typeof o.context.headSha === 'string' ? o.context.headSha : '';
  const installationId = Number(o.context.installationId ?? 0);
  if (!repoFullName || !headSha || !Number.isFinite(installationId) || installationId <= 0) return false;
  const api = deps.api ?? (githubApi as unknown as Api);
  await api(installationId, `/repos/${repoFullName}/statuses/${headSha}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      state: 'pending',
      context: LANDING_STATUS_CONTEXT,
      description: reviewBudgetWaitDescription(o.resetsAt).slice(0, 140),
    }),
  });
  return true;
}
