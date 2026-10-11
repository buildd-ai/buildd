/**
 * The task page's one outcome row, from the record (lib/task-verdict.ts):
 * the state's word, the headline only where it adds to that word, and the
 * cause when there is one (docs/specs/task-page.md). It sits under the
 * Build → Audit → Land track, which carries where the delivery is; this says
 * what the run on screen came to.
 *
 * Compact by default: a chip and a line. It becomes a card only when it asks
 * for something (a primary or danger action, or failing checks to read).
 * There is no explanation disclosure: the decision ledger behind the wording
 * lives in the admin app.
 */
import Chip, { type ChipTone } from '@/components/ui/Chip';
import type { TaskVerdict, VerdictState } from '@/lib/task-verdict';

const STATE: Record<VerdictState, { label: string; tone: ChipTone }> = {
  shipped: { label: 'Shipped', tone: 'success' },
  done: { label: 'Done', tone: 'success' },
  blocked: { label: 'Blocked', tone: 'error' },
  failed: { label: 'Failed', tone: 'error' },
  needs_you: { label: 'Needs you', tone: 'warning' },
  in_progress: { label: 'In progress', tone: 'running' },
};

// The primary uses the shared button class (globals.css), so it matches every
// other primary action; the others are outlined.
const ACTION_CLASS = {
  primary: 'btn-primary',
  danger: 'border-status-error text-status-error hover:bg-status-error/10',
  quiet: 'border-border-strong text-text-primary hover:bg-surface-3',
} as const;

/** The headline minus what the chip already says: null when it says nothing more. */
export function headlineBeyondLabel(headline: string, label: string): string | null {
  const h = headline.trim();
  if (h.toLowerCase() === label.toLowerCase()) return null;
  const prefix = `${label} · `;
  return h.toLowerCase().startsWith(prefix.toLowerCase()) ? h.slice(prefix.length) : h;
}

export default function TaskVerdictBlock({
  verdict,
  displayStatus,
}: {
  verdict: TaskVerdict;
  /** The page's derived status, kept on the e2e hook. */
  displayStatus: string;
}) {
  const s = STATE[verdict.state];
  const label = verdict.label ?? s.label;
  const tone: ChipTone = verdict.labelTone ?? s.tone;
  const headline = headlineBeyondLabel(verdict.headline, label);
  const asks = verdict.failingChecks.length > 0 || verdict.actions.some(a => a.tone !== 'quiet');
  const chip = (
    <div data-testid="task-header-status" data-status={displayStatus} data-verdict={verdict.state} className="shrink-0">
      <Chip tone={tone} variant="soft">{label}</Chip>
    </div>
  );

  if (!asks) {
    return (
      <section
        aria-label="Outcome"
        data-testid="task-verdict"
        data-state={verdict.state}
        data-worded-by={verdict.wordedBy}
        className="mb-5 flex flex-wrap items-center gap-x-2.5 gap-y-1"
      >
        {chip}
        {headline && (
          <p data-testid="task-verdict-headline" className="min-w-0 text-body font-medium [overflow-wrap:anywhere]">{headline}</p>
        )}
        {verdict.actions.map(a => (
          <a
            key={a.label}
            href={a.href}
            {...(a.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
            data-testid="task-verdict-action"
            className="inline-flex min-h-11 items-center text-meta text-accent-text hover:underline"
          >
            {a.label}{a.external ? ' ↗' : ''}
          </a>
        ))}
        {verdict.cause && (
          <p data-testid="task-verdict-cause" className="w-full text-meta text-text-secondary [overflow-wrap:anywhere]">{verdict.cause}</p>
        )}
      </section>
    );
  }

  return (
    <section
      aria-label="Outcome"
      data-testid="task-verdict"
      data-state={verdict.state}
      data-worded-by={verdict.wordedBy}
      // L2 (a hairline card); L3 only when it asks you for a decision. The chip carries the tone.
      className={`mb-6 px-4 py-3 md:px-5 ${verdict.state === 'needs_you' ? 'card-decision' : 'card'}`}
    >
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        {chip}
        {headline && (
          <h2 data-testid="task-verdict-headline" className="min-w-0 text-body font-semibold leading-snug [overflow-wrap:anywhere]">{headline}</h2>
        )}
      </div>
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
        <div data-testid="task-verdict-actions" className="mt-3 flex flex-col gap-2 md:flex-row md:flex-wrap">
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
    </section>
  );
}
