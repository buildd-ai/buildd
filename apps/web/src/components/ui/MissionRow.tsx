import Link from 'next/link';
import type { ReactNode } from 'react';
import StatePill from './StatePill';
import TaskStrip from './TaskStrip';
import { STATES, type StateKey } from './states';

export interface MissionRowProps {
  href: string;
  title: ReactNode;
  /** One task state per cell, in strip order. Drawn with the small strip, never a bar. */
  strip: readonly StateKey[];
  /** The mission's state; its pill reads `◐ Auditing · 2 of 7 merged · ~4:55 PM`. */
  state?: StateKey;
  /** `2 of 7 merged`. */
  stat?: string;
  /** `~4:55 PM`. */
  eta?: string;
  /** `90m later than first estimated`: only on a slip. */
  slip?: string;
  /** A decision waiting on you, one line: `Decide: …`. */
  decide?: string;
  /** Shown in place of the state pill when there is none (`Starts after …`). */
  meta?: ReactNode;
  /** Right of the state line, small mono. */
  aside?: ReactNode;
  next?: ReactNode;
  note?: ReactNode;
}

/**
 * One mission in the portfolio and on Home: title, a decision if one is
 * waiting, the small strip, one state line, Next. L1: a hairline above, no box.
 */
export default function MissionRow({ href, title, strip, state, stat, eta, slip, decide, meta, aside, next, note }: MissionRowProps) {
  const pillLabel = state ? [STATES[state].word, stat, eta].filter(Boolean).join(' · ') : null;
  return (
    <Link
      href={href}
      data-testid="mission-row"
      className="group flex flex-col gap-1.5 border-t border-border-default py-3.5 text-inherit no-underline"
    >
      <span className="text-title font-semibold text-text-primary [overflow-wrap:anywhere] group-hover:underline group-hover:decoration-[var(--border-strong)]">
        {title}
      </span>
      {decide && <span className="text-title font-semibold text-status-warning">! {decide}</span>}
      <TaskStrip size="sm" cells={strip.map((s, i) => ({ id: String(i), state: s }))} />
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        {state ? (
          <span>
            <StatePill state={state} variant="plain" label={pillLabel} />
            {slip && <span className="font-mono text-meta text-accent-text"> · {slip}</span>}
          </span>
        ) : (
          <span className="font-mono text-meta text-text-muted">{meta}</span>
        )}
        {aside && <span className="font-mono text-chip text-text-muted">{aside}</span>}
      </div>
      {next && (
        <span className="text-title text-text-primary">
          <span className="text-text-muted">Next</span> {next}
        </span>
      )}
      {note && <span className="font-mono text-meta text-text-muted">{note}</span>}
    </Link>
  );
}

export { MissionRow };
