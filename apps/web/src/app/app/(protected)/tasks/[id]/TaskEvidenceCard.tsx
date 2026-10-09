import type { TaskEvidence, TaskMismatch } from '@buildd/shared';
import Disclosure from '@/components/ui/Disclosure';
import { explainProviderAuthFailure } from '@/lib/provider-auth-failure';
import { isExplorationNoise } from '@/lib/trace-consequence';
import type { VerdictCheck } from '@/lib/task-verdict';

/** Mismatches whose evidence is a check on the PR, not anything the agent ran. */
const CHECK_MISMATCHES = new Set(['success_with_red_check', 'fix_check_still_red']);

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
  workerError = null,
  backend = null,
  failingChecks = [],
}: {
  status: string;
  result: unknown;
  /** The latest worker's error: a sign-in failure is recognised from it too. */
  workerError?: string | null;
  backend?: 'claude' | 'codex' | null;
  /** The red checks behind the verdict (lib/task-verdict.ts), with their first error line. */
  failingChecks?: readonly VerdictCheck[];
}) {
  const r = (result ?? null) as { evidence?: TaskEvidence; mismatch?: TaskMismatch[] } | null;
  const evidence = r?.evidence ?? null;
  const mismatch = Array.isArray(r?.mismatch) ? r.mismatch : [];
  if (!evidence && mismatch.length === 0) return null;
  // Records written before exploration noise was filtered at the source can
  // name a grep that matched nothing as the "last failing command", with its
  // output as the key lines and its wording as the class. None of that is
  // evidence of anything; drop it here too.
  const noiseCommand = !!evidence?.lastFailingCommand && isExplorationNoise({
    pattern: 'bash_nonzero_exit',
    excerpt: `$ ${evidence.lastFailingCommand.command} [exit ${evidence.lastFailingCommand.exitCode ?? '?'}]`,
  });
  const noiseLines = noiseCommand && evidence?.keyLinesSource === 'traces';
  // Only the red checks, never the whole list (the PR history has that). A
  // red-check mismatch is evidenced by the check: its row and its line, from
  // the verdict, which read them off the CI record.
  const checkMismatch = mismatch.some(m => CHECK_MISMATCHES.has(m.kind));
  const redChecks: ReadonlyArray<Pick<VerdictCheck, 'name' | 'url' | 'line'>> = checkMismatch && failingChecks.length > 0
    ? failingChecks
    : (evidence?.ciChecks ?? []).filter(c => c.state === 'failed').map(c => ({ name: c.name, url: c.url, line: null }));
  // The plain next step is the action zone's (TaskActionZone); here the
  // card only names it and keeps the stderr folded.
  const auth = evidence
    ? explainProviderAuthFailure([...evidence.keyLines, workerError ?? ''].join('\n'), backend)
    : null;
  // A sign-in failure the action zone already explains, with nothing else
  // recorded (no failing command, no failed check, no diff), adds only noise.
  const curated = !!evidence && (
    (!!evidence.lastFailingCommand && !noiseCommand)
    || (evidence.ciChecks ?? []).some(c => c.state === 'failed')
    || (evidence.diff?.files ?? 0) > 0
  );
  const showEvidence = !!evidence && !(auth && !curated);
  if (!showEvidence && mismatch.length === 0) return null;
  const collapseRaw = !!evidence && (auth !== null || RAW_CLASSES.has(evidence.errorClass));
  // The label names what the card shows: the check when it shows a check,
  // the error class only when the class came from real evidence.
  const label = auth
    ? 'agent sign-in'
    : redChecks.length > 0 && (noiseLines || !evidence?.lastFailingCommand)
      ? 'failing check'
      : evidence && !noiseLines && evidence.errorClass !== 'unknown' ? evidence.errorClass.replace('_', ' ') : null;
  const keyLines = evidence && !noiseLines && evidence.keyLines.length > 0 ? (
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
      {evidence && showEvidence && (
        <details className="card" open={status === 'failed'}>
          <summary className="cursor-pointer min-h-11 flex items-center px-4 py-3 font-mono text-eyebrow font-bold uppercase tracking-[2px] text-status-error select-none">
            Evidence{label ? ` · ${label}` : ''}
          </summary>
          <div className="px-4 pb-4 space-y-3 border-t border-border-default pt-3">
            {redChecks.length > 0 && (
              <ul data-testid="task-evidence-checks" className="space-y-1.5">
                {redChecks.map(c => (
                  <li key={c.name} className="font-mono text-xs [overflow-wrap:anywhere]">
                    {c.url
                      ? <a href={c.url} target="_blank" rel="noopener noreferrer" className="text-status-error hover:underline">✗ {c.name}</a>
                      : <span className="text-status-error">✗ {c.name}</span>}
                    {c.line && <div className="mt-0.5 text-text-primary whitespace-pre-wrap">{c.line}</div>}
                  </li>
                ))}
              </ul>
            )}
            {evidence.lastFailingCommand && !noiseCommand && (
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
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-muted">
              <span>
                {evidence.diff.files} file{evidence.diff.files === 1 ? '' : 's'} · <span className="text-status-success">+{evidence.diff.added}</span>
                <span className="text-status-error">/-{evidence.diff.removed}</span>
              </span>
              {evidence.links.prUrl && <a href={evidence.links.prUrl} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 min-w-11 items-center hover:underline md:min-h-0 md:min-w-0">PR</a>}
              {evidence.links.ciRunUrl && <a href={evidence.links.ciRunUrl} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 min-w-11 items-center hover:underline md:min-h-0 md:min-w-0">CI run</a>}
              <a href="#agent-error-traces" className="inline-flex min-h-11 min-w-11 items-center hover:underline md:min-h-0 md:min-w-0">Full trace</a>
            </div>
          </div>
        </details>
      )}
    </div>
  );
}
