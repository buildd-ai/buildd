/**
 * Away delivery: push a person's pending watch events to their own Pushover
 * key when they are not looking at buildd.
 * (docs/design/subscriptions-and-notifications.md, Presence, Delivery routing
 * step 6, Limits.)
 *
 * Trigger: a cron (`/api/cron/notify-away`, cron-manifest.json), gated by a
 * Redis due-queue so an idle tick never wakes Postgres:
 *   - `recordEvent` (lib/subscriptions.ts) marks each new ledger row due at
 *     created + COALESCE_MS (urgent rows: immediately) via markAwayDue below.
 *   - `?gate=due` every 2 minutes reads that queue and returns unless a row is due.
 *   - The hourly floor tick runs regardless, which heals a lost queue write and
 *     picks up rows left pending while their owner was present and has since left.
 * Why not deliver on the event itself: the emit sites are request paths
 * (GitHub webhook, worker PATCH) and a burst has to be coalesced into one push,
 * which needs a window. The queue gives both: seconds-to-minutes latency,
 * one message per burst, and no Neon wake while nothing happens.
 *
 * Per person, per tick:
 *   present          -> nothing. The row stays pending for the conversation or inbox.
 *   away (incl. no Redis) -> one Pushover message for every pending row, then
 *                       markDelivered(route 'pushover') on each.
 *   no personal key  -> nothing. Never the team key (decision 1).
 *   over the rate    -> rows stay pending; one "N more held" notice per hour.
 *
 * Send before mark, deliberately. markDelivered is the exactly-once claim, but
 * claiming first means a Pushover outage marks rows delivered that never
 * arrived. Sending first means the worst case is a duplicate push (a
 * concurrent conversation delivery, an overlapping tick), which is the failure
 * the design chooses: an extra ping, never a missed one.
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
const MAX_ROWS_PER_TICK = 500;
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

// ── SQL ─────────────────────────────────────────────────────────────────────

/** Pending rows of live person-owned watches, recent enough to still be worth a push. */
export function pendingPersonRowsSql(now: Date): SQL {
  const since = new Date(now.getTime() - MAX_PUSH_AGE_MS).toISOString();
  return sql`
    select d."id", d."event_type" as "eventType", d."payload", d."urgency", d."created_at" as "createdAt",
      s."owner_user_id" as "ownerUserId", s."team_id" as "teamId"
    from "notification_deliveries" d
    join "subscriptions" s on s."id" = d."subscription_id"
    where d."status" = 'pending'
      and s."owner_user_id" is not null
      and s."ended_at" is null
      and d."created_at" > ${since}::timestamptz
    order by d."created_at" asc
    limit ${MAX_ROWS_PER_TICK}
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
  queue?: { clearThrough(nowMs: number): Promise<void>; requeue(ids: string[], dueAtMs: number): Promise<void> };
}

export interface AwaySummary {
  rows: number;
  people: number;
  sent: number;
  delivered: number;
  present: number;
  noKey: number;
  notReady: number;
  held: number;
  failed: number;
  gated?: 'no_sender';
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
  const queue = deps.queue ?? defaultQueue;
  const summary: AwaySummary = { rows: 0, people: 0, sent: 0, delivered: 0, present: 0, noKey: 0, notReady: 0, held: 0, failed: 0 };

  const token = (deps.senderToken ?? personalSenderToken)();
  if (!token) {
    // Nothing can be sent, so do not touch the ledger; rows stay for the inbox.
    return { ...summary, gated: 'no_sender' };
  }

  const rows = ((await exec(pendingPersonRowsSql(now))).rows ?? []) as AwayRow[];
  summary.rows = rows.length;

  const groups = new Map<string, AwayRow[]>();
  for (const r of rows) {
    const k = `${r.ownerUserId}:${r.teamId}`;
    const g = groups.get(k);
    if (g) g.push(r); else groups.set(k, [r]);
  }
  summary.people = groups.size;

  // Clear everything due now first; anything below that must be looked at
  // again later is re-added after, with a future score.
  await queue.clearThrough(now.getTime());

  for (const group of groups.values()) {
    const { ownerUserId: userId, teamId } = group[0];
    try {
      // Coalesce: wait until the burst's first row is a window old, unless something is urgent.
      const oldest = Math.min(...group.map(r => new Date(r.createdAt).getTime()));
      const ready = group.some(r => r.urgency === 'urgent') || now.getTime() - oldest >= COALESCE_MS;
      if (!ready) { summary.notReady++; continue; }

      if ((await presence(userId)).state === 'present') { summary.present++; continue; }

      const userKey = await loadKey(userId, teamId);
      if (!userKey) { summary.noKey++; continue; }

      const counts = ((await exec(recentPushesSql(userId, now))).rows?.[0] ?? {}) as { sent?: number | string; urgent?: number | string };
      const sentLastHour = Number(counts.sent ?? 0);
      if (sentLastHour >= PUSHES_PER_HOUR) {
        summary.held++;
        if (await heldNoticeOnce(userId, now)) {
          await send({
            token, user: userKey, title: 'buildd',
            message: `${group.length} more ${group.length === 1 ? 'update is' : 'updates are'} held in buildd. You have had ${PUSHES_PER_HOUR} alerts this hour.`,
            priority: -1, url: `${appUrl}/app`, urlTitle: 'Open buildd',
          });
        }
        await queue.requeue(group.map(r => r.id), now.getTime() + HELD_RETRY_MS);
        continue;
      }

      const urgentAllowed = Number(counts.urgent ?? 0) < URGENT_PUSHES_PER_HOUR;
      const outcome = await send({ token, user: userKey, ...renderAwayMessage(group, { appUrl, urgentAllowed }) });
      if (outcome === 'rejected') {
        summary.failed++;
        await markKeyRejected(userId, teamId, 'Pushover rejected this key when sending an alert.');
        continue;
      }
      if (outcome === 'failed') {
        summary.failed++;
        await queue.requeue(group.map(r => r.id), now.getTime() + 5 * 60_000);
        continue;
      }
      summary.sent++;
      for (const r of group) {
        const res = await mark({ userId }, r.id, { route: 'pushover' }, { exec, now: () => now });
        if (res.marked) summary.delivered++;
      }
    } catch (err) {
      summary.failed++;
      console.error('[away-delivery] person failed:', err instanceof Error ? err.message : 'unknown');
    }
  }
  return summary;
}

const defaultQueue: NonNullable<AwayDeps['queue']> = {
  async clearThrough(nowMs) {
    const { clearDueThrough } = await import('./redis');
    await clearDueThrough(AWAY_QUEUE, nowMs);
  },
  async requeue(ids, dueAtMs) {
    const { markDue } = await import('./redis');
    await Promise.all(ids.map(id => markDue(AWAY_QUEUE, id, dueAtMs)));
  },
};

async function defaultHeldNoticeOnce(userId: string, now: Date): Promise<boolean> {
  const { setOnce } = await import('./redis');
  const hour = now.toISOString().slice(0, 13);
  // Without Redis this is false: the held notice is the extra, so it is the part that goes.
  return setOnce(`notify-away:held:${userId}:${hour}`, 3600);
}
