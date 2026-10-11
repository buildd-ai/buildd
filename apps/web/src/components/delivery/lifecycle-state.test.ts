import { describe, expect, it } from 'bun:test';
import { DELIVERY_KIND, deliveryStageIndex, type DeliveryKind } from '@/lib/delivery-projection';
import { STEP_OF } from '@/components/ui/Lifecycle';
import { lifecycleState } from './lifecycle-state';

const KINDS = Object.keys(DELIVERY_KIND) as DeliveryKind[];

describe('lifecycleState: a delivery kind on the one Lifecycle track', () => {
  it('every kind sits on the same step it did on the Build › Audit › Land track', () => {
    for (const k of KINDS) {
      const at = deliveryStageIndex(k);
      expect([k, STEP_OF[lifecycleState(k)]]).toEqual([k, at]);
    }
  });

  it('each live kind keeps its own variant', () => {
    expect(lifecycleState('build')).toBe('running');
    expect(lifecycleState('audit')).toBe('review');
    expect(lifecycleState('repair')).toBe('fixing');
    expect(lifecycleState('unavailable')).toBe('recovering');
    expect(lifecycleState('needs')).toBe('needs_you');
    expect(lifecycleState('landing')).toBe('landing');
    expect(lifecycleState('notlanded')).toBe('not_landed');
    expect(lifecycleState('landed')).toBe('landed');
  });
});
