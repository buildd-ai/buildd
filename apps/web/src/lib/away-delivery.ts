/**
 * Away delivery: push a person's pending watch events to their own Pushover
 * key when they are not looking at buildd.
 * (docs/design/subscriptions-and-notifications.md, Presence, Delivery routing
 * step 6, Limits.)
 *
 * Trigger: a cron (`/api/cron/notify-away`, cron-manifest.json), gated by a
 * Redis due-queue so an idle tick never wakes Postgres:
 *   - `recordEvent` (lib/subscriptions.ts) marks each new ledger row due at
 *     created + COALESCE_MS (urgent rows: immediately) via markAwayDue.
 *   - `?gate=due` every 2 minutes (even minutes) reads that queue and returns
 *     unless something is due.
 *   - The hourly floor tick (an odd minute, so it never shares a minute with
 *     the gated tick) runs regardless and heals a lost queue write.
 * Why not deliver on the event itself: the emit sites are request paths
 * (GitHub webhook, worker PATCH) and a burst has to be coalesced into one push,
 * which needs a window. The queue gives both: minute-scale latency, one
 * message per burst, and no Neon wake while nothing happens.
 *
 * Per person, per tick:
 *   no usable personal key -> never fetched (filtered in SQL). Never the team key (decision 1).
 *   burst younger than the window -> looked at again when it is a window old.
 *   present          -> nothing sent; looked at again one window later, so if
 *                       they leave and the row is still pending it goes out then.
 *   away (incl. no Redis) -> under a per-person lock: re-read their pending
 *                       rows, one Pushover message for all of them, then
 *                       markDelivered(route 'pushover') on each.
 *   over the rate    -> rows stay pending (retried later); one "N more held"
 *                       notice per hour.
 *
 * The lock (Redis SET NX, 60s, released after marking) is what makes the
 * per-person cap and the exactly-one-push hold when two ticks overlap: the
 * rows and the hourly count are re-read inside it, so the second run sees
 * what the first marked. With no Redis the lock cannot be taken and the run
 * proceeds (the fail-toward-delivering rule); overlapping ticks are then
 * possible but rare, since the two schedules never share a minute.
 *
 * Send before mark, deliberately. markDelivered is the exactly-once claim, but
 * claiming first means a Pushover outage marks rows delivered that never
 * arrived. Sending first means the worst case is a duplicate push, which is
 * the failure the design chooses: an extra ping, never a missed one.
 */

import { sql, type SQL } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { markDelivered as markDeliveredImpl } from './subscriptions';
import { AWAY_QUEUE, COALESCE_MS } from './notify-away-queue';
import { getPresence, type Presence } from './presence';
import {
  loadPersonalPushoverKey,
  markPersonalPushoverRejected,
  personalSenderToken,
  sendPushoverMessage,
  PERSONAL_PUSHOVER_PURPOSE,
  type PushoverMessage,
  type SendOutcome,
} from './personal-pushover';

export { AWAY_QUEUE, COALESCE_MS, markAwayDue } from './notify-away-queue';
/** Rows older than this are left for the inbox rather than pushed late. */
export const MAX_PUSH_AGE_MS = 24 * 60 * 60_000;
/** Per person, external pushes per rolling hour (design, Limits). */
export const PUSHES_PER_HOUR = 12;
/** Of those, how many may use Pushover's high priority. */
export const URGENT_PUSHES_PER_HOUR = 3;
/** When over the rate, look again after this long. */
export const HELD_RETRY_MS = 20 * 60_000;
/** Per-person lock around read, send and mark. */
export const LOCK_TTL_SEC = 60;
const MAX_OWNERS_PER_TICK = 200;
const MAX_ROWS_PER_OWNER = 50;
const MAX_LINES = 8;

type Exec = (q: SQL) => Promise<{ rows?: unknown[] }>;
const dbExec: Exec = q => db.execute(q) as unknown as Promise<{ rows?: unknown[] }>;

export interface AwayRow {
  id: string;
  eventType: string;
  payload: Record<string, unknown>;
  urgency: 'low' | 'normal' | 'urgent';
  createdAt: string;
  ownerUserId: string;
  teamId: string;
}

export interface AwayOwner {
  ownerUserId: string;
  teamId: string;
  oldest: string | Date;
  urgent: boolean;
}

