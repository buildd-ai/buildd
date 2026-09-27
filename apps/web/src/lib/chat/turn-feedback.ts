/**
 * Thumbs on a chat turn (docs/design/tier-model-pools.md §5b). A person can
 * rate an assistant turn of a conversation they own; the vote lands in
 * `user_feedback` under the conversation's team with a reason LABEL, never
 * free text, so it can feed the tier pool's per-arm stats.
 */
import { and, eq } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { conversationMessages, conversations } from '@buildd/core/db/schema';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  if (!UUID_RE.test(messageId)) return null;
  const [row] = await db
    .select({ teamId: conversations.teamId })
    .from(conversationMessages)
    .innerJoin(conversations, eq(conversations.id, conversationMessages.conversationId))
    .where(ownAssistantMessageScope(messageId, userId))
    .limit(1);
  return row?.teamId ?? null;
}
