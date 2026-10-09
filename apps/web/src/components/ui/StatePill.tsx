import type { ReactNode } from 'react';
import { STATES, TONE_TEXT, TONE_TINT, statusPill, type StateKey, type StateTone } from './states';

export type StatePillVariant = 'tinted' | 'plain';

export interface StatePillProps {
  state: StateKey;
  /** Replaces the state's own word; the glyph stays. */
  label?: ReactNode;
  /** `tinted` (default): a 4px pill on the state's tint. `plain`: glyph + word in the tone, no fill. */
  variant?: StatePillVariant;
  /** A muted suffix, e.g. a relative time `3m`. */
  trailing?: ReactNode;
  title?: string;
  className?: string;
  'data-testid'?: string;
}

/**
 * A state as glyph + word: `◐ Auditing`. The glyph carries the state without
 * colour, so two pills never differ by hue alone. One table (`states.ts`)
 * feeds this, the Lifecycle and the strip cells.
 */
export default function StatePill({ state, label, variant = 'tinted', trailing, title, className = '', 'data-testid': testId }: StatePillProps) {
  const s = STATES[state];
  return (
    <span
      className={`${pillClass(s.tone, variant)} ${className}`}
      data-state={state}
      data-tone={s.tone}
      data-testid={testId}
      title={title ?? s.means}
    >
      <span aria-hidden="true">{s.glyph}</span>
      {label ?? s.word}
      {trailing != null && trailing !== false && <span className="text-text-muted">{trailing}</span>}
    </span>
  );
}

/** A task or worker row's status (`pending`, `in_progress`, `failed`…) as a StatePill. */
export function StatusPill({ status, variant, className }: { status: string; variant?: StatePillVariant; className?: string }) {
  const { state, label } = statusPill(status);
  return <StatePill state={state} label={label} variant={variant} className={className} />;
}

/**
 * A fact tag in a tone, without a glyph: "Needs a decision", "CI running".
 * Same pill shape as StatePill so a card's tags and its state read as a set.
 */
export function TonePill({ tone, children, title, className = '' }: { tone: StateTone; children: ReactNode; title?: string; className?: string }) {
  return (
    <span className={`${pillClass(tone, 'tinted')} ${className}`} data-tone={tone} title={title}>
      {children}
    </span>
  );
}

function pillClass(tone: StateTone, variant: StatePillVariant): string {
  const base = 'inline-flex items-center gap-[5px] whitespace-nowrap shrink-0 font-mono text-chip leading-[1.6]';
  const weight = tone === 'dec' ? 'font-semibold' : 'font-medium';
  return variant === 'plain'
    ? `${base} ${weight} ${TONE_TEXT[tone]}`
    : `${base} ${weight} px-2 py-0.5 rounded-[var(--radius-pill)] ${TONE_TEXT[tone]} ${TONE_TINT[tone]}`;
}

export { StatePill };
