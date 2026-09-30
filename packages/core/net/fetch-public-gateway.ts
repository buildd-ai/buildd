/**
 * Fetch through a LiteLLM gateway with public address validation and caching.
 *
 * Server-side model calls (chat, decision) to a team-configured LiteLLM gateway
 * must only reach public addresses, never follow redirects, and must validate
 * the host on every call. A DNS lookup per call is expensive, so we cache the
 * validation result briefly.
 *
 * The cache is per baseURL and per process — it is not shared across workers and
 * does not require external infrastructure. A single team's gateway is checked
 * once per cache window (default 1 minute).
 */

import {
  checkPublicHost,
  NonPublicAddressError,
  RedirectRefusedError,
  type LookupAll,
} from './public-address';

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface CacheEntry {
  checkedAt: number;
  problem: string | null;
}

/**
 * Create a fetcher for LiteLLM gateway calls with public address checking
 * and host validation caching.
 *
 * @param opts.cacheTtlMs - How long to cache a host validation (default 60000 = 1 minute)
 * @param opts.lookup - Custom DNS lookup (for testing)
 * @param opts.allowLocal - Allow loopback hosts outside production (for testing)
 * @param opts.fetcher - Custom fetcher for testing; defaults to global fetch
 * @returns A fetcher that can be passed to inference or decision calls
 */
export function createPublicGatewayFetcher(opts: {
  cacheTtlMs?: number;
  lookup?: LookupAll;
  allowLocal?: boolean;
  fetcher?: Fetcher;
} = {}): Fetcher {
  const cacheTtlMs = opts.cacheTtlMs ?? 60_000;
  const hostCache = new Map<string, CacheEntry>();
  const doFetch = opts.fetcher ?? fetch;

  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    // AI SDK providers pass a string, a URL or a Request; check the same host
    // whichever it is.
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const { hostname } = new URL(url);
    const now = Date.now();
    const cached = hostCache.get(hostname);

    // Validate and cache the host check (but not every call)
    if (!cached || now - cached.checkedAt >= cacheTtlMs) {
      const problem = await checkPublicHost(hostname, { lookup: opts.lookup, allowLocal: opts.allowLocal });
      hostCache.set(hostname, { checkedAt: now, problem });
      if (problem) throw new NonPublicAddressError(problem);
    } else if (cached.problem) {
      // Use cached validation failure
      throw new NonPublicAddressError(cached.problem);
    }

    // Make the actual call with no-redirect policy and no following redirects
    const res = await doFetch(input, { ...init, redirect: 'manual' });
    if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
      await res.body?.cancel().catch(() => {});
      throw new RedirectRefusedError(res.status);
    }
    return res;
  };
}
