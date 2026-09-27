/**
 * Subscriptions and the delivery ledger (docs/design/subscriptions-and-notifications.md).
 *
 * This module owns the two tables. Nothing here sends anything: emitters call
 * `recordEvent`, which writes ledger rows; delivery (chat, Pushover, inbox)
 * reads them with `listUndelivered` and closes them with `markDelivered`.
 *
 * Public interface:
 *
 *   createSubscription(input)              -> Subscription | null   (null = owner can't see the subject)
 *   cancelSubscription(owner, id)          -> boolean
 *   listSubscriptions(owner)               -> Subscription[]        (live: not ended, not expired)
 *   recordEvent(event)                     -> { recorded, error? }  (never throws)
 *   listUndelivered(owner, { limit })      -> UndeliveredRow[]      (oldest first)
 *   markDelivered(owner, id, { route })    -> { marked, subscriptionEnded }
 *   listUnpostedForConversation(owner, conversationId)
 *                                          -> rows whose record is not yet in their origin conversation
 *
 * Event constructors (use these, never hand-build a dedupe key):
 *   taskCompletedEvent, taskFailedEvent, taskNeedsInputEvent, prMergedEvent, prCiFailedEvent
 *
 * Invariants:
 *   - Exactly-once per (subscription, event): the ledger is unique on
 *     (subscription_id, dedupe_key) and recordEvent is one INSERT ... SELECT ...
 *     ON CONFLICT DO NOTHING. Two emitters that see the same fact build the same
 *     key, so they write one row. No db.transaction (neon-http).
 *   - Scoping: a subscription matches only if its owner can see the subject's
 *     workspace *at event time* (same team; an account or agent task also
 *     needs an explicit link to a restricted workspace). A PR's repo identity
 *     is the github_repos FK only. Create applies the same rule.
 *   - One-shot: delivery claims the subscription first (ends it), then marks
 *     the row; sibling pending rows are coalesced. Exactly one delivery wins
 *     under concurrency. An ended subscription matches nothing and lists no
 *     undelivered rows.
 *   - Expiry: an expired subscription matches nothing. Rows recorded before
 *     expiry stay deliverable.
 */

import { createHash } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import { db } from '@buildd/core/db';

// ── Types ─────────────────────────────────────────────────────────────────────

export const TASK_EVENT_TYPES = ['task.completed', 'task.failed', 'task.needs_input'] as const;
export const PR_EVENT_TYPES = ['pr.merged', 'pr.ci_failed'] as const;
export type TaskEventType = typeof TASK_EVENT_TYPES[number];
export type PrEventType = typeof PR_EVENT_TYPES[number];
export type SubscriptionEventType = TaskEventType | PrEventType;
export type SubjectKind = 'task' | 'pr';

/** Exactly one owner. A person, a waiting worker's task, or an MCP session's account. */
export type SubscriptionOwner = { userId: string } | { taskId: string } | { accountId: string };

export type SubscriptionSubject =
  | { kind: 'task'; taskId: string }
  | { kind: 'pr'; workspaceId: string; repoFullName: string; prNumber: number };

export interface CreateSubscriptionInput {
  owner: SubscriptionOwner;
  subject: SubscriptionSubject;
  eventTypes: SubscriptionEventType[];
  lifetime?: 'one_shot' | 'standing';
  /** Defaults: one-shot 7 days, standing 30 days. Clamped to 90 days. */
  expiresAt?: Date;
  /** Origin conversation; must belong to the owner (person owners only). */
  conversationId?: string | null;
  createdVia: 'chat' | 'mcp' | 'worker' | 'settings';
}

export interface Subscription {
  id: string;
  teamId: string;
  workspaceId: string | null;
  ownerUserId: string | null;
  ownerTaskId: string | null;
  ownerAccountId: string | null;
  conversationId: string | null;
  subjectKind: SubjectKind;
  subjectKey: string;
  subjectRef: Record<string, unknown>;
  eventTypes: SubscriptionEventType[];
  lifetime: 'one_shot' | 'standing';
  createdVia: string;
  expiresAt: string;
  createdAt: string;
}

