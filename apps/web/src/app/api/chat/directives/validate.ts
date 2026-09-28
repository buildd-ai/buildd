/**
 * Shared request checks for the /api/chat/directives routes: ids, text, the
 * workspace a rule is scoped to, and the card's conversation. Every check is
 * against the caller, so a rule or card that is not theirs reads as not found,
 * and a malformed id is a 400/404 before any query sees it (never a 500).
 */
import { DIRECTIVE_TEXT_MAX, normalizeDirectiveText } from '@buildd/core/chat-directives';
import { verifyWorkspaceAccess } from '@/lib/team-access';
import { getOwnConversation } from '@/lib/chat/store';
import type { ChatCaller } from '@/lib/chat/session';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

const bad = (error: string, status = 400) => ({ response: Response.json({ error }, { status }) });

/** A rule id from the path: anything but a UUID is a rule that does not exist. */
export function checkRuleId(raw: string): { id: string } | { response: Response } {
  return isUuid(raw) ? { id: raw } : bad('Rule not found', 404);
}

export function checkText(raw: unknown): { text: string } | { response: Response } {
  if (typeof raw !== 'string') return bad('text must be a string');
  if (raw.trim().length > DIRECTIVE_TEXT_MAX) return bad(`a rule is at most ${DIRECTIVE_TEXT_MAX} characters`);
  const text = normalizeDirectiveText(raw);
  return text ? { text } : bad('text must not be empty');
}

/** null = every workspace. Anything else must be a workspace the caller reaches. */
export async function checkWorkspace(caller: ChatCaller, raw: unknown): Promise<{ workspaceId: string | null } | { response: Response }> {
  if (raw === null || raw === undefined) return { workspaceId: null };
  if (typeof raw !== 'string') return bad('workspaceId must be a string or null');
  if (!isUuid(raw)) return bad('Workspace not found', 404);
  const access = await verifyWorkspaceAccess(caller.user.id, raw);
  if (!access || !caller.teamIds.includes(access.teamId)) return bad('Workspace not found', 404);
  return { workspaceId: raw };
}

/** The caller's own conversation, in a team they are still in. */
export async function checkCard(caller: ChatCaller, raw: unknown): Promise<{ conversationId: string; messageId: string } | { response: Response }> {
  const r = raw as { conversationId?: unknown; messageId?: unknown } | null | undefined;
  if (!r || typeof r.conversationId !== 'string' || typeof r.messageId !== 'string') return bad('conversationId and messageId are required');
  if (!isUuid(r.conversationId)) return bad('Conversation not found', 404);
  if (!isUuid(r.messageId)) return bad('Card not found', 404);
  const conv = await getOwnConversation(r.conversationId, caller.user.id).catch(() => null);
  if (!conv || !caller.teamIds.includes(conv.teamId)) return bad('Conversation not found', 404);
  return { conversationId: r.conversationId, messageId: r.messageId };
}
