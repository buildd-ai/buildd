import type { ReactNode } from 'react';

/**
 * One check as one row (spec 072de598 I-22): a status icon, the check name, a
 * short state word and one mono detail. The whole row is the link to its
 * target, so there is no Open button; an `action` (Skip) is a control inside
 * the row, laid over the link rather than nested in it. The six icons differ
 * in shape, so they read apart in greyscale.
 */
export type CheckRowStatus = 'passed' | 'running' | 'queued' | 'skipped' | 'failed' | 'review';

export const CHECK_STATUSES: readonly CheckRowStatus[] = ['passed', 'running', 'queued', 'skipped', 'failed', 'review'];

export const CHECK_STATE_WORD: Record<CheckRowStatus, string> = {
  passed: 'Passed', running: 'Running', queued: 'Queued', skipped: 'Skipped', failed: 'Failed', review: 'Needs review',
};

const TONE: Record<CheckRowStatus, string> = {
  passed: 'text-status-success',
  running: 'text-accent-text',
  queued: 'text-text-muted',
  skipped: 'text-text-muted',
  failed: 'text-status-error',
  review: 'text-status-warning',
};

export function CheckIcon({ status }: { status: CheckRowStatus }) {
  const common = { width: 18, height: 18, viewBox: '0 0 18 18', 'aria-hidden': true, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, 'data-icon': status, className: `shrink-0 ${TONE[status]}` } as const;
  switch (status) {
    case 'passed': return <svg {...common}><circle cx="9" cy="9" r="7.5" /><path d="M5.5 9.2l2.3 2.3 4.7-4.9" /></svg>;
    case 'running': return <svg {...common}><circle cx="9" cy="9" r="7.5" opacity=".35" /><path d="M9 1.5a7.5 7.5 0 0 1 0 15z" fill="currentColor" /></svg>;
    case 'queued': return <svg {...common} strokeDasharray="2.5 2.5"><circle cx="9" cy="9" r="7.5" /></svg>;
    case 'skipped': return <svg {...common}><circle cx="9" cy="9" r="7.5" /><path d="M5.5 9h7" /></svg>;
    case 'failed': return <svg {...common}><circle cx="9" cy="9" r="7.5" /><path d="M6.3 6.3l5.4 5.4M11.7 6.3l-5.4 5.4" /></svg>;
    case 'review': return <svg {...common}><circle cx="9" cy="9" r="7.5" /><path d="M9 5v5" /><circle cx="9" cy="12.8" r=".6" fill="currentColor" /></svg>;
  }
}

export interface CheckRowProps {
  name: string;
  status: CheckRowStatus;
  /** Replaces the default state word (`In review` on a running merge). */
  stateWord?: string;
  /** The one mono detail: `#5701`, `0 screens · 90df389`. */
  detail?: string | null;
  /** The target the whole row links to; none renders a plain row. */
  href?: string | null;
  /** A control that belongs to the row (Skip). */
  action?: ReactNode;
  /** The step the mission waits on, marked on the desktop steps. */
  current?: boolean;
  /** Stack icon, text and state as a desktop step. */
  steps?: boolean;
  className?: string;
}

export default function CheckRow({ name, status, stateWord, detail, href, action, current, steps, className = '' }: CheckRowProps) {
  const word = stateWord ?? CHECK_STATE_WORD[status];
  const body = (
    <>
      <CheckIcon status={status} />
      <span className="flex min-w-0 flex-1 flex-col md:group-data-[steps]/check:w-full md:group-data-[steps]/check:flex-none">
        <span className="min-w-0 font-medium text-text-primary [overflow-wrap:anywhere]">{name}</span>
        {detail && <span className="min-w-0 truncate font-mono text-meta text-text-muted">{detail}</span>}
      </span>
      <span className={`shrink-0 font-mono text-meta ${TONE[status]}`}>{word}</span>
    </>
  );
  // Phone: icon, name over detail, state word right. Desktop steps: the same three stacked (design MissionChecksDesk).
  const layout = 'flex min-h-11 min-w-0 items-center gap-x-2.5 py-1.5 text-body md:group-data-[steps]/check:flex-col md:group-data-[steps]/check:items-start md:group-data-[steps]/check:gap-y-2 md:group-data-[steps]/check:py-3';
  return (
    <div
      data-testid="check-row"
      data-status={status}
      data-steps={steps || undefined}
      aria-current={current ? 'step' : undefined}
      className={`group/check relative flex min-w-0 items-center gap-x-3 px-3 py-1 ${current ? 'shadow-[inset_2px_0_0_var(--accent)]' : ''} ${className}`}
    >
      {href
        ? <a href={href} className={`${layout} flex-1 after:absolute after:inset-0 after:content-[''] hover:text-text-primary`}>{body}</a>
        : <div className={`${layout} flex-1`}>{body}</div>}
      {action && <span className="relative z-10 shrink-0">{action}</span>}
    </div>
  );
}