export interface NotifyEvent {
  type: SubscriptionEventType;
  subjectKind: SubjectKind;
  /** Task id, or `owner/repo#N` lowercased. */
  subjectKey: string;
  /** Computed from the fact itself, so two emitters of one fact agree. */
  dedupeKey: string;
  /** How the subject's workspace is found for the scoping check. */
  scope: { kind: 'task'; taskId: string } | { kind: 'repo'; repoFullName: string };
  /** Refs and short text only. Emitters omit prose for sensitive workspaces. */
  payload: Record<string, unknown>;
  urgency?: 'low' | 'normal' | 'urgent';
}

export interface UndeliveredRow {
  id: string;
  subscriptionId: string;
  eventType: SubscriptionEventType;
  dedupeKey: string;
  payload: Record<string, unknown>;
  urgency: 'low' | 'normal' | 'urgent';
  createdAt: string;
  conversationId: string | null;
  subjectKind: SubjectKind;
  subjectRef: Record<string, unknown>;
  lifetime: 'one_shot' | 'standing';
}

type Exec = (q: SQL) => Promise<{ rows?: unknown[] }>;
const dbExec: Exec = q => db.execute(q) as unknown as Promise<{ rows?: unknown[] }>;
export interface Deps { exec?: Exec; now?: () => Date }

// ── Event constructors ───────────────────────────────────────────────────────

export function prSubjectKey(repoFullName: string, prNumber: number): string {
  return `${repoFullName.toLowerCase()}#${prNumber}`;
}

type TaskPayload = { title?: string | null; workspaceId?: string | null };

/** A task completing is one fact, whichever row or path reports it. */
export function taskCompletedEvent(e: { taskId: string; workerId?: string | null } & TaskPayload): NotifyEvent {
  return taskEvent('task.completed', e.taskId, `task:${e.taskId}:completed`, e);
}

/** Keyed per attempt: a retry that fails again is a new failure. */
export function taskFailedEvent(e: { taskId: string; workerId?: string | null } & TaskPayload): NotifyEvent {
  return taskEvent('task.failed', e.taskId, `task:${e.taskId}:failed:${e.workerId ?? 'unknown'}`, e);
}

/** Keyed per attempt and question; the question text itself never enters the key. */
export function taskNeedsInputEvent(e: { taskId: string; workerId: string; prompt?: string | null } & TaskPayload): NotifyEvent {
  const q = createHash('sha256').update((e.prompt ?? '').trim()).digest('hex').slice(0, 16);
  return taskEvent('task.needs_input', e.taskId, `task:${e.taskId}:needs_input:${e.workerId}:${q}`, e);
}

function taskEvent(type: TaskEventType, taskId: string, dedupeKey: string, e: TaskPayload & { workerId?: string | null }): NotifyEvent {
  const payload: Record<string, unknown> = { taskId };
  if (e.workerId) payload.workerId = e.workerId;
  if (e.title) payload.title = e.title.slice(0, 200);
  if (e.workspaceId) payload.workspaceId = e.workspaceId;
  return { type, subjectKind: 'task', subjectKey: taskId, dedupeKey, scope: { kind: 'task', taskId }, payload };
}

type PrPayload = { title?: string | null; url?: string | null };

export function prMergedEvent(e: { repoFullName: string; prNumber: number } & PrPayload): NotifyEvent {
  const key = prSubjectKey(e.repoFullName, e.prNumber);
  return prEvent('pr.merged', e, `pr:${key}:merged`);
}

/** One "CI red" per head SHA, however many suites fail on it. */
export function prCiFailedEvent(e: { repoFullName: string; prNumber: number; headSha: string } & PrPayload): NotifyEvent {
  const key = prSubjectKey(e.repoFullName, e.prNumber);
  return prEvent('pr.ci_failed', { ...e }, `pr:${key}:ci_failed:${e.headSha}`, { headSha: e.headSha });
}

