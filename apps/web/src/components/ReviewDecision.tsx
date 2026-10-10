'use client';

import { TonePill } from '@/components/ui/StatePill';
import type { StateTone } from '@/components/ui/states';
import Disclosure from '@/components/ui/Disclosure';
import { blockerLabel, type ReviewBlocker } from '@/lib/attention-line';

/**
 * The body of a review card, in reading order: the one decision asked of you
 * (body size, never louder than the card's title), short sans fact tags (why
 * it is here, what CI is doing), then the reviewer's full
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
      <p data-testid="review-decision" className="mt-1 text-body font-medium text-text-primary [overflow-wrap:anywhere]">{decision}</p>
      {(kinds.length > 0 || status) && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {kinds.map((k) => (
            <TonePill key={k} tone="dec" className="!font-sans" title={blockers.filter((b) => b.kind === k).map((b) => b.text).join('; ')}>
              {blockerLabel(k)}
            </TonePill>
          ))}
          {status && <TonePill tone={statusTone(status)} className="!font-sans">{status}</TonePill>}
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

/** A machine-state tag's tone: red when something failed, blue while checks run, otherwise neutral. */
function statusTone(status: string): StateTone {
  if (/fail|error/i.test(status)) return 'bad';
  if (/running|pending|queued|in progress/i.test(status)) return 'run';
  return 'q';
}
