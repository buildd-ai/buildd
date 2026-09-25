'use client';

/**
 * The Visual review strip (docs/design/visual-qa-auditor.md, "Where the
 * screenshots show"): the latest audit run's screenshots as thumbnails with a
 * square verdict dot and a `route · viewport` caption, under a count line.
 * Rendered in the Delivery block's `visual` detail slot.
 *
 * Images load lazily through the access-checked download route (`shot.src`),
 * never through a share token: audit shots are private. The block sits inside
 * a collapsed `<details>`, so nothing here fetches before it is opened. An
 * image that fails to load is an object the 30-day lifecycle rule expired;
 * the row outlives it, so the tile says "expired" and the finding still reads.
 */
import { useCallback, useState } from 'react';
import type { VisualShot } from '@/lib/mission-visual-review';
import VisualReviewLightbox from './VisualReviewLightbox';
import { ExpiredTile, VERDICT_DOT, viewportAspect } from './visual-review-parts';

function countLine(shots: readonly VisualShot[]): string {
  const n = shots.length;
  const issues = shots.filter(s => s.qa.verdict === 'issue').length;
  const unsure = shots.filter(s => s.qa.verdict === 'unsure').length;
  const head = `${n} shot${n === 1 ? '' : 's'}`;
  if (issues === 0 && unsure === 0) return `${head} · all ok`;
  return [head, issues > 0 ? `${issues} issue${issues === 1 ? '' : 's'}` : null, unsure > 0 ? `${unsure} unsure` : null]
    .filter(Boolean)
    .join(' · ');
}

export interface VisualReviewStripProps {
  /** One run's shots, in display order (`selectLatestRun`). */
  shots: readonly VisualShot[];
  missionId?: string | null;
}

export default function VisualReviewStrip({ shots, missionId }: VisualReviewStripProps) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const [expired, setExpired] = useState<ReadonlySet<string>>(() => new Set());
  const markExpired = useCallback((id: string) => {
    setExpired(prev => (prev.has(id) ? prev : new Set(prev).add(id)));
  }, []);

  return (
    <div data-testid="visual-review-strip" className="border-2 border-border-strong bg-surface-2 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {shots.length > 0 ? (
          <p data-testid="visual-review-count" className="font-mono text-[12px] text-text-primary">{countLine(shots)}</p>
        ) : (
          <p className="font-mono text-[12px] text-text-secondary">No screenshots yet</p>
        )}
        <ul aria-label="Verdict legend" className="flex gap-3 font-mono text-[11px] text-text-muted">
          {(['ok', 'issue', 'unsure'] as const).map(v => (
            <li key={v} className="inline-flex items-center gap-1.5">
              <i aria-hidden="true" className={`inline-block h-2 w-2 ${VERDICT_DOT[v]}`} />
              {v}
            </li>
          ))}
        </ul>
      </div>

      {shots.length > 0 && (
        <ul className="mt-3 flex flex-wrap items-end gap-x-4 gap-y-3">
          {shots.map((shot, i) => (
            <li key={shot.id}>
              <button
                type="button"
                data-testid="visual-review-thumb"
                data-verdict={shot.qa.verdict}
                aria-label={`${shot.qa.route}, ${shot.qa.viewport}: ${shot.qa.verdict}`}
                onClick={() => setOpenIndex(i)}
                className="group flex flex-col items-center gap-1.5 focus-visible:outline-none"
              >
                <span
                  className={`relative block h-24 ${viewportAspect(shot.qa.viewport)} border-2 border-border-strong bg-surface-3 shadow transition-transform group-hover:-translate-x-0.5 group-hover:-translate-y-0.5 group-hover:border-primary group-focus-visible:-translate-x-0.5 group-focus-visible:-translate-y-0.5 group-focus-visible:border-primary`}
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
                  <i aria-hidden="true" className={`absolute -right-1 -top-1 z-10 block h-2.5 w-2.5 ring-2 ring-surface-2 ${VERDICT_DOT[shot.qa.verdict]}`} />
                </span>
                <span className="font-mono text-[10px] text-text-muted">{`${shot.qa.route} · ${shot.qa.viewport}`}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

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
