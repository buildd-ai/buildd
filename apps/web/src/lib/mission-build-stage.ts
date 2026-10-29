// @ui-copy: strings here render in the app; copy:check and the em-dash test scan them.
/**
 * The mission page's Build stage as data (Navigation d25d923d R-5, R-14):
 * one summary line (`11 of 16 merged · 1 running · 1 fixing · 1 your
 * decision · 2 waiting`) and the task list, named, never numbered, in the
 * order a person reads it: what needs a person, then running, fixing,
 * waiting, queued; merged tasks fold into one row. From 20 waiting tasks the
 * waiting rows group by what they wait on.
 *
 * Reads the board model only (the same rows the bar draws, so the list and
 * the bar never disagree) and the Overview's status words. Pure. What sets
 * the finish (R-22) comes in as `finish`, from the Flow timeline's one
 * computation (`missionFinishClause`), so Flow and the summary agree.
 */
import { termWord } from '@buildd/shared';
import { BOARD_LANDED, formatAge, type BoardTask, type MissionBoardModel } from './mission-board';
import { formatCountdown, isClosedUnshipped, overviewCellState, overviewStatus, overviewWaitCause } from './mission-overview';
import { displayTaskTitle } from './task-title';
import { stripOrder } from './mission-task-strip';
import { whenLabel } from './mission-task-hold';

type Model = Pick<MissionBoardModel, 'phases' | 'tasks'>;

/** Rows lead with what needs a person; `merged` rows fold away. */
export type BuildRowState = 'decision' | 'approval' | 'failed' | 'closed' | 'running' | 'fixing' | 'waiting' | 'queued' | 'merged';

export interface BuildStageRow {
  id: string;
  title: string;
  state: BuildRowState;
  /** The state in R-14's words: `Running 12m · writing the test · updated 14s ago`. */
  line: string;
  /** The row's second line when the first is long: the queued hold, a failure's cause. Null when the line says it all. */
  detail: string | null;
  /** The dot's hue: amber for a person, red for a failure, accent for live work, neutral otherwise. */
  tone: 'dec' | 'bad' | 'act' | 'q';
  /** Age in state, for the right edge (`1m ago`, `3d`). Null when it does not help. */
  age: string | null;
  href: string;
}

/** From this many waiting tasks the waiting rows group by what they wait on. */
export const WAITING_GROUP_FROM = 20;

export interface BuildWaitingGroup {
  blockerId: string;
  blockerTitle: string;
  ids: string[];
  /** `Waiting on <task> · 12 ›` */
  line: string;
}

export interface BuildStage {
  /** Build tasks only (checks never count, R-12). */
  total: number;
  merged: { count: number; ids: string[] };
  /** `11 of 16 merged · 1 running · 1 fixing · 1 your decision · 2 waiting`, then `· finish depends on <task>` (R-22). */
  summary: string;
  rows: BuildStageRow[];
  /** Set from WAITING_GROUP_FROM waiting tasks: these replace the waiting rows. */
  waitingGroups: BuildWaitingGroup[] | null;
}

export interface BuildStageOptions {
  hrefFor: (id: string) => string;
  /** A clock time for `resumes 05:26`; defaults to UTC HH:MM. */
  clock?: (ts: number) => string;
  /**
   * What sets the finish (R-22): `finish depends on <task>, then …`, from
   * `missionFinishClause`. Ends the summary line while a build task is unmerged.
   */
  finish?: string | null;
}

const YOUR_DECISION = termWord('decision.your_decision');
const APPROVAL_REQUIRED = termWord('decision.approval_required');

const pad2 = (n: number) => String(n).padStart(2, '0');
const utcClock = (ts: number) => { const d = new Date(ts); return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`; };

/** `14s`, `12m`, `1h 02m`: time since an event, rounded down. */
export function agoShort(ms: number): string {
  const s = Math.floor(Math.max(0, ms) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${pad2(m % 60)}m`;
}

/** A cause mid-line starts lowercase, unless it opens with an acronym (`CI failed`). */
const lower = (s: string) => (/^[A-Z][a-z]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);

