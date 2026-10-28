/**
 * Thumbs on a chat turn (knowledge-base: buildd/design/tier-model-pools.md §5b). A person can
 * rate an assistant turn of a conversation they own; the vote lands in
 * `user_feedback` under the conversation's team with a reason LABEL, never
 * free text, so it can feed the tier pool's per-arm stats.
 */
import { and, eq } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { conversationMessages, conversations } from '@buildd/core/db/schema';
import { isUuid } from '@/lib/uuid';


/** WHERE clause: this assistant message, in a conversation this user owns. */
export function ownAssistantMessageScope(messageId: string, userId: string) {
  return and(
    eq(conversationMessages.id, messageId),
    eq(conversationMessages.role, 'assistant'),
    eq(conversations.createdByUserId, userId),
  );
}

/** The team of an assistant turn the user may rate, or null. */
export async function rateableTurnTeam(messageId: string, userId: string): Promise<string | null> {
  if (!isUuid(messageId)) return null;
  const [row] = await db
    .select({ teamId: conversations.teamId })
    .from(conversationMessages)
    .innerJoin(conversations, eq(conversations.id, conversationMessages.conversationId))
    .where(ownAssistantMessageScope(messageId, userId))
    .limit(1);
  return row?.teamId ?? null;
}
