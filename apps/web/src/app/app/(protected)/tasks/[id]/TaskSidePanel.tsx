import Link from 'next/link';
import type { PrDisplayState } from '@/lib/pr-presentation';
import type { ReactNode } from 'react';
import { StatusPill } from '@/components/ui/StatePill';
import { deliveryReading, type DeliveryTone } from '@/lib/workflow/delivery-display';

/** The header pill's palette, one entry per canonical tone. Success green is for a landed delivery only. */
const HEADER_TONE: Record<DeliveryTone, string> = {
  needs: 'text-[var(--on-accent)] border-accent bg-accent',
  live: 'text-accent-text border-accent bg-accent-soft',
  stalled: 'text-accent-text border-accent bg-accent-soft',
  landed: 'text-status-success border-status-success bg-status-success/10',
  closed: 'text-status-error border-status-error bg-status-error/10',
  failed: 'text-status-error border-status-error bg-status-error/10',
};

/** The page header's status: one square pill, loud only when it's on you. */
/**
 * The kernel's reading of a kernel-owned delivery (workflow-state-kernel
 * §17.5): its headline and who owns the next move. Serializable, so it can
 * cross into client components.
 */
export interface DeliveryPillState {
  headline: string;
  owner: string;
  needsYou: boolean;
  stage: string;
  detail: string | null;
  /** The delivery's PR state (§17.5): what the PR tile, card and shipped header say. */
  prState?: PrDisplayState | null;
  /** The delivery state (WORKING, AWAITING_PUSH, etc.) for tone computation. */
  state: string;
}

export function HeaderStatusPill({ status, merged, delivery = null }: { status: string; merged: boolean; delivery?: DeliveryPillState | null }) {
  const base = 'inline-flex items-center gap-2 px-2.5 min-h-8 font-mono text-[11px] font-semibold border flex-wrap';
  const dot = (extra = '') => <span className={`w-[7px] h-[7px] flex-shrink-0 bg-current ${extra}`} aria-hidden="true" />;

  if (delivery && !merged) {
    // The canonical reading (S17): every surface's label and tone. Null while
    // the owner's attempt is still working, which reads live.
    const reading = deliveryReading({ stage: delivery.stage as never, state: delivery.state as never, headline: delivery.headline, owner: delivery.owner as never });
    const tone: DeliveryTone = delivery.needsYou ? 'needs' : reading?.tone ?? 'live';
    const pulse = (tone === 'live' || tone === 'stalled') && (delivery.owner === 'worker' || delivery.owner === 'reviewer');
    return <span data-owner={delivery.owner} className={`${base} ${HEADER_TONE[tone]}`} title={delivery.headline}>{dot(pulse ? 'animate-status-pulse' : '')}{reading?.label ?? delivery.headline}</span>;
  }
  if (merged) return <span className={`${base} text-status-success border-status-success bg-status-success/10`}>{dot()}Merged</span>;
  switch (status) {
    case 'running':
    case 'starting':
    case 'in_progress':
      return <span className={`${base} text-accent-text border-accent bg-accent-soft`}>{dot('animate-status-pulse')}{status === 'starting' ? 'Starting' : 'Running'}</span>;
    case 'fixing_ci':
      // The task's own row is done, but a CI-fix attempt is still working its PR.
      return <span className={`${base} text-accent-text border-accent bg-accent-soft`}>{dot('animate-status-pulse')}Fixing CI</span>;
    case 'waiting_on_you':
    case 'waiting_input':
      return <span className={`${base} text-[var(--on-accent)] border-accent bg-accent`}>{dot()}Needs input</span>;
    case 'completed':
      return <span className={`${base} text-status-success border-status-success bg-status-success/10`}>{dot()}Completed</span>;
    case 'failed':
      return <span className={`${base} text-status-error border-status-error bg-status-error/10`}>{dot()}Failed</span>;
    default:
      return <StatusPill status={status} />;
  }
}

export interface FactRow {
  key: string;
  label: string;
  value: ReactNode;
}

/** The right-hand fact sheet: label/value rows in one bordered card. */
export function FactSheet({ rows, testId = 'task-fact-sheet' }: { rows: FactRow[]; testId?: string }) {
  if (rows.length === 0) return null;
  return (
    <dl data-testid={testId} className="bg-card border-2 border-border-strong px-5 py-1">
      {rows.map(r => (
        <div key={r.key} data-testid={`task-fact-${r.key}`} className="grid grid-cols-[96px_minmax(0,1fr)] gap-3 py-3.5 border-b border-border-default last:border-b-0">
          <dt className="font-mono text-meta text-text-muted pt-0.5">{r.label}</dt>
          <dd className="min-w-0 font-mono text-[13px] text-text-primary [overflow-wrap:anywhere]">{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Collapsed-by-default description in the side panel. */
export function SideDescription({ children, preview }: { children: ReactNode; preview: string }) {
  return (
    <details data-testid="task-side-description" className="group border-b border-border-default">
      <summary className="flex items-center gap-3 min-h-12 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden">
        <span className="text-text-muted group-open:rotate-90 transition-transform" aria-hidden="true">▸</span>
        <span className="font-mono text-meta text-text-muted shrink-0">Description</span>
        <span className="flex-1 min-w-0 truncate text-[13px] text-text-secondary group-open:hidden">{preview}</span>
      </summary>
      <div className="pb-4">{children}</div>
    </details>
  );
}
