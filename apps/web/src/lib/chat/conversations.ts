/**
 * Server reads for the chat pages: the caller's conversation list and one
 * conversation's saved messages as the `UIMessage`s `useChat` starts from.
 * A conversation belongs to the person who started it; anyone else gets null.
 */
import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { conversationMessages, conversations, missions } from '@buildd/core/db/schema';
import { conversationDisplayTitle } from '@buildd/core/conversation-title';
import type { ChatMessage } from '@/components/chat/chat-contract';

export interface ConversationListItem {
  id: string;
  title: string;
  titleSource: 'auto' | 'user';
  untitled: boolean;
  lastMessageAt: string;
  workspaceId: string | null;
}

export interface LoadedConversation {
  id: string;
  teamId: string;
  workspaceId: string | null;
  title: string | null;
  titleSource: 'auto' | 'user';
  /** The tier the latest assistant turn ran on — shown, never chosen. */
  tier: string | null;
  messages: ChatMessage[];
}

interface MessageRow {
  id: string;
  role: string;
  parts: Array<{ type: string; [key: string]: unknown }>;
  tier: string | null;
  createdAt: Date | string;
  authorUserId: string | null;
}

/** A saved row → the UIMessage the feed and `useChat` read. Pure. */
export function toChatMessage(row: MessageRow, authorName: string | null): ChatMessage {
  const role = row.role === 'user' || row.role === 'assistant' || row.role === 'event' ? row.role : 'assistant';
  return {
    id: row.id,
    role,
    parts: Array.isArray(row.parts) ? row.parts : [],
    metadata: {
      createdAt: new Date(row.createdAt).toISOString(),
      ...(role === 'user' && authorName ? { authorName } : {}),
      ...(row.tier ? { tier: row.tier } : {}),
    },
  };
}

export function latestTier(rows: readonly Pick<MessageRow, 'role' | 'tier'>[]): string | null {
  for (let i = rows.length - 1; i >= 0; i--) if (rows[i].role === 'assistant' && rows[i].tier) return rows[i].tier;
  return null;
}

export async function listConversations(userId: string, teamId: string, limit = 30): Promise<ConversationListItem[]> {
  const rows = await db
    .select({
      id: conversations.id, title: conversations.title, titleSource: conversations.titleSource,
      lastMessageAt: conversations.lastMessageAt, workspaceId: conversations.workspaceId,
    })
    .from(conversations)
    .where(and(eq(conversations.createdByUserId, userId), eq(conversations.teamId, teamId), isNull(conversations.archivedAt)))
    .orderBy(desc(conversations.lastMessageAt))
    .limit(limit);
  return rows.map(r => ({
    id: r.id,
    title: conversationDisplayTitle(r),
    titleSource: r.titleSource,
    untitled: !r.title?.trim(),
    lastMessageAt: new Date(r.lastMessageAt).toISOString(),
    workspaceId: r.workspaceId,
  }));
}

export async function loadConversation(id: string, userId: string, authorName: string | null): Promise<LoadedConversation | null> {
  const [conv, rows] = await Promise.all([
    db.query.conversations.findFirst({
      where: and(eq(conversations.id, id), eq(conversations.createdByUserId, userId)),
      columns: { id: true, teamId: true, workspaceId: true, title: true, titleSource: true, archivedAt: true },
    }),
    db
      .select({
        id: conversationMessages.id, role: conversationMessages.role, parts: conversationMessages.parts,
        tier: conversationMessages.tier, createdAt: conversationMessages.createdAt, authorUserId: conversationMessages.authorUserId,
        owner: conversations.createdByUserId,
      })
      .from(conversationMessages)
      .innerJoin(conversations, eq(conversations.id, conversationMessages.conversationId))
      .where(and(eq(conversationMessages.conversationId, id), eq(conversations.createdByUserId, userId)))
      .orderBy(asc(conversationMessages.createdAt)),
  ]);
  if (!conv) return null;
  return {
    id: conv.id,
    teamId: conv.teamId,
    workspaceId: conv.workspaceId,
    title: conv.title?.trim() ? conv.title : null,
    titleSource: conv.titleSource,
    tier: latestTier(rows),
    messages: rows.map(r => toChatMessage(r, authorName)),
  };
}

/**
 * The conversation a mission was filed from, when it is this person's own.
 * The respond deep link opens it with the question in focus; a teammate's
 * conversation is never opened for someone else.
 */
export async function ownConversationForMission(missionId: string, userId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: conversations.id })
    .from(missions)
    .innerJoin(conversations, eq(conversations.id, missions.conversationId))
    .where(and(eq(missions.id, missionId), eq(conversations.createdByUserId, userId), isNull(conversations.archivedAt)))
    .limit(1);
  return row?.id ?? null;
}

/** `/app/chat/<id>?focus=question&worker=<w>&task=<t>` — the question card in focus. Pure. */
export function questionFocusHref(conversationId: string, q: { workerId: string; taskId: string }): string {
  const qs = new URLSearchParams({ focus: 'question', worker: q.workerId, task: q.taskId });
  return `/app/chat/${conversationId}?${qs.toString()}`;
}
