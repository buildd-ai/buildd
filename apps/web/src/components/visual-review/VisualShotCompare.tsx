'use client';

/**
 * Before and after for a screen shot in more than one audit round
 * (docs/design/visual-qa-human-review.md, part 2). The fix that ran between
 * the rounds (its title, status and PR) sits between the two images.
 *
 * - md and up: the two rounds side by side, the fix strip in the middle.
 * - Phone: the newer round fills the width; press and hold (the image or the
 *   hold button) to see the older one. No slider, no blink.
 * - More than two rounds: a round picker chooses the "before".
 * - `fixCheck` (a fix merged and a screenshot was taken since): the "before"
 *   is the screenshot the fix was filed against, there is no picker, and no
 *   label names a round: "Before", "After", "The fix".
 */
import { useState } from 'react';
import type { VisualReviewCell, VisualReviewCellEntry, VisualReviewFixCheck, VisualReviewFixTask } from '@buildd/shared';
import ShotImage, { VERDICT_DOT, VIEWPORT_LABEL } from './ShotImage';
import { BTN_BASE, BTN_SECONDARY } from './review-ui';

export interface VisualShotCompareProps {
  cell: VisualReviewCell;
  fixTaskHref?: (taskId: string) => string;
  /** The cell's fix check: plain Before / After copy around the merged fix. */
  fixCheck?: VisualReviewFixCheck | null;
  className?: string;
}

/** `[surface fix] /route: finding` → `finding`: the route already heads the deck. */
export function fixTitleText(title: string, route: string): string {
  const prefix = `[surface fix] ${route}:`;
  return title.startsWith(prefix) ? title.slice(prefix.length).trim() : title.replace(/^\[surface fix\]\s*/i, '');
}

export function FixStatus({ fix }: { fix: VisualReviewFixTask }) {
  const merged = !!fix.mergedAt;
  const status = merged ? 'merged' : fix.status.replace(/_/g, ' ');
  const done = merged || fix.status === 'completed';
  return (
    <span className={`font-mono text-[11px] uppercase tracking-[1px] ${done ? 'text-status-success' : fix.status === 'cancelled' ? 'text-text-muted' : 'text-status-warning'}`}>
      {status}
    </span>
  );
}

/** The fix that ran between `before` and the current round. */
function fixBetween(cell: VisualReviewCell, before: VisualReviewCellEntry): VisualReviewFixTask | null {
  if (before.fixTask) return before.fixTask;
  for (const h of cell.history) if (h.round >= before.round && h.round < cell.current.round && h.fixTask) return h.fixTask;
  return null;
}

function Frame({ entry, label, eager, plain }: { entry: VisualReviewCellEntry; label: string; eager?: boolean; plain?: boolean }) {
  return (
    <figure className="flex min-w-0 flex-col gap-2">
      <figcaption className="flex items-center gap-2 font-mono text-[12px] text-text-secondary">
        <i aria-hidden="true" className={`inline-block h-2.5 w-2.5 ${VERDICT_DOT[entry.agentVerdict]}`} />
        <span className="font-semibold uppercase tracking-[1px] text-text-primary">{label}</span>
        {!plain && <span>Round {entry.round}</span>}
      </figcaption>
      <div className="border-2 border-border-strong bg-surface-3">
        <ShotImage shot={entry.shot} alt={plain ? label : `${label}: round ${entry.round}`} large eager={eager} className="mx-auto block h-auto max-h-[62vh] w-auto max-w-full" />
      </div>
      <p className="text-[13px] leading-[1.45] text-text-secondary">{entry.finding}</p>
    </figure>
  );
}

function FixStrip({ cell, before, fixTaskHref, fixCheck }: { cell: VisualReviewCell; before: VisualReviewCellEntry; fixTaskHref?: (id: string) => string; fixCheck?: VisualReviewFixCheck | null }) {
  const fix = fixCheck?.fix ?? fixBetween(cell, before);
  return (
    <div data-testid="compare-fix" className="flex min-w-0 flex-col gap-1.5 border-2 border-border-default bg-surface-2 p-3">
      <p className="section-label">{fixCheck ? 'The fix' : `Round ${before.round} to ${cell.current.round}`}</p>
      {fix ? (
        <>
          <p className="text-[13px] leading-[1.4] text-text-primary">
            {fixTaskHref ? <a href={fixTaskHref(fix.id)} className="underline decoration-border-strong underline-offset-2 hover:text-accent-text">{fixTitleText(fix.title, cell.route)}</a> : fixTitleText(fix.title, cell.route)}
          </p>
          <p className="flex flex-wrap items-center gap-2">
            <FixStatus fix={fix} />
            {fix.prUrl && (
              <a href={fix.prUrl} target="_blank" rel="noreferrer" className="font-mono text-[12px] text-accent-text underline underline-offset-2">
                PR #{fix.prNumber ?? ''}
              </a>
            )}
          </p>
        </>
      ) : (
        <p className="text-[13px] text-text-secondary">Re-shot with no linked fix.</p>
      )}
    </div>
  );
}

