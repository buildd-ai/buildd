/**
 * The mission Flow tab, as data: one row per task in dependency order, each a
 * bar on one time axis, and every gate between them as an edge from the
 * blocker's bar end to the dependent's bar start. Pure, so the rules are
 * tested without a DOM.
 *
 * Spec: docs/specs/mission-flow-timeline.md.
 *
 * - Row order is the strip's (`stripOrder`): every dependency above its
 *   dependents, the same tick numbers the strip draws.
 * - A started task's bar runs from its first run to now (or to its merge);
 *   an unstarted one starts when its last gate finishes plus a fixed audit
 *   wait, and lasts its expected size (or a constant).
 * - Gates are the stored dependencies plus the same-files edges Buildd adds
 *   (`pathDeclaration.softOverlaps`).
 * - The critical path is the longest path through the gates: from the task
 *   that finishes last, back through whichever gate finishes last.
 * - Everything horizontal is a percentage of the window and everything
 *   vertical is a row index, so nothing here knows how wide the screen is.
 */
import { readSoftOverlaps } from '@buildd/core/path-overlap';
import { BOARD_LANDED, type MissionBoardModel } from './mission-board';
import { stripMarks, stripOrder, stripState, stripTick, type StripState } from './mission-task-strip';

type FlowModel = Pick<MissionBoardModel, 'tasks' | 'phases' | 'now' | 'startedAt' | 'bars' | 'merges'>;

/** Between a blocker's finish and its dependent's start: the audit and the merge. */
export const FLOW_AUDIT_WAIT_MS = 10 * 60_000;
/** An unstarted task with no expected size lasts this long. */
export const FLOW_DEFAULT_TASK_MS = 45 * 60_000;
/** Above this many tasks, merged tasks share one row until it is opened. */
export const FLOW_FOLD_ABOVE = 8;
/** A running task always has at least this share of its expected size left. */
const MIN_REMAINING_SHARE = 0.25;

export type FlowGateKind = 'depends' | 'same_files';

export interface FlowGate {
  /** The blocker. */
  from: string;
  /** The dependent. */
  to: string;
  kind: FlowGateKind;
}

/**
 * - `done`: landed; solid from its first run to its merge.
 * - `run`: started and not landed; solid to now, then the rest still to come.
 * - `plan`: not started; every bit of it is still to come.
 */
export type FlowBarKind = 'done' | 'run' | 'plan';

export interface FlowTask {
  id: string;
  /** The strip's tick for this task (`01`, `02`, …). */
  tick: string;
  state: StripState;
  kind: FlowBarKind;
  /** Epoch ms. */
  start: number;
  /** Where the solid part ends: the merge, or now. Null for a `plan` bar. */
  solidEnd: number | null;
  /** Where the bar ends: the merge, or when it is expected to finish. */
  end: number;
  /** The thin line out to the p80 finish, when a p80 exists. */
  p80End: number | null;
  /** Gates into this task (its blockers). */
  gates: FlowGate[];
}

export interface FlowTimeline {
  /** Task ids, in dependency order. */
  order: string[];
  tasks: Record<string, FlowTask>;
  /** Every gate, dependency and same-files alike, in row order of the dependent. */
  gates: FlowGate[];
  /** The critical path, first task first. */
  critical: string[];
  /** The window, epoch ms. */
  from: number;
  to: number;
  now: number;
}

export interface FlowTimelineInput {
  model: FlowModel;
  /** Defaults to `model.now`. */
  now?: number;
  /** Dependent id → the tasks Buildd made it wait on because both change the same files. */
  sameFiles?: Readonly<Record<string, readonly string[]>>;
  /** Task id → expected minutes. Absent: `FLOW_DEFAULT_TASK_MS`. */
  expectedMinutes?: Readonly<Record<string, number | null | undefined>>;
  /** Task id → p80 minutes, when an estimate carries one. */
  p80Minutes?: Readonly<Record<string, number | null | undefined>>;
}

/**
 * Dependent id → the tasks Buildd made it wait on because both change the
 * same files: the `softOverlaps` stored on each row's path declaration.
 */
export function sameFilesFromRows(rows: ReadonlyArray<{ id: string; pathDeclaration?: unknown }>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const r of rows) {
    const ids = readSoftOverlaps(r.pathDeclaration).map(e => e.taskId);
    if (ids.length) out[r.id] = ids;
  }
  return out;
}

/** Task id → expected minutes, from the newest size prediction per task (rows newest first). */
export function expectedMinutesFromPredictions(rows: ReadonlyArray<{ taskId: string; expectedSize: { minutes?: unknown } | null }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    const m = r.expectedSize?.minutes;
    if (out[r.taskId] == null && typeof m === 'number' && Number.isFinite(m) && m > 0) out[r.taskId] = m;
  }
  return out;
}

