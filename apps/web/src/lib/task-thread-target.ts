/**
 * Callback targets for a task filed from a client thread (T3 Code via `buildd acp`).
 *
 * A thread has no address buildd can call, so the target is *remembered* on the task
 * (`context.callbackTarget`, a kind and a thread id, never a secret) and the runner's
 * bridge, which holds the thread, pulls the notes (`GET /api/tasks/thread-events`).
 * Events are derived from the task's current state on read, so there is no delivery
 * loop to keep alive: a missed poll is repaired by the next one, and the bridge
 * remembers which notes it has already shown.
 */

export const THREAD_EVENTS = ['started', 'waiting_input', 'pr_opened', 'completed', 'failed'] as const;
export type ThreadEvent = typeof THREAD_EVENTS[number];

export interface ThreadTarget { kind: 't3_thread'; threadId: string }

const MAX_THREAD_ID = 128;

/** A valid target, stripped to kind and thread id; anything else is null. */
export function parseThreadTarget(value: unknown): ThreadTarget | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as { kind?: unknown; threadId?: unknown };
  if (v.kind !== 't3_thread' || typeof v.threadId !== 'string') return null;
  const threadId = v.threadId.trim();
  if (!threadId || threadId.length > MAX_THREAD_ID) return null;
  return { kind: 't3_thread', threadId };
}

/** `context` with `callbackTarget` sanitized; an invalid one is dropped. */
export function withThreadTarget(context: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const { callbackTarget, ...rest } = (context ?? {}) as Record<string, unknown>;
  const target = parseThreadTarget(callbackTarget);
  return target ? { ...rest, callbackTarget: target } : rest;
}

/** Which targets a task has: the plain URL callback and/or a thread, independently. */
export function selectCallbackTargets(context: Record<string, unknown> | null | undefined): Array<'url' | 't3_thread'> {
  const out: Array<'url' | 't3_thread'> = [];
  const url = (context?.callback as { url?: unknown } | undefined)?.url;
  if (typeof url === 'string' && url.startsWith('https://')) out.push('url');
  if (parseThreadTarget(context?.callbackTarget)) out.push('t3_thread');
  return out;
}

/**
 * The events a task has reached, oldest first. A later state implies the earlier ones
 * (a finished task was started). `waiting_input` shows only while the worker waits:
 * an answered question is not replayed.
 */
export function threadEventsFor(s: { taskStatus: string; workerStatus: string | null; prUrl: string | null; hasWorker: boolean }): ThreadEvent[] {
  const terminal = s.taskStatus === 'completed' || s.taskStatus === 'failed';
  const out: ThreadEvent[] = [];
  if (s.hasWorker || terminal) out.push('started');
  if (s.workerStatus === 'waiting_input' && !terminal) out.push('waiting_input');
  if (s.prUrl) out.push('pr_opened');
  if (s.taskStatus === 'completed') out.push('completed');
  if (s.taskStatus === 'failed') out.push('failed');
  return out;
}

/** The one-line note a thread shows. */
export function threadNote(event: ThreadEvent, task: { title: string; prUrl?: string | null }): string {
  const t = `“${task.title.length > 80 ? `${task.title.slice(0, 79)}…` : task.title}”`;
  switch (event) {
    case 'started': return `buildd: a runner started ${t}.`;
    case 'waiting_input': return `buildd: ${t} has a question and is waiting for an answer.`;
    case 'pr_opened': return `buildd: ${t} opened a pull request${task.prUrl ? `: ${task.prUrl}` : '.'}`;
    case 'completed': return `buildd: ${t} completed.`;
    case 'failed': return `buildd: ${t} failed.`;
  }
}
