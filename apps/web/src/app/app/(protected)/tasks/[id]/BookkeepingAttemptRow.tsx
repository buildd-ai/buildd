import type { ReactNode } from 'react';
import LocalTime from '../LocalTime';
import type { BookkeepingRetry } from './bookkeeping-attempt';

/**
 * Worker-history row for an attempt that never started a session while the
 * task is still queued to run again. One neutral line; everything diagnostic
 * (error, runner, branch, ids) sits behind a native `<details>`, which is
 * keyboard- and screen-reader-operable without script.
 */
export default function BookkeepingAttemptRow({
  workerId,
  retry,
  attemptLabel,
  children,
}: {
  workerId: string;
  retry: BookkeepingRetry;
  attemptLabel?: string | null;
  children: ReactNode;
}) {
  return (
    <details
      data-worker-id={workerId}
      data-testid="worker-history-bookkeeping"
      className="group border-b border-border-default/40 last:border-b-0"
    >
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-3 px-3 py-2 text-body text-text-secondary hover:bg-surface-3 md:px-4 [&::-webkit-details-marker]:hidden">
        <span aria-hidden="true" className="w-7 shrink-0 text-center text-text-muted">○</span>
        <span className="min-w-0 flex-1">
          Session didn&apos;t start ·{' '}
          {retry.kind === 'scheduled'
            ? <>retry scheduled for <LocalTime iso={retry.atIso} /></>
            : 'retry queued'}
          {attemptLabel && <span className="text-text-muted"> · {attemptLabel}</span>}
        </span>
        <span aria-hidden="true" className="shrink-0 text-meta text-text-muted group-open:rotate-90">›</span>
        <span className="sr-only">Show attempt details</span>
      </summary>
      <div className="space-y-1 px-3 pb-3 pl-14 text-meta text-text-muted md:px-4 md:pl-[3.75rem] [overflow-wrap:anywhere]">
        <p>A runner claimed this attempt but no session began. Kept as a bookkeeping record.</p>
        {children}
      </div>
    </details>
  );
}
