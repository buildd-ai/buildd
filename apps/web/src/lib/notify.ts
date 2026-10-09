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
 * Only platform-health alerts that are about no single tenant use the
 * operator sender (`notifyOperator` in ./pushover); every call site of it is
 * pinned in notify-routing-invariant.test.ts.
 */

import { db } from '@buildd/core/db';
import { secrets, notificationPreferences, workspaces, missions, tasks } from '@buildd/core/db/schema';
import { and, eq, isNull } from 'drizzle-orm';
import { decrypt, encrypt } from '@buildd/core/secrets';
import {
  resolveNotifyPlan,
  DEFAULT_NOTIFICATION_PREFERENCES,
  type NotifyEvent,
  type TeamAlertEvent,
  type TeamChannel,
  type PushoverChannel,
} from './notify-rules';

// Pure routing rules live in ./notify-rules (no DB) for unit-testability.
export {
  resolveNotifyPlan,
  isCredentialExpiredError,
  DEFAULT_NOTIFICATION_PREFERENCES,
} from './notify-rules';
export type { NotifyEvent, TeamAlertEvent, TeamChannel, PushoverChannel, NotifyPlan } from './notify-rules';

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
      // Never a person's own row (pushover_personal): team alerts use the team channel only.
      isNull(secrets.userId),
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
 * Pushover is stored as an encrypted JSON blob `{ appToken, userKey }` (per the
 * multi-field-credential pattern in docs/credentials-architecture.md). Both
 * fields are required — a blob missing either is treated as not configured.
 */
function decodePushoverBlob(value: string | null): PushoverChannel | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<PushoverChannel>;
    if (parsed && typeof parsed.appToken === 'string' && parsed.appToken && typeof parsed.userKey === 'string' && parsed.userKey) {
      return { appToken: parsed.appToken, userKey: parsed.userKey };
    }
  } catch {
    // Malformed blob — not a usable channel.
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
    columns: { taskClaimed: true, taskCompleted: true, taskFailed: true, credentialExpired: true, connectorBlocked: true, artifactReady: true },
  });
  if (!row) return { ...DEFAULT_NOTIFICATION_PREFERENCES };
  return {
    taskClaimed: row.taskClaimed,
    taskCompleted: row.taskCompleted,
    taskFailed: row.taskFailed,
    credentialExpired: row.credentialExpired,
    connectorBlocked: row.connectorBlocked,
    artifactReady: row.artifactReady ?? DEFAULT_NOTIFICATION_PREFERENCES.artifactReady,
  };
}

const PUSHOVER_API = 'https://api.pushover.net/1/messages.json';

/**
 * Send via the team's OWN Pushover app + user key. buildd's env PUSHOVER_TOKEN is
 * deliberately NOT used here — that app belongs to the platform and must not
 * deliver another tenant's alerts. resolveNotifyPlan guarantees both fields are
 * present before this is called.
 */
async function sendPushover(channel: PushoverChannel, event: TeamAlertEvent, payload: NotifyPayload): Promise<void> {
  try {
    await fetch(PUSHOVER_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: channel.appToken,
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
async function sendWebhook(url: string, event: TeamAlertEvent, payload: NotifyPayload): Promise<void> {
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
export async function notifyTeam(teamId: string, event: TeamAlertEvent, payload: NotifyPayload): Promise<void> {
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

/** What a tenant alert is about. The first field present decides the owning team. */
export interface AlertSubject {
  teamId?: string | null;
  workspaceId?: string | null;
  missionId?: string | null;
  taskId?: string | null;
  /**
   * A PR escalation: with `needsAttention`, the escalation gate's verdict for
   * this PR decides whether it pages (lib/escalation-page.ts). Needs the
   * workspace, given directly or through the task.
   */
  prNumber?: number | null;
}

async function taskWorkspace(taskId: string): Promise<string | null> {
  const t = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId), columns: { workspaceId: true } });
  return t?.workspaceId ?? null;
}

async function resolveSubjectTeam(subject: AlertSubject): Promise<string | null> {
  if (subject.teamId) return subject.teamId;
  if (subject.workspaceId) {
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, subject.workspaceId), columns: { teamId: true } });
    return ws?.teamId ?? null;
  }
  if (subject.missionId) {
    const m = await db.query.missions.findFirst({ where: eq(missions.id, subject.missionId), columns: { teamId: true } });
    return m?.teamId ?? null;
  }
  if (subject.taskId) {
    const t = await db.query.tasks.findFirst({ where: eq(tasks.id, subject.taskId), columns: { workspaceId: true } });
    return t?.workspaceId ? resolveSubjectTeam({ workspaceId: t.workspaceId }) : null;
  }
  return null;
}

/**
 * Notify the team that owns a workspace, mission or task, on that team's own
 * channel. An owner that cannot be resolved sends nothing: there is no
 * fallback to the platform's app. Fire-and-forget, never throws.
 */
export async function notifyTeamOf(subject: AlertSubject, event: TeamAlertEvent, payload: NotifyPayload): Promise<void> {
  try {
    if (event === 'needsAttention' && subject.prNumber != null) {
      const workspaceId = subject.workspaceId ?? (subject.taskId ? await taskWorkspace(subject.taskId) : null);
      if (workspaceId) {
        const { mayPageEscalation } = await import('./escalation-page');
        if (!(await mayPageEscalation({ workspaceId, prNumber: subject.prNumber }))) return;
      }
    }
    const teamId = await resolveSubjectTeam(subject);
    if (!teamId) return;
    await notifyTeam(teamId, event, payload);
  } catch (err) {
    console.error('[notify] notifyTeamOf failed', err instanceof Error ? err.message : 'unknown');
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
 * Save a team's Pushover channel: their OWN application token AND their user/group
 * key — both required (we never send via buildd's app). Stored as a JSON blob so
 * both fields live in one encrypted row.
 */
export async function setTeamPushover(teamId: string, appToken: string, userKey: string): Promise<void> {
  const blob: PushoverChannel = { appToken: appToken.trim(), userKey: userKey.trim() };
  if (!blob.appToken || !blob.userKey) {
    throw new Error('Pushover requires both an app token and a user/group key');
  }
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

/** Which channels are configured for a team (booleans only — never the values). */
export async function getTeamChannelStatus(teamId: string): Promise<{ pushover: boolean; webhook: boolean }> {
  const channel = await getTeamChannel(teamId);
  return {
    // getTeamChannel only returns `pushover` when BOTH app token + user key are set.
    pushover: !!channel.pushover,
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
      connectorBlocked: merged.connectorBlocked,
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
        connectorBlocked: merged.connectorBlocked,
        updatedAt: now,
      },
    });
  return merged;
}
