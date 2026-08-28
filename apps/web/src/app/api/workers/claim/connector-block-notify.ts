/**
 * Connector-blocked notification helpers.
 *
 * Fires a Pushover/webhook alert the first time a task is blocked due to a
 * required-connector failure, and a reminder after 30 minutes if still blocked.
 *
 * Dedup is tracked in task.context:
 *   connectorBlockNotifiedAt    — ISO timestamp, set when first alert is sent
 *   connectorBlockReminderSentAt — ISO timestamp, set when the reminder is sent
 *
 * Both functions are fire-and-forget in the claim route (errors are caught).
 * The reminder is driven by the /api/cron/connector-block-notify cron.
 */

import { notifyTeam, type NotifyPayload } from '@/lib/notify';

const APP_BASE_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://buildd.dev';
const CONNECTOR_SETTINGS_PATH = '/app/settings#connectors';

// Floor, not a promise: the cron that drives the reminder runs hourly (to let
// Neon's compute autosuspend), so a reminder lands 30–90 min after the block.
export const CONNECTOR_BLOCK_REMINDER_MS = 30 * 60 * 1000;

export interface ConnectorFailure {
  connectorId: string;
  connectorName: string;
  mode: string;
}

export interface ConnectorBlockContext {
  teamId: string;
  taskTitle: string;
  workspaceName: string;
  roleSlug: string;
  failures: ConnectorFailure[];
}

/** Build the canonical notification message string per the task spec. */
export function buildConnectorBlockMessage(
  taskTitle: string,
  workspaceName: string,
  roleSlug: string,
  failures: ConnectorFailure[],
): string {
  const connectorDetail = failures
    .map(f => `${f.connectorName} (${f.mode})`)
    .join(', ');
  const fixUrl = `${APP_BASE_URL}${CONNECTOR_SETTINGS_PATH}`;
  return (
    `Task: "${taskTitle}" (workspace: ${workspaceName}) / ` +
    `Role: ${roleSlug} | Connector: ${connectorDetail} / ` +
    `Fix: ${fixUrl}`
  );
}

/**
 * Send the initial connector-blocked alert for a team.
 * Returns true if the notification was sent (caller should stamp context).
 * Pass `alreadySent=true` to skip (dedup guard from caller).
 */
export async function notifyConnectorBlocked(
  ctx: ConnectorBlockContext,
  alreadySent: boolean,
): Promise<boolean> {
  if (alreadySent) return false;
  if (ctx.failures.length === 0) return false;

  const payload: NotifyPayload = {
    title: '[buildd] Task blocked: connector unavailable',
    message: buildConnectorBlockMessage(
      ctx.taskTitle,
      ctx.workspaceName,
      ctx.roleSlug,
      ctx.failures,
    ),
    url: `${APP_BASE_URL}${CONNECTOR_SETTINGS_PATH}`,
    urlTitle: 'Fix connector settings',
    priority: 0,
  };

  await notifyTeam(ctx.teamId, 'connectorBlocked', payload);
  return true;
}

/**
 * Send a 30-minute stale reminder for a still-blocked task.
 * Returns true if the reminder was sent (caller should stamp context).
 *
 * `notifiedAt` is the timestamp when the first alert was sent.
 * `reminderAlreadySent` is true if a reminder was already recorded.
 */
export async function notifyConnectorBlockReminder(
  ctx: ConnectorBlockContext,
  notifiedAt: Date,
  reminderAlreadySent: boolean,
): Promise<boolean> {
  if (reminderAlreadySent) return false;
  if (ctx.failures.length === 0) return false;

  const elapsed = Date.now() - notifiedAt.getTime();
  if (elapsed < CONNECTOR_BLOCK_REMINDER_MS) return false;

  const minutesSinceBlock = Math.round(elapsed / 60_000);
  const connectorDetail = ctx.failures.map(f => `${f.connectorName} (${f.mode})`).join(', ');
  const fixUrl = `${APP_BASE_URL}${CONNECTOR_SETTINGS_PATH}`;

  const payload: NotifyPayload = {
    title: '[buildd] Reminder: task still blocked by connector',
    message: (
      `Task: "${ctx.taskTitle}" (workspace: ${ctx.workspaceName}) / ` +
      `Role: ${ctx.roleSlug} | Connector: ${connectorDetail} / ` +
      `Blocked for ${minutesSinceBlock} minutes / Fix: ${fixUrl}`
    ),
    url: fixUrl,
    urlTitle: 'Fix connector settings',
    priority: 0,
  };

  await notifyTeam(ctx.teamId, 'connectorBlocked', payload);
  return true;
}

// ── Proactive expiry alerts ──────────────────────────────────────────────────
//
// The two functions above are reactive: they only fire once a task has already
// tripped on a required connector. A connector nobody's task happens to require
// could break and sit silent indefinitely. The cron scans credentials directly
// and calls the function below.
//
// This alerts only when a credential can no longer heal itself — see
// needsReconnect() in lib/connector-status.ts. Warning on merely-approaching
// expiry was pure noise: the refresh sweep renews those, and Cue's 24h token
// lifetime meant "expiring within 24h" was true essentially always.

const CONNECTIONS_PATH = '/app/connections';

export interface ConnectorExpiryContext {
  teamId: string;
  connectorName: string;
  /** Present when the token has a known expiry that has passed. */
  tokenExpiresAt: Date | null;
  /** The refresher's recorded failure, when refresh itself is what broke. */
  refreshError?: string | null;
}

export function buildConnectorExpiryMessage(ctx: ConnectorExpiryContext, now: Date = new Date()): string {
  const fixUrl = `${APP_BASE_URL}${CONNECTIONS_PATH}`;
  const cause = ctx.refreshError
    ? `token refresh failed (${ctx.refreshError})`
    : ctx.tokenExpiresAt
      ? `expired ${Math.max(1, Math.round((now.getTime() - ctx.tokenExpiresAt.getTime()) / 3_600_000))}h ago and has not renewed`
      : 'is no longer usable';
  return (
    `Connection "${ctx.connectorName}" needs re-authorising — ${cause}. ` +
    `Tasks that need it are blocked. / Fix: ${fixUrl}`
  );
}

export async function notifyConnectorExpiry(ctx: ConnectorExpiryContext): Promise<boolean> {
  const payload: NotifyPayload = {
    title: '[buildd] Connection needs reconnecting',
    message: buildConnectorExpiryMessage(ctx),
    url: `${APP_BASE_URL}${CONNECTIONS_PATH}`,
    urlTitle: 'Reconnect',
    priority: 0,
  };

  await notifyTeam(ctx.teamId, 'connectorBlocked', payload);
  return true;
}
