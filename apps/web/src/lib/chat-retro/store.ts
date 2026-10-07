/**
 * Chat retro DB access. Every read and write is scoped to one team; the WHERE
 * builders are exported so tests can render them (PgDialect) and see the scope.
 */
import { db } from '@buildd/core/db';
import {
  chatRetros, conversationApprovals, conversationMessages, conversations,
  tasks, teamMembers, teams, userFeedback, users, workspaces,
} from '@buildd/core/db/schema';
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, notInArray, sql, type SQL } from 'drizzle-orm';
import { TERMINAL_TASK_STATUSES, isTerminalTaskStatus } from '@buildd/shared';
import type { LessonRow } from './lesson';
import { assertContentFree } from './lesson';
import type { Cluster, PriorFiling } from './proposals';
import { HIGH_CONFIDENCE_EVIDENCE, PROPOSAL_MAX_REFS, PROPOSAL_WINDOW_DAYS } from './proposals';
import { FIRST_OCCURRENCE_KINDS } from './visible-answer';
import type { RetroMessage, RetroWindowInput } from './skeleton';
import { RETRO_IDLE_MIN, RETRO_MAX_WINDOW_MESSAGES } from './skeleton';
import type { ChatRetroSettings } from './settings';
import { CHAT_RETRO_DOGFOOD, effectiveChatRetroSettings, readChatRetroSettings } from './settings';
import { isUuid } from '@/lib/uuid';
import { wakeTask } from '@/lib/dispatch-authority';

/** Lessons are kept this long, then pruned by the same cron. */
export const RETRO_RETENTION_DAYS = 90;
/** A conversation quiet for longer than this is not picked up for a first window. */
export const RETRO_LOOKBACK_DAYS = 7;
/** `tasks.context.origin` of a filed proposal. */
export const PROPOSAL_ORIGIN = 'chat-retro';

const DAY_MS = 24 * 60 * 60 * 1000;
// A proposal task in any terminal state is closed: a new filing starts fresh.
const CLOSED = [...TERMINAL_TASK_STATUSES];

export const utcDayStart = (now: Date): Date => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

// ── WHERE builders (rendered in tests) ────────────────────────────────────────

/** The team has an owner who turned on account dogfood (./settings.ts). */
export function dogfoodOwnerExists(): SQL {
  return sql`exists (select 1 from ${teamMembers} inner join ${users} on ${users.id} = ${teamMembers.userId} where ${teamMembers.teamId} = ${teams.id} and ${teamMembers.role} = 'owner' and ${users.chatRetroDogfoodAt} is not null)`;
}

/**
 * Teams that opted in to lessons, or whose owner keeps retros on by account
 * dogfood. Default (NULL / no key / false, no dogfood owner) is excluded.
 */
export function optedInTeamsWhere(): SQL {
  return sql`((${teams.chatRetro} ->> 'lessons') = 'true' or ${dogfoodOwnerExists()})`;
}

/** Teams with a dogfood owner whose stored settings are not already both on. */
export function dogfoodUnsyncedWhere(userId?: string): SQL {
  return and(
    dogfoodOwnerExists(),
    sql`not (coalesce(${teams.chatRetro} ->> 'lessons', '') = 'true' and coalesce(${teams.chatRetro} ->> 'proposals', '') = 'true')`,
    userId
      ? sql`${teams.id} in (select ${teamMembers.teamId} from ${teamMembers} where ${teamMembers.userId} = ${userId} and ${teamMembers.role} = 'owner')`
      : undefined,
  )!;
}

export function teamLessonsWhere(teamId: string): SQL {
  return eq(chatRetros.teamId, teamId);
}

/** This team's conversations that went quiet at least RETRO_IDLE_MIN ago and have messages past their watermark. */
export function pendingConversationsWhere(teamId: string, now: Date): SQL {
  const idleBefore = new Date(now.getTime() - RETRO_IDLE_MIN * 60_000);
  const lookback = new Date(now.getTime() - RETRO_LOOKBACK_DAYS * DAY_MS);
  return and(
    eq(conversations.teamId, teamId),
    lte(conversations.lastMessageAt, idleBefore),
    gt(conversations.lastMessageAt, lookback),
    sql`${conversations.lastMessageAt} > coalesce((select max(${chatRetros.toMessageAt}) from ${chatRetros} where ${chatRetros.conversationId} = ${conversations.id} and ${chatRetros.teamId} = ${teamId}), '-infinity'::timestamptz)`,
  )!;
}

