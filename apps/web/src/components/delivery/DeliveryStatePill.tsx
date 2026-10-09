import StatePill from '@/components/ui/StatePill';
import type { StateKey } from '@/components/ui/states';
import { DELIVERY_KIND, type DeliveryKind } from '@/lib/delivery-projection';

/**
 * The shared state each delivery kind is drawn as. The glyph and tone come
 * from states.ts; the word stays the delivery's own where the shared word
 * would say something else (Held, Planning, Audit can’t run).
 */
export const STATE_KEY_OF_DELIVERY: Record<DeliveryKind, StateKey> = {
  landed: 'landed', landing: 'landing', audit: 'review', repair: 'fixing', build: 'running',
  waiting: 'waiting', held: 'blocked', planning: 'queued',
  unavailable: 'recovering', notlanded: 'not_landed', needs: 'needs_you',
};

/** A delivery kind as glyph + word through the shared StatePill: never colour alone. */
export function DeliveryStatePill({ kind, trailing }: { kind: DeliveryKind; trailing?: string }) {
  return (
    <StatePill
      state={STATE_KEY_OF_DELIVERY[kind]}
      label={DELIVERY_KIND[kind].label}
      trailing={trailing}
      data-testid="delivery-state"
      className="shrink-0"
    />
  );
}
