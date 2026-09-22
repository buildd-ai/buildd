/**
 * The notification path.
 *
 * ── Two properties, both load-bearing ───────────────────────────────────────
 *
 * 1. **It does not depend on the model credential.** Pushover over plain HTTPS
 *    with a user key and an app token from the environment. A dead or expired
 *    Anthropic credential costs the narrative in the body and nothing else;
 *    the page still names the condition and when it tripped.
 *
 * 2. **It does not depend on the platform.** Not `lib/notify`'s per-team
 *    routing, which reads `notification_preferences` from the production
 *    database and only accepts the five `NotifyEvent` values that have columns
 *    there. Routing a platform-health page through the platform's own database
 *    is the circular dependency this whole app exists to break. The same
 *    reasoning is already written into
 *    `apps/web/src/app/api/cron/queue-stall/route.ts`, which reaches for
 *    env-based ops Pushover for exactly this reason.
 *
 * ── Why this awaits, unlike lib/pushover ────────────────────────────────────
 * `apps/web/src/lib/pushover.ts` fires the request and swallows the result,
 * which is right for a serverless route that must not block on a notification.
 * It is wrong here. A responder whose page silently failed to send is
 * indistinguishable from one with nothing to report, and that is the precise
 * failure this app was written after. So the send is awaited and its outcome
 * is returned, so `cycle.ts` can write a `notify_failed` evidence record — the
 * one failure nothing else in the system could ever catch.
 */

import type { NotifyConfig } from './config';

export interface Page {
  title: string;
  message: string;
  /** Pushover priority. 1 = high (bypasses quiet hours); 0 = normal. */
  priority: 0 | 1;
}

export interface NotifyResult {
  ok: boolean;
  status: number | null;
  error?: string;
}

export type NotifyFn = (page: Page) => Promise<NotifyResult>;

/** Pushover truncates long bodies server-side; trim here so the tail is ours. */
const MAX_MESSAGE = 1000;

export function truncateMessage(message: string, max = MAX_MESSAGE): string {
  if (message.length <= max) return message;
  return `${message.slice(0, max - 3)}...`;
}

export function pushoverNotifier(
  config: NotifyConfig,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): NotifyFn {
  const doFetch = opts.fetchImpl ?? fetch;
  return async (page: Page): Promise<NotifyResult> => {
    try {
      const res = await doFetch('https://api.pushover.net/1/messages.json', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: config.token,
          user: config.user,
          title: page.title,
          message: truncateMessage(page.message),
          priority: page.priority,
        }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
      });
      return res.ok
        ? { ok: true, status: res.status }
        : { ok: false, status: res.status, error: `pushover returned ${res.status}` };
    } catch (err) {
      return {
        ok: false,
        status: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  };
}