const minutes = (v: number | null | undefined): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v * 60_000 : null);

/** Every gate into each task: its on-mission dependencies, then its same-files waits. */
export function flowGates(model: Pick<MissionBoardModel, 'tasks'>, sameFiles: FlowTimelineInput['sameFiles'] = {}): Map<string, FlowGate[]> {
  const out = new Map<string, FlowGate[]>();
  for (const t of Object.values(model.tasks)) {
    const gates: FlowGate[] = [];
    const seen = new Set<string>([t.id]);
    for (const d of t.deps) {
      if (seen.has(d.id) || !model.tasks[d.id]) continue;
      seen.add(d.id);
      gates.push({ from: d.id, to: t.id, kind: 'depends' });
    }
    for (const id of sameFiles?.[t.id] ?? []) {
      if (seen.has(id) || !model.tasks[id]) continue;
      seen.add(id);
      gates.push({ from: id, to: t.id, kind: 'same_files' });
    }
    out.set(t.id, gates);
  }
  return out;
}

export function buildFlowTimeline(input: FlowTimelineInput): FlowTimeline {
  const { model } = input;
  const now = input.now ?? model.now;
  const order = stripOrder(model);
  const gatesOf = flowGates(model, input.sameFiles);
  const expected = (id: string) => minutes(input.expectedMinutes?.[id]) ?? FLOW_DEFAULT_TASK_MS;

  // A task's first run (a retry keeps the bar's start), and its merge.
  const firstRun = new Map<string, number>();
  for (const b of model.bars) {
    if (b.tone === 'side') continue;
    const at = firstRun.get(b.taskId);
    if (at == null || b.start < at) firstRun.set(b.taskId, b.start);
  }
  const mergedAt = new Map(model.merges.map(m => [m.taskId, m.at]));

  const tasks: Record<string, FlowTask> = {};
  const visiting = new Set<string>();
  const place = (id: string): FlowTask => {
    if (tasks[id]) return tasks[id];
    const t = model.tasks[id];
    const state = stripState(model, id);
    const gates = gatesOf.get(id) ?? [];
    const tick = stripTick(order.indexOf(id));
    const ran = firstRun.get(id) ?? t.startedAt;
    const est = expected(id);
    const p80 = minutes(input.p80Minutes?.[id]);
    let x: FlowTask;
    if (BOARD_LANDED.has(t.status)) {
      const end = mergedAt.get(id) ?? t.endedAt ?? now;
      const start = Math.min(ran ?? end - est, end);
      x = { id, tick, state, kind: 'done', start, solidEnd: end, end, p80End: null, gates };
    } else if (state === 'ready' || state === 'blocked' || state === 'queued') {
      // A cycle can't be scheduled through; a gate already being placed is skipped.
      visiting.add(id);
      const after = gates.filter(g => !visiting.has(g.from)).map(g => place(g.from).end + FLOW_AUDIT_WAIT_MS);
      visiting.delete(id);
      const start = Math.max(now, ...after);
      x = { id, tick, state, kind: 'plan', start, solidEnd: null, end: start + est, p80End: p80 != null ? start + p80 : null, gates };
    } else if (state === 'failed') {
      // Stopped: solid to where it ended, nothing drawn as still to come.
      const end = Math.min(t.endedAt ?? now, now);
      const start = Math.min(ran ?? end, end);
      x = { id, tick, state, kind: 'run', start, solidEnd: end, end, p80End: null, gates };
    } else {
      const start = Math.min(ran ?? now, now);
      const left = Math.max(est - (now - start), est * MIN_REMAINING_SHARE);
      x = { id, tick, state, kind: 'run', start, solidEnd: now, end: now + left, p80End: p80 != null ? Math.max(start + p80, now + left) : null, gates };
    }
    tasks[id] = x;
    return x;
  };
  for (const id of order) place(id);

  const gates = order.flatMap(id => tasks[id].gates);
  const critical = criticalPath(order, tasks);
  const starts = order.map(id => tasks[id].start);
  const ends = order.map(id => Math.max(tasks[id].end, tasks[id].p80End ?? 0));
  const from = Math.min(model.startedAt, ...starts);
  const last = Math.max(now, ...ends);
  // A little air past the last finish, and never a window under 30 minutes.
  const to = Math.max(from + 30 * 60_000, from + (last - from) * 1.02);
  return { order, tasks, gates, critical, from, to, now };
}

/**
 * The longest path through the gates: the task that finishes last, then
 * whichever of its gates finishes last, back to a task with none. Ties go to
 * the later row, so the line names what is furthest along the plan.
 */
