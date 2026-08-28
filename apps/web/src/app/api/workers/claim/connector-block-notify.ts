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
// could expire and sit silent indefinitely. The cron scans credentials directly
// and calls the function below, so the team hears about it before work stalls.

const CONNECTIONS_PATH = '/app/connections';

export interface ConnectorExpiryContext {
  teamId: string;
  connectorName: string;
  /** false → already expired/revoked; true → still valid, inside the warning window. */
  expiringSoon: boolean;
  tokenExpiresAt: Date | null;
}

export function buildConnectorExpiryMessage(ctx: ConnectorExpiryContext, now: Date = new Date()): string {
  const fixUrl = `${APP_BASE_URL}${CONNECTIONS_PATH}`;
  if (!ctx.expiringSoon) {
    return (
      `Connection "${ctx.connectorName}" has expired — tasks that need it will be blocked. / ` +
      `Fix: ${fixUrl}`
    );
  }
  const hours = ctx.tokenExpiresAt
    ? Math.max(1, Math.round((ctx.tokenExpiresAt.getTime() - now.getTime()) / 3_600_000))
    : null;
  return (
    `Connection "${ctx.connectorName}" expires ${hours != null ? `in ~${hours}h` : 'soon'} — ` +
    `reconnect now to avoid blocked tasks. / Fix: ${fixUrl}`
  );
}

/**
 * Alert a team that a connector credential has expired (or is about to).
 * Dedup is the caller's job — stamp `secrets.expiryNotifiedAt` when this returns true.
 */
export async function notifyConnectorExpiry(ctx: ConnectorExpiryContext): Promise<boolean> {
  const payload: NotifyPayload = {
    title: ctx.expiringSoon
      ? '[buildd] Connection expiring soon'
      : '[buildd] Connection expired',
    message: buildConnectorExpiryMessage(ctx),
    url: `${APP_BASE_URL}${CONNECTIONS_PATH}`,
    urlTitle: 'Reconnect',
    priority: ctx.expiringSoon ? -1 : 0,
  };

  await notifyTeam(ctx.teamId, 'connectorBlocked', payload);
  return true;
}
