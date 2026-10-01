'use client';

/**
 * The completed mission's "What shipped" header (docs/design/mission-shipped-report.md,
 * "Surface"): the plain-language lede, the change-type chip, up to three hero
 * shots that open the review deck, and at most two off-plan lines. The branch
 * (record, no shots, mechanical-only) is decided by `buildShippedHeaderView`.
 */
import ShotImage, { VERDICT_DOT, VIEWPORT_LABEL, viewportAspect } from '@/components/visual-review/ShotImage';
import { NO_SCREENSHOTS_LINE, SHIPPED_HEADER_ID, type ShippedHeaderView } from '@/lib/mission-shipped-header';
import { useMissionVisualReview } from './MissionVisualReview';

const THUMB_WIDTH = { mobile: 'w-20', desktop: 'w-40' } as const;

export default function MissionShippedHeader({ missionId, view }: { missionId: string; view: ShippedHeaderView }) {
  const review = useMissionVisualReview(missionId);
  const cellOf = (artifactId: string) =>
    review?.model.cells.find(c => c.history.some(h => h.shot.id === artifactId)) ?? null;

  return (
    <section
      id={SHIPPED_HEADER_ID}
      data-testid="mission-shipped-header"
      data-variant={view.lede ? 'lede' : 'mechanical'}
      aria-labelledby="what-shipped-label"
      className="mt-[18px] flex scroll-mt-4 flex-col gap-3 border-2 border-border-strong bg-card px-[18px] py-4 shadow-[var(--card-shadow)]"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="what-shipped-label" className="font-mono text-[11px] font-bold uppercase tracking-[1.5px] text-status-success">
          What shipped
        </h2>
        {view.changeTypeLabel && (
          <span data-testid="shipped-change-type" className="border border-border-default px-1.5 py-0.5 font-mono text-[11px] font-semibold uppercase text-text-secondary">
            {view.changeTypeLabel}
          </span>
        )}
        {view.completedByHand && (
          <span data-testid="shipped-by-hand" className="font-mono text-[11px] uppercase text-text-muted">
            Completed by hand
          </span>
        )}
      </div>

      {view.lede && (
        <p data-testid="shipped-lede" className="max-w-[60ch] text-[19px] font-semibold leading-snug text-text-primary md:text-[24px]">
          {view.lede}
        </p>
      )}

      {view.heroShots.length > 0 && (
        <ul data-testid="shipped-hero-shots" className="flex flex-wrap items-end gap-3">
          {view.heroShots.map(s => {
            const cell = cellOf(s.artifactId);
            const cellKey = cell?.key ?? null;
            const label = `${VIEWPORT_LABEL[s.viewport]} · ${s.route}`;
            const frame = (
              <>
                <span className={`relative block overflow-hidden border-2 border-border-strong bg-surface-2 ${THUMB_WIDTH[s.viewport]} ${viewportAspect(s.viewport)}`}>
                  <ShotImage shot={cell?.history.find(h => h.shot.id === s.artifactId)?.shot ?? { id: s.artifactId, src: '' }} alt={label} className="block h-full w-full object-cover object-top" />
                  <i aria-hidden="true" className={`absolute -right-1 -top-1 z-10 block h-2.5 w-2.5 ring-2 ring-surface-2 ${VERDICT_DOT[s.verdict]}`} />
                </span>
                <span className="font-mono text-[11px] uppercase tracking-[1px] text-text-muted">{VIEWPORT_LABEL[s.viewport]}</span>
              </>
            );
            return (
              <li key={s.artifactId}>
                {cellKey && review ? (
                  <button
                    type="button"
                    data-testid="shipped-hero-shot"
                    data-cell={cellKey}
                    aria-label={`Open ${label} in the review deck`}
                    onClick={() => review.openDeck(cellKey)}
                    className="flex min-h-11 flex-col items-start gap-1.5 text-left"
                  >
                    {frame}
                  </button>
                ) : (
                  <a
                    data-testid="shipped-hero-shot"
                    href={`/api/artifacts/${encodeURIComponent(s.artifactId)}/download`}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`Open ${label} full size`}
                    className="flex min-h-11 flex-col items-start gap-1.5"
                  >
                    {frame}
                  </a>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {view.noScreenshotsLine && (
        <p data-testid="shipped-no-screenshots" className="font-mono text-[12.5px] text-text-secondary">
          {NO_SCREENSHOTS_LINE}
        </p>
      )}

      {view.offPlan.length > 0 && (
        <div data-testid="shipped-off-plan" className="border-t border-border-default pt-3">
          <span className="font-mono text-[11px] uppercase tracking-[1.2px] text-text-muted">Off plan</span>
          <ul className="mt-1.5 flex flex-col gap-1">
            {view.offPlan.map(line => (
              <li key={line} className="font-mono text-[12.5px] leading-[1.55] text-text-secondary">{line}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