/**
 * This team's lessons in the clustering window that carry a signature. Only
 * a judged lesson, or a visible-answer finding code made without the model
 * (./lesson.ts withVisibleAnswer), ever carries one.
 */
export function clusterWhere(teamId: string, now: Date): SQL {
  return and(
    eq(chatRetros.teamId, teamId),
    isNotNull(chatRetros.signature),
    gte(chatRetros.createdAt, new Date(now.getTime() - PROPOSAL_WINDOW_DAYS * DAY_MS)),
  )!;
}

/** Proposal tasks filed today in this team's workspaces. */
export function filedTodayWhere(teamId: string, now: Date): SQL {
  return and(
    sql`${tasks.context} ->> 'origin' = ${PROPOSAL_ORIGIN}`,
    gte(tasks.createdAt, utcDayStart(now)),
    sql`${tasks.workspaceId} in (select ${workspaces.id} from ${workspaces} where ${workspaces.teamId} = ${teamId})`,
  )!;
}

export function priorFilingWhere(workspaceId: string, signature: string): SQL {
  return and(
    eq(tasks.workspaceId, workspaceId),
    sql`${tasks.context} ->> 'origin' = ${PROPOSAL_ORIGIN}`,
    sql`${tasks.context} ->> 'frictionSignature' = ${signature}`,
  )!;
}

/** A lesson whose evidence has a no_output or render_gap entry code is sure of. */
export function highConfidenceEvidence(): SQL {
  const kinds = sql.join(FIRST_OCCURRENCE_KINDS.map(k => sql`${k}`), sql`, `);
  return sql`exists (select 1 from jsonb_array_elements(${chatRetros.evidence}) e where e->>'kind' in (${kinds}) and (e->>'conf')::real >= ${HIGH_CONFIDENCE_EVIDENCE})`;
}
// ── Reads ─────────────────────────────────────────────────────────────────────

/**
 * Teams that run buildd's dogfood policy: a high-confidence visible-answer
 * failure files on first occurrence (./proposals.ts filesOnFirstOccurrence).
 * Comma-separated team ids in CHAT_RETRO_DOGFOOD_TEAM_IDS; unset = none, so
 * every other opted-in team keeps the recurrence rules.
 */
export function dogfoodTeamIds(env: Record<string, string | undefined> = process.env): Set<string> {
  return new Set((env.CHAT_RETRO_DOGFOOD_TEAM_IDS ?? '').split(',').map(s => s.trim()).filter(Boolean));
}

export async function listOptedInTeams(): Promise<Array<{ teamId: string; settings: ChatRetroSettings; dogfood: boolean }>> {
  const rows = await db
    .select({ id: teams.id, chatRetro: teams.chatRetro, dogfoodOwner: sql<boolean>`${dogfoodOwnerExists()}` })
    .from(teams)
    .where(optedInTeamsWhere());
  const dogfood = dogfoodTeamIds();
  return rows.map(r => ({
    teamId: r.id,
    settings: effectiveChatRetroSettings(readChatRetroSettings(r.chatRetro), r.dogfoodOwner === true),
    dogfood: dogfood.has(r.id) || r.dogfoodOwner === true,
  }));
}

/** The team's effective settings, and whether an owner's account dogfood is what holds them on. */
export async function readTeamRetroState(teamId: string): Promise<{ settings: ChatRetroSettings; dogfood: boolean }> {
  const [row] = await db
    .select({ chatRetro: teams.chatRetro, dogfoodOwner: sql<boolean>`${dogfoodOwnerExists()}` })
    .from(teams)
    .where(eq(teams.id, teamId));
  const dogfood = row?.dogfoodOwner === true;
  return { settings: effectiveChatRetroSettings(readChatRetroSettings(row?.chatRetro), dogfood), dogfood };
}

