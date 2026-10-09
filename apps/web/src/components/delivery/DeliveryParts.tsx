/**
 * The delivery chip and the audit evidence cards, shared by every surface that renders lib/delivery-projection.ts
 * (Home, Activity, mission detail). One vocabulary, one rendering: glyph and
 * word, never colour alone. The Build → Audit → Land track is the shared
 * `Lifecycle` (components/ui), fed by `lifecycleState`.
 */
import type { EvidenceEntry } from '@/lib/activity-delivery';
import { DELIVERY_KIND, type DeliveryKind, type DeliveryTone } from '@/lib/delivery-projection';

export const TONE_TEXT: Record<DeliveryTone, string> = {
  success: 'text-status-success', info: 'text-status-info', warning: 'text-status-warning',
  ink: 'text-text-primary', muted: 'text-text-muted', error: 'text-status-error',
};
export const TONE_EDGE: Record<DeliveryTone, string> = {
  success: 'border-l-status-success', info: 'border-l-status-info', warning: 'border-l-status-warning',
  ink: 'border-l-accent', muted: 'border-l-border-default', error: 'border-l-status-error',
};

export function DeliveryChip({ kind }: { kind: DeliveryKind }) {
  const k = DELIVERY_KIND[kind];
  return (
    <span data-testid="delivery-chip" data-kind={kind} className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap border border-border-default px-1.5 font-mono text-meta ${TONE_TEXT[k.tone]}`}>
      <span aria-hidden="true">{k.glyph}</span>{k.label}
    </span>
  );
}

const REPAIR_REASON = { ci: 'CI failed', conflict: 'conflict with its base', review: 'review notes' } as const;
const REPAIR_STATUS = { running: 'agent fixing now', pushed: 'pushed', failed: 'did not finish', queued: 'queued for a free slot' } as const;

/**
 * One evidence entry: a revision card (its gates, the current head framed) or
 * the repair between two heads. Activity's rows and mission detail's drawer
 * both render it, so a repair reads the same on both.
 */
export function DeliveryEvidence({ entry }: { entry: EvidenceEntry }) {
  if (entry.type === 'repair') {
    return (
      <div data-testid="activity-repair" className="ml-2.5 mt-2 border-l-2 border-dashed border-status-warning px-2.5 py-1.5 text-meta text-text-secondary">
        <span className="font-semibold text-status-warning">↻ Repair {entry.round}</span>
        {' · automatic'}
        {entry.reason && ` · ${REPAIR_REASON[entry.reason]}`}
        {` · ${REPAIR_STATUS[entry.status]}`}
        {entry.sha && ` ${entry.sha}`}
      </div>
    );
  }
  return (
    <div data-testid="activity-revision" data-current={entry.current} className={`mt-2 bg-[var(--chat-surface)] px-3 py-2.5 ${entry.current ? 'border-2 border-border-strong' : 'border border-border-default opacity-80'}`}>
      <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-x-2">
        <span className="text-body font-semibold text-text-primary">
          {entry.sha ? <>Revision <span className="font-mono">{entry.sha}</span></> : 'Revision'}
          <span className="ml-1.5 text-meta font-normal text-text-muted">{entry.current ? 'current head' : 'older head'}</span>
        </span>
        <span className="text-meta text-text-muted">audit round {entry.round}</span>
      </div>
      {entry.gates.map((g, i) => (
        <div key={i} className="grid grid-cols-[18px_minmax(0,1fr)_auto] items-baseline gap-x-2 py-0.5">
          <span aria-hidden="true" className={TONE_TEXT[g.tone]}>{g.glyph}</span>
          <span className={`text-body ${g.void ? 'text-text-muted line-through' : 'text-text-primary'}`}>{g.name}</span>
          <span className={`text-right text-meta ${g.void ? 'text-text-muted line-through' : TONE_TEXT[g.tone]}`}>{g.result}</span>
          {g.why && <span className="col-start-2 col-end-4 text-meta text-text-muted">{g.why}</span>}
        </div>
      ))}
    </div>
  );
}
