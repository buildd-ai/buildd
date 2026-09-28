'use client';

/**
 * The mission's visual review in the chat (docs/design/visual-qa-human-review.md,
 * Chat): the Screens line and a "Review N" row on the mission card, and the
 * review deck in the docked pane or the phone sheet. All of it is the shared
 * visual-review component family over `MissionObjectView.visual`.
 *
 * Decisions go through `ChatActions.reviewShots` / `undoReview` (the decisions
 * route, directly: the tap is the consent, as for answering a question). The
 * deck applies them optimistically, and so does the object store, so the card
 * and the pinned strip move with the tap; a refresh confirms it.
 */
import { useCallback, useMemo, useRef } from 'react';
import type { VisualReviewModel } from '@buildd/shared';
import VisualReviewLine from '@/components/visual-review/VisualReviewLine';
import VisualReviewTray from '@/components/visual-review/VisualReviewTray';
import VisualReviewDeck from '@/components/visual-review/VisualReviewDeck';
import { BTN_BASE, BTN_PRIMARY, BTN_SECONDARY } from '@/components/visual-review/review-ui';
import {
  applyOptimisticDecision,
  applyOptimisticUndo,
  useVisualReviewDecisions,
  type DecideInput,
  type VisualReviewTransport,
} from '@/components/visual-review/review-transport';
import { taskPageHref } from '@/lib/mission-task-href';
import type { BuilddObjectRef } from '../chat-contract';
import { useChatActions } from '../ChatActions';
import { refKey } from '../chat-contract';
import { useObjectStore } from './ObjectStoreProvider';
import type { MissionObjectView } from './object-views';

/** The review is worth a row: an audit exists (any phase but off). */
export function hasVisualReview(visual: VisualReviewModel | null | undefined): visual is VisualReviewModel {
  return !!visual && visual.phase !== 'off';
}

/** "11 ok, 2 issues, 1 unsure": current screens by effective verdict (the human decision where there is one). */
export function visualCountsText(model: VisualReviewModel): string | null {
  const s = model.summary;
  if (s.shots === 0) return null;
  const ok = s.effectiveOk ?? s.ok;
  const issues = s.effectiveIssues ?? s.issues;
  const unsure = model.cells.filter(c => c.effectiveVerdict === 'unsure').length;
  const bits = [`${ok} ok`, `${issues} ${issues === 1 ? 'issue' : 'issues'}`];
  if (unsure > 0) bits.push(`${unsure} unsure`);
  return bits.join(', ');
}

/** The deck button's words: the screens awaiting you (one count with the Line and the Tray), else all of them. */
export function reviewButtonLabel(model: VisualReviewModel): string | null {
  if (model.cells.length === 0) return null;
  const n = model.summary.awaitingHuman;
  return n > 0 ? `Review ${n}` : `All ${model.cells.length} screens`;
}

/**
 * The card's Screens row: the Line, the counts and "Review N". `tray` adds the
 * thumbnails (the desktop card); the phone card stays one row.
 */
export function MissionVisualRow({ objRef, visual, tray = false, className = '' }: {
  objRef: BuilddObjectRef;
  visual: VisualReviewModel;
  tray?: boolean;
  className?: string;
}) {
  const actions = useChatActions();
  const open = (startKey: string | null) => actions.openVisualReview(objRef, startKey);
  const counts = visualCountsText(visual);
  const label = reviewButtonLabel(visual);
  const awaiting = visual.summary.awaitingHuman > 0;
  return (
    <div data-testid="mission-card-visual" data-phase={visual.phase} className={`flex min-w-0 flex-col gap-2 ${className}`}>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="min-w-0">
          <VisualReviewLine model={visual} />
          {counts && <p data-testid="mission-card-visual-counts" className="mt-0.5 font-mono text-[12px] text-text-muted">{counts}</p>}
        </div>
        {label && (
          <button
            type="button"
            data-testid="mission-card-review"
            onClick={() => open(visual.queue[0] ?? null)}
            className={`${BTN_BASE} min-h-10 shrink-0 px-3.5 text-[13px] ${awaiting ? BTN_PRIMARY : BTN_SECONDARY}`}
          >
            {label}
          </button>
        )}
      </div>
      {tray && visual.cells.length > 0 && <VisualReviewTray model={visual} onReview={open} hideLine className="[&_[data-testid=visual-review-review-button]]:hidden" />}
    </div>
  );
}

/**
 * The deck inline in the pane or the sheet (`layout="sheet"`: never a Dialog
 * stacked inside the chat's BottomSheet).
 */
export function ChatVisualDeck({ objRef, view, startKey, closable = true }: {
  objRef: BuilddObjectRef;
  view: MissionObjectView & { visual: VisualReviewModel };
  startKey: string | null;
  /** Show the deck's own close (back to the mission). Off in the phone sheet, whose own close ends the review. */
  closable?: boolean;
}) {
  const actions = useChatActions();
  const store = useObjectStore();
  const viewRef = useRef(view);
  viewRef.current = view;
  const missionId = view.id;
  const { reviewShots, undoReview } = actions;

  const transport = useMemo<VisualReviewTransport>(() => ({
    decide: req => reviewShots({ missionId, ...req }),
    undo: reviewId => undoReview({ missionId, reviewId }),
  }), [reviewShots, undoReview, missionId]);

  const setVisual = useCallback((visual: VisualReviewModel) => {
    store.set(objRef, { ...viewRef.current, visual });
  }, [store, objRef]);

  const vr = useVisualReviewDecisions(view.visual, transport, { onModel: setVisual });

  // Optimistic in the store too, so the card and the pinned strip move with
  // the tap. A failure puts the last model back; a refresh confirms either way.
  const decide = useCallback(async (input: DecideInput) => {
    const before = viewRef.current.visual;
    const optimistic = before ? applyOptimisticDecision(before, input, `chat-${Date.now()}`).model : null;
    if (optimistic) setVisual(optimistic);
    const r = await vr.decide(input);
    if (!r.ok && r.reason !== 'stale' && before && viewRef.current.visual === optimistic) setVisual(before);
    store.refresh(objRef);
    return r;
  }, [vr, setVisual, store, objRef]);

  const undo = useCallback(async (reviewIds: readonly string[]) => {
    const before = viewRef.current.visual;
    const optimistic = before ? applyOptimisticUndo(before, reviewIds) : null;
    if (optimistic) setVisual(optimistic);
    const r = await vr.undo(reviewIds);
    if (!r.ok && before && viewRef.current.visual === optimistic) setVisual(before);
    store.refresh(objRef);
    return r;
  }, [vr, setVisual, store, objRef]);

  return (
    <div data-testid="chat-visual-deck" data-ref={refKey(objRef)}>
      <VisualReviewDeck
        key={startKey ?? ''}
        layout="sheet"
        model={vr.model}
        startKey={startKey}
        onDecide={decide}
        onUndo={undo}
        onClose={closable ? actions.closeVisualReview : undefined}
        fixTaskHref={taskId => taskPageHref({ taskId, missionId })}
      />
    </div>
  );
}
