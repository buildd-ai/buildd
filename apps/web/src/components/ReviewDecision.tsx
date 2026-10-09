'use client';

import Chip from '@/components/ui/Chip';
import Disclosure from '@/components/ui/Disclosure';
import { blockerLabel, type ReviewBlocker } from '@/lib/review-decision';

/**
 * The body of a review card, in reading order: the one decision asked of you,
 * short fact tags (why it is here, what CI is doing), then the reviewer's full
 * reasoning folded behind Details. A reviewer's escalation can run a paragraph;
 * the card never shows it inline.
 */
export function ReviewDecision({
  decision,
  detail,
  blockers,
  status,
}: {
  decision: string;
  /** The full reason. Folded; omitted when it says no more than the decision. */
  detail?: string | null;
  blockers: ReviewBlocker[];
  /** Machine state, e.g. "CI running". */
  status?: string | null;
}) {
  const kinds = [...new Set(blockers.map((b) => b.kind))];
  const hasDetail = (detail && detail.trim() !== decision.trim()) || blockers.length > 0;
  return (
    <>
      <p data-testid="review-decision" className="mt-1 text-body text-text-primary [overflow-wrap:anywhere]">{decision}</p>
      {(kinds.length > 0 || status) && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {kinds.map((k) => (
            <Chip key={k} tone="warning" dot={false} title={blockers.filter((b) => b.kind === k).map((b) => b.text).join('; ')}>
              {blockerLabel(k)}
            </Chip>
          ))}
          {status && <Chip tone="muted" dot={false}>{status}</Chip>}
        </div>
      )}
      {hasDetail && (
        <Disclosure summary="Details" className="mt-1">
          {blockers.length > 0 && (
            <ul className="mb-1.5 space-y-0.5 text-meta text-text-secondary">
              {blockers.map((b, i) => (
                <li key={i} className="[overflow-wrap:anywhere]">
                  <span className="text-text-muted">{blockerLabel(b.kind)}: </span>
                  {b.text}
                </li>
              ))}
            </ul>
          )}
          {detail && (
            <p className="text-meta text-text-secondary whitespace-pre-line [overflow-wrap:anywhere]">{detail}</p>
          )}
        </Disclosure>
      )}
    </>
  );
}
