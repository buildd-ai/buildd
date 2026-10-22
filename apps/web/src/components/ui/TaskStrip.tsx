'use client';

import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type RefObject } from 'react';
import { STATES, type StateKey } from './states';
import { stripKeyTarget, stripRunColumns, stripRunLabel, stripRuns, tickOf, type StripMark } from './task-strip';

/** Why a waiting cell waits (spec f7f67f1a R-5): its own fill, apart from the state's. */
export type TaskStripWait = 'tasks' | 'slot' | 'hold' | 'unknown' | 'closed';

export interface TaskStripCell {
  id: string;
  state: StateKey;
  /** The tick under the cell. Defaults to its 1-based position, `07`. */
  tick?: string;
  /** The task's title, for the cell's accessible name and tooltip. */
  title?: string;
  /** A waiting cell's cause, one texture each (globals.css `data-wait`). `closed` keeps its state's fill. */
  wait?: TaskStripWait;
  /** The cell's state word, when it says more than the state's (`Next in line`). */
  word?: string;
}

/**
 * A grouped strip's three looks (spec d25d923d R-4): merged is solid green,
 * work in flight an accent hatch, everything else a dashed outline. Web
 * rendering only: the cell's state (and so `buildd top`'s row) is unchanged.
 */
export type TaskStripLook = 'merged' | 'running' | 'waiting';
const IN_FLIGHT: ReadonlySet<StateKey> = new Set<StateKey>(['running', 'review', 'fixing', 'landing', 'recovering']);
export function stripLook(state: StateKey): TaskStripLook {
  return state === 'landed' ? 'merged' : IN_FLIGHT.has(state) ? 'running' : 'waiting';
}

/** The small dot a look carries: amber when a person must act, red when it failed. */
export function stripDot(state: StateKey): 'amber' | 'red' | null {
  return state === 'needs_you' || state === 'waiting' ? 'amber' : state === 'failed' || state === 'ci_failed' ? 'red' : null;
}

/** A run of cells drawn as one group, a gap before it; `outline` encloses it (the work in progress). */
export interface TaskStripGroup {
  key: string;
  ids: readonly string[];
  outline?: boolean;
}

export type TaskStripMarks = ReadonlyMap<string, StripMark> | Readonly<Record<string, StripMark | undefined>>;

export interface TaskStripProps {
  cells: readonly TaskStripCell[];
  /**
   * `lg`: one button per task, a tick row under it, ← → / Home / End step the
   * selection. `sm`: a non-interactive row that replaces every progress bar;
   * above 16 tasks, settled runs collapse into one segment sized by count.
   */
  size?: 'lg' | 'sm';
  selectedId?: string | null;
  /** ← → / Home / End, and a tap when there is no `onOpen`. */
  onSelect?: (id: string) => void;
  /** `lg`: a tap (Enter, Space) opens the cell's task instead of selecting it. */
  onOpen?: (id: string) => void;
  /** Relation to the selection (spec §5): drawn on the tick row only, never on a cell (strip R-17). */
  marks?: TaskStripMarks;
  /** Desktop caps large cells at 56px instead of stretching them across the column. Default true. */
  capped?: boolean;
  /**
   * `lg` only: draw the cells as these groups, in this order, a gap between
   * groups and an outline round each `outline` group. Absent: one plain row.
   */
  groups?: readonly TaskStripGroup[];
  label?: string;
  className?: string;
}

/** Past this many cells the tick row stops numbering and draws marks as bars (spec §5.2). */
export const MAX_NUMBERED_TICKS = 12;

const LG_COLUMNS = '[grid-template-columns:repeat(var(--n),minmax(0,1fr))]';
const LG_COLUMNS_CAPPED = `${LG_COLUMNS} md:[grid-template-columns:repeat(var(--n),minmax(0,56px))]`;

function markOf(marks: TaskStripMarks | undefined, id: string): StripMark | null {
  if (!marks) return null;
  const m = marks instanceof Map ? marks.get(id) : (marks as Record<string, StripMark | undefined>)[id];
  return m ?? null;
}

/**
 * The box strip: the one progress element. Each cell's fill is its task's
 * display state (`states.ts`), never a share of work done.
 */
export default function TaskStrip(props: TaskStripProps) {
  return props.size === 'sm' ? <SmallStrip {...props} /> : <LargeStrip {...props} />;
}

