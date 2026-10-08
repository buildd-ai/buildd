/**
 * The task page's first block: one verdict, from the record (lib/task-verdict.ts).
 * State, one-sentence headline, the fact behind it (a failing check shows its
 * name and first error line inline), up to three actions, and a "Why this?"
 * disclosure naming the rule and any decision-ledger rows behind the wording.
 *
 * Nothing below this block restates the state: the shipped header's chips,
 * "Your move" and "already handled" row are gone.
 */
import Chip, { type ChipTone } from '@/components/ui/Chip';
import Disclosure from '@/components/ui/Disclosure';
import type { StoredVerdictDecision, TaskVerdict, VerdictState } from '@/lib/task-verdict';

const STATE: Record<VerdictState, { label: string; tone: ChipTone; border: string }> = {
  shipped: { label: 'Shipped', tone: 'success', border: 'border-status-success' },
  done: { label: 'Done', tone: 'success', border: 'border-status-success' },
  blocked: { label: 'Blocked', tone: 'error', border: 'border-status-error' },
  failed: { label: 'Failed', tone: 'error', border: 'border-status-error' },
  needs_you: { label: 'Needs you', tone: 'warning', border: 'border-status-warning' },
  in_progress: { label: 'In progress', tone: 'running', border: 'border-status-running' },
};

// The primary uses the shared button class (globals.css), so it matches every
// other primary action; the others are outlined.
const ACTION_CLASS = {
  primary: 'btn-primary',
  danger: 'border-status-error text-status-error hover:bg-status-error/10',
  quiet: 'border-border-strong text-text-primary hover:bg-surface-3',
} as const;

const KIND_LABEL: Record<StoredVerdictDecision['decisionIds'][number]['kind'], string> = {
  headline: 'Wording and actions',
  mismatch_diagnosis: 'Mismatch diagnosis',
  error_class: 'Error classification',
};

export default function TaskVerdictBlock({
  verdict,
  decision,
  displayStatus,
}: {
  verdict: TaskVerdict;
  /** The cached decision on the task, as stored (applied or not). */
  decision: StoredVerdictDecision | null;
  /** The page's derived status, kept on the e2e hook. */
  displayStatus: string;
}) {
  const s = STATE[verdict.state];
  const decisionCurrent = !!decision && decision.state === verdict.state && decision.causeKey === verdict.causeKey;
  return (
    <section
      aria-label="Where this task stands"
      data-testid="task-verdict"
      data-state={verdict.state}
      data-worded-by={verdict.wordedBy}
      className={`mb-6 border-2 border-l-[6px] bg-card px-4 py-4 shadow-[var(--card-shadow)] md:px-5 ${s.border}`}
    >
      <div data-testid="task-header-status" data-status={displayStatus} data-verdict={verdict.state}>
        <Chip tone={s.tone} variant="soft">{s.label}</Chip>
      </div>
      <h2 data-testid="task-verdict-headline" className="mt-2 text-heading font-semibold leading-snug [overflow-wrap:anywhere]">
        {verdict.headline}
      </h2>
      {verdict.cause && (
        <p data-testid="task-verdict-cause" className="mt-1.5 text-body text-text-secondary [overflow-wrap:anywhere]">{verdict.cause}</p>
      )}
      {verdict.failingChecks.length > 0 && (
        <ul data-testid="task-verdict-checks" className="mt-3 flex flex-col border-t border-border-default">
          {verdict.failingChecks.map(c => {
            const body = (
              <>
                <span aria-hidden="true" className="w-4 shrink-0 text-status-error">✗</span>
                <span className="min-w-0 flex-1">
                  <span className="font-mono text-body font-semibold text-status-error [overflow-wrap:anywhere]">{c.name}</span>
                  {c.line && <span className="block font-mono text-meta text-text-primary whitespace-pre-wrap [overflow-wrap:anywhere]">{c.line}</span>}
                </span>
                {c.url && <span className="shrink-0 text-meta text-accent-text">log ↗</span>}
              </>
            );
            const cls = 'flex min-h-11 items-start gap-2 border-b border-border-default py-2';
            return (
              <li key={c.name} data-testid="task-verdict-check">
                {c.url
                  ? <a href={c.url} target="_blank" rel="noopener noreferrer" className={`${cls} hover:bg-surface-2`}>{body}</a>
                  : <div className={cls}>{body}</div>}
              </li>
            );
          })}
        </ul>
      )}
      {verdict.actions.length > 0 && (
        <div data-testid="task-verdict-actions" className="mt-4 flex flex-col gap-2 md:flex-row md:flex-wrap">
          {verdict.actions.map(a => (
            <a
              key={a.label}
              href={a.href}
              {...(a.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
              data-testid="task-verdict-action"
              className={`inline-flex min-h-11 w-full items-center justify-center border-2 px-4 text-body font-medium md:w-auto ${ACTION_CLASS[a.tone]}`}
            >
              {a.label}{a.external ? ' ↗' : ''}
            </a>
          ))}
        </div>
      )}
      <div className="mt-3 border-t border-border-default" data-testid="task-verdict-why">
        <Disclosure summary={<span className="font-mono text-meta uppercase tracking-[1px] text-text-muted">Why this?</span>}>
          <div className="pb-2 pt-1 text-meta text-text-secondary space-y-1.5">
            <p>
              The state comes from the record (pull request, checks, attempts, workers), never from the agent&apos;s summary.
              {verdict.wordedBy === 'model'
                ? ' The wording and actions were chosen by the decision model for this exact state.'
                : ' The wording is the rules’ own.'}
            </p>
            {decision && decisionCurrent && decision.fallback && decision.decisionIds.length > 0 && (
              <p>The decision model was not applied this time (unavailable or not confident), so the rules&apos; wording stands.</p>
            )}
            {decision && !decisionCurrent && (
              <p>The last model decision was made for an earlier state; it is not used.</p>
            )}
            {decision && decision.decisionIds.length > 0 && (
              <ul data-testid="task-verdict-decisions" className="font-mono">
                {decision.decisionIds.map(d => (
                  <li key={d.id} className="[overflow-wrap:anywhere]">
                    {KIND_LABEL[d.kind]} · {d.status} · <span title={d.id}>{d.id.slice(0, 8)}</span>
                  </li>
                ))}
                <li className="text-text-muted">
                  Decision ledger: task_verdict{decision.model ? ` · ${decision.model}` : ''}
                </li>
              </ul>
            )}
          </div>
        </Disclosure>
      </div>
    </section>
  );
}
