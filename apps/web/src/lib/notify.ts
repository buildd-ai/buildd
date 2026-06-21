/**
 * Per-team notification routing.
 *
 * Each team gets its OWN alert channel — alerts route to the team that owns the
 * task, never to one hardcoded global account. The channel lives in the shared
 * `secrets` table (purpose 'pushover' / 'notify_webhook'), team-scoped exactly
 * like the agent-backend credentials (see docs/credentials-architecture.md), and
 * which events fire is controlled per-team in `notification_preferences`.
 *
 * No channel configured OR the event disabled → no-op (no cross-tenant spam).
 *
 * For platform/ops alerts that are NOT tenant-specific (project health watcher,
 * large-payload guard, budget cron) keep using the env-based `notify()` in
 * ./pushover — do not route those through here.
 */

import { db } from '@buildd/core/db';
import { secrets, notificationPreferences } from '@buildd/core/db/schema';
import { and, eq, isNull } from 'drizzle-orm';
import { decrypt, encrypt } from '@buildd/core/secrets';
import {
  resolveNotifyPlan,
  DEFAULT_NOTIFICATION_PREFERENCES,
  type NotifyEvent,
  type TeamChannel,
  type PushoverChannel,
} from './notify-rules';

// Pure routing rules live in ./notify-rules (no DB) for unit-testability.
export {
  resolveNotifyPlan,
  isCredentialExpiredError,
  DEFAULT_NOTIFICATION_PREFERENCES,
} from './notify-rules';
export type { NotifyEvent, TeamChannel, PushoverChannel, NotifyPlan } from './notify-rules';

export interface NotifyPayload {
  title: string;
  message: string;
  url?: string;
  urlTitle?: string;
  /** Pushover priority. Defaults: -1 (silent) for routine events, 0 for failures. */
  priority?: -2 | -1 | 0 | 1;
}

/**
 * Resolve the team-wide channel secrets (pushover key + webhook URL).
 *
 * Channels are a TEAM property, so we read the team-wide rows
 * (accountId/workspaceId NULL) — the same "one secret covers the team" model the
 * agent-backend credentials use. Values are decrypted here and never logged.
 */
export async function getTeamChannel(teamId: string): Promise<TeamChannel> {
  const rows = await db.query.secrets.findMany({
    where: and(
      eq(secrets.teamId, teamId),
      isNull(secrets.accountId),
      isNull(secrets.workspaceId),
    ),
    columns: { purpose: true, encryptedValue: true },
  });

  const channel: TeamChannel = {};
  for (const row of rows) {
    if (row.purpose === 'pushover') {
      const decoded = decodePushoverBlob(safeDecrypt(row.encryptedValue));
      if (decoded) channel.pushover = decoded;
    } else if (row.purpose === 'notify_webhook') {
      channel.webhookUrl = safeDecrypt(row.encryptedValue);
    }
  }
  return channel;
}

/**
 * Pushover is stored as an encrypted JSON blob `{ userKey, appToken? }` (per the
 * multi-field-credential pattern in docs/credentials-architecture.md). Legacy
 * rows that stored a bare user-key string are still accepted.
 */
function decodePushoverBlob(value: string | null): PushoverChannel | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<PushoverChannel>;
    if (parsed && typeof parsed.userKey === 'string' && parsed.userKey) {
      return { userKey: parsed.userKey, appToken: typeof parsed.appToken === 'string' ? parsed.appToken : null };
    }
  } catch {
    // Not JSON — treat the whole string as a bare user key (back-compat).
    return { userKey: value, appToken: null };
  }
  return null;
}

function safeDecrypt(value: string): string | null {
  try {
    return decrypt(value);
  } catch {
    // Never surface secret material or crypto internals in logs.
    console.error('[notify] failed to decrypt a channel secret');
    return null;
  }
}

/** Load a team's event preferences, falling back to defaults when no row exists. */
export async function getTeamPreferences(teamId: string): Promise<Record<NotifyEvent, boolean>> {
  const row = await db.query.notificationPreferences.findFirst({
    where: eq(notificationPreferences.teamId, teamId),
    columns: { taskClaimed: true, taskCompleted: true, taskFailed: true, credentialExpired: true },
  });
  if (!row) return { ...DEFAULT_NOTIFICATION_PREFERENCES };
  return {
    taskClaimed: row.taskClaimed,
    taskCompleted: row.taskCompleted,
    taskFailed: row.taskFailed,
    credentialExpired: row.credentialExpired,
  };
}

const PUSHOVER_API = 'https://api.pushover.net/1/messages.json';

/**
 * Send via the team's Pushover channel. The user/group key always comes from the
 * team; the app token is the team's own if they provided one, otherwise buildd's
 * shared app token (env PUSHOVER_TOKEN — already set in prod).
 */
async function sendPushover(channel: PushoverChannel, event: NotifyEvent, payload: NotifyPayload): Promise<void> {
  const token = channel.appToken || process.env.PUSHOVER_TOKEN;
  if (!token) return; // no team token and platform has none — nothing we can send with
  try {
    await fetch(PUSHOVER_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token,
        user: channel.userKey,
        title: payload.title,
        message: payload.message,
        priority: payload.priority ?? -1,
        ...(payload.url ? { url: payload.url, url_title: payload.urlTitle } : {}),
      }),
    });
  } catch {
    // Non-fatal: notifications must never block the request path.
  }
}

