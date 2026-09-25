/**
 * The mission Delivery block (docs/design/mission-feed-mobile-continuity.md,
 * W2 "Delivery", addendum D5): one line under the situation —
 * `Integrated ◐ 4/6 · Verified 2/3 · Shipped –` — that expands into the steps
 * and whatever each step owns (the mission PR, the review summary, the visual
 * review strip, the budget banner). Shipped renders its own one-line row (`MissionReleaseSection`,
 * via `rows`). It replaces the stack of cards that used to sit
 * between the outcome and the task list.
 *
 * Native `<details>`: no client state, works before hydration, and a blocked
 * step (budget at cap, criteria failing) opens it by default.
 */
import type { ReactNode } from 'react';
import {
  DELIVERY_STATE_GLYPH,
  DELIVERY_STATE_TEXT,
  formatDeliverySummary,
  type DeliveryStep,
  type DeliveryStepKey,
} from '@/lib/mission-delivery';


export interface MissionDeliveryProps {
  steps: readonly DeliveryStep[];
  /** What each step owns, shown under it when expanded. */
  details?: Partial<Record<DeliveryStepKey, ReactNode>>;
  /** A step that renders its own row (glyph, label and status) in place of the default line. */
  rows?: Partial<Record<DeliveryStepKey, ReactNode>>;
}

export default function MissionDelivery({ steps, details = {}, rows = {} }: MissionDeliveryProps) {
  if (steps.length === 0) return null;
  const blocked = steps.some(s => s.state === 'blocked');

  return (
    <details data-testid="mission-delivery" open={blocked} className="group mb-3 border-y border-border-default">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 font-mono text-[12px] text-text-secondary hover:text-text-primary [&::-webkit-details-marker]:hidden">
        {/* Wraps between steps rather than truncating: with all four steps the
            line is wider than 358px, and truncation dropped Budget, the one
            step that blocks. */}
        <span
          data-testid="mission-delivery-summary"
          aria-label={formatDeliverySummary(steps)}
          className="flex min-w-0 flex-1 flex-wrap gap-x-1.5 py-1"
        >
          {steps.map((s, i) => (
            <span key={s.key} data-testid="mission-delivery-summary-step" data-step={s.key} className="whitespace-nowrap" aria-hidden="true">
              {i > 0 && <span className="text-text-muted">{'· '}</span>}
              {`${s.label} `}
              <span className={DELIVERY_STATE_TEXT[s.state]}>{DELIVERY_STATE_GLYPH[s.state]}</span>
              {` ${s.value}`}
            </span>
          ))}
        </span>
        <span aria-hidden="true" className="shrink-0 text-text-muted group-open:rotate-180">▾</span>
      </summary>
      <div className="pb-3">
        <h2 className="section-label mb-1">Delivery</h2>
        {steps.map(step => (
          <div key={step.key} data-testid="mission-delivery-step" data-step={step.key} data-state={step.state} className="py-1.5">
            {rows[step.key] ?? (
              <div className="flex min-h-9 items-center gap-2 font-mono text-[12px]">
                <span aria-hidden="true" className={`w-3 shrink-0 text-center ${DELIVERY_STATE_TEXT[step.state]}`}>
                  {DELIVERY_STATE_GLYPH[step.state]}
                </span>
                <span className="w-20 shrink-0 font-semibold text-text-primary">{step.label}</span>
                <span className="min-w-0 flex-1 text-text-secondary">{step.detail}</span>
              </div>
            )}
            {details[step.key] && <div className="mt-1.5 pl-5">{details[step.key]}</div>}
          </div>
        ))}
      </div>
    </details>
  );
}
