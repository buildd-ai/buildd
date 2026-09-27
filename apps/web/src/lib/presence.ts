/**
 * Presence: is this person looking at buildd right now?
 * (docs/design/subscriptions-and-notifications.md, Presence; decision 2.)
 *
 * The chat page sends a beat every 30s while its tab is visible
 * (components/chat/ChatPresenceBeat.tsx -> POST /api/chat/presence).
 *
 * Per tab, not per person. `presence:<userId>` is a Redis sorted set with one
 * member per mounted chat page (`<tabId>|<conversationId>`), scored by that
 * tab's expiry (beat + 75s). A visible beat upserts the tab's member; a hidden
 * beat removes only that member. So two open tabs cannot clear each other, and
 * a late "hidden" beacon from a page that has since been replaced (a new
 * mount gets a new tab id) removes nothing that is still live. The person is
 * present while any member's expiry is in the future.
 *
 * Failure mode, on purpose: no live tab, no Redis, a Redis error, or a
 * malformed member all read as `away`. Away is the state that delivers, so a
 * presence bug costs an extra ping, never a missed one. Postgres is not used:
 * a 75s fact is not worth a Neon wake (docs/design/cron-wake-windows.md).
 */

import { presenceAdd, presenceLive, presenceRemove } from './redis';
import { PRESENCE_TTL_SEC } from './presence-shared';

export { PRESENCE_TTL_SEC, PRESENCE_BEAT_MS } from './presence-shared';

export type Presence =
  | { state: 'present'; conversationId: string | null }
  | { state: 'away'; reason: 'no_beat' | 'unavailable' };

/** `live` returns `undefined` for "could not ask"; `add` returns false for the same. */
export interface PresenceStore {
  add(key: string, member: string, expiresAtMs: number, ttlSec: number, nowMs: number): Promise<boolean>;
  remove(key: string, member: string): Promise<void>;
  live(key: string, nowMs: number): Promise<string[] | undefined>;
}

const redisStore: PresenceStore = {
  add: presenceAdd,
  remove: presenceRemove,
  live: presenceLive,
};

export interface PresenceDeps { store?: PresenceStore; now?: () => Date }

export function presenceKey(userId: string): string {
  return `presence:${userId}`;
}

/** Beats without a tab id (an old client) share one member, which is the pre-per-tab behaviour. */
export const DEFAULT_TAB_ID = 'default';

function member(tabId: string, conversationId: string | null): string {
  return `${tabId}|${conversationId ?? ''}`;
}

export async function recordBeat(
  userId: string,
  beat: { visible: boolean; conversationId: string | null; tabId?: string | null },
  deps: PresenceDeps = {},
): Promise<{ stored: boolean }> {
  const store = deps.store ?? redisStore;
  const now = (deps.now ?? (() => new Date()))().getTime();
  const m = member(beat.tabId || DEFAULT_TAB_ID, beat.conversationId);
  try {
    if (!beat.visible) {
      await store.remove(presenceKey(userId), m);
      return { stored: true };
    }
    return { stored: await store.add(presenceKey(userId), m, now + PRESENCE_TTL_SEC * 1000, PRESENCE_TTL_SEC, now) };
  } catch {
    return { stored: false };
  }
}

/** Present while any tab's beat is live. The conversation is the first live tab's, if it has one. */
export async function getPresence(userId: string, deps: PresenceDeps = {}): Promise<Presence> {
  const store = deps.store ?? redisStore;
  const now = (deps.now ?? (() => new Date()))().getTime();
  let live: string[] | undefined;
  try {
    live = await store.live(presenceKey(userId), now);
  } catch {
    return { state: 'away', reason: 'unavailable' };
  }
  if (live === undefined) return { state: 'away', reason: 'unavailable' };
  const tabs = (Array.isArray(live) ? live : []).filter((m): m is string => typeof m === 'string' && m.includes('|'));
  if (tabs.length === 0) return { state: 'away', reason: 'no_beat' };
  const conv = tabs.map(m => m.slice(m.indexOf('|') + 1)).find(c => c.length > 0);
  return { state: 'present', conversationId: conv ?? null };
}
