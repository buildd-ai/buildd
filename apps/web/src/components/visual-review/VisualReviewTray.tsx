'use client';

/**
 * The visual audit's screens as a tray (docs/design/visual-qa-human-review.md,
 * part 2): thumbnails grouped by route, the phone and desktop shot of a route
 * side by side, each with its agent verdict dot and its human-review marker
 * (hollow: not decided yet; solid: you agreed; struck: you disagreed; a
 * hollow tick: you waived an unsure call; a filled grey square: its fix
 * merged and it waits for a new screenshot, nothing to decide). "Review N"
 * opens the deck at the
 * head of the queue, and a thumbnail opens it at that screen. The button is
 * secondary on purpose: when the audit needs you, VisualReviewAsk carries
 * the one orange call to action.
 *
 * With no screens yet it states the phase and offers that phase's inline
 * actions, all as callbacks: turn the audit off or skip it when no browser
 * runner is online, answer the boot-failure question, retry a stalled or
 * failed audit.
 */
import { useState } from 'react';
import type { VisualReviewCell, VisualReviewMarker, VisualReviewModel } from '@buildd/shared';
import { awaitingCapture, describeVisualPhase } from '@/lib/visual-review-model';
import ShotImage, { VERDICT_DOT, VIEWPORT_LABEL, viewportAspect } from './ShotImage';
import VisualReviewLine from './VisualReviewLine';
import { AnswerRow, type OnAnswer } from './VisualReviewAsk';
import { ActionButton, BTN_BASE, BTN_SECONDARY, BTN_SIZE, CHIP, groupCells } from './review-ui';

export interface VisualReviewPhaseActions {
  /** no_browser_runner: turn the audit off for this mission. */
  onTurnOff?: () => void | Promise<void>;
  /** no_browser_runner, stalled, failed: cancel this audit task only. */
  onSkip?: () => void | Promise<void>;
  /** stalled, failed: run the audit again. */
  onRetry?: () => void | Promise<void>;
  /** boot_failed: answer the parked worker. */
  onAnswer?: OnAnswer;
  answerOptions?: readonly string[];
}

export interface VisualReviewTrayProps {
  model: VisualReviewModel;
  /** Opens the deck at a cell (`null`: the head of the queue). */
  onReview?: (startKey: string | null) => void;
  actions?: VisualReviewPhaseActions;
  /** Hide the Line header, when the host already shows it. */
  hideLine?: boolean;
  /**
   * Hide the "Review N" button, when the host shows VisualReviewAsk beside
   * this Tray (its orange button opens the same deck). Thumbnails still open it.
   */
  hideReviewButton?: boolean;
  /**
   * `one`: one route per row, for a narrow host (a side rail). `fit`: as many
   * routes per row as the host's own width holds (a container query), for a
   * host whose width is not the viewport's (a board column).
   */
  columns?: 'auto' | 'one' | 'fit';
  className?: string;
}

const MARKER_LABEL: Record<VisualReviewMarker, string> = {
  awaiting: 'not reviewed',
  confirmed: 'you agreed',
  disputed: 'you disagreed',
  waived: 'you waived it',
  fix_merged: 'fix merged, waiting for a new screenshot',
};

/** The thumbnail's plain words: what the agent said, or where the fix stands. */
function thumbState(cell: VisualReviewCell): string {
  if (awaitingCapture(cell)) return MARKER_LABEL.fix_merged;
  if (cell.fixCheck?.state === 'check') return cell.current.review ? `fix merged, ${MARKER_LABEL[cell.marker]}` : 'fix merged, new screenshot to check';
  return `agent said ${cell.current.agentVerdict}, ${MARKER_LABEL[cell.marker]}`;
}

