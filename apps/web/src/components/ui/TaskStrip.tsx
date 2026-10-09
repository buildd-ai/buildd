'use client';

import { useRef, type CSSProperties, type KeyboardEvent } from 'react';
import { STATES, type StateKey } from './states';
import { stripKeyTarget, stripRunColumns, stripRunLabel, stripRuns, tickOf, type StripMark } from './task-strip';

export interface TaskStripCell {
  id: string;
  state: StateKey;
  /** The tick under the cell. Defaults to its 1-based position, `07`. */
  tick?: string;
  /** The task's title, for the cell's accessible name and tooltip. */
  title?: string;
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

function LargeStrip({ cells, selectedId, onSelect, marks, capped = true, label = 'Tasks', className = '' }: TaskStripProps) {
  const ref = useRef<HTMLDivElement>(null);
  const n = cells.length;
  const columns = capped ? LG_COLUMNS_CAPPED : LG_COLUMNS;
  const style = { '--n': n } as CSSProperties;
  const selIndex = cells.findIndex(c => c.id === selectedId);
  const focusIndex = selIndex === -1 ? 0 : selIndex;
  const numbered = n <= MAX_NUMBERED_TICKS;

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
      <div ref={ref} role="toolbar" aria-label={label} onKeyDown={onKeyDown} className={`grid gap-1 ${columns}`} style={style}>
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
              aria-pressed={selected}
              aria-label={`${tick} ${s.word}${c.title ? `: ${c.title}` : ''}`}
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
                className={`state-cell flex h-4 w-full shrink-0 items-center justify-center rounded-[var(--radius-cell)] font-mono text-chip font-semibold leading-none md:h-full ${selected ? 'md:[outline:2px_solid_var(--text-primary)] md:[outline-offset:2px]' : ''}`}
              >
                {s.cellGlyph ? s.glyph : null}
              </span>
            </button>
          );
        })}
      </div>
      <div aria-hidden="true" data-testid="task-strip-ticks" className={`grid gap-1 text-center font-mono text-chip ${columns}`} style={style}>
        {cells.map((c, i) => {
          const selected = c.id === selectedId;
          // MK-3: the selected tick is never marked and always keeps its number.
          const mark = selected ? null : markOf(marks, c.id);
          return (
            <span key={c.id} data-mark={mark ?? undefined} className={tickClass(mark, selected, c.state, numbered)}>
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
