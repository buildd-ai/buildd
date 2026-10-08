// POST a resolved payload to a grant, for the http adapter. Error messages
// are fixed strings:
// never the URL (it can carry a capability) and never a header.

import type { ResolvedDeliver, FetchFn } from './types';

export const DEFAULT_OUTBOUND_TIMEOUT_MS = 10_000;
export const MAX_OUTBOUND_TIMEOUT_MS = 30_000;

export function outboundTimeout(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(v, MAX_OUTBOUND_TIMEOUT_MS) : DEFAULT_OUTBOUND_TIMEOUT_MS;
}

/** Throws (retryable) on a non-2xx, a timeout, a network error or an expired grant. */
export async function postToGrant(
  fetchFn: FetchFn,
  resolved: ResolvedDeliver,
  opts: { timeoutMs: number; defaultHeaders?: Record<string, string>; now?: () => number },
): Promise<void> {
  const grant = resolved.grant!;
  const now = opts.now ?? Date.now;
  if (grant.expiresAt && Date.parse(grant.expiresAt) <= now()) throw new Error('grant_expired');
  let res: Response;
  try {
    res = await fetchFn(grant.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...opts.defaultHeaders, ...grant.headers },
      body: JSON.stringify(resolved.payload),
      signal: AbortSignal.timeout(opts.timeoutMs),
      redirect: 'manual',
    });
  } catch (err) {
    const n = (err as { name?: string } | null)?.name;
    throw new Error(n === 'TimeoutError' || n === 'AbortError' ? 'timeout' : 'network_error');
  }
  // Drain so the connection is released; the body is never read into a log.
  try { await res.body?.cancel(); } catch { /* ignore */ }
  if (res.status < 200 || res.status >= 300) throw new Error(`http_${res.status}`);
}
