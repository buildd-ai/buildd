/**
 * The red-PR sweep's due queue (`buildd:due:ci-red`, lib/cron-due-queue.ts).
 *
 * A CI failure the webhook could not act on yet — a fix attempt is still in
 * flight, or this head was already tried — has no event coming that would
 * bring it back: if the in-flight attempt finishes without pushing, GitHub
 * never reports that head again. The webhook schedules a look here instead,
 * and the gated `pr-reconcile?scope=ci-red&gate=due` tick picks it up
 * (lib/ci-red-sweep.ts). The hourly floor re-enumerates from Postgres, so a
 * lost write costs an hour, not the PR.
 *
 * Kept apart from the sweep so the webhook depends on one small writer, not on
 * the sweep's database bindings.
 */

import { markDue } from '@/lib/redis';

export const CI_RED_DUE_QUEUE = 'ci-red';

/**
 * The owner-task context key holding the head last escalated to a human, which
 * makes an escalation once per PR + head (lib/ci-failure-retry.ts).
 */
export const CI_RED_ESCALATED_KEY = 'ciRedEscalatedHeadSha';

export interface CiRedRef {
  workspaceId: string;
  prNumber: number;
}

export const ciRedMember = (ref: CiRedRef): string => `${ref.workspaceId}:${ref.prNumber}`;

/** Inverse of `ciRedMember`; null for anything that is not `<workspace>:<positive int>`. */
export function parseCiRedMember(member: string): CiRedRef | null {
  const i = member.lastIndexOf(':');
  if (i <= 0) return null;
  const tail = member.slice(i + 1);
  if (!/^\d+$/.test(tail)) return null;
  const prNumber = Number(tail);
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0) return null;
  return { workspaceId: member.slice(0, i), prNumber };
}

/** Ask the sweep to look at this PR at `dueAtMs`. Never throws (Redis ops no-op when unconfigured). */
export async function scheduleCiRedLook(ref: CiRedRef, dueAtMs: number): Promise<void> {
  try {
    await markDue(CI_RED_DUE_QUEUE, ciRedMember(ref), dueAtMs);
  } catch (err) {
    console.warn('[ci-red-queue] could not schedule a look:', err instanceof Error ? err.message : err);
  }
}