export function criticalPath(order: readonly string[], tasks: Readonly<Record<string, Pick<FlowTask, 'end' | 'gates'>>>): string[] {
  if (order.length === 0) return [];
  const rank = new Map(order.map((id, i) => [id, i]));
  const later = (a: string, b: string) => {
    const d = tasks[a].end - tasks[b].end;
    return d !== 0 ? d > 0 : (rank.get(a) ?? 0) > (rank.get(b) ?? 0);
  };
  let cur = order.reduce((a, b) => (later(b, a) ? b : a));
  const path = [cur];
  const seen = new Set(path);
  for (;;) {
    const gates = tasks[cur].gates.map(g => g.from).filter(id => tasks[id] && !seen.has(id));
    if (gates.length === 0) break;
    cur = gates.reduce((a, b) => (later(b, a) ? b : a));
    seen.add(cur);
    path.unshift(cur);
  }
  return path;
}

/** What sets the finish: the first unlanded task on the critical path, then the rest of it. Null once it has all landed. */
export function finishSetBy(timeline: Pick<FlowTimeline, 'critical' | 'tasks'>): { head: FlowTask; then: FlowTask[] } | null {
  const rest = timeline.critical.map(id => timeline.tasks[id]).filter(t => t.kind !== 'done');
  if (rest.length === 0) return null;
  return { head: rest[0], then: rest.slice(1) };
}

/** `Finish is set by 04 (building), then 06 → 07.` — `word` is the state's display word. */
export function criticalPathLine(timeline: Pick<FlowTimeline, 'critical' | 'tasks'>, word: (s: StripState) => string): string | null {
  const f = finishSetBy(timeline);
  if (!f) return null;
  const then = f.then.length ? `, then ${f.then.map(t => t.tick).join(' → ')}` : '';
  return `Finish is set by ${f.head.tick} (${word(f.head.state).toLowerCase()})${then}.`;
}

/** The selection a Flow tab opens on: the task setting the finish, else the last row. */
export function defaultFlowSelection(timeline: Pick<FlowTimeline, 'critical' | 'tasks' | 'order'>): string | null {
  return finishSetBy(timeline)?.head.id ?? timeline.order[timeline.order.length - 1] ?? null;
}

/**
 * The tasks a selection lights: itself, plus exactly what the strip marks for
 * it (`stripMarks`): upstream of a held task, downstream of an active one,
 * nothing for a landed one.
 */
export function flowLit(model: Pick<MissionBoardModel, 'tasks'>, selectedId: string | null): Set<string> {
  if (!selectedId || !model.tasks[selectedId]) return new Set();
  return new Set([selectedId, ...stripMarks(model, selectedId).reached]);
}

export interface FlowEdge extends FlowGate {
  /** Both ends are lit by the selection. */
  on: boolean;
  /** Consecutive on the critical path. */
  critical: boolean;
}

export function flowEdges(timeline: Pick<FlowTimeline, 'gates' | 'critical'>, lit: ReadonlySet<string>): FlowEdge[] {
  const next = new Map(timeline.critical.slice(0, -1).map((id, i) => [id, timeline.critical[i + 1]]));
  return timeline.gates.map(g => ({ ...g, on: lit.has(g.from) && lit.has(g.to), critical: next.get(g.from) === g.to }));
}

/** Merged tasks share one row when there are more than `FLOW_FOLD_ABOVE` tasks and at least two have merged. */
export function shouldFoldMerged(timeline: Pick<FlowTimeline, 'order' | 'tasks'>): boolean {
  if (timeline.order.length <= FLOW_FOLD_ABOVE) return false;
  return timeline.order.filter(id => timeline.tasks[id].kind === 'done').length >= 2;
}

// ── Layout: percentages and row indices only ────────────────────────────────

export interface FlowBarLayout {
  id: string;
  kind: FlowBarKind;
  /** % of the window. */
  left: number;
  /** The solid part: done, or so far. */
  solid: number;
  /** The part still to come, from `left + solid`. */
  forecast: number;
  /** The thin p80 line, from `left`; null without a p80. */
  p80: number | null;
  /** An unlanded task on the critical path. */
  critical: boolean;
}

export type FlowRow =
  | { kind: 'task'; id: string; bar: FlowBarLayout }
  | { kind: 'merged'; ids: string[]; bars: FlowBarLayout[] };

export interface FlowLayout {
  rows: FlowRow[];
  /** Row index that draws each task. */
  rowOf: Map<string, number>;
  /** % of the window. */
  nowAt: number;
  folded: boolean;
  /** The fold exists (open or closed). */
  foldable: boolean;
}