function SmallStrip({ cells, label = 'Tasks', className = '' }: TaskStripProps) {
  const runs = stripRuns(cells.map(c => c.state));
  const summary = runs.map(r => `${r.count} ${STATES[r.state].word.toLowerCase()}`).join(', ');
  return (
    <div
      role="img"
      aria-label={`${label}: ${summary}`}
      data-testid="task-strip"
      data-size="sm"
      className={`grid gap-[3px] ${className}`}
      style={{ gridTemplateColumns: stripRunColumns(runs) }}
    >
      {runs.map((r, i) => {
        const s = STATES[r.state];
        const text = stripRunLabel(r);
        return (
          <span
            key={i}
            className="state-cell h-3.5 rounded-sm overflow-hidden whitespace-nowrap pl-[5px] font-mono text-chip md:text-[9.5px] font-semibold leading-[14px]"
            data-state={r.state}
            data-tone={s.tone}
            data-pattern={s.pattern}
            data-frame={s.frame}
            data-count={r.count}
            title={`${r.count} ${s.word}`}
          >
            {text}
          </span>
        );
      })}
    </div>
  );
}

/**
 * Grid columns for grouped cells: one `--cell` track per cell, a `--group-gap`
 * track between groups. `col` is each cell's 1-based column; `spans` each
 * outlined group's [start, end) columns.
 */
export function groupedColumns(groups: readonly TaskStripGroup[]): { template: string; col: Map<string, number>; spans: { key: string; from: number; to: number }[]; tracks: number } {
  const tracks: string[] = [];
  const col = new Map<string, number>();
  const spans: { key: string; from: number; to: number }[] = [];
  for (const g of groups) {
    if (g.ids.length === 0) continue;
    if (tracks.length > 0) tracks.push('var(--group-gap)');
    const from = tracks.length + 1;
    for (const id of g.ids) { tracks.push('var(--cell)'); col.set(id, tracks.length); }
    if (g.outline) spans.push({ key: g.key, from, to: tracks.length + 1 });
  }
  return { template: tracks.join(' '), col, spans, tracks: tracks.length };
}

/**
 * Which strip edge an outline touches. The outline sits 5px outside its
 * cells, so a strip whose first (or last) group is outlined pads that side
 * by the same 5px and the frame never sticks out past the strip.
 */
function outlineEdge(grouped: ReturnType<typeof groupedColumns> | null): { edge: 'start' | 'end' | 'both' | undefined; pad: string } {
  if (!grouped) return { edge: undefined, pad: '' };
  const start = grouped.spans.some(s => s.from === 1);
  const end = grouped.spans.some(s => s.to === grouped.tracks + 1);
  const edge = start && end ? 'both' : start ? 'start' : end ? 'end' : undefined;
  return { edge, pad: `${start ? 'pl-[5px]' : ''} ${end ? 'pr-[5px]' : ''}`.trim() };
}

// Below md a grouped cell shares the width up to a 44px box (spec f7f67f1a R-4,
// R-38): a short strip stays compact boxes, a long one shrinks its cells to
// STRIP_MIN_CELL and then wraps onto another row. It never scrolls sideways.
// From md the cells share the column as before, capped at 56px.
const GROUPED_BASE = '[--group-gap:6px] [--cell:minmax(0,44px)] md:[--group-gap:12px]';
const GROUPED_VARS = `${GROUPED_BASE} md:[--cell:minmax(0,1fr)]`;
const GROUPED_VARS_CAPPED = `${GROUPED_BASE} md:[--cell:minmax(0,56px)]`;

/** The narrowest a phone cell gets before the strip wraps (R-38). */
export const STRIP_MIN_CELL = 28;
const CELL_GAP = 4;
const GROUP_GAP = 6;

/** How many cells fit on one phone row of `width` px, given the group gaps a row may hold. */
export function stripRowCapacity(width: number, groupCount: number): number {
  const usable = width + CELL_GAP - Math.max(0, groupCount - 1) * (GROUP_GAP + CELL_GAP);
  return Math.max(1, Math.floor(usable / (STRIP_MIN_CELL + CELL_GAP)));
}

/**
 * Splits the groups into rows of at most `perRow` cells, in order. A group
 * that spans a row break continues on the next row with its outline.
 */
