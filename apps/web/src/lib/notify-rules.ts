/**
 * Pure notification routing rules — no DB, no network, no secrets.
 *
 * Kept separate from ./notify (which does IO) so the decision logic is trivially
 * unit-testable. ./notify re-exports these.
 */

/** Toggleable per-team event types. Mirrors the boolean columns on `notification_preferences`. */
export type NotifyEvent = 'taskClaimed' | 'taskCompleted' | 'taskFailed' | 'credentialExpired';

/** Defaults match the previous always-on behaviour, but every event is now muteable. */
export const DEFAULT_NOTIFICATION_PREFERENCES: Record<NotifyEvent, boolean> = {
  taskClaimed: true,
  taskCompleted: true,
  taskFailed: true,
  credentialExpired: true,
};

/**
 * The team's Pushover channel — BOTH the team's own application token AND their
 * user/group key. We never send a tenant's alerts through buildd's own Pushover
 * app: each team brings its own app token so message volume, rate limits, and
 * logs stay attributed to that team (no cross-tenant coupling). A channel missing
 * either field is treated as not configured.
 */
export interface PushoverChannel {
  /** Pushover application token (the team's own app — identifies the sender). */
  appToken: string;
  /** Pushover user or group key (identifies who receives the alert). */
  userKey: string;
}

/** The team's resolved channel. Either, both, or neither may be present. */
export interface TeamChannel {
  /** Pushover channel (the team's own app token + user/group key). */
  pushover?: PushoverChannel | null;
  /** URL buildd POSTs the alert JSON to. */
  webhookUrl?: string | null;
}

/** What a notification attempt should do, given the channel + preferences. */
export interface NotifyPlan {
  /** Send to Pushover (a pushover key is set AND the event is enabled). */
  pushover: boolean;
  /** POST to the webhook (a webhook URL is set AND the event is enabled). */
  webhook: boolean;
  /** True when nothing will be sent (no channel, or the event is disabled). */
  noop: boolean;
}

/**
 * Decide what to send. Returns a no-op plan when the event is disabled or no
 * channel is configured.
 */
export function resolveNotifyPlan(
  event: NotifyEvent,
  channel: TeamChannel | null,
  prefs: Record<NotifyEvent, boolean>,
): NotifyPlan {
  const enabled = prefs[event] ?? DEFAULT_NOTIFICATION_PREFERENCES[event];
  // A Pushover channel needs BOTH the team's app token and user key.
  const hasPushover = !!channel?.pushover?.appToken && !!channel?.pushover?.userKey;
  const hasWebhook = !!channel?.webhookUrl;

  if (!enabled || (!hasPushover && !hasWebhook)) {
    return { pushover: false, webhook: false, noop: true };
  }

  return { pushover: hasPushover, webhook: hasWebhook, noop: false };
}

/**
 * Detect an expired/invalid agent-backend credential from a runner's error text.
 * This is the auth-failure pattern (e.g. a 401 from the model provider) that
 * should prompt the team to re-set their credential — NOT a budget/rate-limit
 * pause, and NOT buildd's own API-key auth (the runner's bld_ key).
 */
export function isCredentialExpiredError(error?: string | null): boolean {
  if (!error) return false;
  const lower = error.toLowerCase();
  if (lower.includes('invalid api key') || lower.includes('bld_')) return false;
  return (
    lower.includes('invalid authentication credentials') ||
    lower.includes('invalid x-api-key') ||
    lower.includes('authentication_error') ||
    lower.includes('oauth token has expired') ||
    lower.includes('oauth authentication is currently not supported') ||
    (lower.includes('401') && (lower.includes('authentication') || lower.includes('credential'))) ||
    lower.includes('expired credential') ||
    lower.includes('credential has expired')
  );
}
