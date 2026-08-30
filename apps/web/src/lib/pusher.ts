import Pusher from 'pusher';

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

  pusher = new Pusher({
    appId,
    key,
    secret,
    cluster,
    useTLS: true,
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

// Optional channel prefix for environment isolation (e.g. "preview-")
const CHANNEL_PREFIX = process.env.PUSHER_CHANNEL_PREFIX || '';

// Channel names
export const channels = {
  workspace: (id: string) => `${CHANNEL_PREFIX}workspace-${id}`,
  task: (id: string) => `${CHANNEL_PREFIX}task-${id}`,
  worker: (id: string) => `${CHANNEL_PREFIX}worker-${id}`,
  mission: (id: string) => `${CHANNEL_PREFIX}mission-${id}`,
} as const;

// Event names
export const events = {
  TASK_CREATED: 'task:created',
  TASK_CLAIMED: 'task:claimed',
  TASK_COMPLETED: 'task:completed',
  TASK_FAILED: 'task:failed',
  // Task assigned to specific runner
  TASK_ASSIGNED: 'task:assigned',
  WORKER_STARTED: 'worker:started',
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
} as const;
