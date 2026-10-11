import type { StateKey } from '@/components/ui/states';
import type { DeliveryKind } from '@/lib/delivery-projection';
import { STATE_KEY_OF_DELIVERY } from './DeliveryStatePill';

/**
 * A delivery kind as a state on the one `Lifecycle` track. Same as the pill's
 * mapping except `waiting`: a delivery that has not started is before Build,
 * where the shared `waiting` (an agent paused on a question) sits on Build.
 */
export function lifecycleState(kind: DeliveryKind): StateKey {
  return kind === 'waiting' ? 'ready' : STATE_KEY_OF_DELIVERY[kind];
}
