/**
 * Mid-turn steering (off unless `createChatTurn({ steering })` is set).
 *
 * AI SDK v7 cannot inject a user message into a running model step, so a
 * steer is queued against the conversation and injected at the next step
 * boundary (`prepareStep`). If the turn ends first, it comes back to the
 * client as a `deferred` `data-steer` part and the client sends it as the next
 * user message. At most `maxPerTurn` (default 3) steers apply to one turn; the
 * rest are deferred. A steer never extends the turn's deadline.
 *
 * The queue is an adapter: a serverless app's steer request and its running
 * turn usually land on different instances, so production needs a shared
 * queue (a KV list, a DB table). `memorySteerQueue()` only works within one
 * process (tests, a long-running server).
 */

export interface QueuedSteer {
  id: string;
  text: string;
  /** Who sent it. The runner only applies steers from the person the turn is for. */
  userId: string;
  /** ISO 8601. */
  at: string;
}

export interface SteerQueue {
  push(conversationId: string, steer: QueuedSteer): Promise<void> | void;
  /** Remove and return everything queued for the conversation, oldest first. */
  drain(conversationId: string): Promise<QueuedSteer[]> | QueuedSteer[];
}

export function memorySteerQueue(): SteerQueue & { readonly size: (conversationId: string) => number } {
  const q = new Map<string, QueuedSteer[]>();
  return {
    push(conversationId, steer) {
      q.set(conversationId, [...(q.get(conversationId) ?? []), steer]);
    },
    drain(conversationId) {
      const out = q.get(conversationId) ?? [];
      q.delete(conversationId);
      return out;
    },
    size: conversationId => q.get(conversationId)?.length ?? 0,
  };
}

export const MAX_STEER_TEXT = 2_000;
export const DEFAULT_MAX_STEERS_PER_TURN = 3;

/** The model-facing wording of an injected steer. */
export function steerInstruction(text: string): string {
  return `[The person added this while you were working. Take it into account from here on.]\n${text}`;
}
