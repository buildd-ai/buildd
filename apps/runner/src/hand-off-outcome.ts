/**
 * The completion-payload signal for a hand-off failure after work
 * (docs/specs/workflow-state-kernel.md §6.6, S30).
 *
 * "No confirmed outcome", "commits but no PR", "uncommitted changes", an unmet
 * output requirement and a fix whose head never reached GitHub all mean the
 * same thing to the workflow kernel: the work is not on GitHub. That is not the
 * same as the work having failed, so the runner says so with
 * `outcome: 'unproven'` beside the local head and commit count it saw. The
 * server still verifies against GitHub (R2): these are facts for the kernel's
 * decision, never proof of delivery.
 *
 * A server that predates this ignores the fields; a runner that predates this
 * omits them and the server keeps today's `failed` mapping.
 */
import { GATE_SLUGS } from '@buildd/core/gate-slugs';
import type { GitStats } from './git-operations';

export interface HandOffUnproven {
  outcome: 'unproven';
  localHeadSha: string | null;
  commitCount: number;
}

export function handOffUnproven(stats: GitStats, trackedCommits = 0): HandOffUnproven {
  return {
    outcome: 'unproven',
    localHeadSha: stats.lastCommitSha ?? null,
    commitCount: typeof stats.commitCount === 'number' ? stats.commitCount : trackedCommits,
  };
}

/** A refusal about the session's deliverables (the output gate), not about the request. */
export function isHandOffRefusal(refusal: { gate?: string }): boolean {
  return refusal.gate === GATE_SLUGS.OUTPUT_REQUIREMENT;
}
