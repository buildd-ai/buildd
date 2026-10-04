// `http`: a webhook (the cloud runner, or any consumer). The URL and its
// bearer token arrive as a per-delivery grant from resolve.

import { outboundTimeout, postToGrant } from './grant-post';
import type { FetchFn, TransportAdapter } from './types';

export function httpAdapter(fetchFn: FetchFn, now?: () => number): TransportAdapter {
  return {
    type: 'http',
    needsResolve: true,
    async deliver(ctx, _step, resolved) {
      if (!resolved?.grant) return { kind: 'declined', why: 'no_grant' };
      await postToGrant(fetchFn, resolved, { timeoutMs: outboundTimeout(ctx.options.timeoutMs), ...(now ? { now } : {}) });
      return { kind: 'delivered', via: 'webhook' };
    },
  };
}
