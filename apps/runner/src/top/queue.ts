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
 * A row that shares only mergeable files with an open PR or a live lease (the
 * server's `alongside`) also says it "starts alongside #n (same files, merges
 * at the end)": the claim starts it next to that work, and the merge settles it.
 * A row the server is refusing is never "now". A task held on its own (a start
 * time ahead, e.g. a retry floor after failures, or a person's hold) is listed
 * after the queue, not in it, with its reason.
 *
 * The server's `wait` (spec "Overlap scheduling", AC-10) is the one reason
 * explain, the task page and the web Queue give: read from the claim route's
 * own query and gates. When it says the task waits (a declared dependency, its
 * lane place, a limit), the row says that; when it says only a free slot, an
 * older refusal on overlap or a dependency no longer holds and is not repeated.
 */
import { TERMS, queueWaitShort, titleWithAttempt, type QueueWait, type RunnerQueueExclusion, type RunnerQueueTask } from '@buildd/shared';
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
  /** The task's mission, so the Missions view can list queued work the task list did not send. */
  missionId: string | null;
  roleSlug?: string | null;
  workspace: string;
  /** Whose work it is (R-58): "you", a teammate's first name, or "-" when buildd cannot tell. */
  by: string;
  /** The mission's title, or "-" for a task outside any mission. */
  mission: string;
  /** The estimate in words, "-" with none; null when the team has estimates off. */
  est: string | null;
  /**
   * When it starts: "now", what holds it ("when #4 ends (same files)", a local
   * time), "in ~15m (next free slot)", "paused"; on a held row the time then
   * why ("18:26 · retries after failures"); on a "Not for this runner" row, why.
   */
  starts: string;
  /** Set on a row this runner never takes, or one held on its own. */
  reason?: string;
  /** Set on a "Not for this runner" row: the server's reason code. */
  exclusion?: RunnerQueueExclusion;
  /** Set on a row held on its own: it is listed after the queue and can still be picked. */
  held?: boolean;
  /** "starts alongside #n (same files, merges at the end)" when it shares only mergeable files with other work. */
  alongside?: string;
  /** On a queued row that waits: what kind of thing it waits for (the Next line counts these). */
  wait?: WaitKind;
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
  local_session: 'runs from your session',
  another_runner: 'another runner takes it',
  role_missing: 'needs a role this runner lacks',
  runner_type: 'for another kind of runner',
  workspace_executor: 'its workspace runs work elsewhere',
  subject_dead: 'its PR is closed',
};

/** Whose work a row is, in the by column (R-58); an older server sends no owner and reads "-". */
export function ownerWords(t: RunnerQueueTask): string {
  if (t.owner === 'you') return 'you';
  if (t.owner === 'teammate') return t.ownerName || 'teammate';
  return '-';
}

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

/**
 * Why a held row waits, in the R-25 words ("retries after failures, Oct 22
 * 14:07"), and its starts column: the time first, so a narrow column keeps it.
 */
function heldWords(t: RunnerQueueTask, now: number): { reason: string; starts: string } {
  const paused = TERMS['work.paused'].short;
  if (t.holds.includes('task_held')) return { reason: CLAIM_EXCLUSION_WORDS.task_held, starts: `${paused} · by a person` };
  if (t.holds.includes('mission_held')) return { reason: CLAIM_EXCLUSION_WORDS.mission_held, starts: `${paused} · ${CLAIM_EXCLUSION_WORDS.mission_held}` };
  const at = localLiftTime(t.holdUntil!, now);
  const cause = t.holdCause === 'retry_after_failures' ? 'retries after failures'
    : t.holdCause === 'usage_limit_reset' ? 'after the usage limit resets'
    : t.holdCause === 'credential_probe' ? 'rechecks its login'
    : 'scheduled';
  return { reason: `${cause}, ${at}`, starts: `${at} · ${cause}` };
}

const OVERLAP_CODES = new Set(['soft_overlap', 'path_overlap', 'advisory_manifest', 'ordered_behind']);

function clip(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

/** Same words as the server's explain (apps/web/src/lib/explain-coordination.ts). */
export function startsAlongsideWords(who: string): string {
  return `starts alongside ${who} (same files, merges at the end)`;
}

/** The work a row starts alongside, in words: the PR as `#n`, else the holder by title. */
function alongsideWords(a: NonNullable<RunnerQueueTask['alongside']>, state: TopState): string {
  if (a.prNumber) return startsAlongsideWords(`#${a.prNumber}`);
  const title = a.holderTaskId ? titleOf(a.holderTaskId, state) : null;
  return startsAlongsideWords(title ? `"${clip(title, 24)}"` : a.holderTaskId ? `task ${a.holderTaskId.slice(0, 8)}` : 'other work');
}

/** The title of a task top knows of: the task list, its workers, or the queue. Never its retry key. */
function titleOf(taskId: string, state: TopState): string | null {
  const raw = rawTitleOf(taskId, state);
  return raw == null ? null : titleWithAttempt(raw);
}

function rawTitleOf(taskId: string, state: TopState): string | null {
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
    return holderWords(holder, positions, state);
  }
  if (code === 'deps_blocked') return 'after its dependency';
  if (code && CLAIM_EXCLUSION_WORDS[code]) return CLAIM_EXCLUSION_WORDS[code];
  if (o.reason === 'refused') return o.status === 429 ? 'account has no free slot' : 'the server refused its claim';
  if (o.reason === 'no_slots') return 'account has no free slot';
  if (code) return o.detail ? clip(o.detail.replace(/\.\s.*$/s, ''), 40) : TERMS['wait.unknown'].short;
  return null;
}