export function layoutFlowTimeline(timeline: FlowTimeline, opts: { mergedOpen?: boolean } = {}): FlowLayout {
  const span = timeline.to - timeline.from;
  const pct = (v: number) => Math.min(100, Math.max(0, ((v - timeline.from) / span) * 100));
  const crit = new Set(timeline.critical);
  const bar = (id: string): FlowBarLayout => {
    const t = timeline.tasks[id];
    const left = pct(t.start);
    const solidEnd = t.solidEnd ?? t.start;
    return {
      id,
      kind: t.kind,
      left,
      solid: pct(solidEnd) - left,
      forecast: t.kind === 'done' ? 0 : pct(t.end) - pct(solidEnd),
      p80: t.p80End != null ? pct(t.p80End) - left : null,
      critical: t.kind !== 'done' && crit.has(id),
    };
  };
  const foldable = shouldFoldMerged(timeline);
  const folded = foldable && !opts.mergedOpen;
  const rows: FlowRow[] = [];
  const rowOf = new Map<string, number>();
  if (folded) {
    const ids = timeline.order.filter(id => timeline.tasks[id].kind === 'done');
    rows.push({ kind: 'merged', ids, bars: ids.map(bar) });
    for (const id of ids) rowOf.set(id, 0);
  }
  for (const id of timeline.order) {
    if (folded && timeline.tasks[id].kind === 'done') continue;
    rowOf.set(id, rows.length);
    rows.push({ kind: 'task', id, bar: bar(id) });
  }
  return { rows, rowOf, nowAt: pct(timeline.now), folded, foldable };
}

/** SVG user units: the track is `FLOW_X_UNITS` wide and each row `FLOW_ROW_UNITS` tall, stretched to fit. */
export const FLOW_X_UNITS = 1000;
export const FLOW_ROW_UNITS = 100;

export interface FlowEdgePath extends FlowEdge {
  d: string;
}

/**
 * Each edge as an elbow: out of the blocker's bar end, down (or up) at a
 * short step past it, into the dependent's bar start. Units are track-relative
 * (`FLOW_X_UNITS` × rows · `FLOW_ROW_UNITS`), never pixels.
 */
export function flowEdgePaths(timeline: FlowTimeline, layout: FlowLayout, edges: readonly FlowEdge[]): FlowEdgePath[] {
  const span = timeline.to - timeline.from;
  const x = (v: number) => Math.round(Math.min(1, Math.max(0, (v - timeline.from) / span)) * FLOW_X_UNITS * 10) / 10;
  const y = (row: number) => row * FLOW_ROW_UNITS + FLOW_ROW_UNITS / 2;
  const out: FlowEdgePath[] = [];
  for (const e of edges) {
    const r1 = layout.rowOf.get(e.from);
    const r2 = layout.rowOf.get(e.to);
    if (r1 == null || r2 == null || r1 === r2) continue;
    const x1 = x(timeline.tasks[e.from].end);
    const x2 = x(timeline.tasks[e.to].start);
    const xm = Math.min(x1 + 6, Math.max(x2 - 3, x1));
    out.push({ ...e, d: `M${x1},${y(r1)} H${xm} V${y(r2)} H${x2}` });
  }
  // Lit edges last, so they draw over the faint ones.
  return out.sort((a, b) => Number(a.on) - Number(b.on));
}

const AXIS_STEPS = [15, 30, 60, 120, 180, 360, 720, 1440, 2880, 10080].map(m => m * 60_000);
const MAX_AXIS_TICKS = 6;

/** Elapsed-time ticks from the window start (`0`, `1h`, `2h` · `1d`, `2d`), at most six. */
export function flowAxisTicks(timeline: Pick<FlowTimeline, 'from' | 'to'>): Array<{ at: number; label: string }> {
  const span = timeline.to - timeline.from;
  const step = AXIS_STEPS.find(s => Math.floor(span / s) + 1 <= MAX_AXIS_TICKS) ?? AXIS_STEPS[AXIS_STEPS.length - 1];
  const label = (ms: number) => {
    if (ms === 0) return '0';
    if (step >= 1440 * 60_000) return `${Math.round(ms / 86_400_000)}d`;
    if (step >= 60 * 60_000) return `${Math.round(ms / 3_600_000)}h`;
    const h = Math.floor(ms / 3_600_000);
    const m = Math.round((ms % 3_600_000) / 60_000);
    return h ? (m ? `${h}h${m}` : `${h}h`) : `${m}m`;
  };
  const out: Array<{ at: number; label: string }> = [];
  for (let ms = 0; ms <= span; ms += step) out.push({ at: (ms / span) * 100, label: label(ms) });
  return out;
}
