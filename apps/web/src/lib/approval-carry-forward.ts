/**
 * Keep a reviewer's approval valid across a push that does not change the PR.
 *
 * `review-verdict-gate` treats an approval as stale once the head moves. That
 * is right for a push that changes code, but a rebase or base merge — which
 * the base-freshness gate in auto-merge demands — moves the head without
 * changing the diff, and used to leave the PR blocked until a human merged it
 * or a fresh agent review re-read an identical change. When the diff is
 * provably unchanged, the new head is recorded on the approving review task
 * (`context.equivalentHeadShas`) and the gate accepts it. CI still has to go
 * green on the new head; this only answers "was this change reviewed".
 *
 * Only `approved` carries forward. A blocking verdict stays blocking.
 */

import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import { eq, sql } from 'drizzle-orm';
import { readPrReviewStatus } from '@/lib/pr-review-request';
import type { PrReviewStatus } from '@/lib/pr-review-status';
import { isContentEquivalentHead } from '@/lib/pr-content-equivalence';

type StatusSlice = Pick<PrReviewStatus, 'state' | 'reviewTaskId' | 'reviewHeadSha' | 'reviewEquivalentHeadShas'>;

async function recordEquivalentHead(p: { reviewTaskId: string; headSha: string }): Promise<void> {
  await db
    .update(tasks)
    .set({
      context: sql`jsonb_set(COALESCE(${tasks.context}, '{}'::jsonb), '{equivalentHeadShas}', COALESCE(${tasks.context}->'equivalentHeadShas', '[]'::jsonb) || to_jsonb(${p.headSha}::text))`,
      updatedAt: new Date(),
    })
    .where(eq(tasks.id, p.reviewTaskId));
}

export async function carryForwardApprovalIfUnchanged(params: {
  installationId: number;
  repoFullName: string;
  workspaceId: string;
  prNumber: number;
  baseRef: string;
  headSha: string;
  deps?: {
    readStatus?: (p: { workspaceId: string; prNumber: number }) => Promise<StatusSlice>;
    isEquivalent?: typeof isContentEquivalentHead;
    record?: typeof recordEquivalentHead;
  };
}): Promise<{ carried: boolean; reason: string }> {
  const readStatus = params.deps?.readStatus ?? readPrReviewStatus;
  const isEquivalent = params.deps?.isEquivalent ?? isContentEquivalentHead;
  const record = params.deps?.record ?? recordEquivalentHead;

  const status = await readStatus({ workspaceId: params.workspaceId, prNumber: params.prNumber });
  if (status.state !== 'approved') return { carried: false, reason: `review is ${status.state}, not approved` };
  if (!status.reviewTaskId || !status.reviewHeadSha) return { carried: false, reason: 'approval has no recorded commit' };
  if (status.reviewHeadSha === params.headSha || status.reviewEquivalentHeadShas.includes(params.headSha)) {
    return { carried: true, reason: 'approval already covers this commit' };
  }

  const check = await isEquivalent({
    installationId: params.installationId,
    repoFullName: params.repoFullName,
    baseRef: params.baseRef,
    fromSha: status.reviewHeadSha,
    toSha: params.headSha,
  });
  if (!check.equivalent) return { carried: false, reason: check.reason };

  await record({ reviewTaskId: status.reviewTaskId, headSha: params.headSha });
  console.log(
    `[review] PR #${params.prNumber}: approval at ${status.reviewHeadSha.slice(0, 7)} carried to ${params.headSha.slice(0, 7)} — ${check.reason}`,
  );
  return { carried: true, reason: check.reason };
}
