import type { TaskEvidence, TaskMismatch } from '@buildd/shared';

/**
 * Why the task ended as it did: the compact record written on `result.evidence`
 * (error class, key lines, last failing command, CI checks) and any mismatch
 * between the agent's summary and what buildd recorded. Renders nothing for a
 * task that has neither.
 */
export default function TaskEvidenceCard({
  status,
  result,
}: {
  status: string;
  result: unknown;
}) {
  const r = (result ?? null) as { evidence?: TaskEvidence; mismatch?: TaskMismatch[] } | null;
  const evidence = r?.evidence ?? null;
  const mismatch = Array.isArray(r?.mismatch) ? r.mismatch : [];
  if (!evidence && mismatch.length === 0) return null;

  return (
    <div className="mb-6" id="task-evidence" data-testid="task-evidence">
      {mismatch.length > 0 && (
        <div data-testid="task-mismatch" className="card mb-3 border-l-4 border-status-warning p-4">
          <div className="font-mono text-[11px] md:text-[10px] uppercase tracking-[2.5px] text-status-warning mb-2">
            Summary and record disagree
          </div>
          <ul className="space-y-1 text-sm text-text-primary">
            {mismatch.map(m => (
              <li key={m.kind} className="[overflow-wrap:anywhere]">{m.detail}</li>
            ))}
          </ul>
        </div>
      )}
      {evidence && (
        <details className="card" open={status === 'failed'}>
          <summary className="cursor-pointer p-4 font-mono text-[11px] md:text-[10px] uppercase tracking-[2.5px] text-red-400 hover:text-red-300 select-none">
            Evidence · {evidence.errorClass.replace('_', ' ')}
          </summary>
          <div className="px-4 pb-4 space-y-3 border-t border-border-default pt-3">
            {evidence.lastFailingCommand && (
              <div className="font-mono text-xs text-text-secondary [overflow-wrap:anywhere]">
                $ {evidence.lastFailingCommand.command}
                {evidence.lastFailingCommand.exitCode != null ? ` [exit ${evidence.lastFailingCommand.exitCode}]` : ''}
              </div>
            )}
            {evidence.keyLines.length > 0 && (
              <pre className="font-mono text-xs text-text-primary whitespace-pre-wrap [overflow-wrap:anywhere] bg-surface-2 p-3 max-h-80 overflow-auto">
                {evidence.keyLines.join('\n')}
              </pre>
            )}
            {evidence.ciChecks && evidence.ciChecks.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {evidence.ciChecks.map(c => {
                  const cls = c.state === 'failed' ? 'text-status-error' : c.state === 'passed' ? 'text-status-success' : 'text-text-muted';
                  const body = <>{c.state === 'failed' ? '✗' : c.state === 'passed' ? '✓' : '…'} {c.name}</>;
                  return c.url ? (
                    <a key={c.name} href={c.url} target="_blank" rel="noopener noreferrer" className={`font-mono text-xs hover:underline ${cls}`}>{body}</a>
                  ) : (
                    <span key={c.name} className={`font-mono text-xs ${cls}`}>{body}</span>
                  );
                })}
              </div>
            )}
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-muted">
              <span>
                {evidence.diff.files} file{evidence.diff.files === 1 ? '' : 's'} · <span className="text-status-success">+{evidence.diff.added}</span>
                <span className="text-status-error">/-{evidence.diff.removed}</span>
              </span>
              {evidence.links.prUrl && <a href={evidence.links.prUrl} target="_blank" rel="noopener noreferrer" className="hover:underline">PR</a>}
              {evidence.links.ciRunUrl && <a href={evidence.links.ciRunUrl} target="_blank" rel="noopener noreferrer" className="hover:underline">CI run</a>}
              <a href="#agent-error-traces" className="hover:underline">Full trace</a>
            </div>
          </div>
        </details>
      )}
    </div>
  );
}
