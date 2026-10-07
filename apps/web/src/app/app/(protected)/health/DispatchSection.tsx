/**
 * Dispatch on /app/health: the delivery transport's state for the viewer's
 * team. Renders the same report the `dispatch_health` MCP action prints
 * (lib/dispatch-health.ts, one implementation), read server-side in page.tsx.
 * Pure render: no hooks, no fetches, so it imports nothing that touches the DB.
 */
import Chip, { type ChipTone } from '@/components/ui/Chip';
import { Stat } from '@/components/StatTile';
import { formatDuration, type DispatchHealthReport, type DispatchWorkerStatus } from '@buildd/core/dispatch-health-report';

const WORKER: Record<DispatchWorkerStatus['status'], { tone: ChipTone; label: string }> = {
  reachable: { tone: 'success', label: 'Worker reachable' },
  unreachable: { tone: 'error', label: 'Worker unreachable' },
  unconfigured: { tone: 'muted', label: 'Worker not configured' },
};

const TRANSPORT_LABEL: Record<string, string> = { in_app: 'in app', shadow: 'shadow', dispatch: 'dispatch' };

export function DispatchSection({ report, now }: { report: DispatchHealthReport | null; now: number }) {
  if (!report || report.workspaces.length === 0) return null;
  const o = report.outbox;
  const worker = WORKER[report.worker.status];
  const workerTone: ChipTone = report.worker.status === 'reachable' && report.worker.workerConfigured === false ? 'warning' : worker.tone;
  const routes = Object.entries(o.deliveredVia).sort((a, b) => b[1] - a[1]);
  const off = report.workspaces.filter(w => w.transport !== 'dispatch');
  const repair = report.lastRepair;
  const rc = repair?.reconcile ?? null;
  const latency = o.latencyMs.samples > 0
    ? `p50 ${formatDuration(o.latencyMs.p50)}, p95 ${formatDuration(o.latencyMs.p95)}`
    : 'no samples';

  return (
    <div data-testid="health-section-dispatch" className="mb-6">
      <div className="flex items-baseline justify-between gap-3 mb-3">
        <h3 className="text-xs font-medium text-text-secondary">Dispatch</h3>
        <span className="text-meta text-text-muted">
          {report.workspaces.length} {report.workspaces.length === 1 ? 'workspace' : 'workspaces'}
        </span>
      </div>
      <div className="card p-4 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <p
            data-testid="dispatch-verdict"
            data-healthy={report.healthy ? 'true' : 'false'}
            className={`text-sm font-medium ${report.healthy ? 'text-status-success' : 'text-status-error'}`}
          >
            {report.verdict}
          </p>
          <Chip
            tone={workerTone}
            data-testid="dispatch-worker"
            title={report.worker.error ?? undefined}
            trailing={report.worker.ms !== undefined ? `${report.worker.ms}ms` : undefined}
          >
            {worker.label}
          </Chip>
        </div>

        {report.problems.length > 1 && (
          <ul data-testid="dispatch-problems" className="space-y-1 text-xs text-text-secondary">
            {report.problems.map(p => (
              <li key={p} className="border-l-2 border-status-error pl-2">{p}</li>
            ))}
          </ul>
        )}

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5 pt-3 border-t border-border-default">
          <Stat label="Pending" value={String(o.pending)} sub={`${o.due} due, ${o.overdue} overdue`} />
          <Stat label="Handed off" value={String(o.handedOff)} sub={`${o.orphaned} orphaned`} />
          <Stat label="Unacked" value={String(o.unacked)} sub={`${o.unackedStale} past fallback`} />
          <Stat label="Failed 24h" value={String(o.failed24h)} sub={`${o.delivering} delivering, ${o.stuck} stuck`} />
          <Stat label="Delivered 24h" value={String(o.delivered24h)} sub={latency} />
        </div>

        <div data-testid="dispatch-routes" className="pt-3 border-t border-border-default text-xs text-text-secondary">
          {routes.length === 0 ? (
            <span className="text-text-muted">No deliveries in 24h.</span>
          ) : (
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
              <span className="text-text-muted">By route</span>
              {routes.map(([via, n]) => (
                <span key={via} className="tabular-nums">{via} <span className="text-text-primary">{n}</span></span>
              ))}
            </div>
          )}
        </div>

        <p data-testid="dispatch-last-repair" className="text-xs text-text-secondary">
          {!repair ? (
            <span className="text-text-muted">No repair run recorded.</span>
          ) : (
            <>
              <span className="text-text-muted">Last repair run</span>{' '}
              {formatDuration(now - Date.parse(repair.at))} ago, all teams
              {repair.ok ? '' : ' (failed)'}
              {rc
                ? `: checked ${rc.checked}, republished ${rc.republished}, projected ${rc.projected}, taken back ${rc.fellBack}, left ${rc.left}, Worker errors ${rc.workerErrors}`
                : repair.reconcileError ? `: reconcile failed (${repair.reconcileError})` : ''}
            </>
          )}
        </p>

        {off.length > 0 && (
          <div data-testid="dispatch-kill-switch" className="text-xs text-text-secondary">
            <span className="text-status-warning">Not on dispatch</span>{' '}
            {off.map((w, i) => (
              <span key={w.id}>
                {i > 0 ? ', ' : ''}{w.name} <span className="text-text-muted">{TRANSPORT_LABEL[w.transport] ?? w.transport}</span>
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
