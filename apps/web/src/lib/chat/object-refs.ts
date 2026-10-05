/**
 * Derive BuilddObjectRef[] from the API responses a chat tool call produced.
 *
 * Tool text is for the model; refs are for the client, which renders each as
 * the live object (fetched and subscribed by id). So refs come from the JSON
 * the routes returned, not from parsing tool prose. Refs are pointers: an id,
 * a display hint and a plain-text fallback, never a snapshot of state.
 */

import type { BuilddObjectRef } from '@buildd/shared';
import { taskDisplayLabel } from '@buildd/core/task-label';
import { otherVisualEvidence, type VisualEvidenceArtifact } from '@buildd/core/visual-review-text';
import type { ApiCall } from './in-process-api';

/** Cap per tool call: a list of 50 tasks renders as the first few cards. */
export const MAX_REFS_PER_CALL = 8;
/** PRs render as one compact list, so a week of them isn't cut to the card cap. */
export const MAX_PR_REFS = 40;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

function wsOf(o: Obj): string | null {
  return str(o.workspaceId) ?? (isObj(o.workspace) ? str(o.workspace.id) : undefined) ?? null;
}

function taskRef(t: Obj): BuilddObjectRef | null {
  const id = str(t.id);
  if (!id) return null;
  const title = str(t.title) ?? 'Task';
  const status = str(t.status);
  return { kind: 'task', id, workspaceId: wsOf(t), title, fallbackText: `Task: ${title}${status ? ` [${status}]` : ''}` };
}

function missionRef(m: Obj): BuilddObjectRef | null {
  const id = str(m.id);
  if (!id) return null;
  const title = str(m.title) ?? 'Mission';
  const status = str(m.status);
  return { kind: 'mission', id, workspaceId: wsOf(m), title, fallbackText: `Mission: ${title}${status ? ` [${status}]` : ''}` };
}

const PR_URL = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/;

function prRefsFromWorkers(task: Obj): BuilddObjectRef[] {
  const workers = Array.isArray(task.workers) ? task.workers.filter(isObj) : [];
  const out: BuilddObjectRef[] = [];
  for (const w of workers) {
    const url = str(w.prUrl);
    const m = url ? PR_URL.exec(url) : null;
    if (!url || !m) continue;
    const prNumber = Number(m[2]);
    out.push({
      kind: 'pr', id: `${m[1]}#${prNumber}`, workspaceId: wsOf(task), repo: m[1], prNumber, url,
      taskId: str(task.id), title: `#${prNumber}`, fallbackText: `PR ${m[1]}#${prNumber}: ${url}`,
      missionId: str(task.missionId) ?? null,
      missionTitle: (isObj(task.mission) ? str(task.mission.title) : undefined) ?? null,
      area: str(task.title) ? taskDisplayLabel({ label: str(task.label) ?? null, title: str(task.title)! }).scope : null,
      category: str(task.category) ?? null,
    });
  }
  return out;
}

function questionRefsFromWorkers(task: Obj): BuilddObjectRef[] {
  const workers = Array.isArray(task.workers) ? task.workers.filter(isObj) : [];
  const out: BuilddObjectRef[] = [];
  for (const w of workers) {
    const wf = isObj(w.waitingFor) ? w.waitingFor : null;
    if (str(w.status) !== 'waiting_input' || !wf || str(w.id) === undefined) continue;
    const prompt = str(wf.prompt) ?? 'A worker asked a question';
    out.push({
      kind: 'question', id: str(w.id)!, taskId: str(task.id)!, missionId: str(task.missionId) ?? null,
      workspaceId: wsOf(task), title: prompt.slice(0, 120), fallbackText: `Question: ${prompt.slice(0, 280)}`,
    });
  }
  return out;
}

