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

export function formatWorkerMessages(messages: WorkerMessage[]): string {
  return messages.map(m => {
    const from = `from task ${m.fromTaskId}`;
    switch (m.type) {
      case 'path_released': {
        const paths = Array.isArray(m.body?.paths) ? (m.body.paths as string[]) : [];
        return `**AGENT MESSAGE** (path_released, ${from}): ${paths.join(', ') || 'the paths you were blocked on'} `
          + `merged and are now free. Your base moved — rebase onto the updated base branch before you push.`;
      }
      case 'path_blocked_on_you': {
        const paths = Array.isArray(m.body?.overlappingPaths)
          ? (m.body.overlappingPaths as string[])
          : [];
        const branch = typeof m.body?.detectedByBranch === 'string' ? ` (branch ${m.body.detectedByBranch})` : '';
        return `**AGENT MESSAGE** (path_blocked_on_you, ${from}${branch}): another agent is editing `
          + `${paths.join(', ') || 'paths you hold'}. If you are about to land these files, say so or narrow your edits.`;
      }
      case 'question': {
        const t = typeof m.body?.text === 'string' ? m.body.text : JSON.stringify(m.body);
        return `**AGENT MESSAGE** (question, ${from}): ${t}\n`
          + `Reply with send_worker_message (type: "answer", replyToMsgId: "${m.id}") if the answer changes what they do next.`;
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
