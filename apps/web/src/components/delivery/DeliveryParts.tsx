/**
 * The delivery chip and the Build › Audit › Land track, shared by every
 * surface that renders lib/delivery-projection.ts (Home, Activity). One
 * vocabulary, one rendering: glyph and word, never colour alone.
 */
import {
  DELIVERY_KIND, DELIVERY_STAGES, deliveryStageIndex, repairBadge,
  type DeliveryKind, type DeliveryTone,
} from '@/lib/delivery-projection';

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

/** Build › Audit › Land in words: ✓ for passed stages, the current one underlined. Repair shows as `Audit ↻N`. */
export function DeliveryTrack({ kind, rounds }: { kind: DeliveryKind; rounds: number }) {
  const at = deliveryStageIndex(kind);
  const current = DELIVERY_STAGES[Math.max(0, Math.min(2, at))];
  return (
    <span className="inline-flex flex-wrap items-center gap-1 font-mono text-meta" aria-label={at < 0 ? 'Not started' : at > 2 ? 'Landed' : `Stage: ${current}`}>
      {DELIVERY_STAGES.map((name, i) => {
        const done = at > i;
        const cur = at === i;
        const text = done ? `✓ ${name}` : cur && i === 1 && rounds > 0 ? `${name} ${repairBadge(rounds)}` : name;
        return (
          <span key={name} className="inline-flex items-center gap-1">
            {i > 0 && <span aria-hidden="true" className="text-text-muted">›</span>}
            <span className={done ? 'text-text-secondary' : cur ? 'font-semibold text-text-primary underline underline-offset-4' : 'text-text-muted'}>{text}</span>
          </span>
        );
      })}
    </span>
  );
}