/** The one state a build task is in for the list. */
export function buildRowState(model: Model, id: string): BuildRowState {
  const t = model.tasks[id];
  if (BOARD_LANDED.has(t.status)) return isClosedUnshipped(model, id) ? 'closed' : 'merged';
  if (isClosedUnshipped(model, id)) return 'closed';
  const state = overviewCellState(model, id);
  switch (state) {
    case 'running': return 'running';
    case 'fixing': return t.executing ? 'running' : 'fixing';
    case 'ci_failed': case 'failed': return 'failed';
    case 'waiting': return 'decision';
    case 'needs_you': return t.delivery?.needsYou && !t.waitingFor ? 'approval' : 'decision';
    case 'review': case 'landing': case 'recovering': return t.delivery?.needsYou ? 'approval' : 'running';
    case 'blocked': return t.blockers.length > 0 || t.offStrip.length > 0 ? 'waiting' : 'queued';
    default: return 'queued';
  }
}

const ORDER: Record<BuildRowState, number> = { decision: 0, approval: 0, failed: 0, closed: 0, running: 1, fixing: 2, waiting: 3, queued: 4, merged: 5 };

const blockerName = (model: Model, t: BoardTask): string | null => {
  // The name the list shows the task by: no label chip in brackets, no internal title.
  const on = t.blockers.map(id => model.tasks[id]?.title).find(Boolean);
  if (on) return displayTaskTitle(on);
  const off = t.offStrip[0];
  return off ? `${displayTaskTitle(off.title)}${off.otherMission ? ' (another mission)' : ''}` : null;
};

/** The row's words for one task (R-14): one word, at most one short cause, time in state. */
export function buildRowLine(model: Model, id: string, state: BuildRowState, now: number, clock: (ts: number) => string): { line: string; detail: string | null; age: string | null } {
  const t = model.tasks[id];
  const s = overviewStatus(model, id);
  const asked = t.waitStartedAt != null ? formatAge(now - t.waitStartedAt) : null;
  switch (state) {
    case 'decision':
      return { line: YOUR_DECISION, detail: null, age: asked ? `${asked} ago` : null };
    case 'approval':
      return { line: APPROVAL_REQUIRED, detail: t.delivery?.label && t.delivery.label !== APPROVAL_REQUIRED ? t.delivery.label : null, age: asked ? `${asked} ago` : null };
    case 'failed': {
      const cause = s.cause ?? t.failedDependency?.title ?? null;
      return { line: cause ? `${s.word} · ${cause}` : s.word, detail: null, age: t.endedAt != null ? `${formatAge(now - t.endedAt)} ago` : null };
    }
    case 'closed':
      return { line: t.replacement ? `Closed → #${t.replacement.number}` : 'Closed without merging', detail: null, age: null };
    case 'running': {
      const since = s.since ?? t.startedAt;
      const elapsed = since != null ? formatAge(now - since) : null;
      const step = s.cause ? lower(s.cause) : null;
      // Every running row says how fresh it is; before its first event that is the start (R-5).
      const lastEvent = s.lastEventAt ?? since;
      const updated = lastEvent != null ? `updated ${agoShort(now - lastEvent)} ago` : null;
      const head = s.word === 'Fixing'
        ? `Fixing${step ? ` · ${step}` : ''}${elapsed ? ` · running ${elapsed}` : ''}`
        : `Running${elapsed ? ` ${elapsed}` : ''}${step ? ` · ${step}` : ''}`;
      return { line: updated ? `${head} · ${updated}` : head, detail: null, age: null };
    }
    case 'fixing': {
      const cause = s.cause ? lower(s.cause) : null;
      const resumes = s.retryAt != null && s.retryAt > now ? `resumes ${clock(s.retryAt)}` : null;
      return { line: ['Fixing', cause, resumes].filter(Boolean).join(' · '), detail: null, age: null };
    }
    case 'waiting': {
      const name = blockerName(model, t);
      const more = Math.max(0, t.blockers.length + t.offStrip.length - 1);
      return { line: name ? `Waiting on ${name}${more > 0 ? ` and ${more} more` : ''}` : 'Waiting on a task', detail: null, age: formatAge(now - t.createdAt) };
    }
    case 'queued': {
      const age = formatAge(now - (t.waitStartedAt ?? t.createdAt));
      const wait = overviewWaitCause(model, id);
      // The hold's cause, when the claim gate recorded one that is not another task (R-14).
      // A start time names when it starts, not that it is scheduled.
      const startsAt = t.waitingKind === 'start_deferred' && t.startAt != null && t.startAt > now ? t.startAt : null;
      const hold = startsAt != null ? `starts ${whenLabel(startsAt, now)}` : wait === 'hold' && s.cause ? lower(s.cause) : null;
      return { line: `Queued ${age}${hold ? ` · ${hold}` : ''}`, detail: null, age: null };
    }
    default:
      return { line: s.word, detail: null, age: null };
  }
}

