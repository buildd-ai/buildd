import Pusher from 'pusher';
import { CHAT_PUSHER_EVENTS, conversationChannelName } from '@buildd/shared';

// Server-side Pusher client (optional)
let pusher: Pusher | null = null;

// Inject a mock client in tests — avoids relying on mock.module('pusher') for
// transitive imports, which breaks when the real pusher package is installed.
export function _resetPusher(client: Pusher | null = null): void {
  pusher = client;
}

function getPusher(): Pusher | null {
  if (pusher) return pusher;

  const appId = process.env.PUSHER_APP_ID;
  const key = process.env.PUSHER_KEY;
  const secret = process.env.PUSHER_SECRET;
  const cluster = process.env.PUSHER_CLUSTER;

  if (!appId || !key || !secret || !cluster) {
    return null; // Pusher not configured
  }

  // PUSHER_HOST points at a self-hosted Pusher-protocol server (e.g. soketi in
  // scripts/demo). Unset = Pusher's hosted cluster, exactly as before.
  const host = process.env.PUSHER_HOST;
  pusher = new Pusher({
    appId,
    key,
    secret,
    cluster,
    useTLS: host ? process.env.PUSHER_USE_TLS === 'true' : true,
    ...(host ? { host, port: process.env.PUSHER_PORT } : {}),
  });

  return pusher;
}

// Pusher enforces a 10 KB per-event payload limit.
// Warn at 8 KB (2 KB headroom for envelope overhead).
// Hard-cap at 10240 bytes — skip the trigger entirely to avoid a silent 413.
const PUSHER_PAYLOAD_WARN_BYTES = 8192;
const PUSHER_PAYLOAD_HARD_CAP_BYTES = 10240;

/**
 * Trigger a Pusher event (no-op if Pusher not configured).
 * Enforces a hard 10 KB size cap — payloads over the cap are dropped with a
 * loud error log rather than sent (which would return a silent 413). Callers
 * must use thin event payloads (IDs + timestamps only) and let clients refetch
 * large row data over HTTP.
 */
export async function triggerEvent(
  channel: string,
  event: string,
  data: unknown
): Promise<void> {
  const client = getPusher();
  if (!client) return; // Silent no-op

  const serialized = JSON.stringify(data);

  if (serialized.length > PUSHER_PAYLOAD_HARD_CAP_BYTES) {
    console.error(
      `[Pusher] payload for event "${event}" on channel "${channel}" exceeds hard cap ` +
      `(${serialized.length} bytes > ${PUSHER_PAYLOAD_HARD_CAP_BYTES} byte limit) — ` +
      `event dropped. Slim the payload to IDs and timestamps only.`
    );
    return;
  }

  if (serialized.length > PUSHER_PAYLOAD_WARN_BYTES) {
    console.warn(
      `[Pusher] oversized payload for event "${event}" on channel "${channel}": ` +
      `${serialized.length} bytes (warn limit ${PUSHER_PAYLOAD_WARN_BYTES})`
    );
  }

  try {
    await client.trigger(channel, event, data);
  } catch (error) {
    console.error('Pusher trigger failed:', error);
  }
}

/**
 * triggerEvent, but says what happened, for callers whose retry depends on it
 * (the dispatch consumer). `unconfigured` is not a failure: with no Pusher
 * there is no live listener to miss the event.
 */
export async function triggerEventChecked(
  channel: string,
  event: string,
  data: unknown,
): Promise<'sent' | 'unconfigured' | 'failed'> {
  const client = getPusher();
  if (!client) return 'unconfigured';
  if (JSON.stringify(data).length > PUSHER_PAYLOAD_HARD_CAP_BYTES) return 'failed';
  try {
    await client.trigger(channel, event, data);
    return 'sent';
  } catch (error) {
    console.error('Pusher trigger failed:', error);
    return 'failed';
  }
}

// ── Worker progress dedup ──────────────────────────────────────────────────
//
// A runner's 30-second sync cycle PATCHes the worker endpoint even when
// nothing visible has changed (no new currentAction, no status transition,
// no taskProgress). Each PATCH fires 2 Pusher messages (worker + workspace
// channel) — enough to exhaust the daily message quota with a modest fleet.
//
// `hasVisibleWorkerChange` returns true only when the event carries something
// the dashboard or other subscribers would act on. Callers MUST still fire
// for terminal events (WORKER_COMPLETED, WORKER_FAILED) unconditionally; this
// guard applies only to WORKER_PROGRESS.

export interface WorkerProgressSnapshot {
  status: string | null | undefined;
  currentAction: string | null | undefined;
}

