/**
 * The mission page's Landed strip, as data: its order, each cell's state, what
 * a selection marks, which cell is selected by default, where the drawer's
 * caret sits under it, and how the keyboard and the stepper move. Pure, so the
 * strip's rules are tested without a DOM.
 *
 * Spec: docs/specs/mission-progress-strip-ordering.md. Strip order is
 * dependency order (every dependency left of its dependents), banded by
 * component and level from the shared adjacency the Board model carries.
 */
import { BOARD_LANDED, type BoardStatus, type BoardTask, type MissionBoardModel } from './mission-board';

type StripModel = Pick<MissionBoardModel, 'phases' | 'tasks'>;

// ── Display state (§3) ──────────────────────────────────────────────────────

/**
 * A cell's state: the Board's, with landed folded into one and `blocked`
 * split by what holds it. Derived from the shared adjacency, never stored.
 */
export type StripState =
  | 'landed' | 'review' | 'running' | 'fixing' | 'waiting' | 'ci_failed' | 'failed'
  | 'ready' // nothing holds it
  | 'blocked' // waiting on work that is moving, or on another mission
  | 'queued'; // behind a chain that is itself held

export function stripState(model: Pick<MissionBoardModel, 'tasks'>, id: string): StripState {
  const t = model.tasks[id];
  if (BOARD_LANDED.has(t.status)) return 'landed';
  if (t.status !== 'blocked') return t.status as Exclude<BoardStatus, 'merged' | 'done' | 'blocked'>;
  if (t.offStrip.length > 0 || t.frontier.length === 0) return 'blocked';
  return t.frontier.every(f => model.tasks[f]?.status === 'blocked') ? 'queued' : 'blocked';
}

const HELD: ReadonlySet<StripState> = new Set(['blocked', 'queued']);
export const isHeldState = (s: StripState) => HELD.has(s);
/** Something can happen on it now: not landed, not held. */
export const isActiveState = (s: StripState) => s !== 'landed' && !HELD.has(s);

/**
 * The one failed/error bucket (ci_failed, fixing, failed): everywhere a cell's
 * state is painted — the strip cell, its outline, a tick's digit, a count — it
 * is this check or `stripTone`, never a second "is this cell red" test.
 */
const ERROR: ReadonlySet<StripState> = new Set(['ci_failed', 'fixing', 'failed']);
export const isErrorState = (s: StripState) => ERROR.has(s);

/**
 * A cell's colour tone: the one landed/failed/open vocabulary every surface
 * (strip cell fill, outline, tick digit, drawer border+pill) renders from, so
 * a failed cell can never read as "open" in one place and "failed" in another.
 */
export type StripTone = 'ok' | 'error' | 'open';
export function stripTone(state: StripState): StripTone {
  if (state === 'landed') return 'ok';
  if (isErrorState(state)) return 'error';
  return 'open';
}

/** Active slots whose state is the failed/error bucket, in strip order. */
export function errorIndices(slots: readonly StripSlot[]): number[] {
  return slots.flatMap((s, i) => (s.kind === 'task' && isErrorState(s.state) ? [i] : []));
}

const READINESS: Record<StripState, number> = {
  landed: 0, review: 1, running: 2, fixing: 2, waiting: 2, ci_failed: 3, failed: 3, ready: 4, blocked: 5, queued: 6,
};

// ── Order (§2) ──────────────────────────────────────────────────────────────

/**
 * Component (by its earliest member), then level, then readiness, phase,
 * createdAt, id. Every on-strip edge raises the level, and component and level
 * outrank every state key, so dependencies sit left of dependents (ORD-1) and
 * a state change only moves a cell within its own level (ORD-3).
 */