// ── SQL ─────────────────────────────────────────────────────────────────────

/**
 * People with pending rows who can actually receive a push: one row per
 * (owner, team), oldest burst first, so the cap is over people, not rows, and
 * one busy person cannot starve everyone else. Owners with no usable personal
 * key are filtered here, in SQL, so their rows are never fetched at all.
 */
export function awayOwnersSql(now: Date): SQL {
  const since = new Date(now.getTime() - MAX_PUSH_AGE_MS).toISOString();
  return sql`
    select s."owner_user_id" as "ownerUserId", s."team_id" as "teamId",
      min(d."created_at") as "oldest", bool_or(d."urgency" = 'urgent') as "urgent"
    from "notification_deliveries" d
    join "subscriptions" s on s."id" = d."subscription_id"
    where d."status" = 'pending'
      and s."owner_user_id" is not null
      and s."ended_at" is null
      and d."created_at" > ${since}::timestamptz
      and exists (
        select 1 from "secrets" k
        where k."purpose" = ${PERSONAL_PUSHOVER_PURPOSE}
          and k."user_id" = s."owner_user_id"
          and k."team_id" = s."team_id"
          and k."account_id" is null
          and k."workspace_id" is null
          and k."health_status" <> 'revoked'
      )
    group by s."owner_user_id", s."team_id"
    order by min(d."created_at") asc
    limit ${MAX_OWNERS_PER_TICK}
  `;
}

/** One person's pending rows, read under their lock so a second run sees what the first marked. */
export function ownerPendingRowsSql(userId: string, teamId: string, now: Date): SQL {
  const since = new Date(now.getTime() - MAX_PUSH_AGE_MS).toISOString();
  return sql`
    select d."id", d."event_type" as "eventType", d."payload", d."urgency", d."created_at" as "createdAt",
      s."owner_user_id" as "ownerUserId", s."team_id" as "teamId"
    from "notification_deliveries" d
    join "subscriptions" s on s."id" = d."subscription_id"
    where s."owner_user_id" = ${userId}::uuid
      and s."team_id" = ${teamId}::uuid
      and d."status" = 'pending'
      and s."ended_at" is null
      and d."created_at" > ${since}::timestamptz
    order by d."created_at" asc
    limit ${MAX_ROWS_PER_OWNER}
  `;
}

/**
 * Pushes sent to this person in the last hour. One message marks all its rows
 * with the same delivered_at, so distinct timestamps count messages, not rows.
 */
export function recentPushesSql(userId: string, now: Date): SQL {
  const since = new Date(now.getTime() - 60 * 60_000).toISOString();
  return sql`
    select count(distinct d."delivered_at")::int as "sent",
      count(distinct d."delivered_at") filter (where d."urgency" = 'urgent')::int as "urgent"
    from "notification_deliveries" d
    join "subscriptions" s on s."id" = d."subscription_id"
    where s."owner_user_id" = ${userId}::uuid
      and d."route" = 'pushover'
      and d."status" = 'delivered'
      and d."delivered_at" > ${since}::timestamptz
  `;
}

// ── Rendering ───────────────────────────────────────────────────────────────

const EVENT_LABEL: Record<string, string> = {
  'task.completed': 'Task completed',
  'task.failed': 'Task failed',
  'task.needs_input': 'Needs your input',
  'pr.merged': 'PR merged',
  'pr.ci_failed': 'CI failed',
};

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

function subjectLine(row: AwayRow): string {
  const p = row.payload ?? {};
  if (row.eventType.startsWith('pr.')) {
    const ref = str(p.repo) && typeof p.prNumber === 'number' ? `${p.repo}#${p.prNumber}` : 'a pull request';
    return str(p.title) ? `${ref} ${str(p.title)}` : ref;
  }
  return str(p.title) ?? 'a task';
}

function rowUrl(row: AwayRow, appUrl: string): string | undefined {
  const p = row.payload ?? {};
  if (row.eventType.startsWith('pr.')) return str(p.url) ?? undefined;
  return str(p.taskId) ? `${appUrl}/app/tasks/${p.taskId}` : undefined;
}

