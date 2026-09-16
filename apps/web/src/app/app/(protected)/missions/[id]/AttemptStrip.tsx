'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { AttemptStrip as AttemptStripData } from '@/lib/attempt-strip';

/**
 * The attempt strip (U8): `●●○ 3 attempts · CI ×2 · reviewer ×1`, expanding in
 * place on the parent task's row.
 *
 * Attempts used to land in the bookkeeping footer, which published a title, a
 * timestamp and a PR url — so *why* the attempt exists, *who* ran it and *how
 * many remain* were all absent. Every line rendered here comes pre-assembled
 * from `buildAttemptStrips` (`lib/attempt-strip.ts`); this component chooses no
 * facts, only their shape on screen.
 *
 * A strip with no attempts renders nothing: an empty row of chrome is the
 * regression the no-empty-chrome invariant exists to prevent.
 */

const STATUS_CLS: Record<string, string> = {
  completed: 'text-status-success',
  failed: 'text-status-error',
  cancelled: 'text-text-muted',
  budget_exhausted: 'text-status-warning',
  waiting_input: 'text-status-warning',
};

function statusClass(status: string): string {
  return STATUS_CLS[status] ?? 'text-status-info';
}

export default function AttemptStrip({
  strip,
  defaultExpanded = false,
  hideToggle = false,
}: {
  strip: AttemptStripData | null;
  /** Test/fixture seam — the live row always starts collapsed. */
  defaultExpanded?: boolean;
  /**
   * Suppress this component's own summary `<button>` and render the strip
   * always-open (timeline-mobile-rail.md Rule D13-9). The mobile rail uses the
   * whole right column as the single disclosure control, so the summary line
   * becomes plain text: two nested toggles is precisely the ambiguity that made
   * v1's 24×15px retry stub untappable in practice.
   */
  hideToggle?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const open = hideToggle || expanded;

  if (!strip || strip.total === 0) return null;

  const summaryLine = (
    <>
      <span className="tracking-[0.15em] text-text-secondary" aria-hidden="true">{strip.dots}</span>
      <span>{strip.summary}</span>
    </>
  );

  return (
    <div className={hideToggle ? 'pb-0.5' : 'pl-7 pb-0.5'} data-testid="attempt-strip">
      {hideToggle ? (
        <div className="flex items-center gap-1.5 text-[10px] text-text-muted font-mono">{summaryLine}</div>
      ) : (
        <button
          type="button"
          onClick={() => setExpanded(v => !v)}
          aria-expanded={expanded}
          className="flex items-center gap-1.5 text-[10px] text-text-muted hover:text-text-secondary transition-colors font-mono"
          title="Attempts on this task"
        >
          {summaryLine}
        </button>
      )}

      {open && (
        <div className="mt-1 space-y-1 border-l border-border-default pl-2.5">
          {strip.attempts.map(attempt => (
            <div key={attempt.id} className="flex items-baseline gap-2 flex-wrap text-[10px]">
              <span aria-hidden="true" className="text-text-secondary">
                {attempt.settled ? '●' : '○'}
              </span>
              <Link
                href={attempt.href}
                className="text-text-secondary hover:text-text-primary hover:underline"
              >
                {attempt.reason || 'attempt'}
              </Link>
              {attempt.actor && <span className="text-text-muted">· {attempt.actor}</span>}
              <span className={statusClass(attempt.status)}>· {attempt.status}</span>
              {attempt.prLink && (
                <a
                  href={attempt.prLink.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-accent-text hover:underline font-mono"
                >
                  {attempt.prLink.label}
                </a>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