export function wrapStripGroups(groups: readonly TaskStripGroup[], perRow: number): TaskStripGroup[][] {
  const rows: TaskStripGroup[][] = [];
  let row: TaskStripGroup[] = [];
  let used = 0;
  for (const g of groups) {
    let rest = g.ids;
    while (rest.length > 0) {
      if (used >= perRow) { rows.push(row); row = []; used = 0; }
      const take = rest.slice(0, perRow - used);
      row.push({ ...g, ids: take });
      used += take.length;
      rest = rest.slice(take.length);
    }
  }
  if (row.length > 0) rows.push(row);
  return rows;
}

/** Cells per phone row, measured; unlimited from md and before the first measure. */
function useRowCapacity(box: RefObject<HTMLDivElement | null>, groupCount: number, enabled: boolean): number {
  const [perRow, setPerRow] = useState(Number.POSITIVE_INFINITY);
  useEffect(() => {
    const el = box.current;
    if (!enabled || !el || typeof ResizeObserver === 'undefined') return;
    const desktop = typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia('(min-width: 768px)') : null;
    const measure = () => setPerRow(desktop?.matches ? Number.POSITIVE_INFINITY : stripRowCapacity(el.clientWidth, groupCount));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    desktop?.addEventListener?.('change', measure);
    return () => { ro.disconnect(); desktop?.removeEventListener?.('change', measure); };
  }, [box, groupCount, enabled]);
  return perRow;
}

