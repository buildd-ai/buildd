/**
 * Conversation persistence and DTOs for agent chat. Conversations are
 * personal: only their creator reads or writes them (P1).
 */

import { and, asc, desc, eq, inArray, isNull, lt } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { conversationApprovals, conversationMessages, conversations } from '@buildd/core/db/schema';
import { conversationDisplayTitle, normalizeConversationTitle } from '@buildd/core/conversation-title';
import type {
  ChatMessagePart,
  ChatUsage,
  ConversationApprovalDTO,
  ConversationDTO,
  ConversationMessageDTO,
  ConversationUpdatedPayload,
  ConversationUpdatedReason,
} from '@buildd/shared';
import { channels, events, triggerEvent } from '@/lib/pusher';

export type ConversationRow = typeof conversations.$inferSelect;
export type MessageRow = typeof conversationMessages.$inferSelect;

/** How much history a turn sends the model. Older turns stay stored. */
export const HISTORY_LIMIT = 40;

export function toConversationDTO(c: ConversationRow): ConversationDTO {
  return {
    id: c.id,
    teamId: c.teamId,
    workspaceId: c.workspaceId,
    createdByUserId: c.createdByUserId,
    title: conversationDisplayTitle(c),
    titleSource: c.titleSource,
    agentRoleSlug: c.agentRoleSlug,
    lastMessageAt: c.lastMessageAt.toISOString(),
    archivedAt: c.archivedAt ? c.archivedAt.toISOString() : null,
    createdAt: c.createdAt.toISOString(),
  };
}

export function toMessageDTO(m: MessageRow): ConversationMessageDTO {
  return {
    id: m.id,
    conversationId: m.conversationId,
    role: m.role,
    parts: m.parts,
    authorUserId: m.authorUserId,
    surface: m.surface,
    tier: m.tier,
    model: m.model,
    usage: m.usage ?? null,
    createdAt: m.createdAt.toISOString(),
  };
}

export async function createConversation(input: {
  teamId: string;
  workspaceId: string | null;
  userId: string;
}): Promise<ConversationRow> {
  const [row] = await db.insert(conversations).values({
    teamId: input.teamId,
    workspaceId: input.workspaceId,
    createdByUserId: input.userId,
  }).returning();
  return row;
}

export async function listConversations(userId: string, opts: { before?: Date; limit: number; teamIds: string[] }) {
  if (opts.teamIds.length === 0) return { conversations: [], nextCursor: null };
  const rows = await db.query.conversations.findMany({
    where: and(
      eq(conversations.createdByUserId, userId),
      inArray(conversations.teamId, opts.teamIds),
      isNull(conversations.archivedAt),
      opts.before ? lt(conversations.lastMessageAt, opts.before) : undefined,
    ),
    orderBy: [desc(conversations.lastMessageAt)],
    limit: opts.limit + 1,
  });
  const page = rows.slice(0, opts.limit);
  return {
    conversations: page,
    nextCursor: rows.length > opts.limit ? page[page.length - 1].lastMessageAt.toISOString() : null,
  };
}

/** The conversation, only if `userId` created it. */
export async function getOwnConversation(id: string, userId: string): Promise<ConversationRow | null> {
  const row = await db.query.conversations.findFirst({
    where: and(eq(conversations.id, id), eq(conversations.createdByUserId, userId)),
  });
  return row ?? null;
}

export async function loadMessages(conversationId: string, limit = 500): Promise<MessageRow[]> {
  const rows = await db.query.conversationMessages.findMany({
    where: eq(conversationMessages.conversationId, conversationId),
    orderBy: [desc(conversationMessages.createdAt)],
    limit,
  });
  return rows.reverse();
}

export async function loadApprovals(conversationId: string): Promise<ConversationApprovalDTO[]> {
  const rows = await db.query.conversationApprovals.findMany({
    where: eq(conversationApprovals.conversationId, conversationId),
    orderBy: [asc(conversationApprovals.createdAt)],
    columns: { approvalId: true, messageId: true, toolName: true, status: true, decidedAt: true },
  });
  return rows.map(r => ({
    id: r.approvalId, messageId: r.messageId, toolName: r.toolName, status: r.status,
    decidedAt: r.decidedAt ? r.decidedAt.toISOString() : null,
  }));
}

export async function insertMessage(input: {
  id?: string;
  conversationId: string;
  role: 'user' | 'assistant' | 'event';
  parts: ChatMessagePart[];
  authorUserId?: string | null;
  tier?: string | null;
  model?: string | null;
  usage?: ChatUsage | null;
}): Promise<MessageRow> {
  const now = new Date();
  const [row] = await db.insert(conversationMessages).values({
    ...(input.id ? { id: input.id } : {}),
    conversationId: input.conversationId,
    role: input.role,
    parts: input.parts,
    authorUserId: input.authorUserId ?? null,
    tier: input.tier ?? null,
    model: input.model ?? null,
    usage: input.usage ?? null,
    createdAt: now,
  }).returning();
  await db.update(conversations).set({ lastMessageAt: now }).where(eq(conversations.id, input.conversationId));
  return row;
}

/** Replace a stored message's parts (an approval continuation extends the same message). */
export async function updateMessage(id: string, conversationId: string, patch: {
  parts: ChatMessagePart[];
  usage?: ChatUsage | null;
  tier?: string | null;
  model?: string | null;
}): Promise<void> {
  await db.update(conversationMessages)
    .set({
      parts: patch.parts,
      ...(patch.usage !== undefined ? { usage: patch.usage } : {}),
      ...(patch.tier !== undefined ? { tier: patch.tier } : {}),
      ...(patch.model !== undefined ? { model: patch.model } : {}),
    })
    .where(and(eq(conversationMessages.id, id), eq(conversationMessages.conversationId, conversationId)));
  await db.update(conversations).set({ lastMessageAt: new Date() }).where(eq(conversations.id, conversationId));
}

/**
 * Set the title. An automatic title never overwrites one the user chose: the
 * `WHERE title_source = 'auto'` makes that race-free.
 */
export async function setConversationTitle(id: string, raw: string, source: 'auto' | 'user'): Promise<string | null> {
  const title = normalizeConversationTitle(raw);
  if (!title) return null;
  const rows = await db.update(conversations)
    .set({ title, titleSource: source })
    .where(source === 'auto'
      ? and(eq(conversations.id, id), eq(conversations.titleSource, 'auto'), isNull(conversations.title))
      : eq(conversations.id, id))
    .returning({ id: conversations.id });
  return rows.length > 0 ? title : null;
}

export async function setConversationArchived(id: string, archived: boolean): Promise<void> {
  await db.update(conversations).set({ archivedAt: archived ? new Date() : null }).where(eq(conversations.id, id));
}

/** A ping for other devices. Never carries message text. */
export async function pingConversation(conversationId: string, reason: ConversationUpdatedReason, messageId?: string) {
  const payload: ConversationUpdatedPayload = { conversationId, reason, ...(messageId ? { messageId } : {}) };
  await triggerEvent(channels.conversation(conversationId), events.CONVERSATION_UPDATED, payload);
}
