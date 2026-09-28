/**
 * Provider failures, as words a person can act on. A turn that fails after it
 * started streaming used to say only "The turn failed." whatever the cause; the
 * common causes (a key out of credit or over its limit, a throttled key, a
 * rejected key) each have a fix the person or the app owner can make.
 *
 * Reads the AI SDK's `APICallError` shape (`statusCode`, `responseBody`,
 * `message`) structurally, through `RetryError.lastError` / `errors` and
 * `cause`, so it needs no import of `ai` or `@ai-sdk/provider`.
 */

import type { ChatTurnErrorCode, TurnErrorData } from '@builddai/ai-kit/chat/contract';

export const TURN_ERROR_MESSAGES: Record<ChatTurnErrorCode, string> = {
  insufficient_credit: 'The AI provider refused this turn: the key is out of credit or over its spending limit. Add credit or raise the key\'s limit, then try again.',
  rate_limited: 'The AI provider is rate-limiting this key. Wait a minute, then try again.',
  invalid_key: 'The AI provider rejected the key. Check the provider key in settings.',
  failed: 'The turn failed.',
};

const CREDIT = /insufficient (credit|funds|balance|quota)|more credits|can only afford|credit limit|spending limit|key limit|limit exceeded for key|exceeded your current quota|payment required|out of credits?/i;
const RATE = /rate.?limit|too many requests/i;
const AUTH = /invalid (api )?key|no auth credentials|unauthori[sz]ed|user not found|api key (is )?(missing|invalid|disabled)/i;

/** Every error in the chain: the error, its `cause`, and a retry's `lastError` / `errors`. */
function chain(e: unknown, depth = 0, out: unknown[] = []): unknown[] {
  if (e == null || depth > 4 || out.includes(e)) return out;
  out.push(e);
  if (typeof e === 'object') {
    const o = e as { cause?: unknown; lastError?: unknown; errors?: unknown };
    if (o.lastError !== undefined) chain(o.lastError, depth + 1, out);
    if (Array.isArray(o.errors)) for (const x of o.errors.slice(-3)) chain(x, depth + 1, out);
    if (o.cause !== undefined) chain(o.cause, depth + 1, out);
  }
  return out;
}

function text(e: unknown): string {
  if (typeof e === 'string') return e;
  if (!e || typeof e !== 'object') return '';
  const o = e as { message?: unknown; responseBody?: unknown; data?: unknown };
  const parts = [o.message, o.responseBody];
  if (o.data && typeof o.data === 'object') {
    try { parts.push(JSON.stringify(o.data)); } catch { /* circular */ }
  }
  return parts.filter(p => typeof p === 'string').join(' ');
}

function status(e: unknown): number | undefined {
  const s = e && typeof e === 'object' ? (e as { statusCode?: unknown; status?: unknown }).statusCode ?? (e as { status?: unknown }).status : undefined;
  return typeof s === 'number' && s >= 100 && s < 600 ? s : undefined;
}

/**
 * Classify a stream error. Credit wins over a rate limit when both match
 * (OpenRouter returns 402 for credit, and some routes return 429 with a
 * "key limit" body), and auth only on 401/403 or an explicit message.
 */
export function classifyTurnError(error: unknown): TurnErrorData {
  const errs = chain(error);
  const statuses = errs.map(status).filter((s): s is number => s !== undefined);
  const all = errs.map(text).join(' \n ');
  const httpStatus = statuses.at(-1);
  const withStatus = (code: ChatTurnErrorCode): TurnErrorData => ({
    code, message: TURN_ERROR_MESSAGES[code], ...(httpStatus !== undefined ? { status: httpStatus } : {}),
  });
  if (statuses.includes(402) || CREDIT.test(all)) return withStatus('insufficient_credit');
  if (statuses.includes(429) || RATE.test(all)) return withStatus('rate_limited');
  if (statuses.includes(401) || statuses.includes(403) || AUTH.test(all)) return withStatus('invalid_key');
  return withStatus('failed');
}
