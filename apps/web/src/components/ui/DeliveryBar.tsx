export type DeliveryOutcome = 'delivered' | 'not-delivered' | 'came-to-you';

export interface DeliveryBarProps {
  /** Where the delivery starts and ends on the day axis, as offsets 0..1 (clamped). */
  start: number;
  end: number;
  /** Where build hands over to verify, same axis. Defaults to the midpoint of start..end. */
  verifyStart?: number;
  /** One tick per fix round, as offsets on the same axis. */
  fixRounds?: readonly number[];
  outcome: DeliveryOutcome;
  /** Replaces the default accessible name. */
  label?: string;
  className?: string;
  'data-testid'?: string;
}

/** The end mark per outcome: three different glyphs, so the outcome reads without colour. */
export const DELIVERY_END_MARK: Record<DeliveryOutcome, string> = {
  delivered: '■',
  'not-delivered': '✕',
  'came-to-you': '!',
};

const OUTCOME_PHRASE: Record<DeliveryOutcome, string> = {
  delivered: 'delivered',
  'not-delivered': 'not delivered',
  'came-to-you': 'came to you',
};

const OUTCOME_COLOR: Record<DeliveryOutcome, string> = {
  delivered: 'var(--status-success)',
  'not-delivered': 'var(--status-error)',
  'came-to-you': 'var(--status-warning)',
};

export function deliveryBarName(outcome: DeliveryOutcome, fixRounds: number): string {
  const rounds = fixRounds === 1 ? '1 fix round' : `${fixRounds} fix rounds`;
  return `${OUTCOME_PHRASE[outcome]}, ${fixRounds === 0 ? 'no fix rounds' : rounds}`;
}

const clamp = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
const pct = (n: number) => `${(n * 100).toFixed(3)}%`;

/**
 * One delivery on a day axis: a build segment, a verify segment, a tick per
 * fix round and an end mark (■ delivered, ✕ not delivered, ! came to you).
 * Build is solid and verify hatched, matching StageMeter, so the two read as
 * one language. Read as one image with an accessible name; the parts are
 * decoration. Both segments keep a minimum width so a very short delivery
 * stays visible. Spec 9430a28f r2 R-16, AC-15.
 */
export default function DeliveryBar({
  start, end, verifyStart, fixRounds = [], outcome, label, className = '', 'data-testid': testId,
}: DeliveryBarProps) {
  const s = clamp(start);
  const e = Math.max(s, clamp(end));
  const v = Math.min(e, Math.max(s, clamp(verifyStart ?? (s + e) / 2)));
  const ticks = fixRounds.map(clamp);
  return (
    <span
      role="img"
      aria-label={label ?? deliveryBarName(outcome, ticks.length)}
      className={`relative block h-[14px] w-full ${className}`}
      data-outcome={outcome}
      data-fix-rounds={ticks.length}
      data-testid={testId}
    >
      <span aria-hidden="true" className="absolute inset-x-0 top-1/2 h-px bg-[var(--border-strong)]" />
      <span
        aria-hidden="true"
        data-segment="build"
        className="absolute top-[3px] h-[8px] min-w-[3px] rounded-l-[2px]"
        style={{ left: pct(s), width: pct(v - s), background: 'var(--accent)' }}
      />
      <span
        aria-hidden="true"
        data-segment="verify"
        className="absolute top-[3px] h-[8px] min-w-[3px] border-y border-[var(--act-hatch)]"
        style={{
          left: pct(v),
          width: pct(e - v),
          backgroundColor: 'var(--accent-soft)',
          backgroundImage: 'repeating-linear-gradient(135deg, var(--act-hatch) 0 2px, transparent 2px 5px)',
        }}
      />
      {ticks.map((t, i) => (
        <span
          key={i}
          aria-hidden="true"
          data-fix-tick=""
          className="absolute top-0 h-[14px] w-[2px] -translate-x-1/2"
          style={{ left: pct(t), background: 'var(--text-primary)' }}
        />
      ))}
      <span
        aria-hidden="true"
        data-end-mark={outcome}
        className="absolute top-0 flex h-[14px] w-[14px] -translate-x-1/2 items-center justify-center rounded-[3px] font-mono text-[10px] font-bold leading-none"
        style={{ left: pct(e), background: OUTCOME_COLOR[outcome], color: 'var(--on-ink)' }}
      >
        {DELIVERY_END_MARK[outcome]}
      </span>
    </span>
  );
}