export function stripOrder(model: StripModel): string[] {
  const ids = model.phases.flatMap(p => p.taskIds);
  const tasks = model.tasks;
  const first = new Map<number, BoardTask>();
  for (const id of ids) {
    const t = tasks[id];
    const f = first.get(t.component);
    if (!f || t.createdAt < f.createdAt || (t.createdAt === f.createdAt && t.id < f.id)) first.set(t.component, t);
  }
  const state = new Map(ids.map(id => [id, stripState(model, id)]));
  const cmpId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return [...ids].sort((a, b) => {
    const ta = tasks[a];
    const tb = tasks[b];
    if (ta.component !== tb.component) {
      const fa = first.get(ta.component)!;
      const fb = first.get(tb.component)!;
      return fa.createdAt - fb.createdAt || cmpId(fa.id, fb.id);
    }
    return ta.level - tb.level
      || READINESS[state.get(a)!] - READINESS[state.get(b)!]
      || (ta.phaseIndex ?? Infinity) - (tb.phaseIndex ?? Infinity)
      || ta.createdAt - tb.createdAt
      || cmpId(a, b);
  });
}

// ── Slots and the 64-cell cap (§7.11) ───────────────────────────────────────

/** The most cell buttons the strip draws (`FLIGHT_STRIP_BAR_CAP`). */
export const STRIP_CELL_CAP = 64;
export const STRIP_FOLD_PREFIX = 'strip-fold:';

export type StripSlot =
  | { kind: 'task'; id: string; state: StripState }
  | { kind: 'fold'; id: string; state: 'landed' | 'queued'; taskIds: string[] };

/**
 * One slot per cell, in strip order. Past the cap the leftmost landed cells
 * fold into one summary at 01; if that is not enough, the rightmost queued
 * cells fold into a trailing one. Active and blocked work is never folded.
 */
export function stripSlots(model: StripModel, cap = STRIP_CELL_CAP): StripSlot[] {
  const order = stripOrder(model);
  const slots: StripSlot[] = order.map(id => ({ kind: 'task', id, state: stripState(model, id) }));
  if (slots.length <= cap) return slots;
  const over = slots.length - cap;
  const landed = slots.flatMap((s, i) => (s.state === 'landed' ? [i] : []));
  const queued = slots.flatMap((s, i) => (s.state === 'queued' ? [i] : []));
  let foldL: number[] = landed.slice(0, over + 1);
  let foldQ: number[] = [];
  if (landed.length < over + 1) {
    // Folding n cells into one summary saves n − 1; a lone cell saves nothing.
    foldL = landed.length >= 2 ? landed : [];
    const need = over - Math.max(foldL.length - 1, 0) + 1;
    foldQ = queued.length >= 2 ? queued.slice(-Math.min(need, queued.length)) : [];
  }
  const out: StripSlot[] = [];
  const folded = new Set([...foldL, ...foldQ]);
  if (foldL.length) out.push({ kind: 'fold', id: `${STRIP_FOLD_PREFIX}landed`, state: 'landed', taskIds: foldL.map(i => order[i]) });
  slots.forEach((s, i) => { if (!folded.has(i)) out.push(s); });
  if (foldQ.length) out.push({ kind: 'fold', id: `${STRIP_FOLD_PREFIX}queued`, state: 'queued', taskIds: foldQ.map(i => order[i]) });
  return out;
}

/** The slot a task is drawn in (its own, or the summary it folded into). */
export function slotIndexOf(slots: readonly StripSlot[]): Map<string, number> {
  const at = new Map<string, number>();
  slots.forEach((s, i) => {
    if (s.kind === 'task') at.set(s.id, i);
    else for (const id of s.taskIds) at.set(id, i);
  });
  return at;
}

// ── Dependency-on-selection (§5) ────────────────────────────────────────────

export type StripMark = 'direct' | 'transitive';

export interface StripSelectionMarks {
  /** upstream: what holds the selection; downstream: what it holds. */
  direction: 'upstream' | 'downstream' | null;
  marks: Map<string, StripMark>;
  /** In the walk's direction, every on-strip task reached (direct included). */
  reached: string[];
}