/** Effective settings: what the pass and the turn signal act on. */
export async function readTeamSettings(teamId: string): Promise<ChatRetroSettings> {
  return (await readTeamRetroState(teamId)).settings;
}

export async function hasAccountDogfood(userId: string): Promise<boolean> {
  const [row] = await db.select({ at: users.chatRetroDogfoodAt }).from(users).where(eq(users.id, userId));
  return !!row?.at;
}

export interface PendingConversation { id: string; workspaceId: string | null; dataClass: string | null }

export async function listPendingConversations(teamId: string, now: Date, limit: number): Promise<PendingConversation[]> {
  const rows = await db
    .select({ id: conversations.id, workspaceId: conversations.workspaceId, dataClass: workspaces.dataClass })
    .from(conversations)
    .leftJoin(workspaces, eq(workspaces.id, conversations.workspaceId))
    .where(pendingConversationsWhere(teamId, now))
    .orderBy(desc(conversations.lastMessageAt))
    .limit(limit);
  return rows.map(r => ({ id: r.id, workspaceId: r.workspaceId, dataClass: (r.dataClass as string | null) ?? null }));
}

/** The next window of one conversation: messages after its watermark, oldest first. */
export async function loadWindow(teamId: string, conversationId: string): Promise<RetroWindowInput> {
  const [mark] = await db
    .select({ at: sql<Date | null>`max(${chatRetros.toMessageAt})` })
    .from(chatRetros)
    .where(and(eq(chatRetros.teamId, teamId), eq(chatRetros.conversationId, conversationId)));
  const after = mark?.at ? new Date(mark.at) : null;
  const rows = await db
    .select({
      id: conversationMessages.id, role: conversationMessages.role, parts: conversationMessages.parts,
      tier: conversationMessages.tier, usage: conversationMessages.usage, createdAt: conversationMessages.createdAt,
    })
    .from(conversationMessages)
    .where(and(eq(conversationMessages.conversationId, conversationId), after ? gt(conversationMessages.createdAt, after) : undefined))
    .orderBy(asc(conversationMessages.createdAt))
    .limit(RETRO_MAX_WINDOW_MESSAGES);
  const messages = rows as unknown as RetroMessage[];
  const ids = messages.map(m => m.id);
  const [downs, denied] = ids.length === 0 ? [[], []] : await Promise.all([
    db.select({ entityId: userFeedback.entityId, reason: userFeedback.reason }).from(userFeedback).where(and(
      eq(userFeedback.teamId, teamId),
      eq(userFeedback.entityType, 'conversation_message'),
      eq(userFeedback.signal, 'down'),
      inArray(userFeedback.entityId, ids),
    )),
    db.select({ messageId: conversationApprovals.messageId }).from(conversationApprovals).where(and(
      eq(conversationApprovals.conversationId, conversationId),
      eq(conversationApprovals.status, 'denied'),
      inArray(conversationApprovals.messageId, ids),
    )),
  ]);
  return {
    messages,
    thumbsDown: new Map(downs.map(d => [d.entityId, d.reason ?? null])),
    deniedApprovalMessageIds: new Set(denied.map(d => d.messageId)),
  };
}

export async function judgedToday(teamId: string, now: Date): Promise<number> {
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(chatRetros)
    .where(and(teamLessonsWhere(teamId), eq(chatRetros.status, 'judged'), gte(chatRetros.createdAt, utcDayStart(now))));
  return Number(r?.n ?? 0);
}

