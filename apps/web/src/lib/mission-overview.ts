// @ui-copy: strings here render in the app; copy:check and the em-dash test scan them.
/**
 * The mission Overview's rules as data: which task is selected on arrival,
 * the strip's cells and marks, and the focus card's reason line. Pure, so it
 * is tested over real board models without a DOM.
 */
import type { TaskStripCell, TaskStripWait } from '@/components/ui/TaskStrip';
import { STATES, type StateKey, type StateTone } from '@/components/ui/states';
import { reasonLine, type StripMark } from '@/components/ui/task-strip';
import { WAITING_KIND_SPEC, type WaitingKind } from '@buildd/core/waiting-reason';
import { termFor, termWord } from '@buildd/shared';
import { BOARD_LANDED, type MissionBoardModel } from './mission-board';
import { STALL_GRACE_MS } from './mission-helpers';
import { isActiveState, isHeldState, stripMarks, stripOrder, stripState, stripTick } from './mission-task-strip';

type Model = Pick<MissionBoardModel, 'phases' | 'tasks'>;

/** The Overview rail's two counts, said in words. The second names what the viewer decides. */
export function railLines(live: number, needs: number): { agents: string; needs: string } {
  return {
    agents: live === 0 ? 'No agents working' : `${live} ${live === 1 ? 'agent' : 'agents'} working`,
    needs: needs === 0 ? 'Nothing to decide' : `${needs} ${needs === 1 ? 'decision' : 'decisions'} to make`,
  };
}

/**
 * The task on arrival: the first task in flight. Never the first task for its
 * own sake: a mission with nothing in flight falls to the first held task,
 * and a finished one to the last.
 */
export function finishSettingTaskId(model: Model, order: readonly string[] = stripOrder(model)): string | null {
  if (order.length === 0) return null;
  const unfinished = order.filter(id => !BOARD_LANDED.has(model.tasks[id].status));
  const inFlight = unfinished.find(id => isActiveState(stripState(model, id)));
  return inFlight ?? unfinished[0] ?? order[order.length - 1];
}

/**
 * The selected task (spec f7f67f1a R-6, R-9): the one the viewer chose while it
 * is still on the strip, so a task keeps its selection when it changes group;
 * else the task a hold names (the situation block's task); else the first
 * task in flight.
 */
export function overviewDefaultSelection(model: Model, order: readonly string[], chosen: string | null, held: string | null): string | null {
  if (chosen && order.includes(chosen)) return chosen;
  if (held && order.includes(held)) return held;
  return finishSettingTaskId(model, order);
}

// ── Groups (spec f7f67f1a R-1) ───────────────────────────────────────────────

/** Done, In progress and Waiting hold build work; checks holds audit, fix and refresh rows. */
export type OverviewGroupKey = 'done' | 'active' | 'waiting' | 'checks';

export interface OverviewLayout {
  /** Every task, group by group: the order the strip draws and the keys step through. */
  order: string[];
  /** Non-empty groups only, in display order. */
  groups: { key: OverviewGroupKey; ids: string[] }[];
}

const GROUP_ORDER: readonly OverviewGroupKey[] = ['done', 'active', 'waiting', 'checks'];

/**
 * A kernel-owned delivery the kernel settled without shipping it: its PR closed
 * unmerged and nothing superseded it (the kernel's `deliveryShipped` is false;
 * a superseded one reads `landed`, not `closed`). The board's tone map still
 * files it as finished (S17), so the Overview decides this itself (R-2).
 */
export function isClosedUnshipped(model: Model, id: string): boolean {
  return model.tasks[id]?.delivery?.tone === 'closed';
}

/** The cell's display state: the strip's, except a closed, unshipped delivery is `not_landed`, never green. */
export function overviewCellState(model: Model, id: string): StateKey {
  return isClosedUnshipped(model, id) ? 'not_landed' : stripState(model, id);
}

function groupOf(model: Model, id: string): OverviewGroupKey {
  if (model.tasks[id].deliverableRole !== 'build') return 'checks';
  if (isClosedUnshipped(model, id)) return 'waiting';
  const state = stripState(model, id);
  if (state === 'landed') return 'done';
  return state === 'ready' || isHeldState(state) ? 'waiting' : 'active';
}

/**
 * The Overview's groups. Strip order (dependency order) holds inside each
 * group; only a status change moves a task between groups. Other strips keep
 * plain strip order.
 */
