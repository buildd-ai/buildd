/**
 * Outcome labels for merge readiness (`buildd.merge_readiness`) decisions,
 * attached when the PR reaches a terminal state, so every live Assess becomes
 * a labelled example and the next backtest is a query.
 *
 * - Source `pr_terminal`: `merge_now` | `code_change` | `close`, one per
 *   decision head (`labelMergeReadinessOutcome` in @buildd/core). Written by
 *   the `pr.close_delivered` subscriber, with the hourly pr-reconcile pass as
 *   the backstop because the webhook is lossy. A force-pushed decision head is
 *   labelled from commit messages, `metadata.confidence: 'low'`.
 * - Source `pr_reverted`: `reverted` | `not_reverted`, by the same hourly pass,
 *   once a revert of a merged PR is in the revert ledger (`pr_reverts`) within
 *   `REVERT_WINDOW_MS`, or the window has passed without one.
 *
 * Idempotent by construction: only heads without a `pr_terminal` row are read
 * from GitHub at all, and the write is `labelDecisionOutcome`'s first label per
 * (decision, source) wins, so a redelivery or a sweep after the webhook is a
 * no-op. Never throws to its caller.
 *
 * The stores (DB + GitHub) are `merge-readiness-outcomes-store.ts`.
 */
import { labelDecisionOutcome } from '@buildd/core/decision-outcomes';
import {
  labelMergeReadinessOutcome,
  revertOutcome,
  type MergeReadinessOutcome,
  type PrCommitFact,
  type PrFileDiff,
} from '@buildd/core/merge-readiness-outcome';
import { MERGE_READINESS_KIND, MERGE_READINESS_SUBJECT_TYPE, mergeAdviceSubjectId } from './merge-advice';

export const PR_TERMINAL_SOURCE = 'pr_terminal' as const;
export const PR_REVERT_SOURCE = 'pr_reverted' as const;

/** One decision head on a PR that has no `pr_terminal` label yet. */
export interface PendingDecisionHead {
  teamId: string;
  workspaceId: string;
  prNumber: number;
  headSha: string;
  /** The first decision on this head. */
  decidedAt: Date;
}

export interface PrTerminalState {
  state: 'open' | 'closed';
  merged: boolean;
  headSha: string;
  baseSha: string;
  mergedAt: Date | null;
  closedAt: Date | null;
  mergeCommitSha: string | null;
}

/** GitHub reads for one PR's repo. `compare` returns 'unreachable' when a sha is gone (force-pushed). */
export interface MergeReadinessGithub {
  readPr(prNumber: number): Promise<PrTerminalState>;
  prFiles(prNumber: number): Promise<PrFileDiff[]>;
  compare(base: string, head: string): Promise<{ mergeBaseSha: string; files: PrFileDiff[] } | 'unreachable'>;
  prCommits(prNumber: number): Promise<PrCommitFact[]>;
}

export interface MergeReadinessOutcomeDeps {
  findPendingHeads(q: { workspaceIds: string[]; prNumber: number }): Promise<PendingDecisionHead[]>;
  github(repoFullName: string, installationId: number): MergeReadinessGithub;
  label?: typeof labelDecisionOutcome;
}

export interface AttachResult {
  status: 'no_pending' | 'open' | 'labelled' | 'failed';
  recorded: number;
  duplicate: number;
  conflict: number;
  unlabelled: number;
  errors: number;
}

const empty = (status: AttachResult['status']): AttachResult => ({ status, recorded: 0, duplicate: 0, conflict: 0, unlabelled: 0, errors: 0 });

function memo<T>(fn: () => Promise<T>): () => Promise<T> {
  let p: Promise<T> | null = null;
  return () => (p ??= fn());
}

/** Label every unlabelled merge readiness decision on one PR. Never throws. */
export async function attachMergeReadinessOutcomes(
  input: { workspaceIds: string[]; repoFullName: string; prNumber: number; installationId: number },
  deps: MergeReadinessOutcomeDeps,
): Promise<AttachResult> {
  try {
    if (input.workspaceIds.length === 0) return empty('no_pending');
    // The ledger first: a PR nobody assessed costs one query and no GitHub call.
    const heads = await deps.findPendingHeads({ workspaceIds: input.workspaceIds, prNumber: input.prNumber });
    if (heads.length === 0) return empty('no_pending');

    const gh = deps.github(input.repoFullName, input.installationId);
    const pr = await gh.readPr(input.prNumber);
    if (pr.state !== 'closed') return empty('open');

    const finalFiles = memo(() => gh.prFiles(input.prNumber));
    const commits = memo(() => gh.prCommits(input.prNumber));
    const label = deps.label ?? labelDecisionOutcome;
    const result = empty('labelled');

    for (const head of heads) {
      let outcome: MergeReadinessOutcome | null;
      try {
        outcome = await outcomeFor(head, pr, gh, finalFiles, commits);
      } catch (err) {
        console.warn(`[merge-readiness-outcomes] PR #${input.prNumber} head ${head.headSha.slice(0, 8)}: read failed:`, (err as Error)?.message ?? err);
        result.errors++;
        continue;
      }
      if (!outcome) { result.unlabelled++; continue; }

      const res = await label({
        teamId: head.teamId,
        capability: MERGE_READINESS_KIND,
        subject: { type: MERGE_READINESS_SUBJECT_TYPE, id: mergeAdviceSubjectId(head.workspaceId, head.prNumber, head.headSha) },
        source: PR_TERMINAL_SOURCE,
        label: outcome.label,
        observedAt: pr.mergedAt ?? pr.closedAt ?? undefined,
        metadata: {
          confidence: outcome.confidence,
          reason: outcome.reason,
          ...(outcome.changedFiles ? { changedFiles: outcome.changedFiles.slice(0, 50) } : {}),
          decisionHeadSha: head.headSha,
          finalHeadSha: pr.headSha,
          mergeCommitSha: pr.mergeCommitSha,
          mergedAt: pr.mergedAt?.toISOString() ?? null,
        },
      });
      if (!res.ok) { result.errors++; continue; }
      for (const r of res.results) {
        if (r.status === 'recorded') result.recorded++;
        else if (r.status === 'duplicate') result.duplicate++;
        else result.conflict++;
      }
    }
    return result;
  } catch (err) {
    console.warn(`[merge-readiness-outcomes] PR #${input.prNumber}: failed (non-fatal):`, (err as Error)?.message ?? err);
    return { ...empty('failed'), errors: 1 };
  }
}

