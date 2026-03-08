/**
 * Pushover notification utility.
 * Two apps: "tasks" for operational events, "alerts" for errors/warnings.
 *
 * Env vars:
 *   PUSHOVER_USER          — your user key
 *   PUSHOVER_TOKEN_TASKS   — app token for task events (claimed, done)
 *   PUSHOVER_TOKEN_ALERTS  — app token for alerts (failures, large payloads)
 *   PUSHOVER_TOKEN         — fallback if per-app tokens aren't set
 */

type PushoverPriority = -2 | -1 | 0 | 1;
type PushoverApp = 'tasks' | 'alerts';

interface PushoverOptions {
  app?: PushoverApp; // default: 'tasks'
  title: string;
  message: string;
  priority?: PushoverPriority; // default: -1 (silent)
  url?: string;
  urlTitle?: string;
}

function getToken(app: PushoverApp): string | undefined {
  if (app === 'tasks') return process.env.PUSHOVER_TOKEN_TASKS || process.env.PUSHOVER_TOKEN;
  if (app === 'alerts') return process.env.PUSHOVER_TOKEN_ALERTS || process.env.PUSHOVER_TOKEN;
  return process.env.PUSHOVER_TOKEN;
}

export function notify(opts: PushoverOptions): void {
  const user = process.env.PUSHOVER_USER;
  const token = getToken(opts.app ?? 'tasks');
  if (!user || !token) return;

  fetch('https://api.pushover.net/1/messages.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token,
      user,
      title: opts.title,
      message: opts.message,
      priority: opts.priority ?? -1,
      ...(opts.url ? { url: opts.url, url_title: opts.urlTitle } : {}),
    }),
  }).catch(() => {});
}
