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
  | 'path_blocked_on_you'
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
  return messages.map(m => {
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
      case 'path_blocked_on_you': {
        const paths = Array.isArray(m.body?.overlappingPaths)
          ? (m.body.overlappingPaths as string[])
          : [];
        const branch = typeof m.body?.detectedByBranch === 'string' ? ` (branch ${m.body.detectedByBranch})` : '';
        return `**AGENT MESSAGE** (path_blocked_on_you, ${from}${branch}): another agent is editing `
          + `${paths.join(', ') || 'paths you hold'}. If you are about to land these files, tell them so:\n`
          + replyRecipe(m, 'answer', 'I am about to land these files — <what you are changing and when>');
      }
      case 'question': {
        const t = typeof m.body?.text === 'string' ? m.body.text : JSON.stringify(m.body);
        return `**AGENT MESSAGE** (question, ${from}): ${t}\n`
          + `If the answer changes what they do next, reply with exactly this call:\n`
          + replyRecipe(m, 'answer', '<your answer>');
      }
      case 'answer': {
        const t = typeof m.body?.text === 'string' ? m.body.text : JSON.stringify(m.body);
        return `**AGENT MESSAGE** (answer, ${from}): ${t}`;
      }
      default:
        return `**AGENT MESSAGE** (${m.type}, ${from}): ${JSON.stringify(m.body)}`;
    }
  }).join('\n\n');
}
