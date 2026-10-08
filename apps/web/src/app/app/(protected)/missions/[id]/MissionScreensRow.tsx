'use client';

/**
 * The footer's "Screens" row, next to Shipped (docs/design/visual-qa-human-review.md,
 * "Where it shows"): the visual review step, live. It shows whenever the
 * mission has an audit, queued, waiting on a browser runner, boot-failed and
 * stalled ones included, so a stuck audit is never invisible.
 *
 * With screens, a tap opens the review deck. Without any yet, it opens the
 * Tray in the side sheet, where the phase's actions are (turn the audit off,
 * skip it, retry it, answer its question).
 */
import { useState } from 'react';
import SideSheet from '@/components/SideSheet';
import { VISUAL_TONE_TEXT, VerdictDots, visualPhaseTone } from '@/components/visual-review/VisualReviewLine';
import { describeVisualPhase, screensToReview } from '@/lib/visual-review-model';
import { DELIVERY_STATE_GLYPH, DELIVERY_STATE_TEXT, type DeliveryStep } from '@/lib/mission-delivery';
import { MissionVisualTray, useMissionVisualReview } from './MissionVisualReview';

export default function MissionScreensRow({ missionId, step }: { missionId: string; step: DeliveryStep | null | undefined }) {
  const review = useMissionVisualReview(missionId);
  const [sheet, setSheet] = useState(false);
  if (!review || review.model.phase === 'off') return null;
  const m = review.model;
  const copy = describeVisualPhase(m);
  const hasShots = m.cells.length > 0;
  const awaiting = screensToReview(m);
  const state = step?.state ?? 'todo';
  return (
    <>
      <button
        type="button"
        data-testid="mission-screens-row"
        data-phase={m.phase}
        aria-haspopup="dialog"
        onClick={() => (hasShots ? review.openDeck(m.queue[0] ?? null) : setSheet(true))}
        className="flex min-h-11 w-full items-center gap-2 border-t border-border-default text-left font-mono text-[12px] hover:bg-surface-2"
      >
        <span aria-hidden="true" className={`w-3 shrink-0 text-center ${DELIVERY_STATE_TEXT[state]}`}>
          {DELIVERY_STATE_GLYPH[state]}
        </span>
        <span className="w-20 shrink-0 font-semibold text-text-primary">Screens</span>
        <span className="flex min-w-0 flex-1 items-center gap-2.5">
          <span title={copy.detail} className={`min-w-0 truncate ${VISUAL_TONE_TEXT[visualPhaseTone(m.phase)]}`}>{copy.label}</span>
          <span className="hidden sm:inline-flex"><VerdictDots cells={m.cells} /></span>
        </span>
        <span className="shrink-0 text-text-muted">
          <span className="hidden sm:inline">{hasShots ? (awaiting > 0 ? `Review ${awaiting} ` : 'Review ') : 'Details '}</span>
          <span aria-hidden="true">›</span>
        </span>
      </button>
      <SideSheet open={sheet} onClose={() => setSheet(false)} title="Visual review" testId="mission-screens-sheet">
        <MissionVisualTray review={review} columns="one" />
      </SideSheet>
    </>
  );
}