/** What kind of thing a row waits for: the Next line (R-59) counts rows by it. */
export type WaitKind = 'same_files' | 'dependency' | 'time' | 'limit';

/** The kind of a refusal's words, from the same code refusalWords read. */
function refusalKind(o: ClaimOutcome): WaitKind {
  const code = o.exclusion ?? null;
  if (code && OVERLAP_CODES.has(code)) return 'same_files';
  if (code === 'deps_blocked') return 'dependency';
  return 'limit';
}

/** Words for the work an overlap waits for: its position here, else its title. */
function holderWords(holder: string | null | undefined, positions: Map<string, number>, state: TopState): string {
  const at = holder ? positions.get(holder) : undefined;
  if (at !== undefined) return `when #${at} ends (same files)`;
  const title = holder ? titleOf(holder, state) : null;
  return title ? `same files as "${clip(title, 18)}"` : 'when work on its files ends';
}

/** The kind of the server's wait, for the Next line's counts. */
const SERVER_WAIT_KIND: Record<QueueWait['kind'], WaitKind | null> = { declared: 'dependency', lane: 'same_files', limit: 'limit', start_time: 'time', slot: null };

/** Why the row waits, in words and kind, or null when nothing holds it (it starts on a free slot). */
function waitWords(t: RunnerQueueTask, positions: Map<string, number>, state: TopState, holds: ProviderHold[], now: number): { text: string; kind: WaitKind } | null {
  if (t.holds.includes('workspace_paused') && future(t.holdUntil, now)) return { text: localLiftTime(t.holdUntil!, now), kind: 'time' };
  // The server's one reason, the same every surface gives.
  const server = t.wait ?? null;
  if (server && server.kind !== 'slot') {
    const text = queueWaitShort(server, now);
    if (text) return { text, kind: SERVER_WAIT_KIND[server.kind]! };
  }
  const own = runnerHoldTime(t, state, holds, now);
  if (own) return { text: own, kind: 'time' };
  if (t.holds.includes('runner_cooldown')) return { text: localLiftTime(new Date(now + RUNNER_COOLDOWN_MS).toISOString(), now), kind: 'time' };
  const o = liveTaskOutcome({ id: t.id, title: t.title, status: 'pending', backend: t.backend }, state, now);
  // With the server's slot wait, an older overlap or dependency refusal no longer holds it.
  const stale = server?.kind === 'slot' && !!o?.exclusion && (OVERLAP_CODES.has(o.exclusion) || o.exclusion === 'deps_blocked');
  const refused = o && o.reason !== 'claimed' && !stale ? refusalWords(o, positions, state) : null;
  if (refused) return { text: refused, kind: refusalKind(o!) };
  if (server?.kind === 'slot') return null;
  // The claim starts one task per mission that declares no files (the server's read of its serialization).
  if (t.holds.includes('advisory_manifest')) return { text: holderWords(t.holderTaskId, positions, state), kind: 'same_files' };
  // Serial lane: one task at a time, first come (the server's stored order).
  if (t.holds.includes('serial_lane') && t.lane) {
    const pos = t.lane.position;
    return { text: t.lane.stuckSince ? `in line (${pos} ahead), holder stalled` : `in line, ${pos} ahead`, kind: 'same_files' };
  }
  if (t.holds.includes('deps_blocked')) return { text: 'after its dependency', kind: 'dependency' };
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

/** "6 slots · 1 running · 5 free" (R-26), or "paused" in place of free while the runner is paused. */
export function slotsSummary(state: TopState, now: number): string {
  const n = state.runner.maxConcurrent;
  const running = busySlots(state);
  const tail = heldNow(state, now) ? TERMS['runner.paused'].short : `${Math.max(0, n - running)} free`;
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
    const waits: boolean[] = [];
    const kinds: Array<WaitKind | undefined> = [];
    const starts = queued.map(t => {
      // R-33: runner paused, the order stays and nothing has a start time.
      if (held) { waits.push(true); kinds.push(undefined); return TERMS['runner.paused'].short; }
      const w = waitWords(t, positions, state, holds, now);
      waits.push(!!w);
      kinds.push(w?.kind);
      if (w) return w.text;
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
        title: titleWithAttempt(t.title),
        missionId: t.missionId,
        roleSlug: t.roleSlug,
        workspace: t.workspaceName,
        by: ownerWords(t),
        mission: t.missionTitle ?? '-',
        est: tm.estimatesOn ? (t.estimateMinutes != null ? estimateWords(t.estimateMinutes) : '-') : null,
        starts: starts[i],
        ...(kinds[i] ? { wait: kinds[i] } : {}),
        // Only a row nothing else holds: one that waits says what it waits for.
        ...(t.alongside && !waits[i] ? { alongside: alongsideWords(t.alongside, state) } : {}),
      })),
      held: heldTasks.map(t => {
        const w = heldWords(t, now);
        return {
          taskId: t.id,
          position: null,
          title: titleWithAttempt(t.title),
          missionId: t.missionId,
          roleSlug: t.roleSlug,
          workspace: t.workspaceName,
          by: ownerWords(t),
          mission: t.missionTitle ?? '-',
          est: tm.estimatesOn ? (t.estimateMinutes != null ? estimateWords(t.estimateMinutes) : '-') : null,
          starts: w.starts,
          reason: w.reason,
          held: true,
        };
      }),
      notFor: notFor.map(t => ({
        taskId: t.id,
        position: null,
        title: titleWithAttempt(t.title),
        missionId: t.missionId,
        roleSlug: t.roleSlug,
        workspace: t.workspaceName,
        by: ownerWords(t),
        mission: t.missionTitle ?? '-',
        est: tm.estimatesOn ? '-' : null,
        starts: exclusionWords(t),
        reason: exclusionWords(t),
        exclusion: t.reason,
      })),
    });
  }
  return out;
}