function prEvent(type: PrEventType, e: { repoFullName: string; prNumber: number } & PrPayload, dedupeKey: string, extra: Record<string, unknown> = {}): NotifyEvent {
  const payload: Record<string, unknown> = { repo: e.repoFullName, prNumber: e.prNumber, ...extra };
  if (e.title) payload.title = e.title.slice(0, 200);
  if (e.url) payload.url = e.url;
  return {
    type, subjectKind: 'pr', subjectKey: prSubjectKey(e.repoFullName, e.prNumber), dedupeKey,
    scope: { kind: 'repo', repoFullName: e.repoFullName }, payload,
  };
}

// ── Shared SQL fragments ─────────────────────────────────────────────────────

const uuidOrNull = (v: string | null | undefined): SQL => (v ? sql`${v}::uuid` : sql`null::uuid`);

function ownerColumns(owner: SubscriptionOwner): { userId: string | null; taskId: string | null; accountId: string | null } {
  return {
    userId: 'userId' in owner ? owner.userId : null,
    taskId: 'taskId' in owner ? owner.taskId : null,
    accountId: 'accountId' in owner ? owner.accountId : null,
  };
}

/** `s."owner_<kind>_id" = $id` for exactly the owner's column. */
function ownerMatch(owner: SubscriptionOwner, alias = 's'): SQL {
  const a = sql.raw(alias);
  if ('userId' in owner) return sql`${a}."owner_user_id" = ${owner.userId}::uuid`;
  if ('taskId' in owner) return sql`${a}."owner_task_id" = ${owner.taskId}::uuid`;
  return sql`${a}."owner_account_id" = ${owner.accountId}::uuid`;
}

/**
 * Can this owner see workspace `w`? The three owner refs are SQL (columns of a
 * subscription row, or bound parameters at create time).
 */
function ownerSeesWorkspace(o: { userId: SQL; taskId: SQL; accountId: SQL }): SQL {
  return sql`(
    (${o.userId} is not null and exists (select 1 from "team_members" tm where tm."team_id" = w."team_id" and tm."user_id" = ${o.userId}))
    or (${o.taskId} is not null and exists (select 1 from "tasks" ot join "workspaces" ow on ow."id" = ot."workspace_id" where ot."id" = ${o.taskId} and ow."team_id" = w."team_id"
      and (ow."id" = w."id" or w."access_mode" = 'open' or exists (select 1 from "account_workspaces" taw where taw."account_id" = ot."claimed_by" and taw."workspace_id" = w."id"))))
    or (${o.accountId} is not null and exists (select 1 from "accounts" oa where oa."id" = ${o.accountId} and oa."team_id" = w."team_id" and (w."access_mode" = 'open' or exists (select 1 from "account_workspaces" aw where aw."account_id" = oa."id" and aw."workspace_id" = w."id"))))
  )`;
}

const SUB_OWNER_COLS = {
  userId: sql`s."owner_user_id"`,
  taskId: sql`s."owner_task_id"`,
  accountId: sql`s."owner_account_id"`,
};

/**
 * Workspace `w` is linked to this repo through the github_repos FK. The
 * free-text `workspaces.repo` column is deliberately not consulted: it is not
 * an identity (often a URL, and it does not follow renames).
 */
function workspacePointsAtRepo(repoFullName: string): SQL {
  const repo = repoFullName.toLowerCase();
  return sql`exists (select 1 from "github_repos" gr where gr."id" = w."github_repo_id" and lower(gr."full_name") = ${repo})`;
}

// ── recordEvent ──────────────────────────────────────────────────────────────

