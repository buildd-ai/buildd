'use client';

/**
 * A completed mission's outcome hero (Navigation d25d923d R-23 to R-27): what
 * the mission produced, first, with the execution record beneath it.
 *
 * ```
 * OUTCOME READY
 * Mission final: what buildd should adopt              [ Open report ]
 * │ Aggregates the read-throughs. No code was produced…
 * Supporting reports · 9 ›
 * ```
 *
 * The view (`buildOutcomeHero`) decides every word; this only lays it out.
 * Opening a report opens it in place, in the page's one Records sheet; the
 * `?artifact=` link stays the no-script fallback and the address to share.
 */
import { useState, type MouseEvent, type ReactNode } from 'react';
import { SHIPPED_HEADER_ID } from '@/lib/mission-shipped-header';
import { openMissionRecords } from '@/lib/mission-records-open';
import type { OutcomeHeroView } from '@/lib/mission-outcome';

export default function MissionOutcomeHero({ missionId, view, children }: { missionId: string; view: OutcomeHeroView; children?: ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const openInPlace = (artifactId: string | null, exclude: string | null = null) => (e: MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey) return;
    if (openMissionRecords({ missionId, artifactId, exclude })) e.preventDefault();
  };
  const primary = view.primary;

  return (
    <section
      id={SHIPPED_HEADER_ID}
      data-testid="mission-outcome-hero"
      data-class={view.class}
      aria-labelledby="mission-outcome-words"
      className="mt-[18px] flex min-w-0 scroll-mt-4 flex-col gap-3 border-2 border-border-strong bg-card px-[18px] py-4 shadow-[var(--card-shadow)]"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="mission-outcome-words" data-testid="outcome-words" className="text-eyebrow font-semibold text-status-success">
          {view.words}
        </h2>
        {view.specState && (
          <span data-testid="outcome-spec-state" className="border border-border-default px-1.5 py-0.5 text-chip font-semibold text-text-secondary">
            {view.specState}
          </span>
        )}
      </div>

      {primary && (
        <div className="flex min-w-0 flex-col gap-3 md:flex-row md:items-start md:justify-between md:gap-6">
          <h3 className="min-w-0 break-words text-heading font-semibold text-text-primary">
            <a data-testid="outcome-title" href={primary.href} onClick={openInPlace(primary.id)} className="underline-offset-4 hover:underline">
              {primary.title}
            </a>
          </h3>
          <a
            data-testid="outcome-open"
            href={primary.href}
            onClick={openInPlace(primary.id)}
            className="inline-flex min-h-11 w-full shrink-0 items-center justify-center border-2 border-border-strong bg-surface-2 px-4 text-body font-semibold text-text-primary hover:bg-card-hover md:w-auto"
          >
            {primary.action}
          </a>
        </div>
      )}

      {view.lede && (
        <div className="flex min-w-0 flex-col items-start gap-1">
          {view.ledeIsExcerpt ? (
            <blockquote
              data-testid="outcome-lede"
              data-excerpt="true"
              className={`max-w-[60ch] border-l-2 border-border-default pl-3 text-body leading-relaxed text-text-secondary ${expanded ? '' : 'line-clamp-4 md:line-clamp-none'}`}
            >
              {view.lede}
            </blockquote>
          ) : (
            <p data-testid="outcome-lede" className={`max-w-[60ch] text-body leading-relaxed text-text-primary ${expanded ? '' : 'line-clamp-4 md:line-clamp-none'}`}>
              {view.lede}
            </p>
          )}
          {!expanded && view.lede.length > 160 && (
            <button type="button" onClick={() => setExpanded(true)} className="inline-flex min-h-11 items-center text-body text-text-secondary underline-offset-4 hover:underline md:hidden">
              More
            </button>
          )}
        </div>
      )}

      {view.delivery && <p data-testid="outcome-delivery" className="font-mono text-meta text-text-secondary">{view.delivery}</p>}

      {children}

      {view.reports.length > 0 && (
        <div className="flex min-w-0 flex-col gap-2">
          <ul data-testid="outcome-reports" className="flex min-w-0 flex-col border-t border-border-default">
            {view.reports.map(r => (
              <li key={r.id} className="border-b border-border-default">
                <a data-testid="outcome-report" href={r.href} onClick={openInPlace(r.id)} className="flex min-h-11 min-w-0 items-center gap-2 text-body text-text-primary hover:bg-card-hover">
                  <span className="min-w-0 flex-1 truncate">{r.title}</span>
                  <span aria-hidden="true" className="text-text-muted">›</span>
                </a>
              </li>
            ))}
          </ul>
          <button type="button" data-testid="outcome-choose" onClick={() => openMissionRecords({ missionId })} className="inline-flex min-h-11 items-center self-start text-body text-text-secondary underline-offset-4 hover:text-text-primary hover:underline md:min-h-0">
            Choose the main report ›
          </button>
        </div>
      )}

      {view.supportingCount > 0 && primary && (
        <button
          type="button"
          data-testid="outcome-supporting"
          onClick={() => openMissionRecords({ missionId, exclude: primary.id })}
          className="flex min-h-11 w-full items-center border-t border-border-default pt-1 text-left text-body text-text-secondary hover:text-text-primary md:min-h-9"
        >
          {`Supporting reports · ${view.supportingCount} ›`}
        </button>
      )}
    </section>
  );
}
