// `runner-wake` (interim): ask the producer to wake runners for us, via the
// signed relay callback. The producer holds the realtime credentials; they are
// never copied here. End state: a Dispatch-owned wake channel (design P3).

import type { ProducerClient } from '../producer';
import type { TransportAdapter } from './types';

export function runnerWakeAdapter(producer: ProducerClient): TransportAdapter {
  return {
    type: 'runner-wake',
    needsResolve: false,
    async deliver(ctx, _step, resolved) {
      const payload = resolved?.payload ?? ctx.envelope.payload;
      const res = await producer.relay({ id: ctx.id, attempt: ctx.attempt, target: ctx.target, ...(payload ? { payload } : {}) });
      if (res.outcome === 'delivered') return { kind: 'delivered', via: res.via.startsWith('relay:') ? res.via : `relay:${res.via}` };
      if (res.outcome === 'declined') return { kind: 'declined', why: res.why };
      return { kind: 'skipped', why: res.why };
    },
  };
}
