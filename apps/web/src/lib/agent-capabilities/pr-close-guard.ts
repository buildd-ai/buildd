/**
 * Closing a PR another task owns (`close_pr` → `PATCH /api/github/pr`).
 *
 * The ownership rule (`agentRunMayActOnPr`) says whether an agent run may reach
 * a PR at all: a coordination task the server filed about PR #N links #N, so
 * it passes. It says nothing about the PR's state, and nothing about what the
 * close leaves behind. Both matter for a close by a task that is not the PR's
 * owner:
 *
 *   - A delivery that is ESCALATED, or approved and waiting on a person to
 *     merge it, is a person's to decide. A sweep that closes it takes that
 *     decision away, and whether it did used to depend on which model picked
 *     the sweep up.
 *   - A bare close reads as CLOSED_UNMERGED with an unknown cause, which blocks
 *     the owning task's mission with nothing to say why. Abandonment is a
 *     person's call (T21, `recordPrAbandonment`), so the one record an agent
 *     can leave is a supersession: the work landed in a named, merged PR.
 *
 * So a foreign close needs a reason and a merged successor, and is refused
 * outright on a delivery that waits on a person. People are exempt: a session
 * user or a teammate on another account closes as before.
 */
import { retrySubject, type PrLinkTask } from './pr-links';

export type ForeignCloseRefusal =
  | 'pr_awaiting_person'
  | 'pr_state_unreadable'
  | 'close_reason_required'
  | 'close_successor_required'
  | 'successor_not_merged';

export type ForeignCloseVerdict =
  | { ok: true; reason: string; supersedingPrNumber: number }
  | { ok: false; status: number; reasonCode: ForeignCloseRefusal; error: string; hint: string };

const ASK_OWNER = 'Ask the owner instead: comment on the PR (a sweep worker\'s task token cannot post to the PR\'s mission, and a runner-managed worker cannot ask_human), or ask_human / post_note type=question where open to you.';

/**
 * Is this close by an agent run on a PR its own worker did not open? A retry
 * bound to the PR counts as the owner: it works on that PR.
 */
export function closesForeignPr(
  caller: { id: string; sessionUserId?: string | null },
  worker: { accountId: string | null; prNumber?: number | null; task?: PrLinkTask | null },
  prNumber: number,
): boolean {
  if (caller.sessionUserId) return false;
  if (worker.accountId !== caller.id) return false;
  if (worker.prNumber === prNumber) return false;
  if (worker.task && retrySubject(worker.task) === prNumber) return false;
  return true;
}

export interface ForeignCloseDeps {
  /**
   * The PR's delivery: its state, and whether its next move is a person's.
   * Null when it has none. Throws on a read failure.
   */
  deliveryOf: (prNumber: number) => Promise<{ state: string; needsPerson: boolean } | null>;
  /** Whether the named successor PR is merged on GitHub. Throws on a read failure. */
  successorMerged: (prNumber: number) => Promise<boolean>;
}

export async function checkForeignClose(
  input: { prNumber: number; reason: unknown; supersedingPrNumber: unknown },
  deps: ForeignCloseDeps,
): Promise<ForeignCloseVerdict> {
  const { prNumber } = input;
  let delivery: { state: string; needsPerson: boolean } | null;
  try {
    delivery = await deps.deliveryOf(prNumber);
  } catch {
    return {
      ok: false, status: 503, reasonCode: 'pr_state_unreadable',
      error: `Could not read PR #${prNumber}'s delivery state, so it is not closed: it may be waiting on a person.`,
      hint: 'Retry shortly.',
    };
  }
  if (delivery && (delivery.state === 'ESCALATED' || delivery.needsPerson)) {
    return {
      ok: false, status: 409, reasonCode: 'pr_awaiting_person',
      error: `PR #${prNumber} belongs to another task and is ${delivery.state === 'ESCALATED' ? 'ESCALATED' : `${delivery.state}, waiting on a person`}: closing it is a person's call.`,
      hint: ASK_OWNER,
    };
  }

  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (!reason) {
    return {
      ok: false, status: 400, reasonCode: 'close_reason_required',
      error: `PR #${prNumber} belongs to another task: closing it needs a reason, which is posted on the PR.`,
      hint: 'Pass reason, and supersedingPrNumber naming the merged PR that carries the work.',
    };
  }

  const successor = input.supersedingPrNumber;
  if (typeof successor !== 'number' || !Number.isInteger(successor) || successor <= 0 || successor === prNumber) {
    return {
      ok: false, status: 409, reasonCode: 'close_successor_required',
      error: `PR #${prNumber} belongs to another task: closing it needs supersedingPrNumber, the merged PR that carries its work. `
        + 'A close without one reads as closed for an unknown cause and blocks the owning task, and only a person may mark it abandoned.',
      hint: `${ASK_OWNER} Or rebase it and land it.`,
    };
  }

  let merged: boolean;
  try {
    merged = await deps.successorMerged(successor);
  } catch (err) {
    return {
      ok: false, status: 409, reasonCode: 'successor_not_merged',
      error: `Could not read successor PR #${successor}: ${err instanceof Error ? err.message : String(err)}`,
      hint: 'Check the PR number, then retry.',
    };
  }
  if (!merged) {
    return {
      ok: false, status: 409, reasonCode: 'successor_not_merged',
      error: `Successor PR #${successor} is not merged, so PR #${prNumber} cannot be recorded as superseded by it.`,
      hint: `Close it once #${successor} merges. ${ASK_OWNER}`,
    };
  }
  return { ok: true, reason, supersedingPrNumber: successor };
}

/** The comment a foreign close leaves on the PR, citing the closing task by short id. */
export function foreignCloseComment(p: { closerTaskId: string | null; reason: string; supersedingPrNumber: number }): string {
  const by = p.closerTaskId ? `task \`${p.closerTaskId.slice(0, 8)}\`` : 'another task';
  return `Closed by ${by}, which does not own this PR: ${p.reason}\n\nSuperseded by #${p.supersedingPrNumber}, which is merged.`;
}
