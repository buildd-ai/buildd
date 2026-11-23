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

export const THREAD_EVENTS = ['started', 'waiting_input', 'needs_you', 'pr_opened', 'completed', 'failed'] as const;
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

/**
 * The one-line note a thread shows. A plain sentence, the way the thread itself talks:
 * no "buildd:" or "Needs you:" label in front, and "input" for a wait on the person,
 * which is T3's own word for it.
 */
export function threadNote(event: ThreadEvent, task: { title: string; prUrl?: string | null }): string {
  const t = `“${task.title.length > 80 ? `${task.title.slice(0, 79)}…` : task.title}”`;
  switch (event) {
    case 'started': return `Working on ${t}.`;
    case 'waiting_input': return `${t} is waiting for your input.`;
    case 'needs_you': return `${t} is waiting for your input.`;
    case 'pr_opened': return `Opened a pull request for ${t}${task.prUrl ? `: ${task.prUrl}` : '.'}`;
    case 'completed': return `Finished ${t}.`;
    case 'failed': return `${t} failed.`;
  }
}

/** The slice of a kernel DeliveryView the owner-only check reads. */
export interface OwnerDelivery { needsYou: boolean; state: string; stateReason: string | null; prNumber: number | null; headline: string }

export interface NeedsYouNote { reason: string; text: string }

/**
 * One line when only a person can move a task: its own delivery (pr_landing needs_human,
 * review escalated, a merge refused for a person) or the delivery of a dependency it waits
 * on. `reason` names the state, not the wording, so a note repeats only on a state change.
 * Null for an ordinary wait.
 */
export function needsYouNote(input: {
  delivery: OwnerDelivery | null;
  prUrl: string | null;
  dependency?: { delivery: OwnerDelivery; prUrl: string | null } | null;
}): NeedsYouNote | null {
  const own = input.delivery?.needsYou ? input.delivery : null;
  const dep = !own && input.dependency?.delivery.needsYou ? input.dependency : null;
  const d = own ?? dep?.delivery;
  if (!d) return null;
  const url = own ? input.prUrl : dep!.prUrl;
  const pr = d.prNumber ? `PR #${d.prNumber}` : 'its PR';
  const what = d.headline.replace(/\.$/, '');
  const lead = own ? `${pr} is waiting for your input.` : `This is waiting on ${pr}, which needs your input.`;
  const text = `${lead} ${what}.${url ? ` ${url}` : ''}`;
  return { reason: `${dep ? 'dep:' : ''}${d.state}:${d.stateReason ?? ''}`, text };
}
