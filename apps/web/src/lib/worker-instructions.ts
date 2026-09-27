/**
 * Human→agent instruction plumbing shared by every surface that sends one:
 * `POST /api/workers/[id]/instruct`, `POST /api/workers/[id]/cmd` (action
 * `message`) and the delivery/confirmation half in `PATCH /api/workers/[id]`.
 *
 * The rules encoded here exist because each surface used to invent its own:
 *
 *  - `deliveryState: 'delivered'` was written at send time for urgent messages.
 *    Nothing confirmed the message ever reached an agent, so the UI and
 *    `get_task_messages` reported deliveries that never happened. Only a
 *    consumer's acknowledgement may set 'delivered' now.
 *  - `pendingInstructions` is a single text column. Writing a second instruction
 *    used to overwrite an undelivered first one, so the queue appends instead.
 *  - `/cmd { action: 'message' }` wrote no history at all, so human input was
 *    invisible to both the task UI and `get_task_messages`.
 */

/** Entry shape stored in `workers.instructionHistory`. */
export type InstructionHistoryEntry = {
  type: 'instruction' | 'response';
  /** Omitted for sensitive workspaces — the {type, ts} envelope is kept only. */
  message?: string;
  timestamp: number;
  deliveryState?: 'pending' | 'delivered';
  /**
   * `workers.turns` at send time — the baseline the Steer canvas measures
   * "read at turn N" against (see `messageDeliveryStatus`). Absent on entries
   * written before this field existed; those can reach 'delivered' but never
   * 'read'.
   */
  turnAtSend?: number;
};

/** Cap on `workers.instructionHistory` length (JSONB bloat guard). */
export const INSTRUCTION_HISTORY_CAP = 30;

/**
 * Worker statuses for which the check-in route (`PATCH /api/workers/[id]`)
 * refuses every non-reactivating update with a 409. A queued instruction can
 * never be handed to a worker in one of these states, because the check-in that
 * would collect it is rejected ~1700 lines before the delivery code runs.
 *
 * Kept in sync with `TERMINAL_WORKER_STATUSES` in the check-in route.
 */
export const UNREACHABLE_WORKER_STATUSES = ['completed', 'failed', 'error'] as const;

export function isUnreachableWorkerStatus(status: string | null | undefined): boolean {
  return !!status && (UNREACHABLE_WORKER_STATUSES as readonly string[]).includes(status);
}

/**
 * Append a human instruction to `workers.instructionHistory`, capped and with
 * the message text stripped for sensitive workspaces.
 *
 * `deliveryState` is 'pending' whenever a consumer can still confirm delivery.
 * It is 'delivered' only on the legacy path, where the message goes out over
 * Pusher to a runner that does not speak the acknowledgement protocol and can
 * therefore never confirm anything.
 */
export function appendInstructionHistory(
  current: unknown,
  opts: { message: string; isSensitive: boolean; deliveryState: 'pending' | 'delivered'; turnAtSend?: number },
): InstructionHistoryEntry[] {
  const history: InstructionHistoryEntry[] = Array.isArray(current)
    ? (current as InstructionHistoryEntry[])
    : [];

  const turn = opts.turnAtSend != null ? { turnAtSend: opts.turnAtSend } : {};
  const entry: InstructionHistoryEntry = opts.isSensitive
    ? { type: 'instruction', timestamp: Date.now(), deliveryState: opts.deliveryState, ...turn }
    : { type: 'instruction', message: opts.message, timestamp: Date.now(), deliveryState: opts.deliveryState, ...turn };

  const updated = [...history, entry];
  if (updated.length > INSTRUCTION_HISTORY_CAP) {
    updated.splice(0, updated.length - INSTRUCTION_HISTORY_CAP);
  }
  return updated;
}

/**
 * Add a message to the pending-instruction queue. Appends rather than replaces:
 * a second instruction sent before the first was delivered must not silently
 * destroy the first one's text.
 */
export function enqueuePendingInstruction(current: string | null | undefined, message: string): string {
  return current ? `${current}\n\n${message}` : message;
}

/**
 * Mark instruction-history entries as delivered after a consumer confirmed that
 * human text reached the agent session.
 *
 * `deliveredText` is the exact text the consumer injected. Every 'pending'
 * instruction entry whose message is contained in it is confirmed — the served
 * payload is the concatenation of the queued instructions, so one confirmation
 * can settle several entries. Sensitive workspaces store no message text, so
 * their entries are settled by position (all pending ones) instead.
 */
export function markInstructionsDelivered(
  current: unknown,
  deliveredText: string,
): InstructionHistoryEntry[] {
  const history: InstructionHistoryEntry[] = Array.isArray(current)
    ? (current as InstructionHistoryEntry[])
    : [];

  return history.map((entry) => {
    if (entry.type !== 'instruction' || entry.deliveryState !== 'pending') return entry;
    const confirmed = entry.message === undefined
      ? true // sensitive workspace: no text to match against
      : deliveredText.includes(entry.message);
    return confirmed ? { ...entry, deliveryState: 'delivered' as const } : entry;
  });
}

/**
 * One instruction's status for the Steer canvas: 'sent' (queued, not yet
 * confirmed), 'delivered' (a consumer confirmed the agent received it, but it
 * hasn't taken a turn since), or 'read at turn N' — the agent has since taken
 * at least one more turn, so the instruction was in its context for that turn.
 *
 * N is fixed at `turnAtSend + 1`, the first turn that could have read it —
 * not the worker's live, ever-climbing turn count, so the label doesn't keep
 * changing after the fact. An entry written before `turnAtSend` existed, or a
 * worker with no known turn count, can reach 'delivered' but never 'read'.
 */
export type MessageDeliveryStatus =
  | { state: 'sent' }
  | { state: 'delivered' }
  | { state: 'read'; turn: number };

export function messageDeliveryStatus(
  entry: Pick<InstructionHistoryEntry, 'deliveryState' | 'turnAtSend'>,
  currentTurns: number | null,
): MessageDeliveryStatus {
  if (entry.deliveryState !== 'delivered') return { state: 'sent' };
  if (entry.turnAtSend == null || currentTurns == null || currentTurns <= entry.turnAtSend) return { state: 'delivered' };
  return { state: 'read', turn: entry.turnAtSend + 1 };
}
