/**
 * Conversation titles (agent chat). Titles are set automatically after the
 * first exchange and may be renamed; readers always go through
 * `conversationDisplayTitle`, the way tasks go through `taskDisplayLabel`.
 */

/** `conversations.title` is varchar(80). */
export const CONVERSATION_TITLE_MAX = 80;

export const UNTITLED_CONVERSATION = 'New conversation';

export function conversationDisplayTitle(c: { title: string | null | undefined }): string {
  const t = c.title?.trim();
  return t ? t : UNTITLED_CONVERSATION;
}

/** Clean a model- or user-supplied title to fit the column, or null if nothing is left. */
export function normalizeConversationTitle(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let t = raw.replace(/\s+/g, ' ').trim();
  t = t.replace(/^["'`]+|["'`]+$/g, '').trim();
  t = t.replace(/[.。]+$/, '').trim();
  if (!t) return null;
  if (t.length > CONVERSATION_TITLE_MAX) t = t.slice(0, CONVERSATION_TITLE_MAX - 1).trimEnd() + '…';
  return t;
}
