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
 *  - `/cmd { action: 'message' }` wrote no history at all, then only history:
 *    a missed Pusher event lost the message while history said pending forever.
 *    It now queues exactly like /instruct (`queueInstruction`).
 *
 * One queue, explicit ids, four states (knowledge-base: run-progress-steering-audit §2.3):
 * queued → delivered (in the session) → acknowledged (the agent's turn read it);
 * undelivered is derived, never stored — the run ended first.
 */

import { INTERACTIVE_WORKER_RUNNER, TERMINAL_WORKER_STATUSES, isTerminalWorkerStatus } from '@buildd/shared';

/** Entry shape stored in `workers.instructionHistory`. */
export type InstructionHistoryEntry = {
  /** Server-generated at enqueue. Absent on entries written before ids existed. */
  id?: string;
  type: 'instruction' | 'response';
  /** Omitted for sensitive workspaces — the {type, ts} envelope is kept only. */
  message?: string;
  timestamp: number;
  /** 'pending' is displayed as Queued. */
  deliveryState?: 'pending' | 'delivered' | 'acknowledged';
  deliveredAt?: number;
  acknowledgedAt?: number;
  /**
   * Set when a consumer settled this entry by id: such a consumer reports the
   * agent reading it, so a run that ends before that is "not delivered". A
   * text-matched delivery (older runner) never gets an acknowledgement and so
   * never turns into "not delivered".
   */
  awaitsAck?: true;
  /**
   * `workers.turns` at send time. Recorded only: `workers.turns` counts runner
   * check-ins, not agent turns, so nothing derives a status from it (see
   * `messageDeliveryStatus`).
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
 * It IS the check-in route's terminal set (`TERMINAL_WORKER_STATUSES` from
 * @buildd/shared) — `superseded` included, which this copy used to miss.
 */
export const UNREACHABLE_WORKER_STATUSES = TERMINAL_WORKER_STATUSES;

export const isUnreachableWorkerStatus = isTerminalWorkerStatus;

function newEntryId(): string {
  return globalThis.crypto.randomUUID();
}

function asHistory(current: unknown): InstructionHistoryEntry[] {
  return Array.isArray(current) ? (current as InstructionHistoryEntry[]) : [];
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
  opts: { message: string; isSensitive: boolean; deliveryState: 'pending' | 'delivered'; turnAtSend?: number; id?: string },
): InstructionHistoryEntry[] {
  const history = asHistory(current);

  const turn = opts.turnAtSend != null ? { turnAtSend: opts.turnAtSend } : {};
  const envelope = { id: opts.id ?? newEntryId(), type: 'instruction' as const, timestamp: Date.now(), deliveryState: opts.deliveryState, ...turn };
  const entry: InstructionHistoryEntry = opts.isSensitive ? envelope : { ...envelope, message: opts.message };

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

/** The worker fields `queueInstruction` decides from. */
export interface QueueTarget {
  instructionHistory: unknown;
  pendingInstructions: string | null;
  turns?: number | null;
  status: string;
  runner?: string | null;
  supportsInstructionAck?: boolean | null;
}

export interface QueuedInstruction {
  /** History entry id of the new message. */
  id: string;
  instructionHistory: InstructionHistoryEntry[];
  /** New value for `workers.pendingInstructions`. */
  pendingInstructions: string | null;
  deliveryState: 'pending' | 'delivered';
  /** The message was put on the queue. */
  queueable: boolean;
  /** A consumer can confirm delivery for this worker. */
  ackCapable: boolean;
  /**
   * Text to push over Pusher, or null. Only an urgent message the queue cannot
   * carry gets the text itself: a runner that cannot acknowledge (it cannot
   * de-duplicate a queued copy), or a terminal worker whose session the runner
   * may still hold. Everything queued gets a text-free `deliver_pending`
   * wake-up instead and is collected from the queue.
   */
  pusherText: string | null;
}

/**
 * The one enqueue path for human→agent text, shared by `/instruct` and
 * `/cmd message`. Pure: the caller writes `instructionHistory` and
 * `pendingInstructions` and fires the Pusher event.
 */
export function queueInstruction(
  worker: QueueTarget,
  opts: { message: string; isSensitive: boolean; priority?: 'normal' | 'urgent' | string },
): QueuedInstruction {
  const isUrgent = opts.priority === 'urgent';
  // An interactive worker (claim_task, runner = 'mcp') counts as ack-capable
  // from the start: no runner listens on Pusher for it, its session reads only
  // the queue (receive_messages / update_progress, which acknowledge).
  const ackCapable = worker.supportsInstructionAck === true || worker.runner === INTERACTIVE_WORKER_RUNNER;
  const reachable = !isUnreachableWorkerStatus(worker.status);
  // A legacy runner only ever got urgent text over Pusher; queueing a copy too
  // would have it injected twice (it cannot de-duplicate).
  const queueable = reachable && (ackCapable || !isUrgent);
  // 'delivered' is only written where no confirmation can ever arrive.
  const deliveryState = queueable || ackCapable ? 'pending' : 'delivered';
  const id = newEntryId();

  return {
    id,
    instructionHistory: appendInstructionHistory(worker.instructionHistory, {
      id,
      message: opts.message,
      isSensitive: opts.isSensitive,
      deliveryState,
      ...(typeof worker.turns === 'number' ? { turnAtSend: worker.turns } : {}),
    }),
    pendingInstructions: queueable
      ? enqueuePendingInstruction(worker.pendingInstructions, opts.message)
      : worker.pendingInstructions ?? null,
    deliveryState,
    queueable,
    ackCapable,
    pusherText: isUrgent && !queueable ? opts.message : null,
  };
}

/**
 * Ids of the pending entries whose text is in the served queue — what the
 * consumer echoes back (`instructionIdsDelivered`, then
 * `instructionsAcknowledged`). Sensitive entries carry no text, so every
 * pending one is named. Entries written before ids existed are settled by the
 * text echo instead.
 */
export function pendingInstructionIds(current: unknown, queueText: string): string[] {
  return asHistory(current)
    .filter(e => e.type === 'instruction' && e.deliveryState === 'pending' && !!e.id
      && (e.message === undefined || queueText.includes(e.message)))
    .map(e => e.id as string);
}

/**
 * Mark instruction-history entries as delivered after a consumer confirmed that
 * human text reached the agent session.
 *
 * With `ids` (current consumers), exactly those entries are settled, and they
 * are flagged `awaitsAck`. Without (an older runner), `deliveredText` is the
 * exact text the consumer injected: every 'pending' entry whose message is
 * contained in it is confirmed — the served payload is the concatenation of the
 * queued instructions, so one confirmation can settle several entries.
 * Sensitive workspaces store no message text, so their entries are settled by
 * position (all pending ones) instead.
 */
export function markInstructionsDelivered(
  current: unknown,
  deliveredText: string,
  ids?: readonly string[],
  now: number = Date.now(),
): InstructionHistoryEntry[] {
  const byId = !!ids && ids.length > 0;
  return asHistory(current).map((entry) => {
    if (entry.type !== 'instruction' || entry.deliveryState !== 'pending') return entry;
    if (byId) {
      return entry.id && ids!.includes(entry.id)
        ? { ...entry, deliveryState: 'delivered' as const, deliveredAt: now, awaitsAck: true as const }
        : entry;
    }
    const confirmed = entry.message === undefined
      ? true // sensitive workspace: no text to match against
      : deliveredText.length > 0 && deliveredText.includes(entry.message);
    return confirmed ? { ...entry, deliveryState: 'delivered' as const, deliveredAt: now } : entry;
  });
}

/**
 * The agent's turn read these messages: the runner saw the id echoed on an
 * assistant frame (Claude `user_message_uuid(s)`), the Codex backend started the
 * turn whose prompt it was, or an MCP tool result carried the text. Unknown ids
 * (evicted by the history cap, or someone else's) are ignored.
 */
export function markInstructionsAcknowledged(
  current: unknown,
  ids: readonly string[],
  now: number = Date.now(),
): InstructionHistoryEntry[] {
  if (ids.length === 0) return asHistory(current);
  return asHistory(current).map((entry) => {
    if (entry.type !== 'instruction' || !entry.id || !ids.includes(entry.id)) return entry;
    if (entry.deliveryState === 'acknowledged') return entry;
    return {
      ...entry,
      deliveryState: 'acknowledged' as const,
      deliveredAt: entry.deliveredAt ?? now,
      acknowledgedAt: now,
    };
  });
}

/**
 * One instruction's delivery state, the single derivation every surface uses
 * (task page, Steer canvas, `GET /api/tasks/[id]/messages`, get_task_messages).
 * None of them reads `deliveryState` directly.
 *
 * There is no "read at turn N": `workers.turns` advances on every runner
 * check-in, not on agent turns. Acknowledged comes only from an observed echo.
 */
export type MessageDeliveryState = 'queued' | 'delivered' | 'acknowledged' | 'undelivered';
export type MessageDeliveryStatus = { state: MessageDeliveryState; at: number | null };

export function messageDeliveryStatus(
  entry: Pick<InstructionHistoryEntry, 'deliveryState' | 'timestamp' | 'deliveredAt' | 'acknowledgedAt' | 'awaitsAck'>,
  workerStatus?: string | null,
): MessageDeliveryStatus {
  if (entry.deliveryState === 'acknowledged') {
    return { state: 'acknowledged', at: entry.acknowledgedAt ?? entry.deliveredAt ?? entry.timestamp ?? null };
  }
  const ended = !!workerStatus && isTerminalWorkerStatus(workerStatus);
  if (entry.deliveryState === 'delivered') {
    if (ended && entry.awaitsAck) return { state: 'undelivered', at: null };
    return { state: 'delivered', at: entry.deliveredAt ?? entry.timestamp ?? null };
  }
  if (ended) return { state: 'undelivered', at: null };
  return { state: 'queued', at: entry.timestamp ?? null };
}

/** Short chip label: text, never colour alone. */
export const DELIVERY_STATE_LABEL: Record<MessageDeliveryState, string> = {
  queued: 'Queued',
  delivered: 'Delivered',
  acknowledged: 'Read by the agent',
  undelivered: 'Not delivered',
};

/** The longer line under a message; Codex delivers only once its turn ends. */
export function deliveryStateDetail(state: MessageDeliveryState, opts: { codex?: boolean } = {}): string {
  switch (state) {
    case 'queued': return "Queued · waits for the agent's next turn";
    case 'delivered': return opts.codex
      ? 'Delivered · waits for the current turn to end'
      : 'Delivered · in the session, not read yet';
    case 'acknowledged': return 'Read by the agent';
    case 'undelivered': return 'Not delivered · the run ended first';
  }
}