export function renderAwayMessage(rows: AwayRow[], opts: { appUrl: string; urgentAllowed: boolean }): Omit<PushoverMessage, 'token' | 'user'> {
  const urgent = rows.some(r => r.urgency === 'urgent');
  const allLow = rows.every(r => r.urgency === 'low');
  const priority: PushoverMessage['priority'] = urgent && opts.urgentAllowed ? 1 : allLow ? -1 : 0;
  if (rows.length === 1) {
    const [r] = rows;
    const url = rowUrl(r, opts.appUrl);
    return { title: EVENT_LABEL[r.eventType] ?? 'Update', message: subjectLine(r).slice(0, 1000), priority, ...(url ? { url, urlTitle: 'Open' } : {}) };
  }
  const lines = rows.slice(0, MAX_LINES).map(r => `${EVENT_LABEL[r.eventType] ?? 'Update'}: ${subjectLine(r)}`.slice(0, 120));
  if (rows.length > MAX_LINES) lines.push(`and ${rows.length - MAX_LINES} more`);
  return { title: `${rows.length} updates`, message: lines.join('\n').slice(0, 1000), priority, url: `${opts.appUrl}/app`, urlTitle: 'Open buildd' };
}

// ── The job ─────────────────────────────────────────────────────────────────

export interface AwayLock {
  /** true = acquired, false = another run holds it, null = could not ask (no Redis: proceed). */
  acquire(userId: string): Promise<boolean | null>;
  release(userId: string): Promise<void>;
}

export interface AwayDeps {
  exec?: Exec;
  now?: () => Date;
  appUrl?: string;
  presence?: (userId: string) => Promise<Presence>;
  loadKey?: (userId: string, teamId: string) => Promise<string | null>;
  send?: (m: PushoverMessage) => Promise<SendOutcome>;
  senderToken?: () => string | null;
  markDelivered?: typeof markDeliveredImpl;
  /** True the first time it is asked for this person in the current hour. */
  heldNoticeOnce?: (userId: string, now: Date) => Promise<boolean>;
  markKeyRejected?: (userId: string, teamId: string, error: string) => Promise<void>;
  lock?: AwayLock;
  queue?: { clearThrough(nowMs: number): Promise<void>; requeue(members: string[], dueAtMs: number): Promise<void> };
}

export interface AwaySummary {
  people: number;
  rows: number;
  sent: number;
  delivered: number;
  present: number;
  noKey: number;
  notReady: number;
  held: number;
  locked: number;
  failed: number;
  gated?: 'no_sender';
}

/** Queue member meaning "look at this person again", beside the per-row members recordEvent writes. */
export function ownerMember(userId: string, teamId: string): string {
  return `owner:${userId}:${teamId}`;
}

