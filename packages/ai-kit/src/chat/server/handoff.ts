/**
 * Hand-off: a turn files a long-running job (a runner task) and links it back
 * into the chat.
 *
 * 1. The app's hand-off tool is a write declared `spends: true` (so it always
 *    shows an approval card; Allow can never skip it). Its `execute` files the
 *    job and returns a `ToolResult` with `handoff: { taskId, url }`
 *    (`handoffResult` builds one).
 * 2. `createChatTurn` sees the `handoff`, streams a `data-handoff` part
 *    (`state: 'filed'`) and a "Filed as a task" step, and calls
 *    `store.linkHandoff` so the app knows which conversation to update.
 * 3. When the job reports back (the app's webhook), the app appends
 *    `handoffEventMessage(...)` to the conversation through its own store.
 *    `latestHandoffs(messages)` (contract) folds the states; `<HandoffCard>`
 *    renders the newest.
 */

import {
  EVENT_PART_TYPE,
  HANDOFF_PART_TYPE,
  type HandoffData,
  type ObjectRef,
  type ToolResult,
} from '@builddai/ai-kit/chat/contract';
import type { StoredMessage } from './store';

/** What a hand-off tool returns: the model reads `data`, the kit reads `handoff`. */
export function handoffResult(args: { taskId: string; url: string; title?: string; data?: unknown; summary?: string; objects?: ObjectRef[] }): ToolResult {
  return {
    data: args.data ?? { filed: true, taskId: args.taskId, url: args.url },
    objects: args.objects ?? [],
    summary: args.summary ?? 'filed as a task',
    handoff: { taskId: args.taskId, url: args.url, ...(args.title ? { title: args.title } : {}) },
  };
}

/** Structural check for a tool output carrying a hand-off. */
export function handoffOf(output: unknown): { taskId: string; url: string; title?: string } | null {
  const h = (output as { handoff?: { taskId?: unknown; url?: unknown; title?: unknown } } | null | undefined)?.handoff;
  if (!h || typeof h.taskId !== 'string' || typeof h.url !== 'string' || !h.taskId) return null;
  return { taskId: h.taskId, url: h.url, ...(typeof h.title === 'string' ? { title: h.title } : {}) };
}

/**
 * The message an app appends when a hand-off changes state (running,
 * completed, failed). A `role: 'event'` message: not a model turn, and the
 * turn runner shows it to the model as a one-line `[update]` note.
 */
export function handoffEventMessage(args: {
  id: string;
  handoff: HandoffData;
  /** One line of plain text: "Filed task finished: PR #12 opened". Default from the state. */
  text?: string;
  objects?: ObjectRef[];
  createdAt?: string;
}): StoredMessage {
  const title = args.handoff.title ?? 'The task';
  const text = args.text ?? ({
    filed: `${title} was filed`,
    running: `${title} is running`,
    completed: `${title} finished${args.handoff.summary ? `: ${args.handoff.summary}` : ''}`,
    failed: `${title} failed${args.handoff.summary ? `: ${args.handoff.summary}` : ''}`,
  } as const)[args.handoff.state];
  return {
    id: args.id,
    role: 'event',
    parts: [
      { type: HANDOFF_PART_TYPE, id: args.handoff.taskId, data: args.handoff },
      { type: EVENT_PART_TYPE, data: { event: `handoff.${args.handoff.state}`, objects: args.objects ?? [], text } },
    ],
    ...(args.createdAt ? { createdAt: args.createdAt } : {}),
  };
}
