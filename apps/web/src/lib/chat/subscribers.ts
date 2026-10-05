/**
 * Chat module: a mission filed from a conversation hears back in it.
 *
 * `task.completed` reported by a worker → post "plan ready" into the
 * originating conversation. Lazy and fire-and-forget, as it always was: the
 * chat module is never on the worker PATCH's critical path.
 */
import { subscriber, type AnySubscriber } from '@/lib/core-events';

export const chatSubscribers: readonly AnySubscriber[] = [
  subscriber('chat', 'task.completed', 'chat-task-completed', e => {
    if (e.via !== 'worker') return;
    const { taskId } = e;
    void import('@/lib/chat/mission-events')
      .then(m => m.postTaskCompletedEvent({ taskId }))
      .catch(() => {});
  }),
];