export function recordEventSql(event: NotifyEvent, now: Date): SQL {
  const scope = event.scope.kind === 'task'
    ? sql`select 1 from "tasks" t join "workspaces" w on w."id" = t."workspace_id"
          where t."id" = ${event.scope.taskId}::uuid
            and w."team_id" = s."team_id"
            and (s."workspace_id" is null or s."workspace_id" = w."id")
            and ${ownerSeesWorkspace(SUB_OWNER_COLS)}`
    : sql`select 1 from "workspaces" w
          where w."id" = s."workspace_id"
            and w."team_id" = s."team_id"
            and ${workspacePointsAtRepo(event.scope.repoFullName)}
            and ${ownerSeesWorkspace(SUB_OWNER_COLS)}`;

  return sql`
    insert into "notification_deliveries" ("subscription_id", "dedupe_key", "event_type", "payload", "urgency")
    select s."id", ${event.dedupeKey}, ${event.type}, ${JSON.stringify(event.payload)}::jsonb, ${event.urgency ?? 'normal'}
    from "subscriptions" s
    where s."subject_kind" = ${event.subjectKind}
      and s."subject_key" = ${event.subjectKey}
      and ${event.type} = any(s."event_types")
      and s."ended_at" is null
      and s."expires_at" > ${now.toISOString()}::timestamptz
      and exists (${scope})
    on conflict ("subscription_id", "dedupe_key") do nothing
    returning "id", "subscription_id"
  `;
}

/**
 * Match live subscriptions for this event and write one ledger row each.
 * Idempotent; safe to call from every path that learns the fact. Never throws,
 * so it can sit on any request path: an error is logged and reads as zero rows.
 */
export async function recordEvent(event: NotifyEvent, deps: Deps = {}): Promise<{ recorded: number; error?: true }> {
  const exec = deps.exec ?? dbExec;
  const now = (deps.now ?? (() => new Date()))();
  try {
    const r = await exec(recordEventSql(event, now));
    const rows = (r.rows ?? []) as Array<{ id: string }>;
    // Wake the away-delivery cron for these rows (Redis only; never throws).
    // Imported lazily so emit sites do not load it, and a test that stubs
    // './redis' partially cannot break this module's import.
    if (rows.length > 0) {
      try {
        const { markAwayDue } = await import('./notify-away-queue');
        await markAwayDue(rows, event.urgency ?? 'normal', now);
      } catch { /* best effort */ }
      // Tell the owners' open conversations there is something to pull, so
      // their poll only reaches Postgres when it has to (lib/watch-pending.ts).
      try {
        const { flagWatchOwners } = await import('./watch-pending');
        await flagWatchOwners(rows as Array<{ id: string; subscription_id?: string }>, exec);
      } catch { /* best effort */ }
    }
    return { recorded: rows.length };
  } catch (err) {
    console.error(`[subscriptions] recordEvent ${event.type} failed:`, err);
    return { recorded: 0, error: true };
  }
}

// ── Subscriptions CRUD ───────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
export const ONE_SHOT_DEFAULT_TTL_MS = 7 * DAY_MS;
export const STANDING_DEFAULT_TTL_MS = 30 * DAY_MS;
export const MAX_TTL_MS = 90 * DAY_MS;

export function resolveExpiresAt(input: { lifetime?: 'one_shot' | 'standing'; expiresAt?: Date }, now: Date): Date {
  const max = now.getTime() + MAX_TTL_MS;
  if (input.expiresAt) {
    const t = input.expiresAt.getTime();
    if (!Number.isFinite(t) || t <= now.getTime()) throw new Error('expiresAt must be in the future');
    return new Date(Math.min(t, max));
  }
  return new Date(now.getTime() + (input.lifetime === 'standing' ? STANDING_DEFAULT_TTL_MS : ONE_SHOT_DEFAULT_TTL_MS));
}

function subjectFields(subject: SubscriptionSubject): { key: string; ref: Record<string, unknown>; allowed: readonly string[] } {
  if (subject.kind === 'task') {
    return { key: subject.taskId, ref: { type: 'task', id: subject.taskId }, allowed: TASK_EVENT_TYPES };
  }
  return {
    key: prSubjectKey(subject.repoFullName, subject.prNumber),
    ref: { type: 'pr', workspaceId: subject.workspaceId, repo: subject.repoFullName, number: subject.prNumber },
    allowed: PR_EVENT_TYPES,
  };
}

