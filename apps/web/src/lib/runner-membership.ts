/**
 * Runner presence (docs/specs/runner-heartbeat.md, "Presence channel").
 *
 * A runner is a member of `presence-runner-<accountId>` while its Pusher socket
 * is up; the Pusher webhook tells us when that changes. The channel name's
 * `user_id` is the runner's `localUiUrl`, so a member maps to one
 * `worker_heartbeats` row. State is written only on a change, atomically.
 */
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { sqlWhere } from '@buildd/core/db/relational-sql';
import { workerHeartbeats } from '@buildd/core/db/schema';
import { channels } from './pusher';

/** One account never nears Pusher's 100-member cap; the join auth refuses beyond this. */
export const MAX_RUNNERS_PER_PRESENCE_CHANNEL = 50;

/** A removal this soon after an add for the same member is a reconnect flap: confirm it. */
export const PRESENCE_FLAP_WINDOW_MS = 5_000;

const PREFIX = process.env.PUSHER_CHANNEL_PREFIX || '';
const BASE = `${PREFIX}presence-runner-`;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The account a presence channel name belongs to, or null for any other channel. */
export function accountOfPresenceChannel(channel: string): string | null {
  if (!channel.startsWith(BASE)) return null;
  const id = channel.slice(BASE.length);
  return UUID_RE.test(id) ? id : null;
}

export interface PusherWebhookEvent {
  name: string;
  channel: string;
  user_id?: string;
  time_ms?: number;
}

export type PresenceOutcome = 'written' | 'unchanged' | 'ignored';

export interface PresenceDeps {
  /** Is this member still in the channel? Undefined: could not ask (trust the event). */
  isMember?: (channel: string, userId: string) => Promise<boolean | undefined>;
}

/** Apply one member_added / member_removed event. Writes only when the state changes and the event is newer. */
export async function applyPresenceEvent(ev: PusherWebhookEvent, deps: PresenceDeps = {}): Promise<PresenceOutcome> {
  if (ev.name !== 'member_added' && ev.name !== 'member_removed') return 'ignored';
  const accountId = accountOfPresenceChannel(ev.channel);
  if (!accountId || !ev.user_id) return 'ignored';
  const connected = ev.name === 'member_added';
  const at = new Date(typeof ev.time_ms === 'number' && Number.isFinite(ev.time_ms) ? ev.time_ms : Date.now());
  const key = and(eq(workerHeartbeats.accountId, accountId), eq(workerHeartbeats.localUiUrl, ev.user_id));

  // A removal right after an add may be the old socket's leave arriving late.
  if (!connected && deps.isMember) {
    const row = await db.query.workerHeartbeats.findFirst({ where: sqlWhere(key), columns: { presenceChangedAt: true, presenceConnected: true } });
    if (row?.presenceConnected && row.presenceChangedAt && at.getTime() - row.presenceChangedAt.getTime() < PRESENCE_FLAP_WINDOW_MS) {
      if ((await deps.isMember(ev.channel, ev.user_id)) === true) return 'unchanged';
    }
  }

  const updated = await db.update(workerHeartbeats)
    .set({ presenceConnected: connected, presenceChangedAt: at })
    .where(and(
      key,
      sql`${workerHeartbeats.presenceConnected} IS DISTINCT FROM ${connected}`,
      or(isNull(workerHeartbeats.presenceChangedAt), lt(workerHeartbeats.presenceChangedAt, at)),
    ))
    .returning({ id: workerHeartbeats.id });
  if (updated.length > 0) return 'written';

  // No row yet: the runner joined before its first beat. Seed one with an epoch
  // beat (never online by itself); the beat upsert leaves presence alone.
  if (connected) {
    const exists = await db.query.workerHeartbeats.findFirst({ where: sqlWhere(key), columns: { id: true } });
    if (!exists) {
      const seeded = await db.insert(workerHeartbeats)
        .values({ accountId, localUiUrl: ev.user_id, lastHeartbeatAt: new Date(0), presenceConnected: true, presenceChangedAt: at })
        .onConflictDoNothing()
        .returning({ id: workerHeartbeats.id });
      if (seeded.length > 0) return 'written';
    }
  }
  return 'unchanged';
}

export { channels };
