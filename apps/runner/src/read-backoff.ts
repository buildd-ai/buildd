/**
 * Backing off on the server's read rate limit (apps/web lib/read-rate-limit.ts).
 *
 * The server answers an over-limit GET with 429 and Retry-After. Asking again
 * before then only earns another 429, so BuilddClient holds that endpoint: a
 * GET to it before Retry-After passes is refused here, without a request, as
 * the same `rate_limited` refusal. Writes are never held: the server does not
 * limit them, and runner coordination is exempt.
 */
import { isServerRefusal } from './server-refusal';

/** Retry-After (seconds, or an HTTP date) as whole seconds from now, at least 1; null when absent or unreadable. */
export function parseRetryAfter(value: string | null | undefined, nowMs: number): number | null {
  if (!value) return null;
  const v = value.trim();
  if (/^\d+$/.test(v)) return Math.max(1, Number(v));
  const at = Date.parse(v);
  if (Number.isNaN(at)) return null;
  return Math.max(1, Math.ceil((at - nowMs) / 1000));
}

const pathOf = (endpoint: string) => endpoint.split('?')[0];

export class ReadBackoff {
  private until = new Map<string, number>();
  constructor(private readonly now: () => number = Date.now) {}

  /** Record a 429 for this endpoint. Without Retry-After it is not the read limit, so nothing is held. */
  note(endpoint: string, retryAfter: string | null | undefined): void {
    const sec = parseRetryAfter(retryAfter, this.now());
    if (sec === null) return;
    this.until.set(pathOf(endpoint), this.now() + sec * 1000);
  }

  /** Whole seconds left on this endpoint's hold, or 0. */
  remainingSec(endpoint: string): number {
    const key = pathOf(endpoint);
    const until = this.until.get(key);
    if (until === undefined) return 0;
    const left = until - this.now();
    if (left <= 0) { this.until.delete(key); return 0; }
    return Math.ceil(left / 1000);
  }
}

/** The refusal body BuilddClient raises for a held endpoint: the server's own 429 shape. */
export function heldRefusalBody(retryAfterSec: number): string {
  return JSON.stringify({
    error: `The server is rate limiting reads; retrying after ${retryAfterSec}s.`,
    code: 'rate_limited',
    retryAfterSec,
  });
}

/** Seconds to wait when `err` is the server's read rate limit (or a held endpoint); null for anything else. */
export function rateLimitedRetryAfterSec(err: unknown): number | null {
  if (!isServerRefusal(err) || err.status !== 429) return null;
  try {
    const body = JSON.parse(err.raw);
    if (body?.code !== 'rate_limited') return null;
    return typeof body.retryAfterSec === 'number' && body.retryAfterSec > 0 ? body.retryAfterSec : 1;
  } catch {
    return null;
  }
}
