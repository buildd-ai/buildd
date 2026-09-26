/**
 * A refused turn comes back as JSON with a 4xx instead of a stream
 * (`ChatUnavailableResponse`). The AI SDK surfaces the body as the error's
 * message; this reads it back. Pure.
 */
import type { ChatUnavailableResponse } from '@buildd/shared';

const REASONS = new Set(['capability_disabled', 'no_key', 'budget_exhausted', 'rate_limited']);

export function parseChatUnavailable(err: unknown): ChatUnavailableResponse | null {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : null;
  if (!raw || raw[0] !== '{') return null;
  try {
    const v = JSON.parse(raw) as Partial<ChatUnavailableResponse>;
    if (typeof v.error !== 'string' || !REASONS.has(v.error)) return null;
    return {
      error: v.error as ChatUnavailableResponse['error'],
      message: typeof v.message === 'string' ? v.message : '',
      ...(typeof v.canManageTeamKeys === 'boolean' ? { canManageTeamKeys: v.canManageTeamKeys } : {}),
      ...(typeof v.retryAfterSeconds === 'number' ? { retryAfterSeconds: v.retryAfterSeconds } : {}),
    };
  } catch {
    return null;
  }
}

/** One line for a turn that failed for any other reason. Never echoes a stack. */
export function chatErrorLine(err: unknown): string {
  const u = parseChatUnavailable(err);
  if (u) {
    if (u.error === 'budget_exhausted') return u.message || 'Today’s chat budget is used up. The mission form still works.';
    if (u.error === 'rate_limited') return u.message || 'Too many turns in a short time. Try again in a moment.';
    return u.message || 'Chat is unavailable.';
  }
  const raw = err instanceof Error ? err.message : '';
  if (raw.startsWith('{')) {
    try {
      const v = JSON.parse(raw) as { error?: unknown; message?: unknown };
      if (typeof v.message === 'string') return v.message;
      if (typeof v.error === 'string') return v.error;
    } catch { /* fall through */ }
  }
  return 'The turn didn’t finish. Your message is kept — send it again.';
}
