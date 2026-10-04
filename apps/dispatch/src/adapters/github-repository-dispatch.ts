// `github-repository-dispatch`: POST to a repository's dispatches endpoint.
// The URL and a repo-scoped installation token arrive as a grant from
// resolve; the App key never leaves the producer. GitHub answers 204.

import { outboundTimeout, postToGrant } from './grant-post';
import type { FetchFn, TransportAdapter } from './types';

export function githubRepositoryDispatchAdapter(fetchFn: FetchFn, now?: () => number): TransportAdapter {
  return {
    type: 'github-repository-dispatch',
    needsResolve: true,
    async deliver(ctx, _step, resolved) {
      if (!resolved?.grant) return { kind: 'declined', why: 'no_grant' };
      await postToGrant(fetchFn, resolved, {
        timeoutMs: outboundTimeout(ctx.options.timeoutMs),
        defaultHeaders: { Accept: 'application/vnd.github+json', 'User-Agent': 'buildd-dispatch' },
        ...(now ? { now } : {}),
      });
      return { kind: 'delivered', via: 'github-actions' };
    },
  };
}
