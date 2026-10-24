/**
 * Worker→worker message envelope + rendering. No DB, no imports with side
 * effects: `mcp-tools.ts` reaches the queue over HTTP only and must not gain a
 * DB coupling to render a message.
 *
 * The queue itself lives in ./worker-messages.
 */

/**
 * Max messages held per recipient task. Oldest are dropped on overflow: a
 * blocked agent that has already been told three times does not need a fourth
 * copy more than it needs the newest one.
 */
export const WORKER_MESSAGE_CAP = 3;

export type WorkerMessageType =
  | 'path_released'
  | 'question'
  | 'answer';

export interface WorkerMessage {
  id: string;
  type: WorkerMessageType;
  fromTaskId: string;
  toTaskId?: string;
  fromWorkerId?: string | null;
  sentAt: string;
  hopCount: number;
  body: Record<string, unknown>;
}

export interface WorkerMessageInput {
  type: WorkerMessageType;
  fromTaskId: string;
  toTaskId?: string;
  fromWorkerId?: string | null;
  body: Record<string, unknown>;
  hopCount?: number;
}

/** Build a message envelope with a fresh id and timestamp. */
export function buildWorkerMessage(input: WorkerMessageInput): WorkerMessage {
  return {
    id: crypto.randomUUID(),
    type: input.type,
    fromTaskId: input.fromTaskId,
    ...(input.toTaskId ? { toTaskId: input.toTaskId } : {}),
    ...(input.fromWorkerId !== undefined ? { fromWorkerId: input.fromWorkerId } : {}),
    sentAt: new Date().toISOString(),
    hopCount: input.hopCount ?? 0,
    body: input.body,
  };
}

/**
 * A send_worker_message call an agent can paste and have succeed.
 *
 * The tool requires recipientTaskId, type and body; replyToMsgId lives INSIDE
 * body, not at the top level; and hopCount must be echoed or every hop stores
 * as 1 and the loop cap never trips. A recipe that omits any of those reads as
 * an instruction and fails schema validation.
 */
function replyRecipe(m: WorkerMessage, type: WorkerMessageType, text: string): string {
  return `send_worker_message({ recipientTaskId: "${m.fromTaskId}", type: "${type}", `
    + `body: { replyToMsgId: "${m.id}", text: "${text}" }, hopCount: ${m.hopCount ?? 0} })`;
}

export function formatWorkerMessages(messages: WorkerMessage[]): string {
  const seen = new Set<string>();
  return messages.filter(m => {
    if (!m.id) return true;
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  }).map(m => {
    const from = `from task ${m.fromTaskId}`;
    switch (m.type) {
      case 'path_released': {
        const paths = Array.isArray(m.body?.paths) ? (m.body.paths as string[]) : [];
        const pathList = paths.join(', ') || 'the paths you were blocked on';
        // The reason decides whether "rebase" is advice or a mistake: claims are
        // released when the holder goes terminal, which on the happy path is
        // BEFORE its PR merges, and also happens when a PR is closed unmerged or
        // a worker is reaped. Telling a waiter to rebase onto work that never
        // landed is worse than telling it nothing.
        const reason = typeof m.body?.reason === 'string' ? m.body.reason : null;
        const detail = reason === 'merged'
          ? 'merged into your base branch. Your base moved — rebase before you push.'
          : reason === 'pending_merge'
            ? 'are free to claim: the holding task finished and dropped its locks, but its PR has NOT merged yet. '
              + 'Your base has not moved — do NOT rebase, and expect a second path_released (reason: merged) when it lands.'
            : reason === 'abandoned'
              ? 'are free to claim: the holding task ended without merging (failed, closed unmerged, or expired). '
                + 'Nothing landed — do NOT rebase, and treat any of its work you were building on as absent.'
              : 'are free to claim. Release reason unknown — confirm whether the holding task\'s PR merged before you rebase.';
        return `**AGENT MESSAGE** (path_released, ${from}): ${pathList} ${detail}`;
      }
      case 'question': {
        const t = typeof m.body?.text === 'string' ? m.body.text : JSON.stringify(m.body);
        return `**AGENT MESSAGE** (question, ${from}): ${t}\n`
          + `If the answer changes what they do next, reply with exactly this call:\n`
          + replyRecipe(m, 'answer', '<your answer>');
      }
      case 'answer': {
        const t = typeof m.body?.text === 'string' ? m.body.text : JSON.stringify(m.body);
        // A person answering this session's own question (/respond's
        // interactive path), not another agent replying.
        if (m.body?.source === 'human') {
          const q = typeof m.body?.question === 'string' && m.body.question ? ` "${m.body.question}"` : '';
          return `**HUMAN ANSWER** to your question${q}: ${t}\nCarry on with this answer.`;
        }
        return `**AGENT MESSAGE** (answer, ${from}): ${t}`;
      }
      default:
        return `**AGENT MESSAGE** (${m.type}, ${from}): ${JSON.stringify(m.body)}`;
    }
  }).join('\n\n');
}

/** The marker every rendered worker→worker message starts with. */
export const AGENT_MESSAGE_MARKER = '**AGENT MESSAGE**';

/**
 * Who an injected follow-up came from, for the activity label. Structural: a
 * message is an agent's only when it starts with the marker `formatWorkerMessages`
 * writes; anything else is attributed to a person as before. No sender is
 * inferred beyond what the envelope itself carries.
 */
export function describeInjectedMessage(text: string): { source: 'agent' | 'user'; label: string } {
  if (text.startsWith(AGENT_MESSAGE_MARKER)) {
    const head = /^\*\*AGENT MESSAGE\*\* \(([a-z_]+)(?:, from task ([^,)\s]+))?/.exec(text);
    if (!head) return { source: 'agent', label: 'Agent message' };
    const kind = head[1].replace(/_/g, ' ');
    return { source: 'agent', label: head[2] ? `Agent message: ${kind}, from task ${head[2].slice(0, 8)}` : `Agent message: ${kind}` };
  }
  return { source: 'user', label: text.length > 30 ? `User: ${text.slice(0, 30)}...` : `User: ${text}` };
}