export default function VisualShotCompare({ cell, fixTaskHref, fixCheck, className = '' }: VisualShotCompareProps) {
  const earlier = cell.history.slice(0, -1);
  const check = fixCheck?.state === 'check' ? fixCheck : null;
  const [beforeRound, setBeforeRound] = useState<number>(check?.beforeRound ?? earlier[earlier.length - 1]?.round ?? cell.current.round);
  const [holding, setHolding] = useState(false);
  if (earlier.length === 0) return null;
  const before = (check && earlier.find(h => h.shot.id === check.beforeShotId)) || (earlier.find(h => h.round === beforeRound) ?? earlier[earlier.length - 1]);
  const after = cell.current;
  const shown = holding ? before : after;
  const hold = {
    onPointerDown: () => setHolding(true),
    onPointerUp: () => setHolding(false),
    onPointerCancel: () => setHolding(false),
    onPointerLeave: () => setHolding(false),
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
  };

  return (
    <div data-testid="visual-review-compare" data-before-round={before.round} data-fix-check={check ? 'true' : undefined} className={`flex min-w-0 flex-col gap-3 ${className}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="section-label">Compare {VIEWPORT_LABEL[cell.viewport].toLowerCase()}</span>
        {earlier.length > 1 && !check && (
          <span role="group" aria-label="Before round" className="inline-flex border-2 border-border-strong">
            {earlier.map(h => (
              <button
                key={h.round}
                type="button"
                data-testid={`compare-round-${h.round}`}
                aria-pressed={h.round === before.round}
                onClick={() => setBeforeRound(h.round)}
                className={`min-h-9 px-3 font-mono text-[12px] ${h.round === before.round ? 'bg-text-primary text-surface-1' : 'bg-surface-2 text-text-secondary hover:text-text-primary'}`}
              >
                R{h.round}
              </button>
            ))}
          </span>
        )}
      </div>

      {/* md and up: side by side, the fix between */}
      <div data-testid="compare-desktop" className="hidden gap-4 md:grid md:grid-cols-[minmax(0,1fr)_minmax(160px,220px)_minmax(0,1fr)] md:items-start">
        <Frame entry={before} label="Before" plain={!!check} />
        <FixStrip cell={cell} before={before} fixTaskHref={fixTaskHref} fixCheck={check} />
        <Frame entry={after} label="After" eager plain={!!check} />
      </div>

      {/* Phone: what changed first, then hold for before */}
      <div data-testid="compare-phone" className="flex flex-col gap-3 md:hidden">
        <FixStrip cell={cell} before={before} fixTaskHref={fixTaskHref} fixCheck={check} />
        <p className="text-[14px] leading-[1.45] text-text-primary">
          <span className="mr-1.5 font-mono text-[11px] uppercase tracking-[1px] text-text-muted">{check ? (holding ? 'Before' : 'After') : `Round ${shown.round}`}</span>
          {shown.finding}
        </p>
        <button
          type="button"
          data-testid="compare-hold"
          aria-pressed={holding}
          {...hold}
          onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setHolding(true); } }}
          onKeyUp={() => setHolding(false)}
          className={`${BTN_BASE} ${holding ? 'border-text-primary bg-text-primary text-surface-1' : BTN_SECONDARY} min-h-12 w-full select-none text-[13px]`}
        >
          {holding ? (check ? 'Showing before' : `Showing before, round ${before.round}`) : 'Press and hold to see before'}
        </button>
        {/* The round chip sits above the frame: headers and titles live at the top left of most screens. */}
        <p className="-mb-1.5 flex items-center gap-2">
          <span data-testid="compare-showing" className={`inline-flex items-center border px-1.5 py-px font-mono text-[11px] uppercase tracking-[1px] ${holding ? 'border-text-primary bg-text-primary text-surface-1' : 'border-border-strong bg-surface-1 text-text-primary'}`}>
            {check ? (holding ? 'Before' : 'After') : holding ? `Before, round ${before.round}` : `After, round ${after.round}`}
          </span>
        </p>
        <div data-testid="compare-phone-frame" className="select-none border-2 border-border-strong bg-surface-3" {...hold}>
          <ShotImage shot={shown.shot} alt={check ? (holding ? 'Before' : 'After') : `${holding ? 'Before' : 'After'}: round ${shown.round}`} large eager className="block h-auto w-full" />
        </div>
      </div>
    </div>
  );
}
