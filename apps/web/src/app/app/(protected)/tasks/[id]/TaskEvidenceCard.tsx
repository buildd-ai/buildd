import type { TaskEvidence, TaskMismatch } from '@buildd/shared';
import Disclosure from '@/components/ui/Disclosure';
import { explainProviderAuthFailure } from '@/lib/provider-auth-failure';

/**
 * Key lines that are curated (failing test names, tsc errors, lint hits) stay
 * on the card. Unclassified or sign-in stderr is noise to a reader until they
 * ask for it, so it sits behind "Show raw output".
 */
const RAW_CLASSES = new Set(['unknown', 'auth']);

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
  // The plain next step is the action zone's (TaskActionZone); here the
  // card only names it and keeps the stderr folded.
  const auth = evidence ? explainProviderAuthFailure(evidence.keyLines.join('\n'), null) : null;
  const collapseRaw = !!evidence && (auth !== null || RAW_CLASSES.has(evidence.errorClass));
  const label = auth ? 'agent sign-in' : evidence?.errorClass.replace('_', ' ');
  const keyLines = evidence && evidence.keyLines.length > 0 ? (
    <pre className="font-mono text-meta text-text-primary whitespace-pre-wrap [overflow-wrap:anywhere] bg-surface-2 p-3 max-h-60 md:max-h-80 overflow-auto">
      {evidence.keyLines.join('\n')}
    </pre>
  ) : null;

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
          <summary className="cursor-pointer min-h-11 flex items-center px-4 py-3 font-mono text-eyebrow font-bold uppercase tracking-[2px] text-status-error select-none">
            Evidence · {label}
          </summary>
          <div className="px-4 pb-4 space-y-3 border-t border-border-default pt-3">
            {evidence.lastFailingCommand && (
              <div className="font-mono text-xs text-text-secondary [overflow-wrap:anywhere]">
                $ {evidence.lastFailingCommand.command}
                {evidence.lastFailingCommand.exitCode != null ? ` [exit ${evidence.lastFailingCommand.exitCode}]` : ''}
              </div>
            )}
            {keyLines && (collapseRaw ? (
              <Disclosure summary="Show raw output" count={evidence.keyLines.length}>
                {keyLines}
              </Disclosure>
            ) : keyLines)}
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
