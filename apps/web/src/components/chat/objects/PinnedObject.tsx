'use client';

/**
 * The object the conversation is about, pinned at the top of the chat canvas
 * and live (docs/design/chat-canvas.md). A mission shows as a compact board,
 * one column per phase; anything else as its one-line title. It's a fleet
 * object, so it's hard and square even inside the soft conversation.
 *
 * Desktop: "Open beside" docks the full object in the pane. Phone: the whole
 * strip opens the object as a sheet.
 */
import { useState } from 'react';
import type { VisualReviewModel } from '@buildd/shared';
import { taskDisplayLabel } from '@buildd/core/task-label';
import VisualReviewLine from '@/components/visual-review/VisualReviewLine';
import type { BuilddObjectRef } from '../chat-contract';
import { useChatActions } from '../ChatActions';
import { hasVisualReview } from './mission-visual';
import { ScopeChip } from '@/app/app/(protected)/missions/[id]/MissionBoardParts';
import { useObjectEntry } from './ObjectStoreProvider';
import type { ObjectView } from './object-views';
import { missionCountsLine } from './MissionObject';
import { miniBoardColumns, miniStatusTone, type MiniTone } from './mini-board';
import { StateChip, missionTone } from './parts';

const SQUARE: Record<MiniTone, string> = {
  ok: 'bg-status-success',
  live: 'bg-accent',
  attention: 'bg-status-warning',
  bad: 'bg-status-error',
  review: 'border-[1.5px] border-status-success',
  idle: 'border-[1.5px] border-[var(--fleet-border-mid)]',
};

/**
 * The pinned strip's title. A task shows its display label (scope-stripped,
 * creator-label-aware — the same words the Board and the task page use), not
 * the raw commit-style title `view.title` carries; anything else (a mission,
 * a PR) shows its own title as-is. Before the object has loaded, there's
 * nothing to derive a label from yet, so the ref's own fallback text stands in.
 */
export function pinnedObjectTitle(objRef: BuilddObjectRef, view: ObjectView | null): string {
  if (view?.kind === 'task') return taskDisplayLabel({ title: view.title, label: null }).label;
  if (view && 'title' in view) return view.title;
  return objRef.title ?? objRef.fallbackText;
}

/**
 * The strip's visual review chip: the action, "Review N" (the card button's
 * words; the Line beside it already says how many wait), while screens wait on
 * you, red "No browser runner" while the audit cannot start. Null otherwise
 * (the Line beside it says the rest).
 */
export function pinnedVisualChip(visual: VisualReviewModel | null | undefined): { label: string; tone: 'needs' | 'bad' } | null {
  if (!visual) return null;
  if (visual.phase === 'no_browser_runner') return { label: 'No browser runner', tone: 'bad' };
  const n = visual.summary.awaitingHuman;
  return n > 0 ? { label: `Review ${n}`, tone: 'needs' } : null;
}

const CHIP_TONE = {
  needs: 'border-accent text-accent-text hover:bg-[var(--accent-soft)]',
  bad: 'border-status-error text-status-error hover:bg-surface-3',
} as const;

/** The chip as a button, at every width: it opens the deck (or, with no screens yet, the mission). */
export function PinnedVisualChip({ model, onReview }: { model: VisualReviewModel; onReview(startKey: string | null): void }) {
  const chip = pinnedVisualChip(model);
  if (!chip) return null;
  return (
    <button
      type="button"
      data-testid="canvas-pinned-visual-chip"
      data-tone={chip.tone}
      onClick={() => onReview(model.queue[0] ?? null)}
      className={`inline-flex min-h-9 shrink-0 items-center border-[1.5px] px-2.5 font-mono text-[11px] font-bold uppercase tracking-[1.2px] ${CHIP_TONE[chip.tone]}`}
    >
      {chip.label}
    </button>
  );
}

