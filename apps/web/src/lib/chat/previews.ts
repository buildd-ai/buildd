/**
 * Approval-card previews: for a proposed write, exactly what will change, as
 * before → after, built from the target's current state through the chat's
 * reach-guarded reads (knowledge-base: buildd/design/agent-chat.md → Approval cards).
 *
 *   "Hold task: checkout · Stripe in currency (running on dune)"
 *     Claims: open → held
 *     The agent running on dune is told to stop at a safe point and wait.
 *
 * The same builder runs twice: when the card is proposed (turn.ts →
 * toolApproval) and again when the approval arrives (tools.ts). The second
 * run must land on the same target with the same `fingerprint` (a hash of the
 * before-state), or nothing is written: you approve what you saw.
 *
 * A reference that doesn't resolve to exactly one target (an ambiguous
 * "checkout") yields a question instead of a preview, and no card.
 */

import { isLiveWorkerStatus, isSystemRoleSlug, isTerminalTaskStatus } from '@buildd/shared';
import { systemRoleIntent, VISUAL_REVIEW_IS_MISSION_SCOPED } from '@/lib/system-role-intent';
import type { ApiFn } from '@buildd/core/mcp-tools';
import type { ChatApprovalPreview } from '@buildd/shared';
import { hashToolInput } from './canonical';
import { opSpec } from './registry';
import { isUuid, resolveTaskRef, type TaskScope } from './targets';
import { watchEventTypes, watchWhenPhrase } from '@/lib/watch-notice';
import { findWatch, ONE_SHOT_ENDS, parsePrNumber } from './watch-tools';

export interface PreviewEnv {
  /** Reach-guarded, GET-only API. */
  read: ApiFn;
  /** Where task names are matched (the docked mission, else the default workspace). */
  scope: TaskScope;
}

export type PreviewOutcome =
  | { ok: true; preview: ChatApprovalPreview; input: Record<string, unknown> }
  | { ok: false; question: string };

type Obj = Record<string, any>;
type Change = ChatApprovalPreview['changes'][number];

