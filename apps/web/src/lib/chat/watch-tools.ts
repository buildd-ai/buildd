/**
 * The chat notification tools (docs/design/subscriptions-and-notifications.md
 * → Chat tool surface): `watch`, `unwatch`, `list_watches`. Registered in
 * registry.ts (CHAT_NATIVE_TOOL_SPECS, group `notifications`) and run by
 * tools.ts through the in-process API, so each reaches only the routes its op
 * declares and every row passes the conversation's reach filter.
 *
 * The caller is always the owner: the subscription route takes the owner from
 * the session, and the origin conversation comes from the turn, never from
 * the model's input.
 */

import type { ApiFn } from '@buildd/core/mcp-tools';
import { watchEventTypes, watchWhenPhrase } from '@/lib/watch-notice';

type Obj = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const textOut = (text: string, isError = false) => ({ content: [{ type: 'text' as const, text }], ...(isError ? { isError } : {}) });

/** 42, "42", "#42", "PR 42", or a GitHub pull URL → 42. */
export function parsePrNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isInteger(v) && v > 0 ? v : null;
  const s = str(v);
  if (!s) return null;
  const m = s.match(/\/pull\/(\d+)/) ?? s.match(/^(?:pr\s*)?#?\s*(\d+)$/i);
  const n = m ? Number(m[1]) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** What one-shot watches say about when they end, on the card and in replies. */
export const ONE_SHOT_ENDS = 'after it tells you once, or in 7 days';

/** The watch the route will write, from a (preview-normalized) input. */
export function watchRequestBody(input: Obj, conversationId: string | null): Obj | { error: string } {
  const pr = parsePrNumber(input.prNumber);
  const taskId = str(input.taskId);
  if (!!taskId === (pr !== null)) return { error: 'name one thing to watch: a task or a PR' };
  const kind = taskId ? 'task' : 'pr';
  const eventTypes = watchEventTypes(kind, input.on);
  if (eventTypes.length === 0) return { error: `those events don't apply to a ${kind === 'pr' ? 'PR' : 'task'}` };
  return {
    ...(taskId ? { taskId } : { workspaceId: str(input.workspaceId), prNumber: pr }),
    eventTypes,
    ...(conversationId ? { conversationId } : {}),
  };
}

export async function runWatch(api: ApiFn, input: Obj, conversationId: string | null) {
  const body = watchRequestBody(input, conversationId);
  if ('error' in body) return textOut(`Error: ${body.error}`, true);
  const out = await api('/api/subscriptions', { method: 'POST', body: JSON.stringify(body) });
  const sub = (out?.subscription ?? {}) as Obj;
  const what = body.taskId ? 'that task' : `#${body.prNumber}`;
  const when = watchWhenPhrase(Array.isArray(sub.eventTypes) ? sub.eventTypes as string[] : body.eventTypes as string[]);
  return textOut(`Watching ${what}. The user hears about it here when ${when}, once; the watch ends ${ONE_SHOT_ENDS}. (watch id ${String(sub.id ?? '').slice(0, 8)})`);
}

interface WatchRow { id: string; label?: string | null; subjectKind: string; subjectKey: string; subjectRef?: Obj; eventTypes: string[]; expiresAt: string; workspaceId?: string | null }

async function listWatches(api: ApiFn): Promise<WatchRow[]> {
  const out = await api('/api/subscriptions');
  return (Array.isArray(out?.subscriptions) ? out.subscriptions : []) as WatchRow[];
}

/**
 * The one watch an unwatch input means: by its id (full or the 8-character
 * short id list_watches shows), by the task id, or by PR number. More than
 * one match is a question, never a guess.
 */
export function findWatch(list: readonly WatchRow[], input: Obj): { ok: true; watch: WatchRow } | { ok: false; question: string } {
  const id = str(input.watchId);
  const taskId = str(input.taskId);
  const pr = parsePrNumber(input.prNumber);
  const ws = str(input.workspaceId);
  let hits: WatchRow[];
  if (id) hits = list.filter(w => w.id === id || (id.length >= 8 && w.id.startsWith(id)));
  else if (taskId) hits = list.filter(w => w.subjectKind === 'task' && (w.subjectKey === taskId || (taskId.length >= 8 && w.subjectKey.startsWith(taskId))));
  else if (pr !== null) hits = list.filter(w => w.subjectKind === 'pr' && Number((w.subjectRef as { number?: unknown } | undefined)?.number) === pr && (!ws || w.workspaceId === ws));
  else return { ok: false, question: 'Which watch should stop? Name the task or PR, or ask to list the watches.' };
  if (hits.length === 1) return { ok: true, watch: hits[0] };
  if (hits.length === 0) return { ok: false, question: 'No running watch matches that. Tell the user; nothing to stop.' };
  return { ok: false, question: `That matches ${hits.length} watches: ${hits.map(h => h.label ?? h.id.slice(0, 8)).join(', ')}. Ask the user which one.` };
}

export async function runUnwatch(api: ApiFn, input: Obj) {
  const found = findWatch(await listWatches(api), input);
  if (!found.ok) return textOut(found.question);
  await api(`/api/subscriptions/${found.watch.id}`, { method: 'DELETE' });
  return textOut(`Stopped watching ${found.watch.label ?? 'that'}. Nothing more will be posted about it.`);
}

export async function runListWatches(api: ApiFn) {
  const list = await listWatches(api);
  if (list.length === 0) return textOut('No watches are running.');
  const lines = list.map(w => `- ${w.label ?? w.subjectKey}: tells the user when ${watchWhenPhrase(w.eventTypes)}; ends ${String(w.expiresAt).slice(0, 10)} at the latest (watch id ${w.id.slice(0, 8)})`);
  return textOut(`${list.length} watch${list.length === 1 ? '' : 'es'} running:\n${lines.join('\n')}`);
}
