import type { RunningStatusLine } from './status-line';

/**
 * `Running 12m` under the title, with the running hatch the mission bar uses
 * (globals.css `.state-cell[data-look="running"]`). A stalled run is amber.
 * Keeps the page's `task-header-status` hook for e2e.
 */
export default function TaskStatusLine({ line, displayStatus }: { line: RunningStatusLine; displayStatus: string }) {
  return (
    <p
      data-testid="task-header-status"
      data-status={displayStatus}
      data-verdict="in_progress"
      data-stalled={line.stalled ? 'true' : undefined}
      className={`mt-2 flex items-center gap-2 text-body font-medium ${line.stalled ? 'text-status-warning' : 'text-text-primary'}`}
      suppressHydrationWarning
    >
      <span aria-hidden="true" data-look="running" data-drift className="state-cell inline-block h-3.5 w-3.5 shrink-0 rounded-[3px]" />
      {line.text}
    </p>
  );
}