const LIVE_WORKER = (w: Obj) => isLiveWorkerStatus(w?.status);
const clip = (s: unknown, n = 140): string | null => {
  if (s === undefined || s === null || s === '') return null;
  const t = (typeof s === 'string' ? s : JSON.stringify(s)).replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
/** Models send `"true"` / `"false"` as often as booleans. */
export const asBool = (v: unknown, dflt: boolean): boolean =>
  v === undefined || v === null ? dflt : v === true || v === 'true' ? true : v === false || v === 'false' ? false : dflt;
/** A list param sent as one string is a list of one. */
const listOf = (v: unknown): unknown[] => {
  if (Array.isArray(v)) return v;
  if (typeof v !== 'string' || !v.trim()) return [];
  // …or as a JSON-encoded list.
  if (v.trim().startsWith('[')) {
    try { const parsed = JSON.parse(v); if (Array.isArray(parsed)) return parsed; } catch { /* a plain string */ }
  }
  return [v];
};
/** "http://dune.local:8766" → "dune"; a plain name stays as it is. */
export function runnerName(r: unknown): string {
  const s = String(r ?? '');
  try {
    const host = new URL(s).hostname;
    return host.replace(/\.(local|lan|internal)$/, '') || s;
  } catch {
    return s;
  }
}

function fingerprint(targetId: string, changes: Change[], extra: unknown = null): string {
  return hashToolInput({ t: targetId, b: changes.map(c => c.before), x: extra });
}

function question(q: string): PreviewOutcome {
  return { ok: false, question: q };
}

// ── Targets ──────────────────────────────────────────────────────────────────

interface LoadedTask { task: Obj; live: Obj | null }

async function loadTask(read: ApiFn, id: string): Promise<LoadedTask> {
  const task = await read(`/api/tasks/${id}?include=workers`);
  const workers = Array.isArray(task?.workers) ? task.workers : [];
  return { task, live: workers.find(LIVE_WORKER) ?? null };
}

function taskLabel(t: Obj): string {
  return String(t.title ?? t.label ?? 'task');
}

function workerDetail(t: Obj, live: Obj | null): string | undefined {
  if (t?.context?.heldBy) return 'held';
  if (!live) return t?.status ? String(t.status) : undefined;
  if (live.status === 'waiting_input') return 'needs input';
  return `running${live.runner ? ` on ${runnerName(live.runner)}` : ''}`;
}

async function resolveTask(env: PreviewEnv, ref: unknown): Promise<{ ok: true; loaded: LoadedTask } | { ok: false; question: string }> {
  const r = await resolveTaskRef(env.read, ref, env.scope);
  if (!r.ok) return r;
  try {
    return { ok: true, loaded: await loadTask(env.read, r.id) };
  } catch {
    return { ok: false, question: 'That task isn\'t available here (not found, or outside this conversation\'s team). Ask the user which task they mean.' };
  }
}

// ── Builders ─────────────────────────────────────────────────────────────────

type Builder = (input: Obj, env: PreviewEnv) => Promise<PreviewOutcome>;

const TASK_FIELDS: Array<[string, string]> = [
  ['title', 'Title'], ['description', 'Description'], ['priority', 'Priority'], ['status', 'Status'],
  ['project', 'Project'], ['backend', 'Backend'], ['tier', 'Tier'], ['model', 'Model'], ['maxLoops', 'Max loops'],
];

const updateTask: Builder = async (input, env) => {
  const t = await resolveTask(env, input.taskId);
  if (!t.ok) return question(t.question);
  const { task, live } = t.loaded;
  const changes: Change[] = [];
  for (const [k, label] of TASK_FIELDS) {
    if (input[k] === undefined) continue;
    changes.push({ label, before: clip(task[k]), after: clip(input[k]) });
  }
  if (changes.length === 0) return question('Nothing to change on that task: say what should change.');
  const verb = input.status === 'cancelled' ? 'Cancel task'
    : input.status === 'pending' && ['failed', 'cancelled', 'completed'].includes(task.status) ? 'Re-run task'
      : 'Edit task';
  const note = input.description !== undefined && live
    ? 'The running agent gets the new description as an urgent message.'
    : input.status === 'cancelled' && live ? 'The running agent is stopped.' : undefined;
  return {
    ok: true,
    input: { ...input, taskId: task.id },
    preview: {
      v: 1, verb,
      target: { kind: 'task', id: task.id, label: taskLabel(task), detail: workerDetail(task, live), workspaceId: task.workspaceId ?? null },
      changes, ...(note ? { note } : {}),
      fingerprint: fingerprint(task.id, changes, { status: task.status }),
    },
  };
};

const holdTask: Builder = async (input, env) => {
  const t = await resolveTask(env, input.taskId);
  if (!t.ok) return question(t.question);
  const { task, live } = t.loaded;
  const hold = asBool(input.hold, true);
  const isHeld = !!task.context?.heldBy;
  if (hold === isHeld) return question(`That task is already ${isHeld ? 'held' : 'not held'}. Tell the user; nothing to change.`);
  if (hold && ['completed', 'failed', 'cancelled'].includes(task.status)) return question(`That task is ${task.status}; there's nothing to hold.`);
  const changes: Change[] = [{ label: 'Claims', before: isHeld ? 'held' : 'open', after: hold ? 'held' : 'open' }];
  const reason = str(input.reason);
  if (hold && reason) changes.push({ label: 'Until', before: null, after: clip(reason)! });
  const where = live?.runner ? ` on ${runnerName(live.runner)}` : '';
  const note = live
    ? (hold ? `The agent running${where} is told to stop at a safe point and wait.` : `The agent${where} is told to carry on.`)
    : hold ? 'No agent picks it up until you resume it.' : 'It can be claimed again.';
  return {
    ok: true,
    input: { ...input, taskId: task.id, hold },
    preview: {
      v: 1, verb: hold ? 'Hold task' : 'Resume task',
      target: { kind: 'task', id: task.id, label: taskLabel(task), detail: workerDetail(task, live), workspaceId: task.workspaceId ?? null },
      changes, note, fingerprint: fingerprint(task.id, changes, { live: live?.id ?? null }),
    },
  };
};

const sendAgentMessage: Builder = async (input, env) => {
  const t = await resolveTask(env, input.taskId);
  if (!t.ok) return question(t.question);
  const { task, live } = t.loaded;
  if (!live) {
    return question(`No agent is running on "${taskLabel(task)}" (it's ${task.status}), so a message would never be read. Offer a follow-up task instead (create_task under the same mission).`);
  }
  const message = str(input.message);
  if (!message) return question('What should the agent be told?');
  const changes: Change[] = [{ label: 'Message', before: null, after: clip(message, 400)! }];
  return {
    ok: true,
    input: { ...input, taskId: task.id },
    preview: {
      v: 1, verb: 'Message the agent on',
      target: { kind: 'task', id: task.id, label: taskLabel(task), detail: workerDetail(task, live), workspaceId: task.workspaceId ?? null },
      changes,
      note: input.priority === 'urgent' ? 'Urgent: delivered at the agent\'s next step.' : 'Delivered when the agent next checks in.',
      fingerprint: fingerprint(task.id, changes, { live: live.id }),
    },
  };
};

const answerQuestion: Builder = async (input, env) => {
  const t = await resolveTask(env, input.taskId);
  if (!t.ok) return question(t.question);
  const { task } = t.loaded;
  const workers = Array.isArray(task.workers) ? task.workers : [];
  const waiting = workers.find((w: Obj) => w.status === 'waiting_input' && w.waitingFor);
  if (!waiting) return question(`"${taskLabel(task)}" isn't waiting on a question right now.`);
  const answer = str(input.answer);
  if (!answer) return question('What\'s the answer?');
  const prompt = clip(waiting.waitingFor?.prompt, 160) ?? 'Question';
  const changes: Change[] = [{ label: prompt, before: null, after: clip(answer, 400)! }];
  return {
    ok: true,
    input: { ...input, taskId: task.id, workerId: waiting.id },
    preview: {
      v: 1, verb: 'Answer the question on',
      target: { kind: 'question', id: waiting.id, label: taskLabel(task), detail: 'needs input', workspaceId: task.workspaceId ?? null },
      changes, note: 'The agent resumes with this answer.',
      fingerprint: fingerprint(waiting.id, changes, { prompt }),
    },
  };
};

/** A workspace by id or name, among the reach-filtered workspace list; null when out of reach. */
async function workspaceOf(env: PreviewEnv, ref: string | null): Promise<{ id: string; name: string } | null> {
  if (!ref) return null;
  try {
    const data = await env.read('/api/workspaces');
    const list = (Array.isArray(data?.workspaces) ? data.workspaces : []) as Obj[];
    const w = list.find(x => x.id === ref) ?? list.find(x => String(x.name ?? '').toLowerCase() === ref.toLowerCase());
    return w ? { id: String(w.id), name: String(w.name ?? 'workspace') } : null;
  } catch {
    return null;
  }
}

async function missionOf(env: PreviewEnv, id: unknown): Promise<Obj | null> {
  const mid = str(id) ?? env.scope.missionId ?? null;
  if (!mid) return null;
  try { return await env.read(`/api/missions/${mid}`); } catch { return null; }
}

/** What chat says instead of filing a visual-auditor task. */
export function visualReviewNotATask(mission: { id: string; title?: unknown } | null): string {
  const intent = systemRoleIntent({ roleSlug: 'visual-auditor', missionId: mission?.id ?? null });
  if (intent?.kind !== 'mission') return `${VISUAL_REVIEW_IS_MISSION_SCOPED} Ask the user which mission to review.`;
  return `A visual review is not a task to file: it is the mission's own command. Nothing was filed. Tell the user to open "${String(mission!.title ?? 'the mission')}" and press Visual review there: ${intent.href}`;
}

const createTask: Builder = async (input, env) => {
  // `missionId: null` is the explicit "no mission": it beats the docked mission
  // and the one this conversation filed. Omitted means inherit, and the card says so.
  const standalone = input.missionId === null;
  const mission = standalone ? null : await missionOf(env, input.missionId);
  if (input.missionId && !mission) return question('That mission isn\'t available here. Ask the user which mission the task belongs to.');
  // A visual review is the mission's own command, never a hand-written
  // visual-auditor task: that would miss its dependencies, routes and evidence.
  if (isSystemRoleSlug(str(input.roleSlug))) return question(visualReviewNotATask(mission ? { id: String(mission.id), title: mission.title } : null));
  const dependsOn: string[] = [];
  const depLabels: string[] = [];
  for (const ref of listOf(input.dependsOn)) {
    const r = await resolveTask(env, ref);
    if (!r.ok) return question(r.question);
    dependsOn.push(r.loaded.task.id);
    depLabels.push(taskLabel(r.loaded.task));
  }
  const title = str(input.title);
  if (!title) return question('What should the task be called?');
  const changes: Change[] = [{ label: 'Title', before: null, after: clip(title)! }];
  const desc = clip(str(input.description)?.split(/\n\s*\n/)[0], 200);
  if (desc) changes.push({ label: 'Brief', before: null, after: desc });
  if (depLabels.length) changes.push({ label: 'After', before: null, after: depLabels.join(', ') });
  if (str(input.baseBranch)) changes.push({ label: 'Branch', before: null, after: str(input.baseBranch)! });
  if (str(input.roleSlug)) changes.push({ label: 'Role', before: null, after: str(input.roleSlug)! });
  const paths = listOf(input.pathManifest).filter((p): p is string => typeof p === 'string');
  if (paths.length) changes.push({ label: 'Paths', before: null, after: clip(paths.join(', '), 200)! });
  if (standalone) changes.push({ label: 'Mission', before: null, after: 'none' });
  const workspaceId = str(input.workspaceId) ?? mission?.workspaceId ?? env.scope.workspaceId ?? null;
  const { missionId: _missionId, ...rest } = input;
  return {
    ok: true,
    input: {
      ...rest,
      ...(mission ? { missionId: mission.id } : {}),
      ...(dependsOn.length ? { dependsOn } : {}),
      ...(paths.length ? { pathManifest: paths } : {}),
      ...(workspaceId && !input.workspaceId ? { workspaceId } : {}),
    },
    preview: {
      v: 1, verb: mission ? 'New task in' : 'New task',
      target: mission
        ? { kind: 'mission', id: mission.id, label: String(mission.title), workspaceId: mission.workspaceId ?? null }
        : { kind: 'workspace', id: workspaceId ?? 'default', label: 'this workspace', workspaceId },
      changes, fingerprint: fingerprint(mission?.id ?? workspaceId ?? '', changes),
    },
  };
};

function criterionText(c: Obj): string {
  return String(c?.label ?? c?.description ?? c?.command ?? c?.type ?? 'criterion');
}

const MISSION_FIELDS: Array<[string, string]> = [
  ['title', 'Title'], ['description', 'Goal'], ['status', 'Status'], ['priority', 'Priority'],
  ['cronExpression', 'Schedule'], ['orchestrationMode', 'Orchestration'], ['maxConcurrentTasks', 'Max concurrent tasks'],
  ['costBudgetUsd', 'Budget (USD)'], ['pacingMode', 'Pacing'], ['autoVerify', 'Auto-verify'], ['model', 'Model'],
];

const updateMission: Builder = async (input, env) => {
  const m = await missionOf(env, input.missionId);
  if (!m) return question('Which mission? It isn\'t docked and none was named.');
  const changes: Change[] = [];
  for (const [k, label] of MISSION_FIELDS) {
    if (input[k] === undefined) continue;
    changes.push({ label, before: clip(m[k]), after: clip(input[k]) });
  }
  if (input.startMode !== undefined) changes.push({ label: 'Start', before: m.isHeld ? 'held' : 'armed', after: String(input.startMode) });
  if (input.autoSurfaceAudit !== undefined) {
    // The column defaults to on: a mission row without it has the audit on.
    const on = asBool(input.autoSurfaceAudit, true);
    changes.push({ label: 'Automatic visual audit', before: m.autoSurfaceAudit === false ? 'off' : 'on', after: on ? 'on' : 'off' });
    // The route takes a boolean only; run what the card said.
    input = { ...input, autoSurfaceAudit: on };
  }
  if (input.executor !== undefined) changes.push({ label: 'Runs in', before: m.executor === 'local' ? 'a local session' : 'runners', after: input.executor === 'local' ? 'a local session' : 'runners' });
  // Add or remove criteria against the mission's CURRENT list, so a change
  // never drops a criterion the model couldn't see in full.
  const add = listOf(input.addGoalCriteria).filter((c): c is Obj => !!c && typeof c === 'object');
  const remove = listOf(input.removeGoalCriteria).map(String);
  if (add.length || remove.length) {
    const current = Array.isArray(m.goalCriteria) ? m.goalCriteria : [];
    const kept = current.filter((c: Obj) => !remove.includes(criterionText(c)));
    const { addGoalCriteria: _a, removeGoalCriteria: _r, ...rest } = input;
    input = { ...rest, goalCriteria: [...kept, ...add] };
  }
  if (Array.isArray(input.goalCriteria)) {
    const before = (Array.isArray(m.goalCriteria) ? m.goalCriteria : []).map(criterionText);
    const after = input.goalCriteria.map(criterionText);
    for (const a of after) if (!before.includes(a)) changes.push({ label: 'Goal criteria', before: null, after: a });
    for (const b of before) if (!after.includes(b)) changes.push({ label: 'Goal criteria', before: b, after: null });
  }
  if (changes.length === 0) return question('Nothing to change on that mission: say what should change.');
  const verb = input.status === 'paused' ? 'Pause mission' : input.status === 'active' && m.status === 'paused' ? 'Resume mission'
    : input.startMode === 'held' ? 'Hold mission' : 'Edit mission';
  return {
    ok: true,
    input: { ...input, missionId: m.id },
    preview: {
      v: 1, verb,
      target: { kind: 'mission', id: m.id, label: String(m.title), detail: m.isHeld ? 'held' : m.executor === 'local' ? 'local' : m.status, workspaceId: m.workspaceId ?? null },
      changes,
      ...(input.startMode === 'held' || input.status === 'paused' ? { note: 'No new tasks are claimed until it\'s resumed; running agents finish their current step.' } : {}),
      fingerprint: fingerprint(m.id, changes, { status: m.status, held: m.isHeld }),
    },
  };
};

const armMission: Builder = async (input, env) => {
  const m = await missionOf(env, input.missionId);
  if (!m) return question('Which mission should be armed?');
  if (!m.isHeld) return question(`"${m.title}" isn't held, so there's nothing to arm.`);
  const changes: Change[] = [{ label: 'Start', before: 'held', after: 'armed' }];
  return {
    ok: true, input: { ...input, missionId: m.id },
    preview: {
      v: 1, verb: 'Arm mission', target: { kind: 'mission', id: m.id, label: String(m.title), detail: 'held', workspaceId: m.workspaceId ?? null },
      changes, note: 'Its tasks become claimable by agents now.', fingerprint: fingerprint(m.id, changes),
    },
  };
};

const createSchedule: Builder = async (input, env) => {
  const name = str(input.name);
  const cron = str(input.cronExpression);
  if (!name || !cron) return question('A schedule needs a name and when it runs.');
  const changes: Change[] = [
    { label: 'Name', before: null, after: name },
    { label: 'Runs', before: null, after: `${cron}${str(input.timezone) ? ` (${str(input.timezone)})` : ''}` },
  ];
  if (str(input.title)) changes.push({ label: 'Each run files', before: null, after: clip(input.title)! });
  const ws = await workspaceOf(env, str(input.workspaceId) ?? env.scope.workspaceId ?? null);
  if (!ws) return question('Which workspace should the schedule run in? (It must be one this conversation can reach.)');
  const workspaceId = ws.id;
  return {
    ok: true, input: { ...input, workspaceId },
    preview: {
      v: 1, verb: 'New schedule in', target: { kind: 'workspace', id: workspaceId, label: ws.name, workspaceId },
      changes, fingerprint: fingerprint(workspaceId, changes),
    },
  };
};

/**
 * "Watch: PR #42 (billing-web)" / When: it merges / Where: here / Ends: after
 * it tells you once, or in 7 days. What, until when, and where it goes.
 */
const watch: Builder = async (input, env) => {
  const pr = parsePrNumber(input.prNumber);
  const hasTask = str(input.taskId) !== null;
  if (hasTask === (pr !== null)) return question('Which task or PR should be watched? Name exactly one.');
  let target: ChatApprovalPreview['target'];
  let normalized: Obj;
  let extra: unknown = null;
  let types: string[];
  if (hasTask) {
    const t = await resolveTask(env, input.taskId);
    if (!t.ok) return question(t.question);
    const { task } = t.loaded;
    if (isTerminalTaskStatus(task.status)) return question(`"${taskLabel(task)}" is already ${task.status}, so there is nothing left to watch for. Tell the user.`);
    types = watchEventTypes('task', input.on);
    if (types.length === 0) return question('A task can be watched for: done, failed, or needs_input.');
    target = { kind: 'task', id: task.id, label: taskLabel(task), detail: String(task.status), workspaceId: task.workspaceId ?? null };
    normalized = { taskId: task.id, on: types };
    extra = { status: task.status };
  } else {
    const ws = await workspaceOf(env, str(input.workspaceId) ?? env.scope.workspaceId ?? null);
    if (!ws) return question(`Which workspace is PR #${pr} in? (It must be one this conversation can reach.)`);
    types = watchEventTypes('pr', input.on);
    if (types.length === 0) return question('A PR can be watched for: merged, or ci_failed.');
    target = { kind: 'pr', id: `${ws.id}#${pr}`, label: `PR #${pr}`, detail: ws.name, workspaceId: ws.id };
    normalized = { workspaceId: ws.id, prNumber: pr, on: types };
  }
  const changes: Change[] = [
    { label: 'When', before: null, after: watchWhenPhrase(types) },
    { label: 'Where', before: null, after: 'here, in this conversation' },
    { label: 'Ends', before: null, after: ONE_SHOT_ENDS },
  ];
  return {
    ok: true,
    input: normalized,
    preview: { v: 1, verb: 'Watch', target, changes, fingerprint: fingerprint(target.id, changes, { extra, types }) },
  };
};

/** Only shown when tool output is in context (turn.ts); otherwise unwatch runs without a card. */
const unwatch: Builder = async (input, env) => {
  const data = await env.read('/api/subscriptions');
  const list = (Array.isArray(data?.subscriptions) ? data.subscriptions : []) as Parameters<typeof findWatch>[0];
  const found = findWatch(list, input);
  if (!found.ok) return question(found.question);
  const w = found.watch;
  const changes: Change[] = [{ label: 'Watch', before: `tell you when ${watchWhenPhrase(w.eventTypes)}`, after: null }];
  return {
    ok: true,
    input: { watchId: w.id },
    preview: {
      v: 1, verb: 'Stop watching', target: { kind: 'subscription', id: w.id, label: w.label ?? 'this watch', workspaceId: w.workspaceId ?? null },
      changes, fingerprint: fingerprint(w.id, changes),
    },
  };
};

/** Every other write: the named target, and each field set, before → after when readable. */
const generic = (tool: string, op: string): Builder => async (input, env) => {
  const s = opSpec(tool, input);
  const target = s?.spec.target;
  let id = 'conversation';
  let label = 'this team';
  let kind = 'team';
  let current: Obj | null = null;
  let workspaceId: string | null = env.scope.workspaceId ?? null;
  if (target && 'param' in target) {
    const raw = input[target.param];
    kind = target.is;
    if (target.is === 'task') {
      const t = await resolveTask(env, raw);
      if (!t.ok) return question(t.question);
      current = t.loaded.task;
      id = current.id;
      label = taskLabel(current);
      workspaceId = current.workspaceId ?? null;
      input = { ...input, [target.param]: id };
    } else if (target.is === 'mission') {
      const m = await missionOf(env, raw);
      if (!m) return question('Which mission?');
      current = m; id = m.id; label = String(m.title); workspaceId = m.workspaceId ?? null;
      input = { ...input, [target.param]: id };
    } else {
      const v = str(raw) ?? (target.is === 'workspace' ? env.scope.workspaceId ?? null : null);
      if (!v) return question(`Which ${target.is.replace('_', ' ')}? Pass its id.`);
      id = v; label = v.length > 12 && isUuid(v) ? `${target.is.replace('_', ' ')} ${v.slice(0, 8)}` : v;
      if (target.is === 'workspace') workspaceId = v;
      input = { ...input, [target.param]: v };
    }
  }
  const skip = new Set(['action', 'workspaceId', 'teamId', ...(target && 'param' in target ? [target.param] : [])]);
  const changes: Change[] = Object.entries(input)
    .filter(([k, v]) => !skip.has(k) && v !== undefined)
    .map(([k, v]) => ({ label: k, before: current ? clip(current[k]) : null, after: clip(v) }));
  const verb = `${tool.replace(/^manage_/, '').replace(/_/g, ' ')}${op ? ` · ${op.replace(/_/g, ' ')}` : ''}`;
  return {
    ok: true, input,
    preview: {
      v: 1, verb: verb.charAt(0).toUpperCase() + verb.slice(1),
      target: { kind, id, label, workspaceId },
      changes, fingerprint: fingerprint(id, changes),
    },
  };
};

const BUILDERS: Record<string, Builder> = {
  update_task: updateTask,
  hold_task: holdTask,
  send_agent_message: sendAgentMessage,
  answer_question: answerQuestion,
  create_task: createTask,
  'manage_missions.update': updateMission,
  'manage_missions.arm': armMission,
  create_schedule: createSchedule,
  watch,
  unwatch,
};

/** Build the card for a proposed write (or a question when the target is unclear). */
export async function buildPreview(tool: string, input: Record<string, unknown>, env: PreviewEnv, opts: { confirmAdmin?: boolean } = {}): Promise<PreviewOutcome> {
  const s = opSpec(tool, input);
  const op = s?.op ?? '';
  const key = op ? `${tool}.${op}` : tool;
  const build = BUILDERS[key] ?? generic(tool, op);
  let out: PreviewOutcome;
  try {
    out = await build(input, env);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return question(/404|not available to chat/.test(msg)
      ? 'That isn\'t available here (not found, or outside this conversation\'s team). Ask the user what they mean.'
      : `I couldn't read the current state to show what would change (${msg.slice(0, 120)}).`);
  }
  if (out.ok && opts.confirmAdmin) out.preview.confirmText = out.preview.target.label;
  return out;
}

/** The execution-time check: same target, same before-state as the approved card. */
export function previewMatches(approved: ChatApprovalPreview, now: ChatApprovalPreview): boolean {
  return approved.target.id === now.target.id && approved.fingerprint === now.fingerprint;
}
