'use client';

import Link from 'next/link';

interface ReleaseRowProps {
  release: {
    id: string;
    workspaceId: string;
    archetype: string | null;
    state: string;
    dispatchedAt: string | Date | null;
    deployedAt: string | Date | null;
    commitsAheadAtDispatch: number | null;
    previousSha: string | null;
    headSha: string | null;
    version: string | null;
    runUrl: string | null;
    failureReason: string | null;
  };
  workspaceName: string;
  commitRangeUrl: string | null;
  metrics: { taskCount: number; missionCount: number };
  stateBadge: { label: string; cls: string };
  archetypeBadge: { label: string; cls: string };
}

function relativeTime(iso: string | Date | null): string {
  if (!iso) return '—';
  const date = typeof iso === 'string' ? new Date(iso) : iso;
  const diff = Date.now() - date.getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function ReleaseRow({
  release,
  workspaceName,
  commitRangeUrl,
  metrics,
  stateBadge,
  archetypeBadge,
}: ReleaseRowProps) {
  return (
    <Link
      href={`/app/releases/${release.id}`}
      className="card p-4 hover:bg-surface-hover transition-colors cursor-pointer"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-2">
            <h2 className="font-medium text-text-primary truncate">{workspaceName}</h2>
            <span className={`text-[10px] font-mono font-medium px-1.5 py-0.5 border uppercase tracking-wide ${stateBadge.cls}`}>
              {stateBadge.label}
            </span>
            <span className={`text-[10px] font-mono font-medium px-1.5 py-0.5 border uppercase tracking-wide ${archetypeBadge.cls}`}>
              {archetypeBadge.label}
            </span>
            {release.version && (
              <span className="text-[11px] font-mono text-text-secondary">{release.version}</span>
            )}
          </div>

          <div className="flex items-center gap-4 flex-wrap text-[12px] text-text-secondary">
            {release.dispatchedAt && (
              <span className="font-mono">{relativeTime(release.dispatchedAt)}</span>
            )}
            {release.deployedAt && (
              <span className="font-mono">deployed {relativeTime(release.deployedAt)}</span>
            )}
            {release.commitsAheadAtDispatch != null && (
              <span className="font-mono">{release.commitsAheadAtDispatch} commit{release.commitsAheadAtDispatch !== 1 ? 's' : ''}</span>
            )}
            {commitRangeUrl && (
              <a
                href={commitRangeUrl}
                onClick={(e) => e.stopPropagation()}
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono text-primary hover:underline"
              >
                {release.previousSha?.slice(0, 7)}...{release.headSha?.slice(0, 7)}
              </a>
            )}
          </div>

          {(metrics.taskCount > 0 || metrics.missionCount > 0) && (
            <div className="flex items-center gap-4 flex-wrap text-[11px] text-text-muted mt-2">
              {metrics.taskCount > 0 && (
                <span className="font-mono">{metrics.taskCount} task{metrics.taskCount !== 1 ? 's' : ''}</span>
              )}
              {metrics.missionCount > 0 && (
                <span className="font-mono">{metrics.missionCount} mission{metrics.missionCount !== 1 ? 's' : ''}</span>
              )}
            </div>
          )}

          {release.failureReason && (
            <div className="mt-2 text-[11px] text-status-error font-mono">{release.failureReason}</div>
          )}
        </div>

        {release.runUrl && (
          <a
            href={release.runUrl}
            onClick={(e) => e.stopPropagation()}
            target="_blank"
            rel="noopener noreferrer"
            className="shrink-0 text-[11px] font-mono text-primary hover:underline"
          >
            Run →
          </a>
        )}
      </div>
    </Link>
  );
}