async function outcomeFor(
  head: PendingDecisionHead,
  pr: PrTerminalState,
  gh: MergeReadinessGithub,
  finalFiles: () => Promise<PrFileDiff[]>,
  commits: () => Promise<PrCommitFact[]>,
): Promise<MergeReadinessOutcome | null> {
  const base = { pr: { merged: pr.merged, state: pr.state }, decision: { headSha: head.headSha, decidedAt: head.decidedAt }, finalHeadSha: pr.headSha };
  // Closed unmerged, or merged at the decision's own head: no diff needed.
  const quick = labelMergeReadinessOutcome({ ...base, decisionDiff: null, finalDiff: null, commits: null });
  if (quick && (quick.reason === 'closed_unmerged' || quick.reason === 'head_unchanged')) return quick;

  // The PR's diff at the decision head: three-dot against the final base is
  // the merge base the PR had then, since that head holds no later base commit.
  const atDecision = await gh.compare(pr.baseSha, head.headSha);
  if (atDecision === 'unreachable') {
    return labelMergeReadinessOutcome({ ...base, decisionDiff: null, finalDiff: null, commits: await commits() });
  }
  // What the base changed since then: a file in here that the PR also touches is conflict resolution.
  const baseMoved = atDecision.mergeBaseSha && atDecision.mergeBaseSha !== pr.baseSha
    ? await gh.compare(atDecision.mergeBaseSha, pr.baseSha)
    : null;
  return labelMergeReadinessOutcome({
    ...base,
    decisionDiff: atDecision.files,
    finalDiff: await finalFiles(),
    baseChangedFiles: baseMoved && baseMoved !== 'unreachable' ? baseMoved.files.map(f => f.filename) : [],
  });
}

// ── Revert labels ───────────────────────────────────────────────────────────

/** A decision labelled merged (`merge_now` | `code_change`) with no `pr_reverted` row yet. */
export interface RevertCandidate {
  decisionRecordId: string;
  teamId: string;
  workspaceId: string;
  prNumber: number;
  mergedAt: Date;
}

export interface RevertSweepDeps {
  findRevertCandidates(limit: number): Promise<RevertCandidate[]>;
  /** When the revert ledger first recorded a revert of this PR, or null. */
  findRevertedAt(workspaceId: string, prNumber: number): Promise<Date | null>;
  label?: typeof labelDecisionOutcome;
  now?: () => Date;
}

export async function sweepMergeReadinessReverts(
  deps: RevertSweepDeps,
  opts: { limit?: number } = {},
): Promise<{ checked: number; reverted: number; notReverted: number; errors: number }> {
  const out = { checked: 0, reverted: 0, notReverted: 0, errors: 0 };
  const now = deps.now?.() ?? new Date();
  const label = deps.label ?? labelDecisionOutcome;
  let candidates: RevertCandidate[];
  try {
    candidates = await deps.findRevertCandidates(opts.limit ?? 200);
  } catch (err) {
    console.warn('[merge-readiness-outcomes] revert candidates failed (non-fatal):', (err as Error)?.message ?? err);
    return { ...out, errors: 1 };
  }
  const revertedAt = new Map<string, Promise<Date | null>>();
  for (const c of candidates) {
    out.checked++;
    try {
      const key = `${c.workspaceId}#${c.prNumber}`;
      if (!revertedAt.has(key)) revertedAt.set(key, deps.findRevertedAt(c.workspaceId, c.prNumber));
      const at = await revertedAt.get(key)!;
      const verdict = revertOutcome({ mergedAt: c.mergedAt, revertedAt: at, now });
      if (!verdict) continue;
      const res = await label({
        teamId: c.teamId,
        decisionRecordId: c.decisionRecordId,
        source: PR_REVERT_SOURCE,
        label: verdict,
        observedAt: verdict === 'reverted' && at ? at : now,
        metadata: { mergedAt: c.mergedAt.toISOString(), revertedAt: at?.toISOString() ?? null },
      });
      if (!res.ok) { out.errors++; continue; }
      if (verdict === 'reverted') out.reverted++;
      else out.notReverted++;
    } catch (err) {
      out.errors++;
      console.warn(`[merge-readiness-outcomes] revert check for PR #${c.prNumber} failed:`, (err as Error)?.message ?? err);
    }
  }
  return out;
}
