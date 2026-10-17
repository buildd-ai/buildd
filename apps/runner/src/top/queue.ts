/**
 * `buildd top`'s Queue view (spec c7410e76 R-26, AC-12, AC-27, AC-30), derived
 * from state. Pure: the renderer draws these rows and the keys act on them.
 *
 * The order is the server's (GET /api/workers/queue: the claim route's own
 * order, reach and gates for this runner). This file only puts it in words:
 * per team in view (`t` / `w`, R-23), position, title, workspace, mission, the
 * estimate when the team has estimates on, and when the row starts:
 *   - "now" for every row that would start on a free slot right now, so
 *     several rows start together while slots are free;
 *   - what it waits for, in words, when something holds it: the reason the
 *     server gave the runner's last claim of it ("when #4 ends (same files)",
 *     "after its dependency", a limit or hold with the local time it lifts),
 *     since a read cannot see the claim's in-loop deferrals;
 *   - "in ~15m (next free slot)" only when the slots are full, from the
 *     running agents' estimates ("when a slot frees" without any).
 * A row the server is refusing is never "now". A task held on its own (a start
 * time ahead, e.g. a retry floor after failures, or a person's hold) is listed
 * after the queue, not in it, with its reason.
 */
import type { RunnerQueueExclusion, RunnerQueueTask } from '@buildd/shared';
import { taskIdInSentence } from '../claim-outcomes';
import {
  EXCLUSION_WORDS as CLAIM_EXCLUSION_WORDS, MOVED_CODES, RUNNER_COOLDOWN_MS, busySlots, currentTeam, heldNow, inView, isOrganizerTask, liveTaskOutcome, localLiftTime, matchesFilter, providerHolds, roleLabel, wallFor,
  type ClaimOutcome, type ProviderHold, type TopState, type TopTask,
} from './state';

export interface QueueRow {
  taskId: string;
  /** 1-based place in this team's queue; null on a "Not for this runner" row. */
  position: number | null;
  title: string;
  workspace: string;
  /** The mission's title, "(no mission)", or on a "Not for this runner" row, the reason. */
  mission: string;
  /** The estimate in words, "-" with none; null when the team has estimates off. */
  est: string | null;
  /** When it starts: "now", what holds it ("when #4 ends (same files)", a local time), "in ~15m (next free slot)", "on hold", or "-". */
  starts: string;
  /** Set on a row this runner never takes, or one held on its own. */
  reason?: string;
  /** Set on a row held on its own: it is listed after the queue and can still be picked. */
  held?: boolean;
}

export interface QueueSection {
  teamId: string;
  teamName: string;
  estimatesOn: boolean;
  /** Next for this runner: claimable now, or waiting on a hold the whole team shares. */
  rows: QueueRow[];
  /** A per-task hold (a start time, a person's hold): out of the "after N" count, each with its reason. */
  held: QueueRow[];
  notFor: QueueRow[];
}

const EXCLUSION_WORDS: Record<RunnerQueueExclusion, string> = {
  local_session: 'local session',
  another_runner: 'another runner',
  role_missing: 'a role it lacks',
  runner_type: 'another runner type',
  workspace_executor: 'runs elsewhere',
  subject_dead: 'its PR is closed',
};

function exclusionWords(t: RunnerQueueTask & { reason: RunnerQueueExclusion }): string {
  if (t.reason === 'role_missing' && t.roleSlug) return `needs ${roleLabel(t.roleSlug)}`;
  return EXCLUSION_WORDS[t.reason] ?? 'not for this runner';
}

/** `40m`, `1h`, `1h30`, `2d`. */
export function estimateWords(minutes: number): string {
  const m = Math.max(1, Math.round(minutes));
  if (m < 60) return `${m}m`;
  if (m < 48 * 60) {
    const h = Math.floor(m / 60);
    const rest = m % 60;
    return rest === 0 ? `${h}h` : `${h}h${String(rest).padStart(2, '0')}`;
  }
  return `${Math.round(m / 1440)}d`;
}

function future(iso: string | null | undefined, now: number): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  return !Number.isNaN(t) && t > now;
}

/**
 * A time the runner itself knows holds the task: its last claim of it (R-25)
 * or a provider limit holding all of that provider's work. Null when none.
 */
