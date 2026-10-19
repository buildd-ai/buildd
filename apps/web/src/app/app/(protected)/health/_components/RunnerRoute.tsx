import { runnerRouteDetail, type RouteState, type RunnerRouteInput } from '@/lib/runner-route-health';

const STATE_CLASS: Record<RouteState, string> = {
  ready: 'text-status-success',
  unavailable: 'text-status-warning',
  unknown: 'text-text-muted',
};
const STATE_TEXT: Record<RouteState, string> = { ready: 'ready', unavailable: 'not set up', unknown: 'unknown' };

/**
 * The model route and credential type a runner reported (capacity spec R-11),
 * shown in expanded runner detail. A label only; no secret is read or sent.
 */
export function RunnerRoute({ runner }: { runner: RunnerRouteInput }) {
  const d = runnerRouteDetail(runner);
  return (
    <div data-testid="runner-route" className="px-4 pb-3 space-y-1 text-xs">
      <p className="text-text-secondary">Model login</p>
      <ul className="space-y-0.5">
        {d.rows.map(r => (
          <li key={r.label} className="flex justify-between gap-3">
            <span className="text-text-secondary break-words">{r.label}: {r.source}</span>
            <span className={`shrink-0 ${STATE_CLASS[r.state]}`}>{STATE_TEXT[r.state]}</span>
          </li>
        ))}
      </ul>
      {d.taskRoutes.length > 0 && (
        <>
          <p className="text-text-secondary pt-1">Recent task routes</p>
          <ul data-testid="runner-task-routes" className="space-y-0.5">
            {d.taskRoutes.map(r => (
              <li key={r.route} className="flex justify-between gap-3">
                <span className="text-text-secondary break-words">{r.source}</span>
                <span className="shrink-0 text-text-muted">{r.count} {r.count === 1 ? 'run' : 'runs'}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="text-text-muted">{d.note}</p>
    </div>
  );
}
