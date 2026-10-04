/**
 * Dispatch transport Worker. Producers publish signed envelopes here; each
 * scope's queue is a ScopeQueue Durable Object. Transport only: the producer
 * stays the authority for state, policy and claims. See README.md.
 */
import type { Env } from './env';
import { handleRequest, type QueueHandle } from './http';

export { ScopeQueue } from './scope-queue';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env, scopeKey =>
      env.SCOPE_QUEUE.get(env.SCOPE_QUEUE.idFromName(scopeKey)) as unknown as QueueHandle);
  },
} satisfies ExportedHandler<Env>;
