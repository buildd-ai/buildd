import Link from 'next/link';
import type { ReactNode } from 'react';

/** One thing that needs the person: what it is, why, and where it is decided. */
export interface YouStripItem {
  id: string;
  title: string;
  /** The mono reason line, e.g. `Review · 3 retries`. */
  reason: string;
  /** Where the decision is made (the task page or its decision). */
  href: string;
  /** The button label. Default `Review`. */
  action?: string;
}

export interface YouStripProps {
  /** Everything waiting on the person, most urgent first. The strip shows the first. */
  waiting: readonly YouStripItem[];
  /**
   * The full decision card for `waiting[0]`, when the page has its view
   * (e.g. `<DecisionCard>`). Absent: the strip's own compact card.
   */
  decision?: ReactNode;
  /** Where the count stops, when it is not everything (e.g. `this team`). Named so it cannot disagree silently with a wider count. */
  scope?: string;
  className?: string;
}

/**
 * First on Now. Nothing waiting: a green dot and `Nothing waiting on you`.
 * Otherwise the decision card for the first item that needs the person,
 * framed in the waiting-on-you orange-red (the only place on Now that colour
 * is used, with the meter's waiting state), `1/N` on its reason when more
 * wait behind it. Spec 9430a28f r2 R-12, AC-11.
 */
export default function YouStrip({ waiting, decision, scope, className = '' }: YouStripProps) {
  const first = waiting[0];
  if (!first) {
    return (
      <section
        aria-label="Waiting on you"
        data-testid="you-strip"
        data-waiting={0}
        className={`flex min-h-11 items-center gap-2.5 rounded-[var(--radius-card)] border border-border-default bg-card px-3.5 py-3 ${className}`}
      >
        <span aria-hidden="true" data-testid="you-strip-dot" className="block h-2 w-2 shrink-0 rounded-full bg-status-success" />
        <span className="text-title text-text-primary">Nothing waiting on you{scope ? ` in ${scope}` : ''}</span>
      </section>
    );
  }
  const n = waiting.length;
  return (
    <section aria-label="Waiting on you" data-testid="you-strip" data-waiting={n} className={className}>
      {decision ?? (
        <div
          data-testid="you-strip-card"
          data-item={first.id}
          className="flex items-center gap-3 rounded-[var(--radius-card)] border-[1.5px] border-status-error bg-card px-3.5 py-3"
        >
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-[15px] font-semibold text-text-primary">{first.title}</span>
            <span className="font-mono text-meta text-text-muted">
              {first.reason}{n > 1 && <span data-testid="you-strip-position"> · 1/{n}</span>}{scope && <span data-testid="you-strip-scope"> · {scope}</span>}
            </span>
          </div>
          <Link href={first.href} className="btn btn-ink min-h-10 shrink-0">{first.action ?? 'Review'}</Link>
        </div>
      )}
    </section>
  );
}

export { YouStrip };