/**
 * Should a WORKER_PROGRESS Pusher event be published for this sync tick?
 *
 * Returns true when:
 * - The worker status changed (e.g. waiting_input → running)
 * - The currentAction text changed (visible progress line)
 * - Transient taskProgress data is present (sub-agent steps, not persisted)
 *
 * Returns false for bare heartbeat acks / instruction delivery acks where
 * nothing the subscriber would render has changed.
 */
export function hasVisibleWorkerChange(
  prev: WorkerProgressSnapshot,
  next: WorkerProgressSnapshot,
  taskProgress: unknown[] | null | undefined,
): boolean {
  // Status transition is always visible.
  if (prev.status !== next.status) return true;

  // New currentAction text: the runner reports what it's doing.
  // Treat both null and undefined as "no action" — so
  // null→undefined is NOT a change.
  const prevAction = prev.currentAction ?? null;
  const nextAction = next.currentAction ?? null;
  if (prevAction !== nextAction) return true;

  // Transient sub-agent progress that must travel over Pusher
  // (not persisted in the DB, so polling won't pick it up).
  if (taskProgress && Array.isArray(taskProgress) && taskProgress.length > 0) return true;

  return false;
}

// Optional channel prefix for environment isolation (e.g. "preview-")
const CHANNEL_PREFIX = process.env.PUSHER_CHANNEL_PREFIX || '';

// Channel names
export const channels = {
  workspace: (id: string) => `${CHANNEL_PREFIX}workspace-${id}`,
  task: (id: string) => `${CHANNEL_PREFIX}task-${id}`,
  worker: (id: string) => `${CHANNEL_PREFIX}worker-${id}`,
  mission: (id: string) => `${CHANNEL_PREFIX}mission-${id}`,
  // One runner account's runners: a nudge to beat now (slots set on the dashboard). No data rides on it.
  runner: (accountId: string) => `${CHANNEL_PREFIX}runner-${accountId}`,
  // Agent chat: pings only, never message text (see @buildd/shared chat.ts).
  conversation: (id: string) => `${CHANNEL_PREFIX}${conversationChannelName(id)}`,
} as const;

// Event names
export const events = {
  CONVERSATION_UPDATED: CHAT_PUSHER_EVENTS.CONVERSATION_UPDATED,
  TASK_CREATED: 'task:created',
  TASK_CLAIMED: 'task:claimed',
  // Task assigned to specific runner
  TASK_ASSIGNED: 'task:assigned',
  WORKER_PROGRESS: 'worker:progress',
  WORKER_COMPLETED: 'worker:completed',
  WORKER_FAILED: 'worker:failed',
  // Commands sent to runner
  WORKER_COMMAND: 'worker:command',
  // Schedule events
  SCHEDULE_TRIGGERED: 'schedule:triggered',
  SCHEDULE_DEFERRED: 'schedule:deferred',
  // Task dependency events
  CHILDREN_COMPLETED: 'task:children_completed',
  TASK_UNBLOCKED: 'task:unblocked',
  TASK_DEPENDENCY_FAILED: 'task:dependency_failed',
  // Mission loop events
  MISSION_CYCLE_STARTED: 'mission:cycle_started',
  MISSION_LOOP_COMPLETED: 'mission:loop_completed',
  MISSION_LOOP_STALLED: 'mission:loop_stalled',
  // Every completion decision — allowed or refused — with the predicate inputs
  // that produced it, so "why did/didn't this mission complete" is diagnosable.
  MISSION_COMPLETION_DECISION: 'mission:completion_decision',
  // Generic task status update (non-claiming — dashboard only, does NOT trigger runner re-claim)
  TASK_UPDATED: 'task:updated',
  // Failure loop prevention
  TASK_RETRY_CAP: 'task:retry_cap',
  // Mission reopened (completed mission got new open work)
  MISSION_REOPENED: 'mission:reopened',
  // Mission feed events
  MISSION_NOTE_POSTED: 'mission:note_posted',
  // Connector auth expiry (mid-task 401 circuit breaker)
  WORKER_CONNECTOR_AUTH_EXPIRED: 'worker:connector-auth-expired',
  // GitHub App permission gap (mid-task 403 "Resource not accessible by integration")
  WORKER_CONNECTOR_PERMISSION_INSUFFICIENT: 'worker:connector-permission-insufficient',
  // Release row state changed (dispatched → deploying → healthy / failed)
  RELEASE_UPDATED: 'release:updated',
  // A runner's slots were set on the dashboard: heartbeat now to pick the value up.
  RUNNER_SLOTS: 'runner:slots',
} as const;