function LargeStrip({ cells, selectedId, onSelect, onOpen, marks, capped = true, label = 'Tasks', className = '', groups }: TaskStripProps) {
  const ref = useRef<HTMLDivElement>(null);
  const n = cells.length;
  const isGrouped = !!groups && groups.length > 0;
  const nonEmpty = isGrouped ? groups!.filter(g => g.ids.length > 0) : [];
  const perRow = useRowCapacity(ref, nonEmpty.length, isGrouped);
  const selIndex = cells.findIndex(c => c.id === selectedId);
  const focusIndex = selIndex === -1 ? 0 : selIndex;
  const numbered = n <= MAX_NUMBERED_TICKS;
  const indexOf = new Map(cells.map((c, i) => [c.id, i]));
  const byId = new Map(cells.map(c => [c.id, c]));

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const from = cells.findIndex(c => c.id === (e.target as HTMLElement).dataset.id);
    const to = stripKeyTarget(e.key, from === -1 ? focusIndex : from, n);
    if (to == null) return;
    e.preventDefault();
    onSelect?.(cells[to].id);
    ref.current?.querySelectorAll<HTMLButtonElement>('button[data-id]')[to]?.focus();
  }

  /** One grid of cells plus its tick row: the whole strip, or one wrapped row of it. */
  const renderRow = (rowCells: readonly TaskStripCell[], rowGroups: readonly TaskStripGroup[] | null, key: string) => {
    const grouped = rowGroups ? groupedColumns(rowGroups) : null;
    const columns = grouped ? (capped ? GROUPED_VARS_CAPPED : GROUPED_VARS) : capped ? LG_COLUMNS_CAPPED : LG_COLUMNS;
    const style = (grouped ? { gridTemplateColumns: grouped.template } : { '--n': n }) as CSSProperties;
    const place = (id: string): CSSProperties | undefined => (grouped ? { gridColumn: grouped.col.get(id), gridRow: 1 } : undefined);
    const outline = outlineEdge(grouped);
    return (
      <div key={key} data-testid="task-strip-row" className="flex flex-col gap-1.5">
        <div data-testid="task-strip-cells" data-outline-edge={outline.edge} className={`grid gap-1 ${columns} ${outline.pad}`} style={style}>
          {grouped?.spans.map(sp => (
            // The group outline: one accent frame round the work in progress (spec f7f67f1a R-3).
            <span
              key={`outline-${sp.key}`}
              aria-hidden="true"
              data-testid="task-strip-group-outline"
              data-group={sp.key}
              className="pointer-events-none -m-[5px] rounded-[var(--radius-card)] border border-accent"
              style={{ gridColumn: `${sp.from} / ${sp.to}`, gridRow: 1 }}
            />
          ))}
          {rowCells.map(c => {
            const i = indexOf.get(c.id) ?? 0;
            const s = STATES[c.state];
            const tick = c.tick ?? tickOf(i);
            const selected = c.id === selectedId;
            // A grouped strip (the mission bar) draws three looks plus a dot; a plain one keeps every state's texture.
            const look = grouped ? stripLook(c.state) : undefined;
            const dot = grouped ? stripDot(c.state) : null;
            return (
              <button
                key={c.id}
                type="button"
                data-id={c.id}
                data-state={c.state}
                data-tone={s.tone}
                data-pattern={s.pattern}
                data-frame={s.frame}
                data-wait={c.wait}
                style={place(c.id)}
                aria-pressed={selected}
                aria-label={`${tick} ${c.word ?? s.word}${c.title ? `: ${c.title}` : ''}`}
                title={c.title}
                tabIndex={i === focusIndex ? 0 : -1}
                onClick={() => (onOpen ?? onSelect)?.(c.id)}
                className="flex h-11 min-w-0 cursor-pointer flex-col justify-end gap-[3px] rounded-[var(--radius-cell)] md:h-16 md:gap-0"
              >
                {/* Below md the cell is a slim bar in a full-height tap target; the
                    selection is a separate ink marker above it, not a frame. */}
                <span aria-hidden="true" data-testid="task-strip-marker" className={`h-[3px] w-full shrink-0 rounded-full md:hidden ${selected ? 'bg-text-primary' : ''}`} />
                <span
                  aria-hidden="true"
                  data-testid="task-strip-fill"
                  data-tone={s.tone}
                  data-pattern={s.pattern}
                  data-frame={s.frame}
                  data-wait={c.wait}
                  data-look={look}
                  // The running cell's hatch drifts (globals.css); reduced motion keeps it still.
                  data-drift={look && c.state === 'running' ? true : undefined}
                  className={`state-cell relative flex h-4 w-full shrink-0 items-center justify-center rounded-[var(--radius-cell)] font-mono text-chip font-semibold leading-none md:h-full ${selected ? 'md:[outline:2px_solid_var(--text-primary)] md:[outline-offset:2px]' : ''}`}
                >
                  {look ? null : c.wait && c.wait !== 'closed' ? null : s.cellGlyph ? s.glyph : null}
                  {dot && <span data-testid="task-strip-dot" data-dot={dot} className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full md:right-1 md:top-1" />}
                </span>
              </button>
            );
          })}
        </div>
        <div aria-hidden="true" data-testid="task-strip-ticks" className={`grid gap-1 text-center font-mono text-chip ${columns} ${outline.pad}`} style={style}>
          {rowCells.map(c => {
            const i = indexOf.get(c.id) ?? 0;
            const selected = c.id === selectedId;
            // strip R-16: the selected tick is never marked and always keeps its number.
            const mark = selected ? null : markOf(marks, c.id);
            return (
              <span key={c.id} data-mark={mark ?? undefined} style={place(c.id)} className={tickClass(mark, selected, c.state, numbered)}>
                {numbered || selected ? (c.tick ?? tickOf(i)) : null}
              </span>
            );
          })}
        </div>
      </div>
    );
  };

  const rows = isGrouped
    ? wrapStripGroups(nonEmpty, perRow).map((rg, r) => renderRow(rg.flatMap(g => g.ids.map(id => byId.get(id)).filter((c): c is TaskStripCell => !!c)), rg, `row-${r}`))
    : [renderRow(cells, null, 'row-0')];

  return (
    <div
      ref={ref}
      role="toolbar"
      aria-label={label}
      onKeyDown={onKeyDown}
      data-testid="task-strip"
      data-size="lg"
      data-rows={rows.length}
      className={`flex flex-col gap-3 ${className}`}
    >
      {rows}
    </div>
  );
}

function tickClass(mark: StripMark | null, selected: boolean, state: StateKey, numbered: boolean): string {
  if (selected) return 'font-semibold text-text-primary';
  if (!numbered) {
    // strip R-14/R-15 unnumbered: a 6px bar for direct, a 2px line for transitive, nothing otherwise.
    return mark === 'direct' ? 'h-1.5 self-start rounded-sm bg-accent'
      : mark === 'transitive' ? 'h-0.5 self-start bg-accent'
      : '';
  }
  if (mark === 'direct') return 'rounded-sm bg-accent text-[var(--on-accent)] font-semibold';
  if (mark === 'transitive') return 'text-accent-text border-b-2 border-accent';
  return state === 'running' ? 'text-accent-text' : 'text-text-muted';
}

export { TaskStrip };
