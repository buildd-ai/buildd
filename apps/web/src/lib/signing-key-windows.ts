/**
 * Signing key lifecycle windows, and the JWKS cache policy that has to fit
 * inside them.
 *
 * These live in a dependency-free module for one reason: the relationship
 * between them is the actual security property, and a test can only assert it
 * if it can import the real numbers. `signing-keys.ts` pulls in the database,
 * so tests mock it wholesale — constants exported from there would be replaced
 * by the mock and the invariant below would be asserted against fiction.
 *
 * Lifecycle (spec §B.2–B.3): Active → Retiring → Revoked.
 */

/** An Active key older than this is rotated by the weekly cron. */
export const ACTIVE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * How long a rotated key stays Retiring: still published in JWKS, no longer
 * signing. This is what keeps assertions minted just before a rotation
 * verifiable.
 */
export const RETIRING_WINDOW_MS = 10 * 24 * 60 * 60 * 1000; // 10 days

/**
 * The forced-revocation window (`?force=true`). A compromised key is given
 * minutes, not days — the spec's promise is that it is "absent from the JWKS
 * within minutes".
 */
export const RETIRING_WINDOW_FORCE_MS = 10 * 60 * 1000; // 10 minutes

/**
 * What a resource server is told to cache. Deliberately long: the spec asks
 * relying parties to cache for at least an hour to avoid hammering the
 * endpoint, and pairs that with "MUST re-fetch on unknown kid" as the recovery
 * path for a rotation.
 */
export const JWKS_CLIENT_MAX_AGE_S = 3600; // 1 hour

/**
 * What SHARED caches (Vercel's edge, any intermediary) may hold, and this is
 * the part that must stay small.
 *
 * `max-age` above is safe because the relying party is also instructed to flush
 * on an unknown `kid`. A shared cache is not: it answers that flush from its own
 * copy, so its freshness lifetime — not the relying party's — is the real
 * publication delay for a new key and the real persistence of a revoked one.
 *
 * Observed in production during the first live rotation: origin served the new
 * two-key document while the edge served a one-key HIT, so an RS obeying
 * "re-fetch on unknown kid" would still have been handed a set without the kid
 * that was already signing.
 *
 * Sized against `RETIRING_WINDOW_FORCE_MS`, not against taste: forced
 * revocation is meaningless if a shared cache can outlive it. Asserted in
 * signing-key-windows.test.ts.
 */
export const JWKS_SHARED_MAX_AGE_S = 60;

/**
 * Stale-serving allowance for shared caches, traded against the same window.
 * Non-zero so an origin blip degrades to a slightly stale key set rather than a
 * 503, but counted in full as staleness — a stale document is exactly as wrong
 * as a fresh-but-outdated one.
 */
export const JWKS_SHARED_STALE_S = 60;

/** Worst case a shared cache can serve a key set that no longer matches truth. */
export const JWKS_SHARED_STALENESS_BUDGET_S =
  JWKS_SHARED_MAX_AGE_S + JWKS_SHARED_STALE_S;

export const JWKS_CACHE_CONTROL =
  `public, max-age=${JWKS_CLIENT_MAX_AGE_S}` +
  `, s-maxage=${JWKS_SHARED_MAX_AGE_S}` +
  `, stale-while-revalidate=${JWKS_SHARED_STALE_S}`;
