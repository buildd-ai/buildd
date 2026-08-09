import Link from 'next/link';

export interface ReviewSummaryTask {
  id: string;
  title: string;
  status: string;
  prUrl: string | null;
  prNumber: number | null;
  prMerged: boolean;
  prClosed: boolean;
}

interface MissionReviewSummaryProps {
  tasks: ReviewSummaryTask[];
  missionId: string;
}

export default function MissionReviewSummary({ tasks, missionId }: MissionReviewSummaryProps) {
  const deliverable = tasks.filter(t => t.status !== 'cancelled');
  if (deliverable.length === 0) return null;

  const completedWithPr = deliverable.filter(t => t.status === 'completed' && t.prUrl);
  const completedNoPr = deliverable.filter(t => t.status === 'completed' && !t.prUrl);
  const failed = deliverable.filter(t => t.status === 'failed');
  const inProgress = deliverable.filter(t => ['pending', 'assigned', 'in_progress'].includes(t.status));

  const mergedCount = completedWithPr.filter(t => t.prMerged).length;
  const openPrCount = completedWithPr.filter(t => !t.prMerged && !t.prClosed).length;

  return (
    <div className="card p-4 mb-4 border-l-2 border-status-success/40">
      <h3 className="text-[10px] font-semibold tracking-wider text-text-muted uppercase mb-3">
        Outcome summary
      </h3>

      {completedWithPr.length > 0 && (
        <div className="mb-3">
          <div className="flex items-center gap-2 mb-1.5">
            <span className="text-[11px] font-semibold text-text-secondary">Pull Requests</span>
            <span className="text-[10px] font-mono text-text-muted">
              {mergedCount} merged{openPrCount > 0 ? ` · ${openPrCount} open` : ''}
            </span>
          </div>
          <div className="space-y-1.5">
            {completedWithPr.map(t => (
              <div key={t.id} className="flex items-center gap-2 min-w-0">
                <span className={`shrink-0 w-3 text-center text-[10px] font-mono ${t.prMerged ? 'text-status-success' : t.prClosed ? 'text-text-muted' : 'text-status-warning'}`}>
                  {t.prMerged ? '✓' : t.prClosed ? '×' : '○'}
                </span>
                <Link href={`/app/tasks/${t.id}`} className="min-w-0 truncate text-[12px] text-text-secondary hover:text-accent-text">
                  {t.title}
                </Link>
                {t.prUrl && t.prNumber && (
                  <a
                    href={t.prUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="shrink-0 text-[10px] font-mono text-text-muted hover:text-accent-text"
                  >
                    #{t.prNumber}{t.prMerged ? ' merged' : t.prClosed ? ' closed' : ' open'}
                  </a>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {completedNoPr.length > 0 && (
        <div className="mb-3">
          <p className="text-[12px] text-text-secondary">
            {completedNoPr.length} task{completedNoPr.length !== 1 ? 's' : ''} completed (no PR)
          </p>
        </div>
      )}

      {(failed.length > 0 || openPrCount > 0 || inProgress.length > 0) && (
        <div className="border-t border-border-default pt-2.5 mt-2.5 space-y-1.5">
          {failed.length > 0 && (
            <p className="text-[12px] text-status-error">
              {failed.length} task{failed.length !== 1 ? 's' : ''} failed
            </p>
          )}
          {openPrCount > 0 && (
            <p className="text-[12px] text-status-warning">
              {openPrCount} PR{openPrCount !== 1 ? 's' : ''} not yet merged —{' '}
              <Link href={`/app/missions/${missionId}`} className="hover:underline">view timeline</Link>
            </p>
          )}
          {inProgress.length > 0 && (
            <p className="text-[12px] text-text-muted">
              {inProgress.length} task{inProgress.length !== 1 ? 's' : ''} still queued
            </p>
          )}
        </div>
      )}
    </div>
  );
}
