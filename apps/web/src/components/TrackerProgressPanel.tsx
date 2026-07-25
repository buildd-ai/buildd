'use client';

import { useEffect, useState } from 'react';
import ExternalLink from './ExternalLink';

/**
 * Linear Phase 2 — read-back tracking panel.
 *
 * Renders external work-tracker progress (Linear projects/issues) for a mission
 * or initiative. It is intentionally invisible for unlinked entities: on
 * `linked === false` or ANY fetch error it renders `null` — never an error wall.
 *
 * The panel is only *mounted* by the pages behind a cheap server-side link gate
 * (`getLinksForEntity`), so an unlinked entity never even reaches the fetch here.
 * The client-side `linked` check is a belt-and-suspenders fallback.
 *
 * Data comes from the backend contract (owned by a parallel agent, fetched at
 * runtime — never imported):
 *   GET /api/{missions|initiatives}/[id]/tracker-progress
 */

export interface TrackerProgressItem {
  kind: 'project' | 'issue';
  externalId: string;
  title: string | null;
  percent: number | null; // 0..100 or null
  state: string | null;
  url: string | null;
}

export interface TrackerProgressResponse {
  linked: boolean;
  provider: 'linear' | null;
  items: TrackerProgressItem[];
  fetchedAt: string;
}

type LoadStatus = 'loading' | 'error' | 'done';

/**
 * Fetch + parse the tracker-progress contract. Pure and side-effect-free beyond
 * the network call, so it's trivially testable with a mocked `fetch`. Returns the
 * parsed payload on 200, or `null` on any failure (non-ok status, thrown error,
 * bad JSON) — the caller treats `null` as "render nothing".
 */
export async function fetchTrackerProgress(
  entityType: 'mission' | 'initiative',
  entityId: string,
): Promise<TrackerProgressResponse | null> {
  try {
    const res = await fetch(`/api/${entityType}s/${entityId}/tracker-progress`, {
      credentials: 'include',
    });
    if (!res.ok) return null;
    const data = (await res.json()) as TrackerProgressResponse;
    if (!data || typeof data.linked !== 'boolean') return null;
    return data;
  } catch {
    return null;
  }
}

function providerLabel(provider: string | null): string {
  if (!provider) return 'Linear';
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

function clampPercent(percent: number | null): number | null {
  if (percent == null || Number.isNaN(percent)) return null;
  return Math.max(0, Math.min(100, percent));
}

/** Subtle skeleton shown while the first fetch is in flight. */
function TrackerSkeleton() {
  return (
    <div className="card p-4" data-testid="tracker-skeleton">
      <div className="h-3 w-16 rounded bg-surface-3 animate-pulse mb-3" />
      <div className="space-y-2.5">
        <div className="h-2.5 w-full rounded bg-surface-3 animate-pulse" />
        <div className="h-2.5 w-2/3 rounded bg-surface-3 animate-pulse" />
      </div>
    </div>
  );
}

/** Presentational card. Pure — given the provider + items it renders the panel. */
export function TrackerCard({
  provider,
  items,
}: {
  provider: string | null;
  items: TrackerProgressItem[];
}) {
  return (
    <div className="card p-4" data-testid="tracker-card">
      <div className="flex items-center justify-between mb-3">
        <h2 className="section-label">{providerLabel(provider)}</h2>
        <span className="text-[10px] font-mono uppercase tracking-wide text-text-muted">
          {items.length} {items.length === 1 ? 'item' : 'items'}
        </span>
      </div>

      {items.length === 0 ? (
        <p className="text-[12px] text-text-muted italic">No tracked items yet.</p>
      ) : (
        <ul className="space-y-3">
          {items.map((item) => {
            const pct = clampPercent(item.percent);
            return (
              <li key={`${item.kind}:${item.externalId}`} className="min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-[10px] font-mono uppercase tracking-wide text-text-muted shrink-0">
                    {item.kind}
                  </span>
                  {item.url ? (
                    <ExternalLink
                      href={item.url}
                      className="text-[13px] text-text-primary truncate hover:text-accent-text transition-colors"
                    >
                      {item.title || item.externalId}
                    </ExternalLink>
                  ) : (
                    <span className="text-[13px] text-text-primary truncate">
                      {item.title || item.externalId}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <div className="h-1.5 flex-1 rounded-full bg-[rgba(255,255,255,0.06)] overflow-hidden">
                    {pct != null && (
                      <div
                        className="h-full rounded-full bg-status-success transition-all duration-500"
                        style={{ width: `${pct}%` }}
                        data-testid="tracker-bar"
                      />
                    )}
                  </div>
                  <span className="shrink-0 font-mono text-[10px] tabular-nums text-text-muted w-8 text-right">
                    {pct != null ? `${Math.round(pct)}%` : '—'}
                  </span>
                  {item.state && (
                    <span className="shrink-0 text-[10px] uppercase tracking-wide text-text-secondary">
                      {item.state}
                    </span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * Pure render decision for a given load state. Exported so the render logic is
 * unit-testable without driving React effects:
 *   - loading            → skeleton
 *   - error              → null (invisible, never an error wall)
 *   - done + !linked     → null
 *   - done + linked      → the card
 */
export function renderTrackerContent(status: LoadStatus, data: TrackerProgressResponse | null) {
  if (status === 'loading') return <TrackerSkeleton />;
  if (status === 'error') return null;
  if (!data || !data.linked) return null;
  return <TrackerCard provider={data.provider} items={data.items} />;
}

export default function TrackerProgressPanel({
  entityType,
  entityId,
}: {
  entityType: 'mission' | 'initiative';
  entityId: string;
}) {
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [data, setData] = useState<TrackerProgressResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    fetchTrackerProgress(entityType, entityId).then((result) => {
      if (cancelled) return;
      if (!result) {
        setStatus('error');
        return;
      }
      setData(result);
      setStatus('done');
    });
    return () => {
      cancelled = true;
    };
  }, [entityType, entityId]);

  return renderTrackerContent(status, data);
}
