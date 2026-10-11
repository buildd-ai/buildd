import { triggerEvent, channels, events } from '@/lib/pusher';
import type { QueuedInstruction } from '@/lib/worker-instructions';

/**
 * Wake an instruction's consumer after `queueInstruction`. Server-only (kept
 * out of worker-instructions.ts, which client components import).
 *
 * A queued message gets a text-free `deliver_pending`, at every priority, so
 * delivery never waits for the runner to happen to sync: a worker inside one
 * long silent tool call is not dirty and would not collect. Text rides Pusher
 * only where the queue cannot carry it (`pusherText`).
 */
export async function pushInstructionDelivery(
  workerId: string,
  queued: Pick<QueuedInstruction, 'queueable' | 'pusherText'>,
): Promise<void> {
  if (queued.pusherText !== null) {
    await triggerEvent(
      channels.worker(workerId),
      events.WORKER_COMMAND,
      { action: 'message', text: queued.pusherText, timestamp: Date.now() },
    );
  } else if (queued.queueable) {
    await triggerEvent(
      channels.worker(workerId),
      events.WORKER_COMMAND,
      { action: 'deliver_pending', timestamp: Date.now() },
    );
  }
}