export async function loadClusters(teamId: string, now: Date): Promise<Cluster[]> {
  const rows = await db
    .select({
      signature: chatRetros.signature,
      primaryCause: sql<string>`min(${chatRetros.primaryCause})`,
      fixClass: sql<string>`min(${chatRetros.fixClass})`,
      toolName: sql<string | null>`min(${chatRetros.toolName})`,
      sessions: sql<number>`count(*)::int`,
      days: sql<number>`count(distinct date_trunc('day', ${chatRetros.createdAt}))::int`,
      wastedTokens: sql<number>`coalesce(sum(${chatRetros.wastedTokens}), 0)::int`,
      satisfiedYes: sql<number>`count(*) filter (where ${chatRetros.satisfied} = 'yes')::int`,
      satisfiedPartly: sql<number>`count(*) filter (where ${chatRetros.satisfied} = 'partly')::int`,
      satisfiedNo: sql<number>`count(*) filter (where ${chatRetros.satisfied} = 'no')::int`,
      highConfidence: sql<number>`count(*) filter (where ${highConfidenceEvidence()})::int`,
      workspaceId: sql<string | null>`mode() within group (order by ${chatRetros.workspaceId})`,
      lessonIds: sql<string[]>`(array_agg(${chatRetros.id} order by ${chatRetros.createdAt} desc))[1:${sql.raw(String(PROPOSAL_MAX_REFS))}]`,
      conversationIds: sql<string[]>`(array_agg(distinct ${chatRetros.conversationId}))[1:${sql.raw(String(PROPOSAL_MAX_REFS))}]`,
    })
    .from(chatRetros)
    .where(clusterWhere(teamId, now))
    .groupBy(chatRetros.signature);
  return rows.filter(r => r.signature) as unknown as Cluster[];
}

export async function proposalsFiledToday(teamId: string, now: Date): Promise<number> {
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(tasks).where(filedTodayWhere(teamId, now));
  return Number(r?.n ?? 0);
}

export async function priorFiling(workspaceId: string, signature: string): Promise<PriorFiling | null> {
  const row = await db.query.tasks.findFirst({
    where: priorFilingWhere(workspaceId, signature),
    orderBy: [desc(tasks.createdAt)],
    columns: { id: true, status: true, context: true },
  });
  if (!row) return null;
  const sessions = Number((row.context as Record<string, unknown> | null)?.chatRetroSessions ?? 0);
  return { taskId: row.id, open: !isTerminalTaskStatus(row.status), sessions: Number.isFinite(sessions) ? sessions : 0 };
}

/** The newest lessons for a team, for its admins. Labels and counts only. */
export async function listRecentLessons(teamId: string, limit = 20) {
  return db
    .select({
      id: chatRetros.id, conversationId: chatRetros.conversationId, status: chatRetros.status,
      skipReason: chatRetros.skipReason, userTurns: chatRetros.userTurns, turns: chatRetros.turns,
      inputTokens: chatRetros.inputTokens, outputTokens: chatRetros.outputTokens,
      intent: chatRetros.intent, satisfied: chatRetros.satisfied,
      wastedTurns: chatRetros.wastedTurns, wastedTokens: chatRetros.wastedTokens,
      primaryCause: chatRetros.primaryCause, fixClass: chatRetros.fixClass,
      toolName: chatRetros.toolName, signature: chatRetros.signature, createdAt: chatRetros.createdAt,
    })
    .from(chatRetros)
    .where(teamLessonsWhere(teamId))
    .orderBy(desc(chatRetros.createdAt))
    .limit(limit);
}

// ── Writes ────────────────────────────────────────────────────────────────────

export async function insertLessons(rows: LessonRow[]): Promise<void> {
  if (rows.length === 0) return;
  for (const r of rows) assertContentFree(r);
  await db.insert(chatRetros).values(rows);
}

/** Delete-on-disable: every lesson this team has. */
export async function deleteTeamLessons(teamId: string): Promise<number> {
  const deleted = await db.delete(chatRetros).where(teamLessonsWhere(teamId)).returning({ id: chatRetros.id });
  return deleted.length;
}

export async function writeTeamSettings(teamId: string, next: ChatRetroSettings): Promise<void> {
  await db.update(teams)
    .set({ chatRetro: next.lessons ? next : null, updatedAt: new Date() })
    .where(eq(teams.id, teamId));
}

/**
 * Store lessons + proposals on every team with a dogfood owner (only `userId`'s
 * owned teams when given). The effective policy already reads them as on; this
 * keeps the stored value honest if the owner later leaves. Returns team ids.
 */
async function syncDogfoodTeams(userId?: string): Promise<string[]> {
  const rows = await db.update(teams)
    .set({ chatRetro: { ...CHAT_RETRO_DOGFOOD }, updatedAt: new Date() })
    .where(dogfoodUnsyncedWhere(userId))
    .returning({ id: teams.id });
  return rows.map(r => r.id);
}

/**
 * Turn on account dogfood for one person, and backfill every team they own.
 * Idempotent: the first activation time is kept.
 */
