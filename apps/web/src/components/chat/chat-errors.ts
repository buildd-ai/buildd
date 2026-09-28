/**
 * A refused turn comes back as JSON with a 4xx instead of a stream
 * (`ChatUnavailableResponse`). The AI SDK surfaces the body as the error's
 * message; the kit's `parseChatUnavailable` / `chatErrorLine`
 * (@builddai/ai-kit/chat/contract) read it back. buildd keeps its own words and
 * the typed fields of its refusal body. Pure.
 */
import type { ChatUnavailableResponse } from '@buildd/shared';
import { chatErrorLine as kitChatErrorLine, parseChatUnavailable as kitParse, type ChatErrorLines } from '@builddai/ai-kit/chat/contract';

/** buildd's wording where a refusal carries no message of its own. */
export const BUILDD_CHAT_ERROR_LINES: Partial<ChatErrorLines> = {
  budget_exhausted: 'Today’s chat budget is used up. The mission form still works.',
  failed: 'The turn didn’t finish. Your message is kept — send it again.',
};

export function parseChatUnavailable(err: unknown): ChatUnavailableResponse | null {
  const v = kitParse(err) as (ReturnType<typeof kitParse> & Partial<ChatUnavailableResponse>) | null;
  if (!v) return null;
  return {
    error: v.error,
    message: v.message,
    ...(typeof v.canManageTeamKeys === 'boolean' ? { canManageTeamKeys: v.canManageTeamKeys } : {}),
    ...(typeof v.retryAfterSeconds === 'number' ? { retryAfterSeconds: v.retryAfterSeconds } : {}),
    ...(v.scope === 'team' || v.scope === 'user' ? { scope: v.scope } : {}),
  };
}

/** One line for a turn that failed for any other reason. Never echoes a stack. */
export function chatErrorLine(err: unknown): string {
  return kitChatErrorLine(err, BUILDD_CHAT_ERROR_LINES);
}