export default function PinnedObject({ objRef, onOpen, hideOnDesktop = false, openLabel = 'Open beside ▸', className = '' }: {
  objRef: BuilddObjectRef;
  /** Desktop: dock it in the pane. Phone: open the sheet. */
  onOpen(): void;
  /** The pane already shows this object on desktop: pin on phone only. */
  hideOnDesktop?: boolean;
  /** The desktop button's words; null hides it (the page behind already is the object). */
  openLabel?: string | null;
  /** Extra breakpoint classes (the needs-you strip shows only from 1024 to 1279). */
  className?: string;
}) {
  const { view } = useObjectEntry(objRef);
  const actions = useChatActions();
  const [open, setOpen] = useState(true);
  const mission = view?.kind === 'mission' ? view : null;
  const visual = mission && hasVisualReview(mission.visual) ? mission.visual : null;
  const review = (startKey: string | null) => {
    if (visual && visual.cells.length > 0) actions.openVisualReview(objRef, startKey);
    else onOpen();
  };
  const title = pinnedObjectTitle(objRef, view);
  const cols = mission ? miniBoardColumns(mission.board, 4) : [];
  const tone = mission ? missionTone(mission.stateLabel, mission.status) : null;

  return (
    <section
      data-testid="canvas-pinned"
      data-kind={objRef.kind}
      className={`shrink-0 border-b-2 border-border-strong bg-surface-1 ${hideOnDesktop ? 'md:hidden' : ''} ${className}`}
    >
      <div className="flex min-h-12 min-w-0 items-center gap-2.5 px-4 py-2 md:px-6">
        {/* Phone: the strip is the button. */}
        <button type="button" onClick={onOpen} data-testid="canvas-pinned-open-sheet" className="flex min-h-11 min-w-0 flex-1 items-center gap-2.5 text-left md:hidden">
          <span className="shrink-0 font-mono text-[11px] font-bold uppercase tracking-[1.6px] text-text-muted">{objRef.kind}</span>
          <span className="min-w-0 flex-1 truncate font-mono text-[13px] font-semibold text-text-primary">{title}</span>
          {tone && mission && <StateChip label={mission.stateLabel} tone={tone} pulse={tone === 'live'} />}
          <span aria-hidden="true" className="shrink-0 font-mono text-[12px] text-text-muted">Open ›</span>
        </button>
        <div className="hidden min-w-0 flex-1 items-center gap-3 md:flex">
          <span className="shrink-0 font-mono text-[11px] font-bold uppercase tracking-[1.6px] text-text-muted">{`Pinned · ${objRef.kind}`}</span>
          <span className="min-w-0 truncate font-mono text-[13px] font-semibold text-text-primary">{title}</span>
          {tone && mission && <StateChip label={mission.stateLabel} tone={tone} pulse={tone === 'live'} />}
          <span className="flex-1" />
          {mission && <span className="hidden shrink-0 font-mono text-[12px] text-text-muted lg:inline">{missionCountsLine(mission.board)}</span>}
          {openLabel && (
            <button type="button" data-testid="canvas-pinned-open" onClick={onOpen} className="min-h-9 shrink-0 px-2 font-mono text-[12px] font-semibold text-accent-text hover:underline">
              {openLabel}
            </button>
          )}
          {cols.length > 0 && (
            <button
              type="button"
              data-testid="canvas-pinned-toggle"
              aria-expanded={open}
              onClick={() => setOpen(o => !o)}
              className="min-h-9 shrink-0 px-2 font-mono text-[12px] text-text-muted hover:text-text-primary"
            >
              {open ? 'Hide' : 'Show'}
            </button>
          )}
        </div>
      </div>
      {visual && (
        <div data-testid="canvas-pinned-visual" data-phase={visual.phase} className="flex min-w-0 items-center gap-3 px-4 pb-2 md:px-6">
          <VisualReviewLine model={visual} className="min-w-0 flex-1" />
          <PinnedVisualChip model={visual} onReview={review} />
        </div>
      )}
      {open && cols.length > 0 && (
        <div
          data-testid="canvas-mini-board"
          className="hidden gap-5 overflow-x-auto px-6 pb-4 md:grid"
          style={{ gridTemplateColumns: `repeat(${Math.min(cols.length, 3)}, minmax(200px, 1fr))`, gridAutoFlow: 'column', gridAutoColumns: 'minmax(200px, 1fr)' }}
        >
          {cols.map(c => (
            <div key={c.key} className="min-w-0">
              <h3 className="mb-1.5 flex items-baseline gap-2 border-b-2 border-border-strong pb-1 font-mono text-[11px] font-bold uppercase tracking-[1.4px] text-text-primary">
                <span className="min-w-0 flex-1 truncate">{c.title}</span>
                <span className="shrink-0 text-text-muted">{c.count}</span>
              </h3>
              <ul>
                {c.rows.map(t => {
                  const tn = miniStatusTone(t.status);
                  return (
                    <li
                      key={t.id}
                      data-testid="canvas-mini-row"
                      data-status={t.status}
                      className={`flex min-h-7 min-w-0 items-center gap-2 font-mono text-[12px] ${tn === 'attention' ? 'bg-[var(--accent-soft)] pl-1.5 shadow-[inset_3px_0_0_var(--accent)]' : ''}`}
                    >
                      <span aria-hidden="true" className={`h-2.5 w-2.5 shrink-0 ${SQUARE[tn]} ${tn === 'live' ? 'animate-status-pulse' : ''}`} />
                      <ScopeChip scope={t.scope} />
                      <span className={`min-w-0 truncate ${tn === 'idle' ? 'text-text-muted' : tn === 'ok' ? 'text-text-secondary' : 'text-text-primary'}`}>{t.label}</span>
                    </li>
                  );
                })}
                {c.more > 0 && <li className="pt-0.5 font-mono text-[11px] text-text-muted">{`+${c.more} more`}</li>}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