/**
 * What a selected cell marks on the tick row. A held cell marks its frontier
 * (direct) and the rest of what holds it upstream (transitive); an active cell
 * marks the non-landed work it holds, its direct dependents first. Both walk
 * unsatisfied edges only, so a landed or merged dependency is never marked.
 */
export function stripMarks(model: Pick<MissionBoardModel, 'tasks'>, selectedId: string): StripSelectionMarks {
  const none: StripSelectionMarks = { direction: null, marks: new Map(), reached: [] };
  const t = model.tasks[selectedId];
  if (!t) return none;
  const state = stripState(model, selectedId);
  if (state === 'landed') return none;

  if (isHeldState(state)) {
    const reached = walk(selectedId, id => model.tasks[id]?.blockers ?? []);
    const direct = new Set(t.frontier.filter(id => model.tasks[id]));
    const marks = new Map<string, StripMark>(reached.map(id => [id, direct.has(id) ? 'direct' : 'transitive']));
    return { direction: 'upstream', marks, reached };
  }

  const dependents = new Map<string, string[]>();
  for (const d of Object.values(model.tasks)) {
    for (const b of d.blockers) {
      const list = dependents.get(b);
      if (list) list.push(d.id);
      else dependents.set(b, [d.id]);
    }
  }
  const notLanded = (id: string) => !BOARD_LANDED.has(model.tasks[id].status);
  const reached = walk(selectedId, id => dependents.get(id) ?? []).filter(notLanded);
  if (reached.length === 0) return none;
  const direct = new Set((dependents.get(selectedId) ?? []).filter(notLanded));
  const marks = new Map<string, StripMark>(reached.map(id => [id, direct.has(id) ? 'direct' : 'transitive']));
  return { direction: 'downstream', marks, reached };
}

/** Breadth-first over `next`, excluding `from`; terminates on cycles. */
function walk(from: string, next: (id: string) => readonly string[]): string[] {
  const seen = new Set<string>([from]);
  const out: string[] = [];
  const queue = [...next(from)];
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    queue.push(...next(id));
  }
  return out;
}

/** Per slot: the strongest mark of any task drawn in it (a fold takes its members'). */
export function slotMarks(slots: readonly StripSlot[], marks: ReadonlyMap<string, StripMark>, selectedIndex: number): Array<StripMark | null> {
  const at = slotIndexOf(slots);
  const out: Array<StripMark | null> = slots.map(() => null);
  for (const [id, m] of marks) {
    const i = at.get(id);
    if (i == null || i === selectedIndex) continue;
    if (out[i] !== 'direct') out[i] = m;
  }
  return out;
}

const MAX_NAMED = 2;

/**
 * The drawer's reason line for a selection that marks something: off-strip
 * blockers first, then the frontier (or the direct dependents), at most two
 * named, the rest as a count. Null when the selection marks nothing and is not
 * held (the state's own sentence stands).
 */
export function stripSelectionReason(
  model: Pick<MissionBoardModel, 'tasks'>,
  selectedId: string,
  tickOf: (taskId: string) => string,
): string | null {
  const t = model.tasks[selectedId];
  if (!t) return null;
  const sel = stripMarks(model, selectedId);
  const name = (id: string) => `${tickOf(id)} ${model.tasks[id].scope ?? model.tasks[id].label}`;
  const byTick = (a: string, b: string) => tickOf(a).localeCompare(tickOf(b));
  if (sel.direction === 'downstream') {
    const direct = sel.reached.filter(id => sel.marks.get(id) === 'direct').sort(byTick);
    const named = direct.slice(0, MAX_NAMED);
    const rest = sel.reached.length - named.length;
    return `Unblocks ${named.map(name).join(', ')}${rest > 0 ? ` (+${rest} downstream)` : ''}.`;
  }
  if (!isHeldState(stripState(model, selectedId))) return null;
  const names = [
    ...t.offStrip.map(b => `${b.title}${b.otherMission ? ' · other mission' : ''}`),
    ...t.frontier.filter(id => model.tasks[id]).sort(byTick).map(name),
  ];
  if (names.length === 0) return 'Waiting on its dependencies.';
  const named = names.slice(0, MAX_NAMED);
  const rest = t.offStrip.length + sel.reached.length - named.length;
  return `After ${named.join(', ')}${rest > 0 ? ` (+${rest} upstream)` : ''}.`;
}