export function createSubscriptionSql(input: CreateSubscriptionInput, now: Date): SQL {
  const { key, ref } = subjectFields(input.subject);
  const o = ownerColumns(input.owner);
  const owner = { userId: uuidOrNull(o.userId), taskId: uuidOrNull(o.taskId), accountId: uuidOrNull(o.accountId) };
  const lifetime = input.lifetime ?? 'one_shot';
  const expiresAt = resolveExpiresAt({ lifetime, expiresAt: input.expiresAt }, now);
  const types = sql`array[${sql.join(input.eventTypes.map(t => sql`${t}`), sql`, `)}]::text[]`;
  const conv = input.conversationId ?? null;

  const from = input.subject.kind === 'task'
    ? sql`from "tasks" t join "workspaces" w on w."id" = t."workspace_id" where t."id" = ${input.subject.taskId}::uuid`
    : sql`from "workspaces" w where w."id" = ${input.subject.workspaceId}::uuid and ${workspacePointsAtRepo(input.subject.repoFullName)}`;

  return sql`
    insert into "subscriptions" (
      "team_id", "workspace_id", "owner_user_id", "owner_task_id", "owner_account_id", "conversation_id",
      "subject_kind", "subject_key", "subject_ref", "event_types", "lifetime", "created_via", "expires_at"
    )
    select w."team_id", w."id", ${owner.userId}, ${owner.taskId}, ${owner.accountId}, ${uuidOrNull(conv)},
      ${input.subject.kind}, ${key}, ${JSON.stringify(ref)}::jsonb, ${types}, ${lifetime}, ${input.createdVia},
      ${expiresAt.toISOString()}::timestamptz
    ${from}
      and ${ownerSeesWorkspace(owner)}
      and (${uuidOrNull(conv)} is null or exists (select 1 from "conversations" c where c."id" = ${uuidOrNull(conv)} and c."created_by_user_id" = ${owner.userId} and c."team_id" = w."team_id"))
    returning ${SUBSCRIPTION_COLUMNS}
  `;
}

const SUBSCRIPTION_COLUMNS = sql.raw(`
  "id", "team_id" as "teamId", "workspace_id" as "workspaceId",
  "owner_user_id" as "ownerUserId", "owner_task_id" as "ownerTaskId", "owner_account_id" as "ownerAccountId",
  "conversation_id" as "conversationId", "subject_kind" as "subjectKind", "subject_key" as "subjectKey",
  "subject_ref" as "subjectRef", "event_types" as "eventTypes", "lifetime", "created_via" as "createdVia",
  "expires_at" as "expiresAt", "created_at" as "createdAt"`);

/**
 * Create a watch. Returns null when the owner cannot see the subject (or the
 * conversation is not theirs): nothing is inserted, and the caller should
 * answer "not found", not "forbidden".
 */
export async function createSubscription(input: CreateSubscriptionInput, deps: Deps = {}): Promise<Subscription | null> {
  const { allowed } = subjectFields(input.subject);
  if (input.eventTypes.length === 0) throw new Error('eventTypes must not be empty');
  const bad = input.eventTypes.filter(t => !allowed.includes(t));
  if (bad.length) throw new Error(`event types not valid for a ${input.subject.kind} subject: ${bad.join(', ')}`);
  const exec = deps.exec ?? dbExec;
  const now = (deps.now ?? (() => new Date()))();
  const r = await exec(createSubscriptionSql(input, now));
  return (r.rows?.[0] as Subscription | undefined) ?? null;
}