function runnerHoldTime(t: RunnerQueueTask, state: TopState, holds: ProviderHold[], now: number): string | null {
  const asTask: TopTask = { id: t.id, title: t.title, status: 'pending', backend: t.backend };
  const o = liveTaskOutcome(asTask, state, now);
  const backend = t.backend || 'claude';
  if (o) {
    const wall = wallFor(o, backend, now);
    if (wall && future(wall.resetsAt, now)) return localLiftTime(wall.resetsAt!, now);
    if (o.reason === 'context_paused' && future(o.until, now)) return localLiftTime(o.until!, now);
    if (o.exclusion === 'runner_cooldown') return localLiftTime(new Date(o.at + RUNNER_COOLDOWN_MS).toISOString(), now);
    if (future(o.until, now)) return localLiftTime(o.until!, now);
  }
  const header = holds.find(h => h.backend === backend);
  if (header && future(header.resetsAt, now)) return localLiftTime(header.resetsAt!, now);
  return null;
}

/** A hold of this task alone: a start time still ahead, or a hold a person put on it or its mission. */
function heldOnItsOwn(t: RunnerQueueTask, now: number): boolean {
  if (t.holds.includes('task_held') || t.holds.includes('mission_held')) return true;
  return t.holds.includes('deferred') && future(t.holdUntil, now);
}

/** The reason a held row waits, in the R-25 words ("retries after failures, Oct 22 14:07"). */
function heldWords(t: RunnerQueueTask, now: number): { reason: string; starts: string } {
  if (t.holds.includes('task_held')) return { reason: 'held by a person', starts: 'on hold' };
  if (t.holds.includes('mission_held')) return { reason: 'mission is on hold', starts: 'on hold' };
  const at = localLiftTime(t.holdUntil!, now);
  const cause = t.holdCause === 'retry_after_failures' ? 'retries after failures'
    : t.holdCause === 'usage_limit_reset' ? 'retries when the usage limit resets'
    : t.holdCause === 'credential_probe' ? 'rechecks the rejected login'
    : 'starts at its set time';
  return { reason: `${cause}, ${at}`, starts: at };
}

const OVERLAP_CODES = new Set(['soft_overlap', 'path_overlap', 'advisory_manifest', 'ordered_behind']);

