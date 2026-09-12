import type { ReviewerVerdictSummary, ApprovalStaleness } from '@/lib/action-queue';

interface ReviewerVerdictBannerProps {
  verdict: ReviewerVerdictSummary | null | undefined;
  stale?: ApprovalStaleness | null;
}

/**
 * The reviewer's stored verdict — reviewer, confidence, one-line summary, and
 * (for an approve) the SHA it was made against. Renders unconditionally
 * whenever a verdict exists, independent of whatever local UI state a card
 * built around it is in: an approved PR must never read as unreviewed just
 * because a merge conflict, a retry, or a click is also happening.
 *
 * Shared between `WaitingOnYouReviewCard` (client) and the server-rendered
 * RESOLVING block on Home — a live conflict retry must not hide the approval
 * that preceded it. Deliberately a plain function component (no hooks) so it
 * works unmodified in both a client and a server component tree.
 */
export function ReviewerVerdictBanner({ verdict, stale }: ReviewerVerdictBannerProps) {
  if (!verdict) return null;

  const isApprove = verdict.verdict === 'approve';
  const label = isApprove ? 'Approved' : verdict.verdict === 'request-changes' ? 'Changes Requested' : 'Escalated';
  const tone = isApprove ? 'text-status-success' : verdict.verdict === 'request-changes' ? 'text-status-warning' : 'text-status-error';
  const boxTone = isApprove ? 'bg-status-success/5 border-status-success/20' : verdict.verdict === 'request-changes' ? 'bg-status-warning/5 border-status-warning/20' : 'bg-status-error/5 border-status-error/20';

  return (
    <div className={`mt-2 rounded px-2.5 py-1.5 border ${boxTone}`}>
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className={`text-[11px] font-semibold ${tone}`}>🤖 {label}</span>
        {typeof verdict.confidence === 'number' && (
          <span className={`text-[10px] ${tone}/70`}>(confidence {verdict.confidence.toFixed(2)})</span>
        )}
        {verdict.postedToGithub === false && (
          <span className="text-[10px] text-status-error" title="Recorded here, but GitHub shows no review — branch protection cannot see this verdict.">
            · not posted to GitHub
          </span>
        )}
      </div>
      {verdict.summary && (
        <p className="text-[11px] text-text-secondary leading-relaxed line-clamp-2 mt-0.5">{verdict.summary}</p>
      )}
      {isApprove && verdict.approvedSha && (
        <p className="text-[10px] text-text-muted mt-0.5 font-mono">
          approved at {verdict.approvedSha.slice(0, 7)}
          {stale && (
            <span className="text-status-warning">
              {' '}— {typeof stale.commitsSince === 'number' && stale.commitsSince > 0
                ? `${stale.commitsSince} commit${stale.commitsSince === 1 ? '' : 's'} since`
                : 'the branch has moved since'}
            </span>
          )}
        </p>
      )}
    </div>
  );
}