const TONE: Record<BuildRowState, BuildStageRow['tone']> = { decision: 'dec', approval: 'dec', failed: 'bad', closed: 'bad', running: 'act', fixing: 'act', waiting: 'q', queued: 'q', merged: 'q' };

const count = (n: number, word: string) => `${n} ${word}`;

/** The summary line, in words: `11 of 16 merged · 1 running · 1 fixing · 1 your decision · 2 waiting`. */
export function buildSummaryLine(c: { total: number; merged: number; running: number; fixing: number; failed: number; decision: number; approval: number; waiting: number }): string {
  if (c.total === 0) return 'No tasks';
  const parts = [`${c.merged} of ${c.total} merged`];
  if (c.running) parts.push(count(c.running, 'running'));
  if (c.fixing) parts.push(count(c.fixing, 'fixing'));
  if (c.failed) parts.push(count(c.failed, 'failed'));
  if (c.decision) parts.push(count(c.decision, c.decision === 1 ? lower(YOUR_DECISION) : 'your decisions'));
  if (c.approval) parts.push(count(c.approval, c.approval === 1 ? lower(APPROVAL_REQUIRED) : 'approvals required'));
  if (c.waiting) parts.push(count(c.waiting, 'waiting'));
  return parts.join(' · ');
}

/** The Build stage over the board's build tasks, in reading order. */
export function buildStage(model: Model, now: number, opts: BuildStageOptions): BuildStage {
  const clock = opts.clock ?? utcClock;
  const ids = stripOrder(model).filter(id => model.tasks[id].deliverableRole === 'build');
  const states = new Map(ids.map(id => [id, buildRowState(model, id)] as const));
  const mergedIds = ids.filter(id => states.get(id) === 'merged');
  const open = ids.filter(id => states.get(id) !== 'merged');
  // Needs-a-person rows oldest ask first (the pulse's rule); the rest keep strip order.
  const askedAt = (id: string) => model.tasks[id].waitStartedAt ?? model.tasks[id].endedAt ?? model.tasks[id].createdAt;
  const sorted = [...open].sort((a, b) => {
    const oa = ORDER[states.get(a)!];
    const ob = ORDER[states.get(b)!];
    if (oa !== ob) return oa - ob;
    if (oa === 0) return askedAt(a) - askedAt(b);
    return ids.indexOf(a) - ids.indexOf(b);
  });
  const rows: BuildStageRow[] = sorted.map(id => {
    const state = states.get(id)!;
    const words = buildRowLine(model, id, state, now, clock);
    return { id, title: model.tasks[id].title, state, ...words, tone: TONE[state], href: opts.hrefFor(id) };
  });
  const n = (s: BuildRowState) => rows.filter(r => r.state === s).length;
  const counts = {
    total: ids.length, merged: mergedIds.length, running: n('running'), fixing: n('fixing'),
    failed: n('failed') + n('closed'), decision: n('decision'), approval: n('approval'), waiting: n('waiting') + n('queued'),
  };
  const waitingRows = rows.filter(r => r.state === 'waiting');
  let waitingGroups: BuildWaitingGroup[] | null = null;
  if (waitingRows.length >= WAITING_GROUP_FROM) {
    const byBlocker = new Map<string, string[]>();
    for (const r of waitingRows) {
      const t = model.tasks[r.id];
      const key = t.blockers[0] ?? (t.offStrip[0] ? `off:${t.offStrip[0].id}` : 'unknown');
      byBlocker.set(key, [...(byBlocker.get(key) ?? []), r.id]);
    }
    waitingGroups = [...byBlocker].map(([key, members]) => {
      const t = model.tasks[members[0]];
      const title = displayTaskTitle(model.tasks[key]?.title ?? t.offStrip[0]?.title ?? 'a task');
      return { blockerId: key, blockerTitle: title, ids: members, line: `Waiting on ${title} · ${members.length} ›` };
    });
  }
  const summary = buildSummaryLine(counts);
  const finish = open.length > 0 && opts.finish ? ` · ${opts.finish}` : '';
  return { total: ids.length, merged: { count: mergedIds.length, ids: mergedIds }, summary: `${summary}${finish}`, rows, waitingGroups };
}

/** `16 tasks merged ›`: the folded Build stage once every build task landed (R-15). */
export function buildFoldLine(total: number): string {
  return `${total} ${total === 1 ? 'task' : 'tasks'} merged ›`;
}

/** The merged fold inside the list: `11 merged ›` (Navigation R-5). */
export function mergedFoldLine(count: number): string {
  return `${count} merged ›`;
}

export { formatCountdown };