function clip(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

/** The title of a task top knows of: the task list, its workers, or the queue. */
function titleOf(taskId: string, state: TopState): string | null {
  const t = state.tasks.find(x => x.id === taskId);
  if (t) return t.title;
  const w = Object.values(state.workers).find(x => x.taskId === taskId);
  if (w?.taskTitle) return w.taskTitle;
  for (const tm of state.queue?.teams ?? []) {
    const q = tm.queue.find(x => x.id === taskId) ?? tm.notForRunner.find(x => x.id === taskId);
    if (q) return q.title;
  }
  return null;
}

/**
 * What the runner's last claim of this task was refused for, in the Queue's
 * words (AC-30): an overlap names the work it waits for by position, else by
 * title. Null when its last claim was not refused, or only said it moved.
 */
function refusalWords(o: ClaimOutcome, positions: Map<string, number>, state: TopState): string | null {
  const code = o.exclusion ?? null;
  if (code && MOVED_CODES.has(code)) return null;
  if (code && OVERLAP_CODES.has(code)) {
    // A runner from before the field sends only the server's sentence, which names the task.
    const holder = o.holderTaskId ?? (code === 'soft_overlap' || code === 'path_overlap' ? taskIdInSentence(o.detail) : null);
    const at = holder ? positions.get(holder) : undefined;
    if (at !== undefined) return `when #${at} ends (same files)`;
    const title = holder ? titleOf(holder, state) : null;
    return title ? `same files as "${clip(title, 18)}"` : 'when work on its files ends';
  }
  if (code === 'deps_blocked') return 'after its dependency';
  if (code && CLAIM_EXCLUSION_WORDS[code]) return CLAIM_EXCLUSION_WORDS[code];
  if (o.reason === 'refused') return o.status === 429 ? 'account is at its worker limit' : 'the server refused its claim';
  if (o.reason === 'no_slots') return 'account is at its worker limit';
  if (code) return o.detail ? clip(o.detail.replace(/\.\s.*$/s, ''), 40) : 'held by the server';
  return null;
}

/** Why the row waits, in words, or null when nothing holds it (it starts on a free slot). */
function waitWords(t: RunnerQueueTask, positions: Map<string, number>, state: TopState, holds: ProviderHold[], now: number): string | null {
  if (t.holds.includes('workspace_paused') && future(t.holdUntil, now)) return localLiftTime(t.holdUntil!, now);
  const own = runnerHoldTime(t, state, holds, now);
  if (own) return own;
  if (t.holds.includes('runner_cooldown')) return localLiftTime(new Date(now + RUNNER_COOLDOWN_MS).toISOString(), now);
  const o = liveTaskOutcome({ id: t.id, title: t.title, status: 'pending', backend: t.backend }, state, now);
  const refused = o && o.reason !== 'claimed' ? refusalWords(o, positions, state) : null;
  if (refused) return refused;
  if (t.holds.includes('deps_blocked')) return 'after its dependency';
  if (t.holds.includes('workspace_cap')) return CLAIM_EXCLUSION_WORDS.workspace_cap;
  return null;
}

/** Remembered estimates (minutes) of the agents running now, soonest to finish first; empty without any. */
function runningRemaining(state: TopState, now: number): number[] {
  const out: number[] = [];
  for (const w of Object.values(state.workers)) {
    if (w.status !== 'working' && w.status !== 'stale') continue;
    const est = state.estimates[w.taskId];
    if (typeof est !== 'number') continue;
    const elapsed = w.startedAt ? (now - w.startedAt) / 60_000 : 0;
    out.push(Math.max(1, Math.round(est - elapsed)));
  }
  return out.sort((a, b) => a - b);
}

/** "6 slots · 1 running · 5 free" (R-26), or "on hold" in place of free while held. */
export function slotsSummary(state: TopState, now: number): string {
  const n = state.runner.maxConcurrent;
  const running = busySlots(state);
  const tail = heldNow(state, now) ? 'on hold' : `${Math.max(0, n - running)} free`;
  return `${n} slot${n === 1 ? '' : 's'} · ${running} running · ${tail}`;
}

/** The Queue view's sections: the teams in view, each in the server's claim order. */
export function queueSections(state: TopState, now: number): QueueSection[] {
  const q = state.queue;
  if (!q) return [];
  const team = currentTeam(state);
  const show = inView(state);
  const holds = providerHolds(state, now);
  const held = heldNow(state, now) !== null;
  const keep = (t: RunnerQueueTask) => !isOrganizerTask(t) && show(t.workspaceId) && matchesFilter(t.title, state.filter);
  const out: QueueSection[] = [];
  // Free slots start rows "now", in the claim's order across the teams in view (AC-27).
  let free = Math.max(0, state.runner.maxConcurrent - busySlots(state));
  const remaining = runningRemaining(state, now);
  let slotWait = 0;
  for (const tm of q.teams) {
    if (team && tm.teamId !== team.key && tm.teamName !== team.name) continue;
    const kept = tm.queue.filter(keep);
    const queued = kept.filter(t => !heldOnItsOwn(t, now));
    const heldTasks = kept.filter(t => heldOnItsOwn(t, now));
    const notFor = tm.notForRunner.filter(keep);
    if (queued.length === 0 && heldTasks.length === 0 && notFor.length === 0) continue;
    const positions = new Map(queued.map((t, i) => [t.id, i + 1]));
    const starts = queued.map(t => {
      // R-33: held, the order stays and nothing has a start time.
      if (held) return 'on hold';
      const w = waitWords(t, positions, state, holds, now);
      if (w) return w;
      if (free > 0) { free--; return 'now'; }
      const left = remaining[slotWait++];
      return left !== undefined ? `in ~${estimateWords(left)} (next free slot)` : 'when a slot frees';
    });
    out.push({
      teamId: tm.teamId,
      teamName: tm.teamName,
      estimatesOn: tm.estimatesOn,
      rows: queued.map((t, i) => ({
        taskId: t.id,
        position: i + 1,
        title: t.title,
        workspace: t.workspaceName,
        mission: t.missionTitle ?? '(no mission)',
        est: tm.estimatesOn ? (t.estimateMinutes != null ? estimateWords(t.estimateMinutes) : '-') : null,
        starts: starts[i],
      })),
      held: heldTasks.map(t => {
        const w = heldWords(t, now);
        return {
          taskId: t.id,
          position: null,
          title: t.title,
          workspace: t.workspaceName,
          mission: w.reason,
          est: tm.estimatesOn ? (t.estimateMinutes != null ? estimateWords(t.estimateMinutes) : '-') : null,
          starts: w.starts,
          reason: w.reason,
          held: true,
        };
      }),
      notFor: notFor.map(t => ({
        taskId: t.id,
        position: null,
        title: t.title,
        workspace: t.workspaceName,
        mission: exclusionWords(t),
        est: tm.estimatesOn ? '-' : null,
        starts: '-',
        reason: exclusionWords(t),
      })),
    });
  }
  return out;
}

/** Every row of the Queue view in drawn order: what ↑↓ moves over. */
export function queueRowList(state: TopState, now: number): QueueRow[] {
  return queueSections(state, now).flatMap(s => [...s.rows, ...s.held, ...s.notFor]);
}

/** The selected Queue row, or null when the view has none. */
export function selectedQueueRow(state: TopState, now: number): QueueRow | null {
  const rows = queueRowList(state, now);
  if (rows.length === 0) return null;
  return rows[Math.min(state.queueCursor, rows.length - 1)];
}