export function overviewLayout(model: Model, order: readonly string[] = stripOrder(model)): OverviewLayout {
  const byGroup = new Map<OverviewGroupKey, string[]>(GROUP_ORDER.map(k => [k, []]));
  for (const id of order) byGroup.get(groupOf(model, id))!.push(id);
  const groups = GROUP_ORDER.filter(k => byGroup.get(k)!.length > 0).map(key => ({ key, ids: byGroup.get(key)! }));
  return { order: groups.flatMap(g => g.ids), groups };
}

// ── Why a task waits (spec f7f67f1a R-5) ─────────────────────────────────────

/** On other work, for a free runner, on a hold, for a reason nobody recorded, or closed without merging. */
export type OverviewWaitCause = TaskStripWait;

const ON_TASKS: ReadonlySet<WaitingKind> = new Set<WaitingKind>([
  'dep_declared', 'ordered_behind', 'lane', 'lease_stale', 'serialized_surface',
]);
/** Only a free slot reads "next in line"; a limit is a hold that names itself (spec: Overlap scheduling, AC-10). */
const FOR_SLOT: ReadonlySet<WaitingKind> = new Set<WaitingKind>([
  'eligible_no_runner', 'dispatch_undelivered',
]);

/**
 * Why a waiting build task is not running, from the claim gate's own waiting
 * kind (P-1). Without one, the strip's state decides: held behind a task is
 * `tasks`, nothing holding it is `slot`. An `unknown` kind stays unknown and
 * never reads as an unmet dependency. Null for a task that is not waiting.
 */
export function overviewWaitCause(model: Model, id: string): OverviewWaitCause | null {
  const t = model.tasks[id];
  if (!t || groupOf(model, id) !== 'waiting') return null;
  if (isClosedUnshipped(model, id)) return 'closed';
  const kind = t.waitingKind;
  if (kind === 'unknown') return 'unknown';
  if (kind) return ON_TASKS.has(kind) ? 'tasks' : FOR_SLOT.has(kind) ? 'slot' : 'hold';
  return isHeldState(stripState(model, id)) ? 'tasks' : 'slot';
}

const WAIT_WORD: Record<OverviewWaitCause, string> = { tasks: 'Waiting on tasks', slot: 'Next in line', hold: 'Waiting', unknown: 'Waiting', closed: 'Closed without merging' };

/** A cell's wait word. A hold says its cause in the catalog's word (Paused, Usage limit, Budget reached…). */
function waitWord(model: Model, id: string, wait: OverviewWaitCause): string {
  const kind = model.tasks[id]?.waitingKind;
  return wait === 'hold' && kind ? termFor({ kind: 'waiting', value: kind }).word : WAIT_WORD[wait];
}
const WAIT_LEGEND: Record<OverviewWaitCause, string> = { tasks: 'waiting on tasks', slot: 'next in line', hold: 'blocked', unknown: 'not started', closed: 'closed without merging' };

export interface OverviewLegendEntry {
  key: 'done' | 'active' | OverviewWaitCause | 'checks';
  count: number;
  text: string;
}

/** The counts beside the strip, in words: `5 done`, `2 in progress`, waiting split by cause. */
export function overviewLegend(model: Model, layout: OverviewLayout): OverviewLegendEntry[] {
  const ids = (k: OverviewGroupKey) => layout.groups.find(g => g.key === k)?.ids ?? [];
  const waiting = ids('waiting');
  const byCause = (c: OverviewWaitCause) => waiting.filter(id => overviewWaitCause(model, id) === c).length;
  const checks = ids('checks').length;
  const entries: OverviewLegendEntry[] = [
    { key: 'done', count: ids('done').length, text: `${ids('done').length} done` },
    { key: 'active', count: ids('active').length, text: `${ids('active').length} in progress` },
    ...(['tasks', 'slot', 'hold', 'unknown', 'closed'] as const).map(c => ({ key: c, count: byCause(c), text: `${byCause(c)} ${WAIT_LEGEND[c]}` })),
    { key: 'checks', count: checks, text: `${checks} ${checks === 1 ? 'check' : 'checks'}` },
  ];
  return entries.filter(e => e.count > 0);
}

/**
 * The focus card's line for a waiting or closed task (R-5, R-10): what holds
 * it and what lets it start, from the claim gate's waiting kind. Null when the
 * strip's own reason says it better (waiting on tasks, or no recorded kind).
 */
