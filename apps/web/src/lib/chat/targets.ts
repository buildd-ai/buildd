/**
 * Resolving what a steering request points at ("pause checkout", "tell the
 * export agent…") to exactly one task, or to a clarifying question.
 *
 * The model may pass a full id, an 8-character short id, or the words the
 * user used. Words are matched against the docked mission's tasks when a
 * mission is docked, else against the workspace's active tasks. One match
 * resolves; none or several never guess — the tool returns a question for
 * the user instead, and no approval card is shown.
 */

import type { ApiFn } from '@buildd/core/mcp-tools';

export interface TaskCandidate {
  id: string;
  title: string;
  label?: string | null;
  status?: string;
}

export type Resolution =
  | { ok: true; id: string }
  | { ok: false; question: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHORT_ID = /^[0-9a-f]{6,12}$/i;
const STOP = new Set(['the', 'a', 'an', 'task', 'agent', 'one', 'job', 'for', 'on', 'of', 'this', 'that']);

export const isUuid = (s: string) => UUID.test(s);

function words(s: string): string[] {
  return s.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').split(' ').filter(w => w && !STOP.has(w));
}

function describe(c: TaskCandidate): string {
  return `"${c.label || c.title}" (${c.id.slice(0, 8)}${c.status ? `, ${c.status}` : ''})`;
}

/** Pure matcher: one candidate, or a question. */
export function matchTask(ref: string, candidates: readonly TaskCandidate[], scope: string): Resolution {
  const r = ref.trim();
  if (isUuid(r)) return { ok: true, id: r };
  if (SHORT_ID.test(r)) {
    const byId = candidates.filter(c => c.id.toLowerCase().startsWith(r.toLowerCase()));
    if (byId.length === 1) return { ok: true, id: byId[0].id };
  }
  const want = words(r);
  if (want.length === 0) return { ok: false, question: `Which task in ${scope} do you mean?` };
  const exact = candidates.filter(c => [c.title, c.label].some(t => t && words(t).join(' ') === want.join(' ')));
  if (exact.length === 1) return { ok: true, id: exact[0].id };
  const hits = candidates.filter(c => {
    const have = new Set([...words(c.title), ...words(c.label ?? '')]);
    return want.every(w => have.has(w) || [...have].some(h => h.startsWith(w) && w.length >= 4));
  });
  if (hits.length === 1) return { ok: true, id: hits[0].id };
  if (hits.length === 0) {
    return { ok: false, question: `No task in ${scope} matches "${r}". Ask the user which task they mean; don't guess.` };
  }
  return {
    ok: false,
    question: `"${r}" matches ${hits.length} tasks in ${scope}: ${hits.slice(0, 6).map(describe).join('; ')}. Ask the user which one they mean; don't pick one.`,
  };
}

/** Where a name is looked up: the docked mission, else the workspace's active tasks. */
export interface TaskScope {
  missionId?: string | null;
  missionTitle?: string | null;
  workspaceId?: string | null;
}

export async function loadCandidates(read: ApiFn, scope: TaskScope): Promise<{ candidates: TaskCandidate[]; label: string }> {
  if (scope.missionId) {
    const m = await read(`/api/missions/${scope.missionId}`);
    const tasks = (Array.isArray(m?.tasks) ? m.tasks : []) as TaskCandidate[];
    return { candidates: tasks, label: `mission "${m?.title ?? scope.missionTitle ?? 'this mission'}"` };
  }
  const qs = new URLSearchParams({ status: 'active', limit: '50' });
  if (scope.workspaceId) qs.set('workspaceId', scope.workspaceId);
  const page = await read(`/api/tasks?${qs}`);
  return { candidates: (Array.isArray(page?.tasks) ? page.tasks : []) as TaskCandidate[], label: 'the active tasks' };
}

export async function resolveTaskRef(read: ApiFn, ref: unknown, scope: TaskScope): Promise<Resolution> {
  if (typeof ref !== 'string' || !ref.trim()) return { ok: false, question: 'Which task do you mean?' };
  if (isUuid(ref.trim())) return { ok: true, id: ref.trim() };
  let loaded: { candidates: TaskCandidate[]; label: string };
  try {
    loaded = await loadCandidates(read, scope);
  } catch {
    return { ok: false, question: `I couldn't look up tasks to match "${ref}". Ask the user for the task.` };
  }
  return matchTask(ref, loaded.candidates, loaded.label);
}