/** POST the alert as JSON to the team's webhook. */
async function sendWebhook(url: string, event: NotifyEvent, payload: NotifyPayload): Promise<void> {
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event,
        title: payload.title,
        message: payload.message,
        ...(payload.url ? { url: payload.url } : {}),
      }),
    });
  } catch {
    // Non-fatal.
  }
}

/**
 * Notify a team about an event on THEIR channel.
 *
 * No-ops when the team has no channel configured or the event is disabled in
 * their preferences — so teams that never set up notifications get nothing, and
 * a team's alerts never leak to another team. Fire-and-forget: failures are
 * swallowed and never block the caller.
 */
export async function notifyTeam(teamId: string, event: NotifyEvent, payload: NotifyPayload): Promise<void> {
  if (!teamId) return;
  try {
    const [channel, prefs] = await Promise.all([getTeamChannel(teamId), getTeamPreferences(teamId)]);
    const plan = resolveNotifyPlan(event, channel, prefs);
    if (plan.noop) return;

    const sends: Promise<void>[] = [];
    if (plan.pushover && channel.pushover) sends.push(sendPushover(channel.pushover, event, payload));
    if (plan.webhook && channel.webhookUrl) sends.push(sendWebhook(channel.webhookUrl, event, payload));
    await Promise.all(sends);
  } catch (err) {
    console.error('[notify] notifyTeam failed', err instanceof Error ? err.message : 'unknown');
  }
}

// ── Channel + preference management (used by the settings API/UI) ──────────────

export type ChannelPurpose = 'pushover' | 'notify_webhook';

/**
 * Store (replace) a team-wide channel secret. There is one Pushover credential
 * and one webhook URL per team, so any existing row of the same purpose at the
 * team scope is removed first — mirrors storeCodexCredential's one-per-scope
 * semantics. `value` is the raw plaintext (a webhook URL, or the encoded
 * Pushover blob); use setTeamPushover / setTeamWebhook rather than calling this.
 */
async function setTeamChannel(teamId: string, purpose: ChannelPurpose, value: string): Promise<void> {
  const now = new Date();
  await db.delete(secrets).where(and(
    eq(secrets.teamId, teamId),
    eq(secrets.purpose, purpose),
    isNull(secrets.accountId),
    isNull(secrets.workspaceId),
  ));
  await db.insert(secrets).values({
    teamId,
    accountId: null,
    workspaceId: null,
    purpose,
    encryptedValue: encrypt(value),
    createdAt: now,
    updatedAt: now,
  });
}

/**
 * Save a team's Pushover channel: their user/group key (required) and an OPTIONAL
 * own app token. Stored as a JSON blob so both fields live in one encrypted row.
 * When no app token is given, buildd sends via env PUSHOVER_TOKEN.
 */
export async function setTeamPushover(teamId: string, userKey: string, appToken?: string | null): Promise<void> {
  const blob: PushoverChannel = { userKey, appToken: appToken && appToken.trim() ? appToken.trim() : null };
  await setTeamChannel(teamId, 'pushover', JSON.stringify(blob));
}

/** Save a team's webhook URL. */
export async function setTeamWebhook(teamId: string, url: string): Promise<void> {
  await setTeamChannel(teamId, 'notify_webhook', url);
}

/** Remove a team-wide channel secret. */
export async function deleteTeamChannel(teamId: string, purpose: ChannelPurpose): Promise<void> {
  await db.delete(secrets).where(and(
    eq(secrets.teamId, teamId),
    eq(secrets.purpose, purpose),
    isNull(secrets.accountId),
    isNull(secrets.workspaceId),
  ));
}

/**
 * Which channels are configured for a team (no secret values). `pushoverAppToken`
 * reflects whether the team supplied their OWN app token vs. relying on buildd's.
 */
export async function getTeamChannelStatus(teamId: string): Promise<{ pushover: boolean; pushoverOwnAppToken: boolean; webhook: boolean }> {
  const channel = await getTeamChannel(teamId);
  return {
    pushover: !!channel.pushover?.userKey,
    pushoverOwnAppToken: !!channel.pushover?.appToken,
    webhook: !!channel.webhookUrl,
  };
}

/** Upsert a team's event preferences. Only provided keys are changed. */
export async function setTeamPreferences(
  teamId: string,
  prefs: Partial<Record<NotifyEvent, boolean>>,
): Promise<Record<NotifyEvent, boolean>> {
  const now = new Date();
  const existing = await getTeamPreferences(teamId);
  const merged = { ...existing, ...prefs };
  await db
    .insert(notificationPreferences)
    .values({
      teamId,
      taskClaimed: merged.taskClaimed,
      taskCompleted: merged.taskCompleted,
      taskFailed: merged.taskFailed,
      credentialExpired: merged.credentialExpired,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: notificationPreferences.teamId,
      set: {
        taskClaimed: merged.taskClaimed,
        taskCompleted: merged.taskCompleted,
        taskFailed: merged.taskFailed,
        credentialExpired: merged.credentialExpired,
        updatedAt: now,
      },
    });
  return merged;
}
