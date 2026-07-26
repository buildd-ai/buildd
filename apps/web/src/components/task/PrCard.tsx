import { derivePrLifecycle, isPrMerged } from '@/lib/pr-presentation';

const ExternalIcon = () => (
  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
  </svg>
);

export interface PrCardProps {
  prUrl: string;
  prNumber: number | null;
  prLifecycleStatus?: string | null;
  linesAdded?: number | null;
  linesRemoved?: number | null;
  filesChanged?: number | null;
}

/**
 * Canonical pull-request card. One renderer for every surface that shows a
 * worker's PR — task detail page, mission task drawer, timeline. Lifecycle
 * label/colour and the "View PR" vs "Review & merge" verb come from the shared
 * pr-presentation layer so the PR reads identically everywhere.
 */
export default function PrCard({
  prUrl,
  prNumber,
  prLifecycleStatus,
  linesAdded,
  linesRemoved,
  filesChanged,
}: PrCardProps) {
  const lifecycle = derivePrLifecycle(prLifecycleStatus, true);
  const hasDiff = linesAdded != null || linesRemoved != null || (filesChanged != null && filesChanged > 0);

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

      <a
        href={prUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium rounded-md bg-surface-3 text-text-primary hover:bg-card-hover transition-colors"
      >
        {isPrMerged(prLifecycleStatus) ? 'View PR' : 'Review & merge'} #{prNumber} on GitHub
        <ExternalIcon />
      </a>
    </div>
  );
}
