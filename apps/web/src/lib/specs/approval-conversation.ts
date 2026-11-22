import { db } from '@buildd/core/db';
import { conversationMessages, conversations } from '@buildd/core/db/schema';
import { and, eq } from 'drizzle-orm';
import { isUuid } from '@/lib/uuid';
import { fail, type SpecError } from './store';

/**
 * Approval by recorded intent (Living Spec 65ed7fa3, D-18): the owner says
 * "approve it" in a conversation and that message is the approval. What is
 * checked here is who wrote it: the signed-in person's own session must be the
 * author of the cited message, in a conversation that person owns. An agent,
 * task or API token never gets this far (the route accepts a dashboard
 * session only), and a ref the caller did not author is refused whoever
 * forged it.
 */
export interface ConversationMessageRow {
  conversationOwnerId: string;
  messageConversationId: string;
  role: string;
  authorUserId: string | null;
  createdAt: Date;
}

export interface ConversationProvenance { conversationId: string; messageId: string; messageAt: Date }

export type LoadMessage = (conversationId: string, messageId: string) => Promise<ConversationMessageRow | null>;

export const loadConversationMessage: LoadMessage = async (conversationId, messageId) => {
  const [row] = await db.select({
    conversationOwnerId: conversations.createdByUserId,
    messageConversationId: conversationMessages.conversationId,
    role: conversationMessages.role,
    authorUserId: conversationMessages.authorUserId,
    createdAt: conversationMessages.createdAt,
  }).from(conversationMessages)
    .innerJoin(conversations, eq(conversations.id, conversationMessages.conversationId))
    .where(and(eq(conversationMessages.id, messageId), eq(conversationMessages.conversationId, conversationId))).limit(1);
  return row ?? null;
};

const REFUSED = 'That message is not yours to approve with: approve in a conversation you own, with a message you wrote.';

/**
 * The cited message must be the caller's own user message in the caller's own
 * conversation, written after the revision it approves existed (so it cannot
 * pre-approve a body the person never saw). One generic 403 for every way it
 * can be wrong about authorship, so a ref reveals nothing about others' chats.
 */
export async function verifyOwnerMessage(
  userId: string,
  ref: { conversationId: unknown; messageId: unknown },
  revisionCreatedAt: Date,
  load: LoadMessage = loadConversationMessage,
): Promise<{ ok: true; provenance: ConversationProvenance } | SpecError> {
  if (typeof ref.conversationId !== 'string' || typeof ref.messageId !== 'string' || !isUuid(ref.conversationId) || !isUuid(ref.messageId)) {
    return fail(400, 'conversationId and messageId (the message where you approved) are required');
  }
  const row = await load(ref.conversationId, ref.messageId);
  if (!row || row.messageConversationId !== ref.conversationId || row.conversationOwnerId !== userId
    || row.role !== 'user' || row.authorUserId !== userId) {
    return fail(403, REFUSED, { code: 'message_not_yours' });
  }
  if (row.createdAt.getTime() < revisionCreatedAt.getTime()) {
    return fail(409, 'That message was written before this revision existed, so it cannot approve it. Approve again now.', { code: 'message_predates_revision' });
  }
  return { ok: true, provenance: { conversationId: ref.conversationId, messageId: ref.messageId, messageAt: row.createdAt } };
}

const SOURCE_ID = /^(R|AC|D|I)-\d+$/;
export const MAX_CRITERION_SOURCES = 100;

/** Per-criterion source references: criterion id → what in the conversation it came from (≤200 chars). */
export function parseCriterionSources(v: unknown): { ok: true; sources: Record<string, string> | null } | SpecError {
  if (v === undefined || v === null) return { ok: true, sources: null };
  if (typeof v !== 'object' || Array.isArray(v)) return fail(400, 'criterionSources must map a criterion id to its source');
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length > MAX_CRITERION_SOURCES) return fail(400, `criterionSources holds at most ${MAX_CRITERION_SOURCES} entries`);
  const out: Record<string, string> = {};
  for (const [id, src] of entries) {
    if (!SOURCE_ID.test(id) || typeof src !== 'string' || !src.trim() || src.length > 200) {
      return fail(400, `criterionSources["${id}"] must be a criterion id with a source of 1 to 200 characters`);
    }
    out[id] = src.trim();
  }
  return { ok: true, sources: entries.length ? out : null };
}
