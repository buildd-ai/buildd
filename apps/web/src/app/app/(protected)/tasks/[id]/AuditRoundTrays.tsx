'use client';

/**
 * An audit task's screens, one Tray per round, latest first
 * (docs/design/visual-qa-human-review.md, "Where it shows": the task page and
 * the task sheet show the audit's round, not title links or a grid that mixes
 * attempts). The mission model keeps one shot per cell per round, so a retry
 * never shows beside the run it replaced.
 *
 * A round's screens that a later round re-shot are history: they show, and
 * the deck opens only on the ones still current. Decisions go to the
 * decisions route and adopt the model it returns.
 *
 * `layout="sheet"` (the task sheet) opens the deck inline, in place of the
 * trays, never as a dialog over the sheet.
 */
import { useMemo, useState } from 'react';
import type { VisualReviewModel } from '@buildd/shared';
import VisualReviewDeck from '@/components/visual-review/VisualReviewDeck';
import VisualReviewTray from '@/components/visual-review/VisualReviewTray';
import { createHttpVisualReviewTransport, useVisualReviewDecisions } from '@/components/visual-review/review-transport';
import { visualReviewRoundGroups } from '@/lib/visual-review-rounds';

export interface AuditRoundTraysProps {
  /** The mission's model and this audit's round. */
  visual: { round: number; model: VisualReviewModel };
  layout?: 'dialog' | 'sheet';
  /** One route per row, for a narrow host. */
  columns?: 'auto' | 'one';
}

export default function AuditRoundTrays({ visual, layout = 'dialog', columns = 'auto' }: AuditRoundTraysProps) {
  const transport = useMemo(() => createHttpVisualReviewTransport(visual.model.missionId), [visual.model.missionId]);
  const review = useVisualReviewDecisions(visual.model, transport);
  const groups = useMemo(() => visualReviewRoundGroups(review.model, visual.round), [review.model, visual.round]);
  const [deck, setDeck] = useState<{ round: number; startKey: string | null } | null>(null);
  const deckModel = deck ? groups.find(g => g.round === deck.round)?.deckModel ?? null : null;
  const multi = groups.length > 1;

  const deckEl = deck && deckModel ? (
    <VisualReviewDeck
      key={`${deck.round}:${deck.startKey ?? ''}`}
      model={deckModel}
      layout={layout}
      open
      startKey={deckModel.cells.some(c => c.key === deck.startKey) ? deck.startKey : null}
      onClose={() => setDeck(null)}
      onDecide={review.decide}
      onUndo={review.undo}
    />
  ) : null;
  if (deckEl && layout === 'sheet') return <div data-testid="audit-round-deck">{deckEl}</div>;

  if (groups.length === 0) {
    // No screens yet: the phase and what it waits on.
    return <VisualReviewTray model={review.model} columns={columns} />;
  }
  return (
    <div data-testid="audit-round-trays" className="flex flex-col gap-5">
      {groups.map((g, i) => (
        <section key={g.round} data-testid="audit-round" data-round={g.round} className="flex flex-col gap-2">
          {multi && (
            <h3 className="flex items-center gap-2 border-b border-border-default pb-1.5 font-mono text-[11px] font-semibold uppercase tracking-[1.4px] text-text-secondary">
              {`Round ${g.round}`}
              {i === 0 && g.round === visual.round && <span className="font-medium normal-case tracking-normal text-text-muted">this audit</span>}
              {!g.deckModel && <span className="font-medium normal-case tracking-normal text-text-muted">re-shot in a later round</span>}
            </h3>
          )}
          <VisualReviewTray
            model={g.model}
            onReview={g.deckModel ? (k => setDeck({ round: g.round, startKey: k })) : undefined}
            hideLine={i > 0}
            columns={columns}
          />
        </section>
      ))}
      {deckEl}
    </div>
  );
}
