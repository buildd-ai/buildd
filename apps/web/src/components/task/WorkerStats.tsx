export interface WorkerStatsProps {
  turns?: number | null;
  commitCount?: number | null;
  costUsd?: string | number | null;
  branch?: string | null;
}

/**
 * The run's shape once a worker is no longer live — turns / commits / cost /
 * branch. Shared by the task detail page and the mission task drawer so a
 * finished run reads the same in both. (Live workers own these numbers via
 * their real-time view; render this only for non-live workers.)
 */
export default function WorkerStats({ turns, commitCount, costUsd, branch }: WorkerStatsProps) {
  const cost = costUsd != null ? Number(costUsd) : null;
  const hasAny =
    turns != null || (commitCount != null && commitCount > 0) || cost != null || !!branch;
  if (!hasAny) return null;

  return (
    <div className="rounded-lg border border-border-default p-4 space-y-3">
      <div className="grid grid-cols-2 gap-2 text-[12px]">
        {turns != null && (
          <div>
            <span className="text-text-muted">Turns:</span>{' '}
            <span className="text-text-primary">{turns}</span>
          </div>
        )}
        {commitCount != null && commitCount > 0 && (
          <div>
            <span className="text-text-muted">Commits:</span>{' '}
            <span className="text-text-primary">{commitCount}</span>
          </div>
        )}
        {cost != null && (
          <div>
            <span className="text-text-muted">Cost:</span>{' '}
            <span className="text-text-primary">${cost.toFixed(3)}</span>
          </div>
        )}
      </div>
      {branch && (
        <div className="text-[12px]">
          <span className="text-text-muted">Branch:</span>{' '}
          <span className="text-text-primary font-mono text-[11px] break-all">{branch}</span>
        </div>
      )}
    </div>
  );
}
