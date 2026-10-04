// `http`: a webhook (the cloud runner, or any consumer). The URL and its
// bearer token arrive as a per-delivery grant from resolve.
//
// A failed POST (non-2xx, timeout, network) is a decline, not a retry: the
// route falls through to its next `first` step (the runner wake), exactly as
// the in-app workspaceWebhook adapter does. Buildd's resolve parity table
// assumes this.

import { outboundTimeout, postToGrant } from './grant-post';
import type { FetchFn, TransportAdapter } from './types';

export function httpAdapter(fetchFn: FetchFn, now?: () => number): TransportAdapter {
  return {
    type: 'http',
    needsResolve: true,
    async deliver(ctx, _step, resolved) {
      if (!resolved?.grant) return { kind: 'declined', why: 'no_grant' };
      try {
        await postToGrant(fetchFn, resolved, { timeoutMs: outboundTimeout(ctx.options.timeoutMs), ...(now ? { now } : {}) });
      } catch (err) {
        return { kind: 'declined', why: `webhook_failed:${err instanceof Error ? err.message : 'error'}` };
      }
      return { kind: 'delivered', via: 'webhook' };
    },
  };
}