/** End the owner's own watch. False when it is not theirs or already ended. */
export async function cancelSubscription(owner: SubscriptionOwner, subscriptionId: string, deps: Deps = {}): Promise<boolean> {
  const exec = deps.exec ?? dbExec;
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const r = await exec(sql`
    update "subscriptions" s set "ended_at" = ${now}::timestamptz, "end_reason" = 'cancelled', "updated_at" = ${now}::timestamptz
    where s."id" = ${subscriptionId}::uuid and ${ownerMatch(owner)} and s."ended_at" is null
    returning s."id"
  `);
  return (r.rows ?? []).length > 0;
}

/** The owner's live watches: not ended, not expired. Newest first. */
export async function listSubscriptions(owner: SubscriptionOwner, deps: Deps = {}): Promise<Subscription[]> {
  const exec = deps.exec ?? dbExec;
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const r = await exec(sql`
    select ${SUBSCRIPTION_COLUMNS} from "subscriptions" s
    where ${ownerMatch(owner)} and s."ended_at" is null and s."expires_at" > ${now}::timestamptz
    order by s."created_at" desc
    limit 100
  `);
  return (r.rows ?? []) as Subscription[];
}

// ── Delivery side ────────────────────────────────────────────────────────────

/** Pending ledger rows for this owner, oldest first. Rows of an ended watch (delivered one-shot, cancelled) are excluded. */
export async function listUndelivered(owner: SubscriptionOwner, opts: { limit?: number } & Deps = {}): Promise<UndeliveredRow[]> {
  const exec = opts.exec ?? dbExec;
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
  const r = await exec(sql`
    select d."id", d."subscription_id" as "subscriptionId", d."event_type" as "eventType", d."dedupe_key" as "dedupeKey",
      d."payload", d."urgency", d."created_at" as "createdAt",
      s."conversation_id" as "conversationId", s."subject_kind" as "subjectKind", s."subject_ref" as "subjectRef", s."lifetime"
    from "notification_deliveries" d
    join "subscriptions" s on s."id" = d."subscription_id"
    where ${ownerMatch(owner)}
      and d."status" = 'pending'
      and s."ended_at" is null
    order by d."created_at" asc
    limit ${limit}
  `);
  return (r.rows ?? []) as UndeliveredRow[];
}

export function markDeliveredSql(owner: SubscriptionOwner, deliveryId: string, opts: { route: string }, now: Date): SQL {
  const at = now.toISOString();
  // One statement, ordered by data dependency:
  //   target   the pending row, if it is this owner's and its watch is live
  //   claimed  a one-shot watch is taken FIRST (ended_at IS NULL -> now). Of two
  //            concurrent calls, the second waits on the row lock, re-checks
  //            ended_at, and claims nothing
  //   marked   the row is delivered only for a standing watch or a won claim
  //   siblings the winner folds the watch's other pending rows into coalesced
  return sql`
    with target as (
      select d."id", d."subscription_id", s."lifetime"
      from "notification_deliveries" d
      join "subscriptions" s on s."id" = d."subscription_id"
      where d."id" = ${deliveryId}::uuid and d."status" = 'pending' and s."ended_at" is null and ${ownerMatch(owner)}
    ), claimed as (
      update "subscriptions" s set "ended_at" = ${at}::timestamptz, "end_reason" = 'delivered', "updated_at" = ${at}::timestamptz
      from target
      where s."id" = target."subscription_id" and s."lifetime" = 'one_shot' and s."ended_at" is null
      returning s."id"
    ), marked as (
      update "notification_deliveries" d set "status" = 'delivered', "delivered_at" = ${at}::timestamptz,
        "route" = ${opts.route}, "attempts" = d."attempts" + 1
      from target
      where d."id" = target."id" and d."status" = 'pending'
        and (target."lifetime" = 'standing' or exists (select 1 from claimed))
      returning d."id"
    ), siblings as (
      update "notification_deliveries" d set "status" = 'coalesced'
      from claimed where d."subscription_id" = claimed."id" and d."status" = 'pending' and d."id" <> ${deliveryId}::uuid
      returning d."id"
    )
    select (select count(*) from marked)::int as "marked", (select count(*) from claimed)::int as "ended"
  `;
}

