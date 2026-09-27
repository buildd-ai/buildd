/** Client-safe presence constants (lib/presence.ts is server-only: it imports Redis). */

export const PRESENCE_TTL_SEC = 75;
/** How often a visible tab beats. Well inside the TTL so one dropped beat does not flip to away. */
export const PRESENCE_BEAT_MS = 30_000;
