import Pusher from 'pusher';

// Server-side Pusher client (optional)
let pusher: Pusher | null = null;

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

/**
 * Trigger a Pusher event (no-op if Pusher not configured)
 */
export async function triggerEvent(
  channel: string,
  event: string,
  data: unknown
): Promise<void> {
  const client = getPusher();
  if (!client) return; // Silent no-op

  try {
    await client.trigger(channel, event, data);
  } catch (error) {
    console.error('Pusher trigger failed:', error);
  }
}

// Channel names
export const channels = {
  workspace: (id: string) => `workspace-${id}`,
  task: (id: string) => `task-${id}`,
  worker: (id: string) => `worker-${id}`,
} as const;

// Event names
export const events = {
  TASK_CREATED: 'task:created',
  TASK_CLAIMED: 'task:claimed',
  TASK_COMPLETED: 'task:completed',
  TASK_FAILED: 'task:failed',
  // Task assigned to specific local-ui
  TASK_ASSIGNED: 'task:assigned',
  WORKER_STARTED: 'worker:started',
  WORKER_PROGRESS: 'worker:progress',
  WORKER_COMPLETED: 'worker:completed',
  WORKER_FAILED: 'worker:failed',
  // Commands sent to local-ui
  WORKER_COMMAND: 'worker:command',
  // Schedule events
  SCHEDULE_TRIGGERED: 'schedule:triggered',
} as const;
