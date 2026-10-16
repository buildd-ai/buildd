/**
 * `buildd top`'s Queue view (spec c7410e76 R-26, AC-12), derived from state.
 * Pure: the renderer draws these rows and the keys act on them.
 *
 * The order is the server's (GET /api/workers/queue: the claim route's own
 * order, reach and gates for this runner). This file only puts it in words:
 * per team in view (`t` / `w`, R-23), position, title, workspace, mission, the
 * estimate when the team has estimates on, and when the row is expected to
 * start. A hold with a time says the local time it lifts; one the runner's
 * last claim was refused for (a plan limit, a cooldown, R-25) is read from
 * that outcome, since a read cannot see the claim's in-loop deferrals. Every
 * other row starts "after N", N being the position ahead of it. A task held
 * on its own (a start time ahead, e.g. a retry floor after failures, or a
 * person's hold) is listed after the queue, not in it, with its reason, so
 * "after N" counts only what the runner can take.
 */
import type { RunnerQueueExclusion, RunnerQueueTask } from '@buildd/shared';
import {
  RUNNER_COOLDOWN_MS, currentTeam, inView, isOrganizerTask, liveTaskOutcome, localLiftTime, matchesFilter, providerHolds, roleLabel, wallFor,
  type ProviderHold, type TopState, type TopTask,
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
  /** When it is expected to start: a local time, "next", "after N", "on hold", or "-". */
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

/** When the row at `index` (0-based, in this team's queue) is expected to start. */
function startWords(t: RunnerQueueTask, index: number, positions: Map<string, number>, state: TopState, holds: ProviderHold[], now: number): string {
  if (t.holds.includes('workspace_paused') && future(t.holdUntil, now)) return localLiftTime(t.holdUntil!, now);
  const own = runnerHoldTime(t, state, holds, now);
  if (own) return own;
  if (t.holds.includes('runner_cooldown')) return localLiftTime(new Date(now + RUNNER_COOLDOWN_MS).toISOString(), now);
  if (t.holds.includes('deps_blocked')) {
    const ahead = t.dependsOn.map(id => positions.get(id)).filter((p): p is number => p !== undefined);
    return ahead.length > 0 ? `after ${Math.max(...ahead)}` : 'after its dependency';
  }
  return index === 0 ? 'next' : `after ${index}`;
}

/** The Queue view's sections: the teams in view, each in the server's claim order. */
export function queueSections(state: TopState, now: number): QueueSection[] {
  const q = state.queue;
  if (!q) return [];
  const team = currentTeam(state);
  const show = inView(state);
  const holds = providerHolds(state, now);
  const keep = (t: RunnerQueueTask) => !isOrganizerTask(t) && show(t.workspaceId) && matchesFilter(t.title, state.filter);
  const out: QueueSection[] = [];
  for (const tm of q.teams) {
    if (team && tm.teamId !== team.key && tm.teamName !== team.name) continue;
    const kept = tm.queue.filter(keep);
    const queued = kept.filter(t => !heldOnItsOwn(t, now));
    const heldTasks = kept.filter(t => heldOnItsOwn(t, now));
    const notFor = tm.notForRunner.filter(keep);
    if (queued.length === 0 && heldTasks.length === 0 && notFor.length === 0) continue;
    const positions = new Map(queued.map((t, i) => [t.id, i + 1]));
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
        starts: startWords(t, i, positions, state, holds, now),
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
