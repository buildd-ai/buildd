import { describe, expect, it } from 'bun:test';
import {
  ACTIVE_MAX_AGE_MS,
  RETIRING_WINDOW_MS,
  RETIRING_WINDOW_FORCE_MS,
  JWKS_CLIENT_MAX_AGE_S,
  JWKS_SHARED_MAX_AGE_S,
  JWKS_SHARED_STALE_S,
  JWKS_SHARED_STALENESS_BUDGET_S,
  JWKS_CACHE_CONTROL,
} from './signing-key-windows';

/**
 * The JWKS cache policy is only correct relative to the key lifecycle, so it is
 * asserted relative to it.
 *
 * The endpoint previously sent `s-maxage=3600, stale-while-revalidate=86400`,
 * and a test pinned that exact header string — which passes for any value at
 * all, as long as whoever changes it also edits the expected string. It said
 * nothing about the property that made 3600 wrong.
 *
 * What made it wrong: a shared cache answers a relying party's "re-fetch on
 * unknown kid" from its own copy. So during a rotation the signer switches to
 * the new key immediately while an intermediary keeps serving a document
 * without it — observed live on the first real rotation, origin at two keys and
 * the edge at one. And forced revocation sets the compromised key to fall out
 * of the JWKS in ten minutes, which a day of permitted staleness simply
 * outlives.
 */
describe('JWKS cache policy vs key lifecycle', () => {
  it('lets a shared cache go stale for far less than the forced-revocation window', () => {
    // The whole point of ?force=true. If an intermediary may serve a revoked
    // key for longer than this, the emergency revocation path does nothing.
    expect(JWKS_SHARED_STALENESS_BUDGET_S * 1000).toBeLessThan(RETIRING_WINDOW_FORCE_MS);

    // Not merely less — with room, so shortening the forced window later does
    // not quietly land back at parity.
    expect(JWKS_SHARED_STALENESS_BUDGET_S * 1000).toBeLessThanOrEqual(
      RETIRING_WINDOW_FORCE_MS / 4,
    );
  });

  it('counts stale-while-revalidate as staleness', () => {
    // A stale document is exactly as wrong as a fresh outdated one, so swr is
    // in the budget. Excluding it is how 86400 looked acceptable next to a
    // 3600 s-maxage.
    expect(JWKS_SHARED_STALENESS_BUDGET_S).toBe(
      JWKS_SHARED_MAX_AGE_S + JWKS_SHARED_STALE_S,
    );
  });

  it('keeps the shared lifetime below the client lifetime', () => {
    // The asymmetry IS the fix: relying parties may cache for an hour because
    // they are also told to flush on unknown kid. Intermediaries have no such
    // instruction, so they get a fraction of it.
    expect(JWKS_SHARED_MAX_AGE_S).toBeLessThan(JWKS_CLIENT_MAX_AGE_S);
  });

  it('emits every directive it claims to, and no bare shared lifetime', () => {
    expect(JWKS_CACHE_CONTROL).toBe(
      `public, max-age=${JWKS_CLIENT_MAX_AGE_S}, s-maxage=${JWKS_SHARED_MAX_AGE_S}, stale-while-revalidate=${JWKS_SHARED_STALE_S}`,
    );

    // Without an explicit s-maxage a shared cache falls back to max-age, which
    // is the original bug wearing a shorter header.
    expect(JWKS_CACHE_CONTROL).toContain('s-maxage=');
  });

  it('rotates a key well before its retiring window would have expired it', () => {
    // Ordering sanity on the lifecycle itself: an Active key must be replaced
    // while there is still a meaningful overlap period to hand it.
    expect(RETIRING_WINDOW_MS).toBeLessThan(ACTIVE_MAX_AGE_MS);
    expect(RETIRING_WINDOW_FORCE_MS).toBeLessThan(RETIRING_WINDOW_MS);
  });
});
