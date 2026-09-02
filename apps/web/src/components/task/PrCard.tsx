import { derivePrLifecycle, isPrMerged } from '@/lib/pr-presentation';

const ExternalIcon = () => (
  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
  </svg>
);

export interface CiCheckRun {
  name: string;
  conclusion: string | null;
  status: string;
  detailsUrl: string | null;
}

export interface PrCardProps {
  prUrl: string;
  prNumber: number | null;
  prLifecycleStatus?: string | null;
  linesAdded?: number | null;
  linesRemoved?: number | null;
  filesChanged?: number | null;
  /** Detailed CI check runs — shown on task detail page (AC-4). */
  ciChecks?: {
    total: number;
    passed: number;
    failed: number;
    pending: number;
    runs: CiCheckRun[];
  } | null;
  /** Review summary — shown on task detail page (AC-4). */
  reviews?: {
    approved: number;
    changesRequested: number;
    pending: number;
  } | null;
  /** Mergeable state from GitHub — shown on task detail page (AC-4). */
  mergeable?: boolean | null;
  mergeableState?: string | null;
}

/**
 * Canonical pull-request card. One renderer for every surface that shows a
 * worker's PR — task detail page, mission task drawer, timeline. Lifecycle
 * label/colour and the "View PR" vs "Review & merge" verb come from the shared
 * pr-presentation layer so the PR reads identically everywhere.
 *
 * When `ciChecks` is provided (task detail page), the card also shows individual
 * failing check names linked to their GitHub run pages (AC-4).
 */
export default function PrCard({
  prUrl,
  prNumber,
  prLifecycleStatus,
  linesAdded,
  linesRemoved,
  filesChanged,
  ciChecks,
  reviews,
  mergeable,
  mergeableState,
}: PrCardProps) {
  const lifecycle = derivePrLifecycle(prLifecycleStatus, true);
  const hasDiff = linesAdded != null || linesRemoved != null || (filesChanged != null && filesChanged > 0);

  const isMerged = isPrMerged(prLifecycleStatus);
  const failingRuns = ciChecks?.runs.filter(
    r => r.status === 'completed' && (r.conclusion === 'failure' || r.conclusion === 'timed_out' || r.conclusion === 'cancelled' || r.conclusion === 'action_required')
  ) ?? [];

  const reviewLine = reviews && (reviews.approved + reviews.changesRequested + reviews.pending > 0)
    ? [
        reviews.approved > 0 ? `${reviews.approved} approved` : null,
        reviews.changesRequested > 0 ? `${reviews.changesRequested} changes requested` : null,
        reviews.pending > 0 ? `${reviews.pending} pending` : null,
      ].filter(Boolean).join(' · ')
    : 'no reviews';

  return (
    <div className="rounded-lg border border-border-default p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12px] font-semibold text-text-primary">Pull request</span>
        {lifecycle && (
          <span className={`inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded ${lifecycle.cls}`}>
            {lifecycle.label}
          </span>
        )}
      </div>

      {hasDiff && (
        <div className="flex items-center gap-3 text-[12px] tabular-nums">
          {linesAdded != null && <span className="text-status-success">+{linesAdded}</span>}
          {linesRemoved != null && <span className="text-status-error">&minus;{linesRemoved}</span>}
          {filesChanged != null && filesChanged > 0 && (
            <span className="text-text-muted">{filesChanged} file{filesChanged !== 1 ? 's' : ''}</span>
          )}
        </div>
      )}

      {/* CI check summary — shown when detailed check data is available */}
      {ciChecks && ciChecks.total > 0 && (
        <div className="space-y-1.5">
          <div className="flex items-center gap-2 text-[12px]">
            <span className="text-text-muted">CI:</span>
            {ciChecks.failed > 0 && (
              <span className="text-status-error font-medium">{ciChecks.failed} failed</span>
            )}
            {ciChecks.pending > 0 && (
              <span className="text-status-info">{ciChecks.pending} running</span>
            )}
            {ciChecks.passed > 0 && (
              <span className="text-text-muted">{ciChecks.passed} passed</span>
            )}
            <span className="text-text-muted">/ {ciChecks.total} total</span>
          </div>

          {/* Failing check names with links (AC-4) */}
          {failingRuns.length > 0 && (
            <div className="space-y-1 pl-2 border-l-2 border-status-error/30">
              {failingRuns.map((run, i) => (
                <div key={i} className="flex items-center gap-1.5 text-[11px]">
                  <span className="text-status-error">✗</span>
                  {run.detailsUrl ? (
                    <a
                      href={run.detailsUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-status-error font-mono hover:underline"
                    >
                      {run.name}
                    </a>
                  ) : (
                    <span className="text-status-error font-mono">{run.name}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Mergeable state */}
      {!isMerged && mergeable !== undefined && mergeable !== null && (
        <div className="text-[12px] text-text-muted">
          {mergeable
            ? <span className="text-status-success">Mergeable</span>
            : <span className="text-status-warning">
                {mergeableState === 'dirty' ? 'Merge conflicts' : 'Not mergeable'}
              </span>
          }
        </div>
      )}

      {/* Review state */}
      {ciChecks && (
        <div className="text-[12px] text-text-muted">
          Reviews: {reviewLine}
        </div>
      )}

      <a
        href={prUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium rounded-md bg-surface-3 text-text-primary hover:bg-card-hover transition-colors"
      >
        {isMerged ? 'View PR' : 'Review & merge'} #{prNumber} on GitHub
        <ExternalIcon />
      </a>
    </div>
  );
}
