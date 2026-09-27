/**
 * A cheap "anything to pull?" flag in front of the conversation's watch poll
 * (lib/chat/watch-delivery.ts). The open chat tab polls every 30s; without
 * this, every visible tab would query Postgres on every tick even with no
 * watches at all, and keep Neon awake (docs/design/cron-wake-windows.md).
 *
 *   set:   recordEvent (lib/subscriptions.ts) flags the person owner of every
 *          new ledger row whose watch posts into a conversation.
 *   read:  the poll reaches Postgres only when the flag is set, or when the
 *          conversation is opened (open always drains).
 *   clear: the drain clears it once the owner is present and nothing of
 *          theirs is left pending. While they are away the flag stays, so
 *          the record of a row Pushover delivers is posted when they return.
 *
 * Redis missing or failing reads as `unknown`: the poll falls back to
 * querying, at a longer interval (UNKNOWN_POLL_MS).
 */

import type { SQL } from 'drizzle-orm';
import { delKey, getKey, setWithTtl } from './redis';

/** Outlives a one-shot watch (7 days), so a flag never lapses before its row is posted. */
export const WATCH_PENDING_TTL_SEC = 8 * 24 * 60 * 60;
export const POLL_MS = 30_000;
export const UNKNOWN_POLL_MS = 120_000;

export type PendingState = 'set' | 'clear' | 'unknown';

export function watchPendingKey(userId: string): string {
  return `watch-pending:${userId}`;
}

type Exec = (q: SQL) => Promise<{ rows?: unknown[] }>;

export async function flagWatchOwners(rows: ReadonlyArray<{ subscription_id?: string }>, exec: Exec): Promise<number> {
  const ids = [...new Set(rows.map(r => r.subscription_id).filter((v): v is string => !!v))];
  if (ids.length === 0) return 0;
  const { conversationOwnersSql } = await import('./subscriptions');
  const owners = ((await exec(conversationOwnersSql(ids))).rows ?? []) as Array<{ userId: string }>;
  for (const o of owners) await setWithTtl(watchPendingKey(o.userId), 1, WATCH_PENDING_TTL_SEC);
  return owners.length;
}

export async function watchPendingState(userId: string): Promise<PendingState> {
  try {
    const v = await getKey<unknown>(watchPendingKey(userId));
    if (v === undefined) return 'unknown';
    return v === null ? 'clear' : 'set';
  } catch {
    return 'unknown';
  }
}

export async function clearWatchPending(userId: string): Promise<void> {
  try { await delKey(watchPendingKey(userId)); } catch { /* the flag lapses on its own */ }
}
