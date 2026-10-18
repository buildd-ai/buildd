import type { ReactNode } from 'react';
import LocalTime from '../LocalTime';
import type { BookkeepingRetry } from './bookkeeping-attempt';

const TIMES = ['', 'once', 'twice'];

/**
 * Worker-history row for one or more attempts in a row that never started a
 * session. One neutral line, whether or not the task will run again; the
 * diagnostics of each (error, runner, branch, ids) sit behind a native
 * `<details>`, which is keyboard- and screen-reader-operable without script.
 */
export default function BookkeepingAttemptRow({
  workerId,
  retry,
  attemptLabel,
  count = 1,
  undelivered = false,
  children,
}: {
  workerId: string;
  retry: BookkeepingRetry;
  attemptLabel?: string | null;
  /** How many consecutive rows this line stands for. */
  count?: number;
  /** Every one of them was a claim the runner never received. */
  undelivered?: boolean;
  children: ReactNode;
}) {
  const what = undelivered ? "Claim didn't reach the runner" : "Session didn't start";
  const times = count > 1 ? ` ${TIMES[count] ?? `${count} times`}` : '';
  return (
    <details
      data-worker-id={workerId}
      data-testid="worker-history-bookkeeping"
      className="group border-b border-border-default/40 last:border-b-0"
    >
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-3 px-3 py-2 text-body text-text-secondary hover:bg-surface-3 md:px-4 [&::-webkit-details-marker]:hidden">
        <span aria-hidden="true" className="w-7 shrink-0 text-center text-text-muted">○</span>
        <span className="min-w-0 flex-1">
          {what}{times} ·{' '}
          {retry.kind === 'scheduled'
            ? <>retry scheduled for <LocalTime iso={retry.atIso} /></>
            : retry.kind === 'queued' ? 'retry queued' : 'nothing ran, not counted as a failure'}
          {attemptLabel && count === 1 && <span className="text-text-muted"> · {attemptLabel}</span>}
        </span>
        <span aria-hidden="true" className="shrink-0 text-meta text-text-muted group-open:rotate-90">›</span>
        <span className="sr-only">Show attempt details</span>
      </summary>
      <div className="space-y-1 px-3 pb-3 pl-14 text-meta text-text-muted md:px-4 md:pl-[3.75rem] [overflow-wrap:anywhere]">
        <p>
          {undelivered
            ? 'buildd handed this attempt to a runner, but the runner never received it, so buildd took it back.'
            : 'The runner took this attempt but never started it.'}
        </p>
        {children}
      </div>
    </details>
  );
}
