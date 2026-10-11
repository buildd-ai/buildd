/**
 * Agent access on Health → Failures: what someone should act on, nothing else.
 * Read server-side from agent_capability_decisions
 * (lib/agent-capabilities/access-log.ts).
 *
 *   - Access problems: a run could not get the access it needs to start (a
 *     setup fault), by workspace and cause, with its fix.
 *   - Blocked actions: an agent tried something outside its own task, by
 *     action and reason. The guardrail worked; repeats are still worth seeing.
 *
 * A day with neither renders nothing. Pure render: no hooks, no fetches.
 */
import type { AgentAccessReport } from '@/lib/agent-capabilities/access-log';

export function AgentAccessSection({ report }: { report: AgentAccessReport | null }) {
  if (!report) return null;
  const { grantProblems, refusals } = report;
  if (grantProblems.length === 0 && refusals.length === 0) return null;

  return (
    <div data-testid="health-section-agent-access" className="mb-6 space-y-6">
      {grantProblems.length > 0 && (
        <div data-testid="agent-access-problems">
          <div className="mb-3 flex items-baseline justify-between gap-3">
            <h3 className="text-xs font-medium text-text-secondary">Access problems</h3>
            <span className="text-meta text-text-muted">last {report.windowHours}h</span>
          </div>
          <ul className="card divide-y divide-border-default">
            {grantProblems.map(p => (
              <li key={`${p.workspaceId}-${p.reason}`} className="px-4 py-3">
                <p className="text-body text-text-primary">
                  {p.workspaceName}: {p.reason} <span className="text-text-muted">({p.count}×)</span>
                </p>
                {p.fix && <p className="mt-0.5 text-meta text-text-secondary">{p.fix}</p>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {refusals.length > 0 && (
        <div data-testid="agent-access-refusals">
          <div className="mb-3 flex items-baseline justify-between gap-3">
            <h3 className="text-xs font-medium text-text-secondary">Blocked actions</h3>
            <span className="text-meta text-text-muted">outside their task · last {report.windowHours}h</span>
          </div>
          <ul className="card divide-y divide-border-default">
            {refusals.map(r => (
              <li key={`${r.label}-${r.reason}`} className="flex items-baseline justify-between gap-3 px-4 py-2.5 text-body">
                <span className="min-w-0 text-text-secondary">{r.label} <span className="text-text-muted">· {r.reason}</span></span>
                <span className="shrink-0 text-meta tabular-nums text-text-primary">{r.count}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
