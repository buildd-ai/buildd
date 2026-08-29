import Link from 'next/link';
import type { ReleaseReadinessItem } from '@/lib/release-readiness';
import { computeReleaseWidgetDecision } from '@/lib/release-readiness';

function daysAgo(isoDate: string): number {
  return Math.floor((Date.now() - new Date(isoDate).getTime()) / 86400000);
}

export function ReleaseWidget({ items }: { items: ReleaseReadinessItem[] }) {
  const visible = items.filter(
    (item) => computeReleaseWidgetDecision(item.queueDepth, item.ciState) !== 'hide',
  );

  if (visible.length === 0) return null;

  return (
    <div className="mb-8">
      <div className="flex items-center justify-between mb-4">
        <div className="section-label">Release Queue</div>
        <Link href="/app/missions" className="text-xs text-text-muted hover:text-text-secondary">
          View missions →
        </Link>
      </div>
      <div className="space-y-2">
        {visible.map((item) => {
          const decision = computeReleaseWidgetDecision(item.queueDepth, item.ciState);
          const ageText = item.oldestMergedAt
            ? ` · oldest ${daysAgo(item.oldestMergedAt)}d ago`
            : '';

          if (decision === 'ci_blocking') {
            return (
              <div
                key={item.workspaceId}
                className="border border-border-default rounded-[10px] px-4 py-3 bg-surface-2"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    {item.workspaceName && (
                      <span className="text-[10px] font-mono uppercase tracking-wide text-text-muted/80 block mb-0.5">
                        {item.workspaceName}
                      </span>
                    )}
                    <span className="text-[13px] text-text-secondary">
                      {item.queueDepth} unshipped{ageText}
                    </span>
                  </div>
                  <span className="text-[10px] font-mono font-medium px-1.5 py-0.5 border border-status-warning/30 text-status-warning shrink-0">
                    CI {item.ciState}
                  </span>
                </div>
              </div>
            );
          }

          return (
            <div
              key={item.workspaceId}
              className="border border-border-default rounded-[10px] px-4 py-3 bg-surface-2"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  {item.workspaceName && (
                    <span className="text-[10px] font-mono uppercase tracking-wide text-text-muted/80 block mb-0.5">
                      {item.workspaceName}
                    </span>
                  )}
                  <span className="text-[13px] font-medium text-text-primary">
                    {item.queueDepth} unshipped{ageText}
                  </span>
                </div>
                <Link
                  href="/app/missions"
                  className="text-[11px] text-text-muted hover:text-text-secondary shrink-0"
                >
                  Release →
                </Link>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
