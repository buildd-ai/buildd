/**
 * The PR a repair attempt exists to update, named exactly.
 *
 * A conflict, migration or CI attempt is useless unless its push lands on the
 * PR's own head. Before this stamp the attempt only carried `resumeBranch`, the
 * owning worker's branch. The runner could not tell "a prior attempt's branch"
 * (safe to abandon when it looks runaway) from "the head of the PR I was filed
 * to fix" (never safe to abandon). A mission integration PR's head is far ahead
 * of trunk by construction. The runner read that as divergence, started fresh
 * from trunk, and every attempt completed having changed nothing on the PR.
 * See docs/specs/workflow-state-kernel.md §13.11.
 *
 * Stamped only when GitHub reported the PR's `head.ref`, so `headRef` is a fact,
 * never a guess from a worker row. Pure: the runner imports it too.
 */

export interface RepairTarget {
  prNumber: number;
  /** The PR's head branch as GitHub reported it when the attempt was filed. */
  headRef: string;
  /** The head the attempt was bound to, when known. */
  headSha: string | null;
  /** The PR's base branch, when known. */
  baseRef: string | null;
}

/**
 * Branch continuity for a repair attempt. With a GitHub-reported head, both
 * branch fields name it and `repairTarget` records it. Without one, the legacy
 * fields stay the worker's branch and no target is claimed.
 */
export function repairBranchContext(p: {
  prNumber: number | null | undefined;
  workerBranch: string;
  headRef?: string | null;
  headSha?: string | null;
  baseRef?: string | null;
}): { baseBranch: string; resumeBranch: string; repairTarget?: RepairTarget } {
  const headRef = typeof p.headRef === 'string' && p.headRef.length > 0 ? p.headRef : null;
  if (!headRef || typeof p.prNumber !== 'number') {
    return { baseBranch: p.workerBranch, resumeBranch: p.workerBranch };
  }
  return {
    baseBranch: headRef,
    resumeBranch: headRef,
    repairTarget: { prNumber: p.prNumber, headRef, headSha: p.headSha ?? null, baseRef: p.baseRef ?? null },
  };
}

/**
 * The repair target a task context names, or null. A target whose `headRef`
 * does not match the context's `resumeBranch` is ignored: something rewrote the
 * resume branch after filing, and the exemptions a target grants (divergence is
 * expected, an integration branch may be checked out) must not follow a branch
 * that is no longer the PR's head.
 */
export function readRepairTarget(context: Record<string, unknown> | null | undefined): RepairTarget | null {
  const raw = context?.repairTarget as Partial<RepairTarget> | null | undefined;
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.prNumber !== 'number' || typeof raw.headRef !== 'string' || !raw.headRef) return null;
  if (context?.resumeBranch !== raw.headRef) return null;
  return {
    prNumber: raw.prNumber,
    headRef: raw.headRef,
    headSha: typeof raw.headSha === 'string' ? raw.headSha : null,
    baseRef: typeof raw.baseRef === 'string' ? raw.baseRef : null,
  };
}

/** Thrown by the runner when a repair target's head is gone from the remote. */
export class RepairTargetMissingError extends Error {
  readonly code = 'repair_target_missing';
  constructor(readonly target: RepairTarget) {
    super(
      `repair_target_missing: PR #${target.prNumber}'s head branch "${target.headRef}" is not on the remote. ` +
      `A repair attempt must push to that branch; starting fresh from trunk would leave the PR unchanged. ` +
      `Check whether the PR was closed or its branch deleted.`,
    );
    this.name = 'RepairTargetMissingError';
  }
}
