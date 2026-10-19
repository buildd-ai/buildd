import type { ReactNode } from 'react';

/**
 * Mission History's event icons. Each kind has its own shape, so the meaning
 * never rides on colour alone: a check for merged, a pull-request fork for a
 * PR, a play triangle for work starting, a circular arrow for a retry, an
 * exclamation for something that needs a person. The accessible name is the
 * event's, and the glyph itself is decorative.
 */
export type HistoryIconKind =
  | 'filed' | 'plan' | 'start' | 'retry' | 'pr' | 'merged' | 'done' | 'attention' | 'answered' | 'failed' | 'friction' | 'mission';

export const HISTORY_ICON_LABEL: Record<HistoryIconKind, string> = {
  filed: 'Filed', plan: 'Planning', start: 'Work started', retry: 'Retry', pr: 'Pull request', merged: 'Merged',
  done: 'Done', attention: 'Has a question', answered: 'Answered', failed: 'Stopped or failed',
  friction: 'Friction report', mission: 'Mission completed',
};

const SHAPE: Record<HistoryIconKind, { path: ReactNode; cls: string }> = {
  filed: { path: <path d="M8 3v10M3 8h10" />, cls: 'border-border-strong text-text-secondary' },
  plan: { path: <path d="M8 2.5 13.5 8 8 13.5 2.5 8z" />, cls: 'border-dashed border-border-strong text-text-secondary' },
  start: { path: <path d="M5.5 3.5v9l7-4.5z" />, cls: 'border-border-strong text-text-secondary' },
  retry: { path: <path d="M12.5 8a4.5 4.5 0 1 1-1.4-3.3M12.5 2.5v2.4h-2.4" />, cls: 'border-border-strong text-text-secondary' },
  pr: { path: <path d="M4.5 3v10M4.5 5.5a1.5 1.5 0 1 0 0-.01M4.5 13a1.5 1.5 0 1 0 0-.01M11.5 13V7.5a2 2 0 0 0-2-2H8M11.5 13a1.5 1.5 0 1 0 0-.01" />, cls: 'border-border-strong text-text-secondary' },
  merged: { path: <path d="M3.5 8.5 6.5 11.5 12.5 4.5" />, cls: 'border-status-success text-status-success' },
  done: { path: <path d="M4 4h8v8H4zM6 8l1.5 1.5L10.5 6.5" />, cls: 'border-border-strong text-text-secondary' },
  attention: { path: <path d="M8 3.5v5.5M8 12v.01" />, cls: 'border-status-warning text-status-warning' },
  answered: { path: <path d="M6.5 4 3 7.5 6.5 11M3 7.5h6a3.5 3.5 0 0 1 3.5 3.5v.5" />, cls: 'border-accent text-accent-text' },
  failed: { path: <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />, cls: 'border-status-error text-status-error' },
  friction: { path: <path d="M4.5 13.5v-11M4.5 3h7l-1.5 2.5L11.5 8h-7" />, cls: 'border-dotted border-[var(--fleet-border-mid)] text-text-muted' },
  mission: { path: <path d="M2.5 8.5l3 3 5-6M8.5 11.5l1 1 4.5-6" />, cls: 'border-status-success text-status-success' },
};

export default function HistoryIcon({ kind, label }: { kind: HistoryIconKind; label?: string }) {
  const { path, cls } = SHAPE[kind];
  const name = label ?? HISTORY_ICON_LABEL[kind];
  return (
    <span data-testid="history-icon" data-icon={kind} role="img" aria-label={name} title={name}
      className={`grid h-6 w-6 shrink-0 place-items-center rounded-full border ${cls}`}>
      <svg aria-hidden="true" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">{path}</svg>
    </span>
  );
}