export async function deliverAwayNotifications(deps: AwayDeps = {}): Promise<AwaySummary> {
  const exec = deps.exec ?? dbExec;
  const now = (deps.now ?? (() => new Date()))();
  const appUrl = deps.appUrl ?? process.env.NEXT_PUBLIC_APP_URL ?? 'https://buildd.dev';
  const presence = deps.presence ?? (userId => getPresence(userId));
  const loadKey = deps.loadKey ?? ((u, t) => loadPersonalPushoverKey(u, t, exec));
  const send = deps.send ?? (m => sendPushoverMessage(m));
  const mark = deps.markDelivered ?? markDeliveredImpl;
  const heldNoticeOnce = deps.heldNoticeOnce ?? defaultHeldNoticeOnce;
  const markKeyRejected = deps.markKeyRejected ?? markPersonalPushoverRejected;
  const lock = deps.lock ?? defaultLock;
  const queue = deps.queue ?? defaultQueue;
  const summary: AwaySummary = { people: 0, rows: 0, sent: 0, delivered: 0, present: 0, noKey: 0, notReady: 0, held: 0, locked: 0, failed: 0 };

  const token = (deps.senderToken ?? personalSenderToken)();
  if (!token) {
    // Nothing can be sent, so do not touch the ledger; rows stay for the inbox.
    return { ...summary, gated: 'no_sender' };
  }

  const owners = ((await exec(awayOwnersSql(now))).rows ?? []) as AwayOwner[];
  summary.people = owners.length;

  // Clear everything due now first; anyone who must be looked at again is
  // re-added below with a future score.
  await queue.clearThrough(now.getTime());

  for (const owner of owners) {
    const { ownerUserId: userId, teamId } = owner;
    const again = (dueAtMs: number) => queue.requeue([ownerMember(userId, teamId)], dueAtMs);
    try {
      // Coalesce: wait until the burst's first row is a window old, unless something is urgent.
      const readyAt = new Date(owner.oldest).getTime() + COALESCE_MS;
      if (!owner.urgent && now.getTime() < readyAt) { summary.notReady++; await again(readyAt); continue; }

      // Present: they see it in chat. Look again one window later, so if they
      // leave and the row is still pending it goes out on the normal cadence.
      if ((await presence(userId)).state === 'present') { summary.present++; await again(now.getTime() + COALESCE_MS); continue; }

      const got = await lock.acquire(userId);
      if (got === false) { summary.locked++; continue; }
      try {
        await deliverOne(userId, teamId, again);
      } finally {
        if (got === true) await lock.release(userId);
      }
    } catch (err) {
      summary.failed++;
      console.error('[away-delivery] person failed:', err instanceof Error ? err.message : 'unknown');
    }
  }
  return summary;

  async function deliverOne(userId: string, teamId: string, again: (dueAtMs: number) => Promise<void>): Promise<void> {
    // Re-read under the lock: an overlapping run may have delivered these already.
    const group = ((await exec(ownerPendingRowsSql(userId, teamId, now))).rows ?? []) as AwayRow[];
    if (group.length === 0) return;
    summary.rows += group.length;

    const userKey = await loadKey(userId, teamId);
    if (!userKey) { summary.noKey++; return; }

    const counts = ((await exec(recentPushesSql(userId, now))).rows?.[0] ?? {}) as { sent?: number | string; urgent?: number | string };
    if (Number(counts.sent ?? 0) >= PUSHES_PER_HOUR) {
      summary.held++;
      if (await heldNoticeOnce(userId, now)) {
        await send({
          token: token!, user: userKey, title: 'buildd',
          message: `${group.length} more ${group.length === 1 ? 'update is' : 'updates are'} held in buildd. You have had ${PUSHES_PER_HOUR} alerts this hour.`,
          priority: -1, url: `${appUrl}/app`, urlTitle: 'Open buildd',
        });
      }
      await again(now.getTime() + HELD_RETRY_MS);
      return;
    }

    const urgentAllowed = Number(counts.urgent ?? 0) < URGENT_PUSHES_PER_HOUR;
    const outcome = await send({ token: token!, user: userKey, ...renderAwayMessage(group, { appUrl, urgentAllowed }) });
    if (outcome === 'rejected') {
      summary.failed++;
      await markKeyRejected(userId, teamId, 'Pushover rejected this key when sending an alert.');
      return;
    }
    if (outcome === 'failed') {
      summary.failed++;
      await again(now.getTime() + 5 * 60_000);
      return;
    }
    summary.sent++;
    for (const r of group) {
      const res = await mark({ userId }, r.id, { route: 'pushover' }, { exec, now: () => now });
      if (res.marked) summary.delivered++;
    }
  }
}

const defaultQueue: NonNullable<AwayDeps['queue']> = {
  async clearThrough(nowMs) {
    const { clearDueThrough } = await import('./redis');
    await clearDueThrough(AWAY_QUEUE, nowMs);
  },
  async requeue(members, dueAtMs) {
    const { markDue } = await import('./redis');
    await Promise.all(members.map(m => markDue(AWAY_QUEUE, m, dueAtMs)));
  },
};

const lockKey = (userId: string) => `notify-away:lock:${userId}`;

const defaultLock: AwayLock = {
  async acquire(userId) {
    const { tryLock } = await import('./redis');
    return tryLock(lockKey(userId), LOCK_TTL_SEC);
  },
  async release(userId) {
    const { delKey } = await import('./redis');
    await delKey(lockKey(userId));
  },
};

async function defaultHeldNoticeOnce(userId: string, now: Date): Promise<boolean> {
  const { setOnce } = await import('./redis');
  const hour = now.toISOString().slice(0, 13);
  // Without Redis this is false: the held notice is the extra, so it is the part that goes.
  return setOnce(`notify-away:held:${userId}:${hour}`, 3600);
}
