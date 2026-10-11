import type { ReactNode } from 'react';
import Lifecycle from './Lifecycle';
import StatePill from './StatePill';
import type { StateKey } from './states';

/** A task's frozen estimate in agent minutes, and what it has used. */
export interface TimeEstimate {
  p50: number;
  p80: number;
  /** Minutes so far (or in total, once landed). Null before it starts. */
  actual?: number | null;
}

const HELD: ReadonlySet<StateKey> = new Set(['ready', 'blocked', 'queued']);

/**
 * The focus card's one Time row: `18m so far · planned 60–100m`. Renders
 * nothing without an estimate; it never invents one. Over p80 reads in the
 * live tone with ▲.
 */
export function TimeRow({ estimate, state }: { estimate?: TimeEstimate | null; state: StateKey }) {
  if (!estimate) return null;
  const plan = `planned ${estimate.p50}–${estimate.p80}m`;
  const a = estimate.actual;
  const over = a != null && a > estimate.p80;
  const value = a == null ? plan : state === 'landed' ? `${a}m · ${plan}` : `${a}m so far · ${plan}`;
  return (
    <>
      <dt className="text-text-muted">Time</dt>
      <dd data-testid="focus-time" data-over={over || undefined} className={over ? 'text-accent-text' : ''}>
        {value}{over && ' ▲'}
      </dd>
    </>
  );
}

export interface FocusCardProps {
  /** Mono line above the title: `03 · level 3 of 5 · builder`. */
  meta: ReactNode;
  title: ReactNode;
  state: StateKey;
  repairs?: number;
  /** What happens next, in a sentence. */
  next?: ReactNode;
  /** The SEL-2 reason line (`reasonLine` in task-strip.ts): "After 03 …" / "Unblocks 05, 06". */
  reason?: { lead: string; text: string } | null;
  estimate?: TimeEstimate | null;
  /** What it needs from a person. Omitted → the row is left out. */
  needs?: ReactNode;
  note?: ReactNode;
  /** Required checks, PR line: anything between the lifecycle and the facts. */
  children?: ReactNode;
  footer?: ReactNode;
  /** The 1.5px ink frame of a focused card. Default true; false is a plain L2 card. */
  focused?: boolean;
  className?: string;
}

/**
 * L2: the selected task under the strip. A 6px card on --card; focused, a
 * 1.5px ink frame. Lifecycle first, then Next / reason / Time / Needs you.
 */
export default function FocusCard({ meta, title, state, repairs, next, reason, estimate, needs, note, children, footer, focused = true, className = '' }: FocusCardProps) {
  return (
    <section
      data-testid="focus-card"
      aria-live="polite"
      className={`flex flex-col gap-3 rounded-[var(--radius-card)] bg-card px-4 py-[18px] ${focused ? 'border-[1.5px] border-text-primary' : 'border border-border-default'} ${className}`}
    >
      <div className="font-mono text-meta text-text-muted">
        {meta}
        {HELD.has(state) && <> · <StatePill state={state} variant="plain" /></>}
      </div>
      <h2 className="text-heading font-semibold leading-tight text-text-primary [overflow-wrap:anywhere]">{title}</h2>
      <Lifecycle state={state} repairs={repairs} />
      {children}
      <dl className="grid grid-cols-[82px_minmax(0,1fr)] gap-x-2.5 gap-y-1.5 text-title">
        {next != null && <><dt className="text-text-muted">Next</dt><dd>{next}</dd></>}
        {reason && (
          <>
            <dt className="text-text-muted">{reason.lead}</dt>
            <dd data-testid="focus-reason" className="text-body text-accent-text">{reason.text}</dd>
          </>
        )}
        <TimeRow estimate={estimate} state={state} />
        {needs != null && <><dt className="text-text-muted">Needs you</dt><dd>{needs}</dd></>}
      </dl>
      {note && (
        <p className="flex gap-2 text-body leading-normal text-text-muted">
          <span aria-hidden="true">◌</span>
          <span>{note}</span>
        </p>
      )}
      {footer}
    </section>
  );
}

export { FocusCard };
