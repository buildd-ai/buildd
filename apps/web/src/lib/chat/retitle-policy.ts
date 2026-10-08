/**
 * When to ask whether a conversation has moved on from its auto title, and
 * what to do with the answer (chat/retitle.ts). Pure, so the turn runner
 * imports it without the DB layer.
 */

import type { ConversationRow } from './store';

export type RetitleMode = 'off' | 'shadow' | 'live';
export const RETITLE_MODE: RetitleMode = 'live';
/** Ask on every Nth user turn (N, 2N, ...): drift is slow, and each ask adds tokens to routing. */
export const RETITLE_EVERY_USER_TURNS = 3;
/** A rename is visible and replaces something the person has been reading, so it is gated high. */
export const RETITLE_MIN_CONFIDENCE = 0.9;
export const RETITLE_LOG_PREFIX = '[chat-retitle-shadow]';
/** Prompt version for the retitle decision ledger. Increment when the question or context changes. */
export const RETITLE_PROMPT_VERSION = 'rt1';

/** The title to ask about on this turn, or null. `userTurn` counts the incoming message (1-based). */
export function titleToCheck(
  conversation: Pick<ConversationRow, 'title' | 'titleSource'>,
  userTurn: number,
  mode: RetitleMode = RETITLE_MODE,
): string | null {
  if (mode === 'off' || !conversation.title || conversation.titleSource !== 'auto') return null;
  if (userTurn < RETITLE_EVERY_USER_TURNS || userTurn % RETITLE_EVERY_USER_TURNS !== 0) return null;
  return conversation.title;
}