/** |blockers(T)|, off-strip included: the "waiting on N" count (SEL-3). */
export const stripBlockerCount = (t: Pick<BoardTask, 'blockers' | 'offStrip'>) => t.blockers.length + t.offStrip.length;

// ── Ordinal (§4) ────────────────────────────────────────────────────────────

/** `13 · LEVEL 9 OF 10`, or `13` alone for a cell with no on-strip edge. */
export function stripOrdinal(t: Pick<BoardTask, 'level' | 'levels'>, index: number): string {
  return t.levels > 1 ? `${stripTick(index)} · LEVEL ${t.level} OF ${t.levels}` : stripTick(index);
}

// ── Selection and stepping (§9) ─────────────────────────────────────────────

/** Indices of the active slots (something can happen on them now), in strip order. */
export function activeIndices(slots: readonly StripSlot[]): number[] {
  return slots.flatMap((s, i) => (s.kind === 'task' && isActiveState(s.state) ? [i] : []));
}

/** Indices of the held task slots, in strip order. */
export function heldIndices(slots: readonly StripSlot[]): number[] {
  return slots.flatMap((s, i) => (s.kind === 'task' && isHeldState(s.state) ? [i] : []));
}

/** Held tasks, folded ones included. */
export function heldCount(slots: readonly StripSlot[]): number {
  return slots.reduce((n, s) => n + (s.kind === 'fold' ? (s.state === 'queued' ? s.taskIds.length : 0) : isHeldState(s.state) ? 1 : 0), 0);
}

/**
 * The cell selected on arrival: the task the situation block is about, when
 * the strip has it; else the first active cell; else the first held one; else
 * (all landed) the last.
 */
export function defaultStripSelection(slots: readonly StripSlot[], focusTaskId?: string | null): string | null {
  if (slots.length === 0) return null;
  if (focusTaskId && slots.some(s => s.id === focusTaskId)) return focusTaskId;
  const i = activeIndices(slots)[0] ?? heldIndices(slots)[0] ?? slots.length - 1;
  return slots[i].id;
}

/** The next active cell after `sel`, wrapping; `sel` itself when it is the only one. */
export function nextOpenIndex(open: readonly number[], sel: number): number | null {
  if (open.length === 0) return null;
  return open.find(i => i > sel) ?? open[0];
}

/** Step `delta` cells, wrapping at both ends. */
export function stepIndex(i: number, delta: number, n: number): number {
  return n === 0 ? 0 : (((i + delta) % n) + n) % n;
}

/** The toolbar's keys: ArrowLeft/Right step, Home/End jump. Anything else is not ours. */
export function stripKeyTarget(key: string, i: number, n: number): number | null {
  switch (key) {
    case 'ArrowRight': return stepIndex(i, 1, n);
    case 'ArrowLeft': return stepIndex(i, -1, n);
    case 'Home': return 0;
    case 'End': return n - 1;
    default: return null;
  }
}

/**
 * Horizontal centre of cell `i` of `n` equal flex cells separated by
 * `var(--strip-gap)`: exact under flex gap, so the caret sits on the cell.
 */
export function stripCaretLeft(i: number, n: number): string {
  if (n <= 0) return '0px';
  return `calc((100% - var(--strip-gap) * ${n - 1}) * ${(i + 0.5) / n} + var(--strip-gap) * ${i})`;
}

/** `07`: the tick under a cell and the drawer's position. */
export const stripTick = (i: number) => String(i + 1).padStart(2, '0');

/** Past this many cells the gap tightens to 1px (W-1). */
export const DENSE_STRIP_CELLS = 24;
