/**
 * Presence: is this person looking at buildd right now?
 * (docs/design/subscriptions-and-notifications.md, Presence; decision 2.)
 *
 * The chat page sends a beat every 30s while its tab is visible
 * (components/chat/ChatPresenceBeat.tsx -> POST /api/chat/presence). A visible
 * beat writes `presence:<userId>` to Redis with a 75s TTL; a hidden beat
 * deletes it. So the key lives while a visible tab keeps beating and lapses
 * within 75s of the tab closing, sleeping or going to the background.
 *
 * Failure mode, on purpose: no key, no Redis, a Redis error, or a malformed
 * value all read as `away`. Away is the state that delivers, so a presence bug
 * costs an extra ping, never a missed one. Postgres is not used: a 75s fact is
 * not worth a Neon wake (docs/design/cron-wake-windows.md).
 */

import { delKey, getKey, setWithTtl } from './redis';
import { PRESENCE_TTL_SEC } from './presence-shared';

export { PRESENCE_TTL_SEC, PRESENCE_BEAT_MS } from './presence-shared';

export interface PresenceRecord {
  conversationId: string | null;
  at: string;
}

export type Presence =
  | { state: 'present'; conversationId: string | null }
  | { state: 'away'; reason: 'no_beat' | 'unavailable' };

/** Get returns `undefined` for "could not ask", `null` for "no key". */
export interface PresenceStore {
  set(key: string, value: PresenceRecord, ttlSec: number): Promise<boolean>;
  get(key: string): Promise<PresenceRecord | null | undefined>;
  del(key: string): Promise<void>;
}

const redisStore: PresenceStore = {
  set: (key, value, ttl) => setWithTtl(key, value, ttl),
  get: key => getKey<PresenceRecord>(key),
  del: key => delKey(key),
};

export interface PresenceDeps { store?: PresenceStore; now?: () => Date }

export function presenceKey(userId: string): string {
  return `presence:${userId}`;
}

export async function recordBeat(
  userId: string,
  beat: { visible: boolean; conversationId: string | null },
  deps: PresenceDeps = {},
): Promise<{ stored: boolean }> {
  const store = deps.store ?? redisStore;
  const now = (deps.now ?? (() => new Date()))();
  try {
    if (!beat.visible) {
      await store.del(presenceKey(userId));
      return { stored: true };
    }
    const stored = await store.set(presenceKey(userId), { conversationId: beat.conversationId, at: now.toISOString() }, PRESENCE_TTL_SEC);
    return { stored };
  } catch {
    return { stored: false };
  }
}

export async function getPresence(userId: string, deps: PresenceDeps = {}): Promise<Presence> {
  const store = deps.store ?? redisStore;
  let value: PresenceRecord | null | undefined;
  try {
    value = await store.get(presenceKey(userId));
  } catch {
    return { state: 'away', reason: 'unavailable' };
  }
  if (value === undefined) return { state: 'away', reason: 'unavailable' };
  if (!value || typeof value !== 'object' || typeof value.at !== 'string') return { state: 'away', reason: 'no_beat' };
  return { state: 'present', conversationId: typeof value.conversationId === 'string' ? value.conversationId : null };
}