export function overviewWaitLine(model: Model, id: string): string | null {
  const cause = overviewWaitCause(model, id);
  if (cause === 'closed') return 'Closed without merging. The mission cannot finish until it is reopened or replaced.';
  if (cause === 'unknown') return 'Not started, and no reason is recorded.';
  const kind = model.tasks[id]?.waitingKind;
  if (!kind || cause === 'tasks' || cause == null) return null;
  if (NEVER_LINE[kind]) return NEVER_LINE[kind]!;
  const spec = WAITING_KIND_SPEC[kind];
  // A hold nothing lifts on its own has no "starts when" to give.
  if (spec.releasesWhen.event === 'never') return `${spec.gateName}. It will not start on its own.`;
  return `${spec.gateName}. Starts when ${spec.releasesWhen.text}.`;
}

/** Holds that never lift on their own, said in a sentence of their own. */
const NEVER_LINE: Partial<Record<WaitingKind, string>> = {
  subject_dead: 'The PR it was filed for was closed, so it will not start on its own.',
};

/** One strip cell per task, in the order given, ticked by position; a waiting cell carries its cause. */
export function overviewCells(model: Model, order: readonly string[] = stripOrder(model)): TaskStripCell[] {
  return order.map((id, i) => {
    const wait = overviewWaitCause(model, id);
    // A closed PR someone replaced reads `Closed → #N`; a red PR its R-14 words (`Fixing · CI failed`, `Failed · …`).
    const replacement = wait === 'closed' ? model.tasks[id].replacement ?? null : null;
    const status = overviewStatus(model, id);
    const word = replacement ? `Closed → #${replacement.number}`
      : wait ? waitWord(model, id, wait)
      : (status.tone === 'bad' || status.retryAt != null) && status.cause ? overviewStatusText(status) : null;
    // `live`: a fix attempt an agent is on right now hatches; one waiting out its retry is dashed (R-4).
    return { id, state: overviewCellState(model, id), tick: stripTick(i), title: model.tasks[id].title, live: model.tasks[id].executing === true, ...(wait ? { wait } : {}), ...(word ? { word } : {}) };
  });
}

/** One square of a list's progress row: the strip cell's display state and the Overview group it sits in. */
export interface OverviewProgressCell {
  state: StateKey;
  group: OverviewGroupKey;
}

/**
 * The Overview strip as cells without ids or titles, for a list that draws the
 * mission's progress in one row (`buildd top`, spec c7410e76 R-29): the same
 * groups, order and cell states the page draws, so the two never disagree.
 */
export function overviewProgress(model: Model, order: readonly string[] = stripOrder(model)): OverviewProgressCell[] {
  return overviewLayout(model, order).groups.flatMap(g => g.ids.map(id => ({ state: overviewCellState(model, id), group: g.key })));
}

/** What the selection marks on the tick row, and the focus card's reason line. */
export function overviewSelection(model: Model, order: readonly string[], selectedId: string) {
  const t = model.tasks[selectedId];
  if (!t) return { marks: new Map<string, StripMark>(), reason: null };
  const sel = stripMarks(model, selectedId);
  const tick = (id: string) => stripTick(order.indexOf(id));
  const name = (id: string) => `${tick(id)} ${model.tasks[id].scope ?? model.tasks[id].label}`;
  const byTick = (a: string, b: string) => tick(a).localeCompare(tick(b));
  if (sel.direction === 'downstream') {
    const direct = sel.reached.filter(id => sel.marks.get(id) === 'direct').sort(byTick).map(tick);
    return { marks: sel.marks, reason: reasonLine('downstream', direct, sel.reached.length) };
  }
  if (sel.direction === 'upstream') {
    const names = [
      ...t.offStrip.map(b => `${b.title}${b.otherMission ? ' · other mission' : ''}`),
      ...t.frontier.filter(id => model.tasks[id]).sort(byTick).map(name),
    ];
    return { marks: sel.marks, reason: reasonLine('upstream', names, t.offStrip.length + sel.reached.length) };
  }
  return { marks: sel.marks, reason: null };
}