/** Hollow, solid, strike: the human-review marker. */
export function ReviewMarker({ marker, className = '' }: { marker: VisualReviewMarker; className?: string }) {
  const base = `relative inline-block h-3 w-3 border-2 border-text-primary ${className}`;
  if (marker === 'confirmed') return <i aria-hidden="true" className={`${base} bg-text-primary`} />;
  if (marker === 'fix_merged') return <i aria-hidden="true" className={`relative inline-block h-3 w-3 border-2 border-text-muted bg-text-muted ${className}`} />;
  if (marker === 'disputed') {
    return (
      <i aria-hidden="true" className={`${base} bg-surface-1`}>
        <svg viewBox="0 0 8 8" className="absolute inset-0 h-full w-full"><path d="M0 8 8 0" stroke="var(--text-primary)" strokeWidth="2" /></svg>
      </i>
    );
  }
  if (marker === 'waived') {
    return (
      <i aria-hidden="true" className={`${base} bg-surface-1`}>
        <svg viewBox="0 0 8 8" className="absolute inset-0 h-full w-full"><path d="M1.2 4.2 3.2 6.2 6.8 1.8" fill="none" stroke="var(--text-primary)" strokeWidth="1.6" /></svg>
      </i>
    );
  }
  return <i aria-hidden="true" className={`${base} bg-surface-1`} />;
}

function Thumb({ cell, onOpen }: { cell: VisualReviewCell; onOpen?: (key: string) => void }) {
  const verdict = cell.effectiveVerdict;
  const label = `${cell.route}${cell.variant ? ` ${cell.variant}` : ''}, ${VIEWPORT_LABEL[cell.viewport].toLowerCase()}: ${thumbState(cell)}`;
  const due = cell.needsHuman;
  const inner = (
    <>
      <span
        data-testid="visual-review-frame"
        className={`relative block h-28 md:h-24 ${viewportAspect(cell.viewport)} max-w-full border-2 ${due ? 'border-status-info' : 'border-border-strong'} bg-surface-3 transition-transform group-hover:-translate-y-0.5 group-hover:border-text-primary group-focus-visible:-translate-y-0.5`}
      >
        <ShotImage shot={cell.current.shot} alt="" className="block h-full w-full object-cover object-top" />
        <i aria-hidden="true" className={`absolute -right-1 -top-1 z-10 block h-2.5 w-2.5 ring-2 ring-surface-2 ${VERDICT_DOT[verdict]}`} />
      </span>
      <span className="inline-flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[1px] text-text-muted">
        <ReviewMarker marker={cell.marker} />
        {VIEWPORT_LABEL[cell.viewport]}
        {awaitingCapture(cell) ? ' · Fix merged' : cell.fixCheck ? ' · After fix' : cell.current.round > 1 ? ` · R${cell.current.round}` : ''}
      </span>
    </>
  );
  const common = {
    'data-testid': 'visual-review-thumb',
    'data-cell': cell.key,
    'data-viewport': cell.viewport,
    'data-marker': cell.marker,
    'data-fix-check': cell.fixCheck?.state,
    'data-verdict': verdict,
  };
  if (!onOpen) {
    return <span {...common} aria-label={label} className="group flex flex-col items-start gap-1.5">{inner}</span>;
  }
  return (
    <button {...common} type="button" aria-label={label} onClick={() => onOpen(cell.key)} className="group flex flex-col items-start gap-1.5 text-left focus-visible:outline-none">
      {inner}
    </button>
  );
}

