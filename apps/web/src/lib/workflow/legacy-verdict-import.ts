/**
 * 968aebfd: the legacy review a PR already has when the kernel opens its delivery
 * (docs/specs/workflow-kernel-library.md §5, S5). A legacy reviewer that judged the
 * PR's live head before the delivery existed is that head's review: the open adopts
 * it (`ReviewVerdictAdopted`), so the owner's hand-off does not ask for a second one.
 * A legacy reviewer still running at the live head is waited for: the hand-off holds
 * until it ends, and its verdict is adopted then (the worker PATCH's 00d288fd path).
 *
 * Only evidence bound to exactly what the kernel would review counts. Everything else
 * reads `none`, and the kernel reviews the head itself:
 *  - another repo, PR or head, or a kernel round's own reviewer;
 *  - a verdict whose server-side gates never finished (`result.settledVerdict` absent; one
 *    still finishing is waited for, as a running reviewer is);
 *  - a verdict read at another commit than the head (`result.evidenceSha`);
 *  - a review of another base, or of an unrecorded one (`context.baseRef`), or a
 *    composition-scoped one (`context.compositionDelta`);
 *  - a failed or cancelled reviewer, or a running one past `LIVE_LEGACY_REVIEWER_MAX_AGE_MS`.
 * The newest reviewer at the head decides: a re-review someone asked for after a
 * verdict stands in for it, and if that re-review is unusable the head is reviewed again.
 */
import { sql, type SQL } from 'drizzle-orm';
import { OPEN_TASK_STATUSES } from '@buildd/shared';

/** A running legacy reviewer older than this is not waited for: the kernel reviews the head. */
export const LIVE_LEGACY_REVIEWER_MAX_AGE_MS = 2 * 60 * 60_000;

/**
 * A completed reviewer whose verdict is not settled yet is still in the worker PATCH's
 * outcome handler (its gates run after the task completes): waited for this long, then
 * read as unsettled. A row from before `settledVerdict` existed is past it and never adopted.
 */
export const SETTLING_LEGACY_VERDICT_MS = 5 * 60_000;

export interface LegacyReviewerRow {
  id: string;
  status: string;
  created_at: string | Date;
  updated_at?: string | Date | null;
  context: unknown;
  result: unknown;
}

export type LegacyReviewReading =
  | {
    kind: 'adopt';
    reviewerTaskId: string;
    verdict: string;
    effectiveVerdict: string;
    confidence: number | null;
    evidenceSha: string;
    /** The reviewer's structured output: its findings are the kernel's findings. */
    output: Record<string, unknown>;
  }
  | { kind: 'live'; reviewerTaskId: string }
  | { kind: 'none'; reason: string; reviewerTaskId?: string };

const VERDICTS = new Set(['approve', 'request-changes', 'escalate']);
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/** Pure: what the PR's legacy reviewers (newest first) say about `headSha` against `baseRef`. */
export function readLegacyReview(rows: LegacyReviewerRow[], at: {
  repoFullName: string; prNumber: number; headSha: string; baseRef: string | null; now: number;
}): LegacyReviewReading {
  const mine = rows.filter((r) => {
    const ctx = rec(r.context);
    return !ctx.workflowRoundId
      && Number(ctx.prNumber) === at.prNumber
      && str(ctx.repoFullName)?.toLowerCase() === at.repoFullName.toLowerCase()
      && ctx.headSha === at.headSha;
  });
  const newest = mine[0];
  if (!newest) return { kind: 'none', reason: 'no_review_at_head' };
  const id = newest.id;
  if ((OPEN_TASK_STATUSES as readonly string[]).includes(newest.status)) {
    const age = at.now - new Date(newest.created_at).getTime();
    return age <= LIVE_LEGACY_REVIEWER_MAX_AGE_MS ? { kind: 'live', reviewerTaskId: id } : { kind: 'none', reason: 'reviewer_stalled', reviewerTaskId: id };
  }
  if (newest.status !== 'completed') return { kind: 'none', reason: `reviewer_${newest.status}`, reviewerTaskId: id };
  const ctx = rec(newest.context);
  const result = rec(newest.result);
  const output = rec(result.structuredOutput);
  const verdict = str(output.verdict);
  const settled = str(result.settledVerdict);
  if (verdict && VERDICTS.has(verdict) && !settled && newest.updated_at && at.now - new Date(newest.updated_at).getTime() <= SETTLING_LEGACY_VERDICT_MS) {
    return { kind: 'live', reviewerTaskId: id };
  }
  if (!verdict || !VERDICTS.has(verdict) || !settled || !VERDICTS.has(settled)) return { kind: 'none', reason: 'verdict_not_settled', reviewerTaskId: id };
  if (result.evidenceSha !== at.headSha) return { kind: 'none', reason: 'evidence_not_at_head', reviewerTaskId: id };
  if (!at.baseRef || ctx.baseRef !== at.baseRef) return { kind: 'none', reason: 'base_not_reviewed', reviewerTaskId: id };
  if (ctx.compositionDelta) return { kind: 'none', reason: 'scoped_review', reviewerTaskId: id };
  return {
    kind: 'adopt', reviewerTaskId: id, verdict, effectiveVerdict: settled,
    confidence: typeof output.confidence === 'number' ? output.confidence : null,
    evidenceSha: at.headSha, output,
  };
}

/** The PR's legacy reviewer tasks, newest first (a kernel round's reviewers are filtered by `readLegacyReview`). */
export function legacyReviewersSql(p: { workspaceId: string; prNumber: number }): SQL {
  return sql`-- workflow:legacy_reviewers
SELECT t.id, t.status, t.created_at, t.updated_at, t.context, t.result FROM tasks t
WHERE t.workspace_id = ${p.workspaceId}::uuid AND t.category = 'review'
  AND t.context->>'prNumber' = ${String(p.prNumber)}::text
  AND t.context->>'workflowRoundId' IS NULL
ORDER BY t.created_at DESC, t.id DESC
LIMIT 20`;
}
