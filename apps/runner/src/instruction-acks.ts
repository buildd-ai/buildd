/**
 * Turn-boundary acknowledgement of human messages (knowledge-base:
 * run-progress-steering-audit §2.2–2.3).
 *
 * The runner injects a served message into the session and reports it
 * DELIVERED by id (`instructionIdsDelivered`). That only means it is in the
 * session's input stream. It becomes ACKNOWLEDGED (`instructionsAcknowledged`)
 * when the session shows the agent's turn actually took it in:
 *
 *  - Claude: the injected SDKUserMessage carries a `uuid`; the CLI stamps it on
 *    the first assistant frame that answers it (`user_message_uuid`), or lists
 *    it in `user_message_uuids` once a mid-turn fold consumed it.
 *  - Codex: no mid-turn injection. The backend parks after `turn.completed`
 *    and takes the next message as the next turn's prompt; it reports that
 *    with an `input_consumed` event carrying the message's uuid.
 *  - An AskUserQuestion answer goes in as a tool_result and a resumed session
 *    takes the message as its prompt; neither is echoed. The next top-level
 *    assistant frame is the model's reply to it.
 *
 * Nothing here ever fakes an acknowledgement: an id the session never reads
 * stays Delivered, and the task page shows it Not delivered once the run ends.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The SDK uuid for one injection. A single served message's id is itself a
 * server-generated UUID, so it is used as-is (the echo then names the message
 * directly). Several messages served as one payload share a fresh uuid.
 */
export function injectionUuid(ids: readonly string[]): string {
  if (ids.length === 1 && UUID_RE.test(ids[0])) return ids[0];
  return globalThis.crypto.randomUUID();
}

interface PendingAck {
  uuid: string | null;
  ids: string[];
  /** Acknowledge on the next top-level assistant frame (no echo will come). */
  ackOnNextAssistant: boolean;
}

/** Minimal view of an SDK assistant frame. */
export interface AssistantFrame {
  type?: string;
  parent_tool_use_id?: string | null;
  user_message_uuid?: string;
  user_message_uuids?: string[];
}

export class InstructionAckTracker {
  private pending = new Map<string, PendingAck[]>();

  /**
   * Remember an injection. Returns the uuid to stamp on the SDKUserMessage
   * (null when nothing is tracked).
   */
  register(
    workerId: string,
    ids: readonly string[],
    opts: { uuid?: string; ackOnNextAssistant?: boolean } = {},
  ): string | null {
    if (ids.length === 0) return null;
    const uuid = opts.uuid ?? injectionUuid(ids);
    const list = this.pending.get(workerId) ?? [];
    list.push({ uuid, ids: [...ids], ackOnNextAssistant: opts.ackOnNextAssistant === true });
    this.pending.set(workerId, list);
    return uuid;
  }

  /** Ids acknowledged by this assistant frame (empty when none). */
  onAssistant(workerId: string, frame: AssistantFrame): string[] {
    // Subagent frames answer their own prompts, never ours.
    if (frame.parent_tool_use_id) return [];
    const echoed = new Set<string>([
      ...(typeof frame.user_message_uuid === 'string' ? [frame.user_message_uuid] : []),
      ...(Array.isArray(frame.user_message_uuids) ? frame.user_message_uuids : []),
    ]);
    return this.take(workerId, p => p.ackOnNextAssistant || (p.uuid !== null && echoed.has(p.uuid)));
  }

  /** Codex: the backend started the turn whose prompt carried these uuids. */
  onInputConsumed(workerId: string, uuids: readonly string[]): string[] {
    const set = new Set(uuids);
    return this.take(workerId, p => p.uuid !== null && set.has(p.uuid));
  }

  /** The session is gone: what it never read stays unacknowledged. */
  forget(workerId: string): void {
    this.pending.delete(workerId);
  }

  private take(workerId: string, match: (p: PendingAck) => boolean): string[] {
    const list = this.pending.get(workerId);
    if (!list?.length) return [];
    const hit = list.filter(match);
    if (hit.length === 0) return [];
    const rest = list.filter(p => !match(p));
    if (rest.length > 0) this.pending.set(workerId, rest);
    else this.pending.delete(workerId);
    return [...new Set(hit.flatMap(p => p.ids))];
  }
}