/** `2 of 7 done · 1 of 4 criteria`; `{ criteria: false }` leaves the criteria to the Verified pill. */
export function overviewCounts(model: Pick<MissionBoardModel, 'landed' | 'criteria' | 'criteriaPassed'>, opts: { criteria?: boolean } = {}): string {
  // "done", not "merged": this counts every finished task, PR or not (the
  // Board's landed cell), while the PRs merged criterion counts PR-bearing
  // tasks only. Both called "merged" read as two contradictory merged counts.
  const parts = [model.landed.total === 0 ? 'No tasks' : `${model.landed.done} of ${model.landed.total} done`];
  if (opts.criteria !== false && model.criteria.length > 0) parts.push(`${model.criteriaPassed} of ${model.criteria.length} criteria`);
  return parts.join(' · ');
}

// ── A task's status in words (spec d25d923d R-14) ─────────────────────────────

/**
 * One status dot, one word, at most one short cause: `Queued · Next in line`,
 * `Running 12m 04s · Running unit tests`, `Fixing · CI failed`, `Failed`,
 * `Merged`, `Closed → #N`. No sentences. The words are Navigation R-14's,
 * read from the terms catalog.
 */
export interface OverviewStatus {
  word: string;
  /** The dot's colour family. */
  tone: StateTone;
  cause: string | null;
  /** Running: when the worker started, for a ticking elapsed clock. */
  since: number | null;
  /** Running: its last event (`lastEventOf`), for `updated 14s ago`. */
  lastEventAt: number | null;
  /** A fix waiting out a retry backoff or its checks: when it resumes (`Retry in 3h 52m`). */
  retryAt: number | null;
  /** Closed without merging: the replacement someone named, if any. */
  closed: { replacement: { number: number; url: string | null } | null } | null;
}

/** A red PR's cause in the PR's own words. */
function prCause(state: string | undefined): string | null {
  return state === 'ci_failed' ? 'CI failed' : state === 'conflict' ? 'Merge conflict' : null;
}