function EmptyPhase({ model, actions }: { model: VisualReviewModel; actions?: VisualReviewPhaseActions }) {
  const [error, setError] = useState<string | null>(null);
  const copy = describeVisualPhase(model);
  const a = actions ?? {};
  const buttons: React.ReactNode[] = [];
  if (model.phase === 'no_browser_runner') {
    if (a.onTurnOff) buttons.push(<ActionButton key="off" testId="visual-review-action-turn-off" tone="primary" onAction={a.onTurnOff} onError={setError}>Turn off for this mission</ActionButton>);
    if (a.onSkip) buttons.push(<ActionButton key="skip" testId="visual-review-action-skip" onAction={a.onSkip} onError={setError}>Skip this audit</ActionButton>);
  } else if (model.phase === 'stalled' || model.phase === 'failed') {
    if (a.onRetry) buttons.push(<ActionButton key="retry" testId="visual-review-action-retry" tone="primary" onAction={a.onRetry} onError={setError}>Retry the audit</ActionButton>);
    if (a.onSkip) buttons.push(<ActionButton key="skip" testId="visual-review-action-skip" onAction={a.onSkip} onError={setError}>Skip this audit</ActionButton>);
  }
  const boot = model.phase === 'boot_failed' ? model.bootFailure : null;
  return (
    <div data-testid="visual-review-empty" className="flex flex-col gap-3">
      {boot ? (
        <>
          <p className="border-l-[3px] border-status-error py-1 pl-3 font-mono text-[13px] leading-[1.5] text-text-primary">{boot.prompt}</p>
          {a.onAnswer && <AnswerRow target={{ workerId: boot.workerId, taskId: boot.taskId }} options={a.answerOptions} onAnswer={a.onAnswer} />}
        </>
      ) : (
        <p className="text-[13px] leading-[1.5] text-text-secondary">{copy.detail}</p>
      )}
      {buttons.length > 0 && <div className="flex flex-wrap gap-2">{buttons}</div>}
      {error && <p role="alert" data-testid="visual-review-action-error" className="font-mono text-[12px] text-status-error">{error}</p>}
    </div>
  );
}

export default function VisualReviewTray({ model, onReview, actions, hideLine = false, hideReviewButton = false, columns = 'auto', className = '' }: VisualReviewTrayProps) {
  const groups = groupCells(model.cells);
  const s = model.summary;
  // One count across the Line, the Ask and this button: unsure screens awaiting you.
  // Fix checks wait in the deck's queue, not here (they never put the audit in needs_you).
  const awaiting = s.awaitingHuman;
  const reviewButton = onReview && !hideReviewButton && model.cells.length > 0 ? (
    <button
      type="button"
      data-testid="visual-review-review-button"
      onClick={() => onReview(model.queue[0] ?? null)}
      className={`${BTN_BASE} ${BTN_SIZE} ${BTN_SECONDARY} shrink-0`}
    >
      {awaiting > 0 ? `Review ${awaiting}` : `All ${model.cells.length} screens`}
    </button>
  ) : null;

  return (
    <div data-testid="visual-review-tray" data-phase={model.phase} className={`flex min-w-0 flex-col gap-3 ${columns === 'fit' ? '@container' : ''} ${className}`}>
      {(!hideLine || reviewButton) && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          {!hideLine ? <VisualReviewLine model={model} /> : <span />}
          {reviewButton}
        </div>
      )}

      {model.cells.length === 0 ? (
        <EmptyPhase model={model} actions={actions} />
      ) : (
        <ul className={`grid grid-cols-1 gap-3 ${columns === 'one' ? '' : columns === 'fit' ? '@lg:grid-cols-2 @4xl:grid-cols-3' : 'sm:grid-cols-2 xl:grid-cols-3'}`}>
          {groups.map(g => (
            <li
              key={g.key}
              data-testid="visual-review-route"
              data-route={g.route}
              className="min-w-0 border border-border-default bg-surface-2 p-2.5"
            >
              <p className="mb-2 flex min-w-0 flex-wrap items-center gap-1.5">
                <span className="break-all font-mono text-[13px] font-semibold text-text-primary">{g.route}</span>
                {g.variant && <span className={CHIP}>{g.variant}</span>}
              </p>
              <div className="flex items-end gap-3">
                {g.mobile && <Thumb cell={g.mobile} onOpen={onReview} />}
                {g.desktop && <Thumb cell={g.desktop} onOpen={onReview} />}
              </div>
            </li>
          ))}
        </ul>
      )}
      {model.phase === 'capturing' && model.cells.length > 0 && (
        <p className="font-mono text-[12px] text-text-muted">{describeVisualPhase(model).detail}</p>
      )}
    </div>
  );
}
