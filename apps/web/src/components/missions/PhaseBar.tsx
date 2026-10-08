/**
 * The phase-segmented mission bar: one cell per deliverable, grouped by phase,
 * each cell wearing its task's short label (lib/mission-list-card.ts).
 *
 * - `lg`: the missions list — labels inside cells, phase name + n/N under each group.
 * - `sm`: Home's compact missions summary — no labels, no captions.
 *
 * Colour is tokens only and comes from the cell's canonical tone: landed =
 * success fill, failed = error fill, active = accent outline (with a fill to
 * the worker's progress while running), open = hairline, held = dashed.
 */
import Link from 'next/link';
import type { ListCell, ListCellState, ListPhase } from '@/lib/mission-list-card';
import type { StripTone } from '@/lib/mission-task-strip';

export const CELL_STATE_LABEL: Record<ListCellState, string> = {
  done: 'merged',
  in_ci: 'in CI',
  running: 'running',
  needs_you: 'needs you',
  failed: 'failed',
  queued: 'queued',
  skipped: 'cancelled',
};

/**
 * Cell box classes per canonical tone (`stripTone`) — the same landed / failed
 * / open / held vocabulary as the mission page's strip. The only place the
 * bar's colour is spelled; it is keyed by tone, never by a raw state, so a
 * failed cell cannot take another bucket's colour.
 */
export const TONE_BOX: Record<StripTone, string> = {
  ok: 'bg-status-success border border-status-success',
  error: 'bg-status-error border border-status-error',
  active: 'border border-accent',
  open: 'border border-border-default',
  held: 'border border-dashed border-border-default bg-surface-2',
};

const TONE_TEXT: Record<StripTone, string> = {
  ok: 'text-[var(--card)]',
  error: 'text-[var(--card)]',
  active: 'text-text-primary',
  open: 'text-text-muted',
  held: 'text-text-muted',
};

function Cell({ cell, size }: { cell: ListCell; size: 'lg' | 'sm' }) {
  const h = size === 'lg' ? 'h-[26px]' : 'h-[18px]';
  return (
    <Link
      href={cell.href}
      data-testid="phase-bar-cell"
      data-state={cell.state}
      data-tone={cell.tone}
      data-task-id={cell.taskId}
      aria-label={`${cell.label}: ${CELL_STATE_LABEL[cell.state]}`}
      title={`${cell.title} · ${CELL_STATE_LABEL[cell.state]}`}
      className={`relative block min-w-0 flex-1 overflow-hidden ${h} ${TONE_BOX[cell.tone]} hover:opacity-90`}
    >
      {cell.state === 'running' && (
        <span
          aria-hidden="true"
          className="absolute inset-y-0 left-0 bg-accent"
          style={{ width: `${Math.round(cell.fill * 100)}%` }}
        />
      )}
      {size === 'lg' && (
        <span
          className={`absolute inset-0 flex items-center justify-center overflow-hidden whitespace-nowrap px-0.5 font-mono text-[11px] md:text-[10px] font-semibold ${TONE_TEXT[cell.tone]}`}
        >
          <span className="min-w-0 truncate">{cell.label}</span>
        </span>
      )}
    </Link>
  );
}

export default function PhaseBar({ phases, size = 'lg' }: { phases: readonly ListPhase[]; size?: 'lg' | 'sm' }) {
  if (phases.length === 0) return null;
  return (
    <div
      data-testid="phase-bar"
      className={`flex min-w-0 ${size === 'lg' ? 'flex-wrap gap-x-2.5 gap-y-3' : 'gap-x-1.5'}`}
    >
      {phases.map(p => (
        <div
          key={p.key}
          data-testid="phase-bar-phase"
          className="flex min-w-0 flex-col gap-1.5"
          style={{ flex: `${p.cells.length} 1 ${size === 'lg' ? p.cells.length * 44 : 0}px` }}
        >
          <div className={`flex min-w-0 ${size === 'lg' ? 'gap-[3px]' : 'gap-[2px]'}`}>
            {p.cells.map(c => <Cell key={c.taskId} cell={c} size={size} />)}
          </div>
          {size === 'lg' && (
            <div className="flex justify-between gap-2 whitespace-nowrap font-mono text-[11px] md:text-[10px] uppercase tracking-[1.5px] text-text-muted">
              <span className="truncate">{p.label ?? 'Tasks'}</span>
              <b className="font-semibold tracking-normal text-text-secondary">{p.done}/{p.total}</b>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

const LEGEND: ReadonlyArray<{ tone: StripTone; label: string }> = [
  { tone: 'ok', label: 'landed' },
  { tone: 'active', label: 'active' },
  { tone: 'error', label: 'failed' },
  { tone: 'open', label: 'open' },
  { tone: 'held', label: 'held' },
];

export function PhaseBarLegend() {
  return (
    <div data-testid="phase-bar-legend" className="hidden flex-wrap gap-x-3.5 gap-y-1 font-mono text-[11px] text-text-muted md:flex">
      {LEGEND.map(({ tone, label }) => (
        <span key={tone} className="inline-flex items-center gap-1.5">
          <i aria-hidden="true" className={`relative inline-block h-2.5 w-2.5 overflow-hidden ${TONE_BOX[tone]}`}>
            {tone === 'active' && <b className="absolute inset-y-0 left-0 w-1/2 bg-accent" />}
          </i>
          {label}
        </span>
      ))}
    </div>
  );
}