const STEP_MAX = 64;
const base = (path: string) => path.trim().replace(/^["'`]|["'`]$/g, '').split('/').filter(Boolean).pop() ?? path;

/**
 * A raw step label in words (R-5, R-14): a commit reads as its subject (no
 * `commit:` prefix, no trailers, one line), a tool call as `Reading <file>`,
 * `Editing <file>` or `Running tests`, and a raw shell command as nothing, so
 * the caller falls back to the latest milestone. Plain words pass through,
 * truncated to one line.
 */
export function stepWords(label: string | null | undefined): string | null {
  if (!label) return null;
  const first = label.split('\n').map(l => l.trim()).find(Boolean) ?? '';
  const commit = /^commit:\s*(.+)$/i.exec(first);
  const tool = /^(running|reading|editing|writing|searching|grep|globbing)\s*:\s*(.+)$/i.exec(first);
  let text: string;
  if (commit) text = commit[1].replace(/\s*Co-Authored-By:.*$/i, '').trim();
  else if (tool) {
    const verb = tool[1].toLowerCase();
    const arg = tool[2];
    if (verb === 'running') {
      if (/\b(test|tests|vitest|jest|pytest)\b/.test(arg)) return 'Running tests';
      if (/\b(tsc|typecheck|type-check|lint|build)\b/.test(arg)) return /\bbuild\b/.test(arg) ? 'Building' : 'Checking types';
      return null;
    }
    if (verb === 'reading') text = `Reading ${base(arg)}`;
    else if (verb === 'editing' || verb === 'writing') text = `Editing ${base(arg)}`;
    else return null;
  } else text = first;
  text = text.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > STEP_MAX ? `${text.slice(0, STEP_MAX - 1).trimEnd()}…` : text;
}

/** The latest step in words: the newest milestone that reads, else the current action. */
function latestStepWords(t: { milestones: { label: string }[]; currentAction: string | null }): string | null {
  for (let i = t.milestones.length - 1; i >= 0; i--) {
    const w = stepWords(t.milestones[i].label);
    if (w) return w;
  }
  return stepWords(t.currentAction);
}

const RUNNING = termWord('work.working');
const FIXING = termWord('pr.fixing');
const FAILED = termWord('work.failed');

/**
 * The selected task's status in the shared vocabulary. The true state wins:
 * a task whose PR is red reads `Fixing` with the PR's cause even while a
 * retry backoff runs, never `Queued` (R-20: buildd retries it by itself), and
 * the backoff is `retryAt`, beside it. `Failed` is a failure a person acts on.
 */
export function overviewStatus(model: Model, id: string): OverviewStatus {
  const t = model.tasks[id];
  const state = overviewCellState(model, id);
  const out = (word: string, tone: StateTone, cause: string | null = null, extra: Partial<OverviewStatus> = {}): OverviewStatus => ({
    word, tone, cause, since: null, lastEventAt: null, retryAt: null, closed: null, ...extra,
  });
  const latestStep = latestStepWords(t);
  const live = { since: t.startedAt, lastEventAt: t.lastEventAt ?? null };
  if (isClosedUnshipped(model, id)) return out('Closed', 'q', null, { closed: { replacement: t.replacement ?? null } });
  switch (state) {
    case 'landed':
      return t.pr?.state === 'merged' || t.status === 'merged' ? out(termWord('pr.merged'), 'ok') : out(termWord('work.done'), 'ok');
    case 'running':
      return out(RUNNING, 'act', latestStep ?? null, live);
    case 'fixing':
      return t.executing
        ? out(FIXING, 'act', latestStep ?? prCause(t.pr?.state), live)
        : out(FIXING, 'act', prCause(t.pr?.state), { retryAt: t.startAt ?? null });
    case 'ci_failed':
      return out(FAILED, 'bad', prCause(t.pr?.state) ?? termWord('pr.ci_failed'), { retryAt: t.startAt ?? null });
    case 'failed':
      // What to change, from the task's error evidence (R-20); a dependency failure names its task in the row.
      return out(FAILED, 'bad', t.failureCause ?? null, { retryAt: t.startAt ?? null });
    case 'ready': case 'blocked': case 'queued': {
      const wait = overviewWaitCause(model, id);
      return out(STATES[state].word, 'q', wait ? waitWord(model, id, wait) : null);
    }
    default:
      // In review, merging, an agent's question, a decision: the delivery's own label when the kernel owns it.
      return out(t.delivery?.label ?? STATES[state].word, STATES[state].tone);
  }
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** A countdown: `3h 52m`, `12m`, `under 1m`. */
export function formatCountdown(ms: number): string {
  const m = Math.ceil(Math.max(0, ms) / 60_000);
  if (m < 1) return 'under 1m';
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${pad2(m % 60)}m`;
}

/** An elapsed clock: `12m 04s` under an hour, `1h 02m` past it. */
export function formatElapsed(ms: number): string {
  const s = Math.floor(Math.max(0, ms) / 1000);
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${pad2(s % 60)}s` : `${Math.floor(m / 60)}h ${pad2(m % 60)}m`;
}

/** Time since an event, rounded down: `14s`, `12m`, `1h 02m`. */
function formatAgo(ms: number): string {
  const s = Math.floor(Math.max(0, ms) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${pad2(m % 60)}m`;
}

/**
 * How long a live task may go without an event before its line reads
 * `No activity for 12m`: the stall grace a mission already allows open work
 * with no live worker (`STALL_GRACE_MS`, lib/mission-helpers.ts).
 */
export const NO_ACTIVITY_MS = STALL_GRACE_MS;

/** A live task's line: `Running 12m 04s`, then `Updated 14s ago` or, quiet, `No activity for 12m`. */
export interface LiveLine {
  elapsed: string;
  activity: string;
  /** No event for `NO_ACTIVITY_MS`: the warning tone. */
  quiet: boolean;
}

/** The live line for a status whose worker is executing (`since` set), else null. */
export function liveLine(s: Pick<OverviewStatus, 'word' | 'since' | 'lastEventAt'>, now: number): LiveLine | null {
  if (s.since == null) return null;
  const quietFor = now - (s.lastEventAt ?? s.since);
  const quiet = quietFor >= NO_ACTIVITY_MS;
  return {
    elapsed: `${s.word} ${formatElapsed(now - s.since)}`,
    activity: quiet ? `No activity for ${formatAgo(quietFor)}` : `Updated ${formatAgo(quietFor)} ago`,
    quiet,
  };
}

/** `Failed · CI failed`: the word and its one cause. */
export function overviewStatusText(s: Pick<OverviewStatus, 'word' | 'cause'>): string {
  return s.cause ? `${s.word} · ${s.cause}` : s.word;
}

/** The action beside `Retry in …`: it only brings the retry forward (R-20). */
export const RETRY_NOW = 'Retry now';

/** A fix's pending retry: `Retry in 3h 52m`, or null when none waits. */
export function retryText(s: Pick<OverviewStatus, 'retryAt'>, now: number): string | null {
  return s.retryAt != null && s.retryAt > now ? `Retry in ${formatCountdown(s.retryAt - now)}` : null;
}
