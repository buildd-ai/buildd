'use client';

/**
 * The Board's visual review: the latest audit run as a compact row of
 * thumbnails with the verdict ("6 of 6 ok"), under the auditor task's row.
 * The full strip (captions, legend) lives in the Feed's Delivery step; this is
 * the glance, and any thumb opens the same lightbox.
 */
import { useCallback, useState } from 'react';
import { shotCaption, summarizeVisualRun, verdictLine, type VisualShot } from '@/lib/mission-visual-review';
import VisualReviewLightbox from './VisualReviewLightbox';
import { ExpiredTile, VERDICT_DOT, viewportAspect } from './visual-review-parts';

export interface BoardVisualShotsProps {
  shots: readonly VisualShot[];
  missionId?: string | null;
}

export default function BoardVisualShots({ shots, missionId }: BoardVisualShotsProps) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const [expired, setExpired] = useState<ReadonlySet<string>>(() => new Set());
  const markExpired = useCallback((id: string) => {
    setExpired(prev => (prev.has(id) ? prev : new Set(prev).add(id)));
  }, []);
  if (shots.length === 0) return null;
  const summary = summarizeVisualRun(shots);
  const allOk = summary.ok === summary.shots;

  return (
    <div data-testid="board-visual-shots" className="border-b border-border-default py-2">
      <div className="mb-1.5 flex items-center justify-between gap-2 font-mono text-[11px]">
        <span className="uppercase tracking-[1.5px] text-text-muted">Shots</span>
        <span data-testid="board-visual-verdict" className={`font-semibold tabular-nums ${allOk ? 'text-status-success' : summary.issues > 0 ? 'text-status-error' : 'text-text-primary'}`}>
          {verdictLine(summary)}
        </span>
      </div>
      <ul className="flex flex-wrap items-end gap-1.5">
        {shots.map((shot, i) => (
          <li key={shot.id}>
            <button
              type="button"
              data-testid="board-visual-thumb"
              data-verdict={shot.qa.verdict}
              title={shotCaption(shot)}
              aria-label={`${shotCaption(shot)}: ${shot.qa.verdict}`}
              onClick={() => setOpenIndex(i)}
              className={`relative block h-12 ${viewportAspect(shot.qa.viewport)} border border-border-strong bg-surface-3 hover:border-primary focus-visible:border-primary focus-visible:outline-none`}
            >
              {expired.has(shot.id) ? (
                <ExpiredTile />
              ) : (
                // eslint-disable-next-line @next/next/no-img-element -- signed R2 redirect; next/image would proxy it
                <img
                  src={shot.src}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  onError={() => markExpired(shot.id)}
                  className="block h-full w-full object-cover object-top"
                />
              )}
              <i aria-hidden="true" className={`absolute -right-[3px] -top-[3px] block h-2 w-2 ring-1 ring-surface-1 ${VERDICT_DOT[shot.qa.verdict]}`} />
            </button>
          </li>
        ))}
      </ul>
      <VisualReviewLightbox
        shots={shots}
        index={openIndex}
        onIndexChange={setOpenIndex}
        onClose={() => setOpenIndex(null)}
        expired={expired}
        onExpired={markExpired}
        missionId={missionId}
      />
    </div>
  );
}