/**
 * Close one pending row as delivered via `route` ('conversation', 'pushover', ...).
 * For a one-shot watch the watch is claimed first, atomically, so exactly one
 * caller wins; its other pending rows become `coalesced`. `marked: false`
 * means someone else already delivered it (or it is not this owner's, or the
 * watch has ended): do not send.
 */
export async function markDelivered(
  owner: SubscriptionOwner, deliveryId: string, opts: { route: string }, deps: Deps = {},
): Promise<{ marked: boolean; subscriptionEnded: boolean }> {
  const exec = deps.exec ?? dbExec;
  const now = (deps.now ?? (() => new Date()))();
  const r = await exec(markDeliveredSql(owner, deliveryId, opts, now));
  const row = (r.rows?.[0] ?? {}) as { marked?: number | string; ended?: number | string };
  return { marked: Number(row.marked ?? 0) > 0, subscriptionEnded: Number(row.ended ?? 0) > 0 };
}

// ── The origin conversation's record ────────────────────────────────────────

export interface ConversationRecordRow extends UndeliveredRow {
  status: 'pending' | 'delivered';
}

export function listUnpostedForConversationSql(owner: { userId: string }, conversationId: string, limit: number): SQL {
  // The record every chat watch leaves in its origin conversation, whichever
  // route delivered it (docs/design/subscriptions-and-notifications.md, Delivery
  // routing step 3). A row qualifies while it has no event message there yet
  // (lib/chat/watch-delivery.ts posts it with the row id as the message id):
  //   - pending, or already delivered by another route (Pushover while away);
  //     coalesced / dropped rows never;
  //   - a one-shot watch's record is its first row only: the delivered one, or
  //     the oldest still pending. A later sibling is what the claim coalesces;
  //   - a cancelled watch posts nothing more. A one-shot that ended by being
  //     delivered still posts its record.
  return sql`
    select d."id", d."subscription_id" as "subscriptionId", d."event_type" as "eventType", d."dedupe_key" as "dedupeKey",
      d."payload", d."urgency", d."created_at" as "createdAt", d."status",
      s."conversation_id" as "conversationId", s."subject_kind" as "subjectKind", s."subject_ref" as "subjectRef", s."lifetime"
    from "notification_deliveries" d
    join "subscriptions" s on s."id" = d."subscription_id"
    where s."owner_user_id" = ${owner.userId}::uuid
      and s."conversation_id" = ${conversationId}::uuid
      and d."status" in ('pending', 'delivered')
      and (s."ended_at" is null or s."end_reason" = 'delivered')
      and (s."lifetime" = 'standing' or d."id" = (
        select d2."id" from "notification_deliveries" d2
        where d2."subscription_id" = s."id" and d2."status" in ('pending', 'delivered')
        order by (d2."status" = 'delivered') desc, d2."created_at" asc, d2."id" asc
        limit 1))
      and not exists (select 1 from "conversation_messages" m where m."id" = d."id")
    order by d."created_at" asc
    limit ${limit}
  `;
}

/** Rows whose record is not yet posted in their origin conversation, oldest first (see the SQL). */
export async function listUnpostedForConversation(
  owner: { userId: string }, conversationId: string, opts: { limit?: number } & Deps = {},
): Promise<ConversationRecordRow[]> {
  const exec = opts.exec ?? dbExec;
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
  const r = await exec(listUnpostedForConversationSql(owner, conversationId, limit));
  return (r.rows ?? []) as ConversationRecordRow[];
}

/** The person owners of these subscriptions whose watches post into a conversation. */
export function conversationOwnersSql(subscriptionIds: readonly string[]): SQL {
  return sql`
    select distinct s."owner_user_id" as "userId" from "subscriptions" s
    where s."id" in (${sql.join(subscriptionIds.map(id => sql`${id}::uuid`), sql`, `)})
      and s."owner_user_id" is not null and s."conversation_id" is not null
  `;
}