export async function activateAccountDogfood(userId: string, now = new Date()): Promise<{ syncedTeamIds: string[] }> {
  await db.update(users)
    .set({ chatRetroDogfoodAt: now })
    .where(and(eq(users.id, userId), isNull(users.chatRetroDogfoodAt)));
  return { syncedTeamIds: await syncDogfoodTeams(userId) };
}

/** Owners of the configured dogfood teams who have not got account dogfood yet. */
export function dogfoodTeamOwnersWhere(teamIds: string[]): SQL {
  return and(
    isNull(users.chatRetroDogfoodAt),
    sql`${users.id} in (select ${teamMembers.userId} from ${teamMembers} where ${inArray(teamMembers.teamId, teamIds)} and ${teamMembers.role} = 'owner')`,
  )!;
}

/**
 * Server-side reconciliation, once per daily pass: the owners of the teams in
 * CHAT_RETRO_DOGFOOD_TEAM_IDS get account dogfood, then every team with a
 * dogfood owner (including teams created since) gets its stored settings synced.
 */
export async function reconcileAccountDogfood(env: Record<string, string | undefined> = process.env): Promise<{ activatedUsers: number; syncedTeams: number }> {
  const teamIds = [...dogfoodTeamIds(env)].filter(isUuid);
  const activated = teamIds.length === 0 ? [] : await db.update(users)
    .set({ chatRetroDogfoodAt: new Date() })
    .where(dogfoodTeamOwnersWhere(teamIds))
    .returning({ id: users.id });
  const synced = await syncDogfoodTeams();
  return { activatedUsers: activated.length, syncedTeams: synced.length };
}

/**
 * A team just created by `userId`: store their account dogfood on it, if they
 * have it. Not needed for the policy (a new team reads as on through its owner
 * at once, and the daily pass syncs the stored value); for a caller that wants
 * the stored value right away. Core routes must not import this module
 * (scripts/module-boundaries.test.ts), so team creation does not call it.
 */
export async function inheritAccountDogfood(teamId: string, userId: string): Promise<boolean> {
  if (!(await hasAccountDogfood(userId))) return false;
  await writeTeamSettings(teamId, { ...CHAT_RETRO_DOGFOOD });
  return true;
}

export async function pruneExpiredLessons(now: Date): Promise<number> {
  const deleted = await db.delete(chatRetros)
    .where(lt(chatRetros.createdAt, new Date(now.getTime() - RETRO_RETENTION_DAYS * DAY_MS)))
    .returning({ id: chatRetros.id });
  return deleted.length;
}

export async function insertProposalTask(args: { cluster: Cluster; title: string; description: string }): Promise<string | null> {
  const { cluster } = args;
  if (!cluster.workspaceId) return null;
  const [row] = await db.insert(tasks).values({
    workspaceId: cluster.workspaceId,
    title: args.title.slice(0, 200),
    description: args.description,
    priority: 1,
    status: 'pending',
    mode: 'execution',
    taskClass: 'work',
    // System-filed, like the other generated reports (health-watcher, ci-retry).
    creationSource: 'webhook',
    category: 'research',
    kind: 'analysis',
    outputRequirement: 'none',
    context: {
      origin: PROPOSAL_ORIGIN,
      frictionSignature: cluster.signature,
      chatRetroSessions: cluster.sessions,
      chatRetroLessonIds: cluster.lessonIds.slice(0, PROPOSAL_MAX_REFS),
    },
  }).returning({ id: tasks.id });
  // Written for a worker to pick up, so it gets the same wake as any new task.
  if (row?.id) await wakeTask(row.id, 'task.created');
  return row?.id ?? null;
}

export async function appendToProposal(taskId: string, text: string, sessions: number): Promise<void> {
  await db.update(tasks)
    .set({
      description: sql`coalesce(${tasks.description}, '') || ${text}`,
      context: sql`coalesce(${tasks.context}, '{}'::jsonb) || jsonb_build_object('chatRetroSessions', ${sessions}::int)`,
      updatedAt: new Date(),
    })
    .where(and(eq(tasks.id, taskId), notInArray(tasks.status, CLOSED)));
}