/** How each kind of wait reads in the Next line, singular then plural. */
const WAIT_PHRASE: Record<WaitKind, [string, string]> = {
  same_files: ['waits for work on the same files', 'wait for work on the same files'],
  dependency: ['waits for its dependency', 'wait for their dependencies'],
  time: ['waits for a set time', 'wait for a set time'],
  limit: ['waits on a limit', 'wait on a limit'],
};
const WAIT_ORDER: WaitKind[] = ['same_files', 'dependency', 'time', 'limit'];

/** "#1", "#1 and #2", "#1, #2 and #3", "#1, #2 and 3 more". */
function positionList(ps: string[]): string {
  if (ps.length <= 1) return ps.join('');
  if (ps.length <= 3) return `${ps.slice(0, -1).join(', ')} and ${ps[ps.length - 1]}`;
  return `${ps.slice(0, 2).join(', ')} and ${ps.length - 2} more`;
}

/**
 * The line under the Queue header that says what runs next (R-59): the rows
 * that start now, then how many wait and on what; "nothing can start" when
 * none can; the first row and when a slot frees with every slot busy. Built
 * from the rows' own starts and wait kinds, so it never disagrees with them.
 * Null with nothing queued, and while the runner is paused (every row says so).
 */
export function queueNextLine(state: TopState, now: number): string | null {
  if (heldNow(state, now)) return null;
  const sections = queueSections(state, now);
  const several = sections.length > 1;
  const named = (sec: QueueSection, r: QueueRow) => `#${r.position}${several ? ` (${sec.teamName})` : ''}`;
  const rows = sections.flatMap(sec => sec.rows.map(r => ({ sec, r })));
  if (rows.length === 0) return null;
  const starting = rows.filter(x => x.r.starts === 'now');
  const counts = new Map<WaitKind, number>();
  for (const { r } of rows) if (r.wait) counts.set(r.wait, (counts.get(r.wait) ?? 0) + 1);
  const waits = WAIT_ORDER.filter(k => counts.has(k)).map(k => {
    const n = counts.get(k)!;
    return `${n} ${WAIT_PHRASE[k][n === 1 ? 0 : 1]}`;
  });
  if (starting.length > 0) {
    const verb = starting.length === 1 ? 'starts' : 'start';
    return ['Next: ' + `${positionList(starting.map(x => named(x.sec, x.r)))} ${verb} now`, ...waits].join(' · ');
  }
  // Every slot busy: the first row nothing holds waits only for a slot.
  const slot = rows.find(x => !x.r.wait);
  if (slot) {
    const m = slot.r.starts.match(/^in ~(\S+) \(next free slot\)$/);
    return `Next: ${named(slot.sec, slot.r)}, ${m ? `in ~${m[1]} when a slot frees` : 'when a slot frees'}`;
  }
  if (counts.size === 1) return `Next: nothing can start · every waiting task ${WAIT_PHRASE[[...counts.keys()][0]][0]}`;
  return ['Next: nothing can start', ...waits].join(' · ');
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