/** What each listed release shipped (`include=tasks`), as PR refs with their mission and area. */
function prRefsFromReleases(body: unknown): BuilddObjectRef[] {
  const out: BuilddObjectRef[] = [];
  for (const r of listOf(body, 'releases')) {
    const repo = str(r.repo);
    if (!repo) continue;
    for (const t of Array.isArray(r.tasks) ? r.tasks.filter(isObj) : []) {
      const prNumber = typeof t.prNumber === 'number' ? t.prNumber : null;
      if (!prNumber) continue;
      const title = str(t.title) ?? `#${prNumber}`;
      out.push({
        kind: 'pr', id: `${repo}#${prNumber}`, workspaceId: wsOf(r), repo, prNumber,
        url: `https://github.com/${repo}/pull/${prNumber}`,
        ...(str(t.taskId) ? { taskId: str(t.taskId) } : {}),
        title,
        missionId: str(t.missionId) ?? null,
        missionTitle: str(t.missionTitle) ?? null,
        area: taskDisplayLabel({ label: str(t.label) ?? null, title }).scope,
        category: str(t.category) ?? null,
        fallbackText: `PR ${repo}#${prNumber}: ${title}`,
      });
    }
  }
  return out;
}

function listOf(body: unknown, key: string): Obj[] {
  if (isObj(body) && Array.isArray(body[key])) return (body[key] as unknown[]).filter(isObj);
  return [];
}

export function refsFromCall(call: ApiCall): BuilddObjectRef[] {
  if (call.status >= 400 || call.body == null) return [];
  const p = call.path;
  const out: Array<BuilddObjectRef | null> = [];

  if (p === '/api/tasks' && call.method === 'POST' && isObj(call.body)) out.push(taskRef(call.body));
  else if (p === '/api/tasks') out.push(...listOf(call.body, 'tasks').map(taskRef));
  else if (/^\/api\/tasks\/[^/]+$/.test(p) && isObj(call.body)) {
    const task = isObj(call.body.task) ? call.body.task : call.body;
    out.push(...questionRefsFromWorkers(task), taskRef(task), ...prRefsFromWorkers(task));
  } else if (p === '/api/missions') {
    if (call.method === 'POST' && isObj(call.body)) out.push(missionRef(isObj(call.body.mission) ? call.body.mission : call.body));
    else out.push(...listOf(call.body, 'missions').map(missionRef));
  } else if (/^\/api\/missions\/[^/]+$/.test(p) && isObj(call.body)) {
    out.push(missionRef(isObj(call.body.mission) ? call.body.mission : call.body));
  } else if (/\/schedules(\/[^/]+)?$/.test(p)) {
    const items = isObj(call.body) && isObj(call.body.schedule) ? [call.body.schedule] : listOf(call.body, 'schedules');
    for (const s of items) {
      const id = str(s.id);
      if (!id) continue;
      const name = str(s.name) ?? 'Schedule';
      out.push({ kind: 'schedule', id, workspaceId: wsOf(s), title: name, fallbackText: `Schedule: ${name}` });
    }
  } else if (p === '/api/releases') {
    return prRefsFromReleases(call.body).slice(0, MAX_PR_REFS);
  } else if (/\/artifacts$/.test(p)) {
    // A mission's (type-filtered) artifact list is read for its visual evidence
    // (get_visual_review): a card for each piece of it, not for every diff.
    const list = listOf(call.body, 'artifacts');
    const items = /^\/api\/missions\/[^/]+\/artifacts$/.test(p) && call.method === 'GET'
      ? (() => { const ev = otherVisualEvidence(list as unknown as VisualEvidenceArtifact[], { cells: [] }); return [...ev.reports, ...ev.screenshots] as unknown as Obj[]; })()
      : list;
    for (const a of items) {
      const id = str(a.id);
      if (!id) continue;
      const title = str(a.title) ?? str(a.key) ?? 'Artifact';
      out.push({ kind: 'artifact', id, workspaceId: wsOf(a), title, fallbackText: `Artifact: ${title}` });
    }
  }
  return out.filter((r): r is BuilddObjectRef => r !== null).slice(0, MAX_REFS_PER_CALL);
}

/** Refs across calls, de-duplicated by (kind, id), in call order. */
export function refsFromCalls(calls: ApiCall[]): BuilddObjectRef[] {
  const seen = new Set<string>();
  const out: BuilddObjectRef[] = [];
  for (const call of calls) {
    for (const r of refsFromCall(call)) {
      const k = `${r.kind}:${r.id}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(r);
    }
  }
  // PRs are capped separately: they stack as one compact list, not cards.
  const keep = new Set<BuilddObjectRef>([
    ...out.filter(r => r.kind === 'pr').slice(0, MAX_PR_REFS),
    ...out.filter(r => r.kind !== 'pr').slice(0, MAX_REFS_PER_CALL),
  ]);
  return out.filter(r => keep.has(r));
}
