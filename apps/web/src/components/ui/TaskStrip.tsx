'use client';

import { useRef, type CSSProperties, type KeyboardEvent } from 'react';
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
  onSelect?: (id: string) => void;
  /** Relation to the selection (spec §5): drawn on the tick row only, never on a cell (MK-4). */
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

const GROUPED_VARS = '[--group-gap:6px] [--cell:minmax(0,1fr)] md:[--group-gap:12px]';
const GROUPED_VARS_CAPPED = `${GROUPED_VARS} md:[--cell:minmax(0,56px)]`;

function LargeStrip({ cells, selectedId, onSelect, marks, capped = true, label = 'Tasks', className = '', groups }: TaskStripProps) {
  const ref = useRef<HTMLDivElement>(null);
  const n = cells.length;
  const grouped = groups && groups.length > 0 ? groupedColumns(groups) : null;
  const columns = grouped ? (capped ? GROUPED_VARS_CAPPED : GROUPED_VARS) : capped ? LG_COLUMNS_CAPPED : LG_COLUMNS;
  const style = (grouped ? { gridTemplateColumns: grouped.template } : { '--n': n }) as CSSProperties;
  const place = (id: string): CSSProperties | undefined => (grouped ? { gridColumn: grouped.col.get(id), gridRow: 1 } : undefined);
  const selIndex = cells.findIndex(c => c.id === selectedId);
  const focusIndex = selIndex === -1 ? 0 : selIndex;
  const numbered = n <= MAX_NUMBERED_TICKS;
  const outline = outlineEdge(grouped);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const from = cells.findIndex(c => c.id === (e.target as HTMLElement).dataset.id);
    const to = stripKeyTarget(e.key, from === -1 ? focusIndex : from, n);
    if (to == null) return;
    e.preventDefault();
    onSelect?.(cells[to].id);
    ref.current?.querySelectorAll<HTMLButtonElement>('button[data-id]')[to]?.focus();
  }

  return (
    <div className={`flex flex-col gap-1.5 ${className}`} data-testid="task-strip" data-size="lg">
      <div ref={ref} role="toolbar" aria-label={label} onKeyDown={onKeyDown} data-outline-edge={outline.edge} className={`grid gap-1 ${columns} ${outline.pad}`} style={style}>
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
        {cells.map((c, i) => {
          const s = STATES[c.state];
          const tick = c.tick ?? tickOf(i);
          const selected = c.id === selectedId;
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
              onClick={() => onSelect?.(c.id)}
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
                className={`state-cell flex h-4 w-full shrink-0 items-center justify-center rounded-[var(--radius-cell)] font-mono text-chip font-semibold leading-none md:h-full ${selected ? 'md:[outline:2px_solid_var(--text-primary)] md:[outline-offset:2px]' : ''}`}
              >
                {c.wait && c.wait !== 'closed' ? null : s.cellGlyph ? s.glyph : null}
              </span>
            </button>
          );
        })}
      </div>
      <div aria-hidden="true" data-testid="task-strip-ticks" className={`grid gap-1 text-center font-mono text-chip ${columns} ${outline.pad}`} style={style}>
        {cells.map((c, i) => {
          const selected = c.id === selectedId;
          // MK-3: the selected tick is never marked and always keeps its number.
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
}

function tickClass(mark: StripMark | null, selected: boolean, state: StateKey, numbered: boolean): string {
  if (selected) return 'font-semibold text-text-primary';
  if (!numbered) {
    // MK-1/MK-2 unnumbered: a 6px bar for direct, a 2px line for transitive, nothing otherwise.
    return mark === 'direct' ? 'h-1.5 self-start rounded-sm bg-accent'
      : mark === 'transitive' ? 'h-0.5 self-start bg-accent'
      : '';
  }
  if (mark === 'direct') return 'rounded-sm bg-accent text-[var(--on-accent)] font-semibold';
  if (mark === 'transitive') return 'text-accent-text border-b-2 border-accent';
  return state === 'running' ? 'text-accent-text' : 'text-text-muted';
}

export { TaskStrip };
