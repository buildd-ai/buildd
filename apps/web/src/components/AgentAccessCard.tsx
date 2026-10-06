/**
 * Agent access card on /app/health (Runners): whether runs are getting the access
 * they need, and what agents were refused. Read server-side from
 * agent_capability_decisions (lib/agent-capabilities/access-log.ts).
 *
 * Only what someone should act on: grant failures with their fix, then the
 * refusals by reason. A quiet day is one line. Pure render: no hooks, no
 * fetches.
 */
import { Stat } from '@/components/StatTile';
import type { AgentAccessReport } from '@/lib/agent-capabilities/access-log';

export function AgentAccessSection({ report }: { report: AgentAccessReport | null }) {
  if (!report) return null;
  const refusedTotal = report.refusals.reduce((n, r) => n + r.count, 0);
  const quiet = report.healthy && refusedTotal === 0;
  const verdict = !report.healthy
    ? 'Some runs could not get the access they need.'
    : refusedTotal > 0
      ? `Runs got the access they needed. Agents were refused ${refusedTotal} ${refusedTotal === 1 ? 'action' : 'actions'} outside their task.`
      : 'Runs got the access they needed, and no agent reached outside its task.';

  return (
    <div data-testid="health-section-agent-access" className="mb-6">
      <div className="flex items-baseline justify-between gap-3 mb-3">
        <h3 className="text-xs font-medium text-text-secondary">Agent access</h3>
        <span className="text-meta text-text-muted">last {report.windowHours}h</span>
      </div>
      <div className="card p-4 space-y-4">
        <p
          data-testid="agent-access-verdict"
          data-healthy={report.healthy ? 'true' : 'false'}
          className={`text-sm font-medium ${report.healthy ? 'text-status-success' : 'text-status-error'}`}
        >
          {verdict}
        </p>

        {report.grantProblems.length > 0 && (
          <ul data-testid="agent-access-problems" className="space-y-2">
            {report.grantProblems.map(p => (
              <li key={`${p.workspaceId}-${p.reason}`} className="border-l-2 border-status-error pl-2">
                <p className="text-body text-text-primary">
                  {p.workspaceName}: {p.reason} <span className="text-text-muted">({p.count}×)</span>
                </p>
                {p.fix && <p className="text-meta text-text-secondary">{p.fix}</p>}
              </li>
            ))}
          </ul>
        )}

        {!quiet && (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 pt-3 border-t border-border-default">
            <Stat label="Access granted" value={String(report.granted)} sub={report.adminGranted > 0 ? `${report.adminGranted} at admin level` : 'repo, model, token'} />
            <Stat label="Grant problems" value={String(report.grantProblems.reduce((n, p) => n + p.count, 0))} sub="need a fix" />
            <Stat label="Refused actions" value={String(refusedTotal)} sub="outside their task" />
          </div>
        )}

        {report.refusals.length > 0 && (
          <div data-testid="agent-access-refusals" className="pt-3 border-t border-border-default">
            <ul className="space-y-1">
              {report.refusals.map(r => (
                <li key={`${r.label}-${r.reason}`} className="flex items-baseline justify-between gap-3 text-body">
                  <span className="text-text-secondary min-w-0">{r.label} <span className="text-text-muted">· {r.reason}</span></span>
                  <span className="text-meta text-text-primary tabular-nums shrink-0">{r.count}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
