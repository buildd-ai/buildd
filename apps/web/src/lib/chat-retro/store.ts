/**
 * Chat retro DB access. Every read and write is scoped to one team; the WHERE
 * builders are exported so tests can render them (PgDialect) and see the scope.
 */
import { db } from '@buildd/core/db';
import {
  chatRetros, conversationApprovals, conversationMessages, conversations,
  tasks, teams, userFeedback, workspaces,
} from '@buildd/core/db/schema';
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, lt, lte, notInArray, sql, type SQL } from 'drizzle-orm';
import { TERMINAL_TASK_STATUSES, isTerminalTaskStatus } from '@buildd/shared';
import type { LessonRow } from './lesson';
import { assertContentFree } from './lesson';
import type { Cluster, PriorFiling } from './proposals';
import { PROPOSAL_MAX_REFS, PROPOSAL_WINDOW_DAYS } from './proposals';
import type { RetroMessage, RetroWindowInput } from './skeleton';
import { RETRO_IDLE_MIN, RETRO_MAX_WINDOW_MESSAGES } from './skeleton';
import type { ChatRetroSettings } from './settings';
import { readChatRetroSettings } from './settings';

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

/** Teams that opted in to lessons. Default (NULL / no key / false) is excluded. */
export function optedInTeamsWhere(): SQL {
  return sql`(${teams.chatRetro} ->> 'lessons') = 'true'`;
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

/** This team's judged lessons in the clustering window that carry a signature. */
export function clusterWhere(teamId: string, now: Date): SQL {
  return and(
    eq(chatRetros.teamId, teamId),
    eq(chatRetros.status, 'judged'),
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

// ── Reads ─────────────────────────────────────────────────────────────────────

export async function listOptedInTeams(): Promise<Array<{ teamId: string; settings: ChatRetroSettings }>> {
  const rows = await db.select({ id: teams.id, chatRetro: teams.chatRetro }).from(teams).where(optedInTeamsWhere());
  return rows.map(r => ({ teamId: r.id, settings: readChatRetroSettings(r.chatRetro) }));
}

export async function readTeamSettings(teamId: string): Promise<ChatRetroSettings> {
  const row = await db.query.teams.findFirst({ where: eq(teams.id, teamId), columns: { chatRetro: true } });
  return readChatRetroSettings(row?.chatRetro);
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
