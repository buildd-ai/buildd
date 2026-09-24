'use client';

/**
 * The md-and-up list-header toggle (docs/design/mission-feed-mobile-continuity.md,
 * "Desktop adaptation"): Timeline or Structure. That is all that is left of
 * the mission tabs — the Summary tab was absorbed into NEEDS YOU and the Feed
 * tab became the Notes sheet. Below md the page renders `MissionFeedList`
 * instead and this toggle is never shown.
 *
 * `?view=structure` names the choice. It is written with `replaceState`, so
 * switching views never re-renders the server page.
 */
import { useState, type ReactNode } from 'react';
import type { MissionListView } from '@/lib/mission-list-view';

export default function MissionTabs({
  timelineContent,
  structureContent,
  initialView = 'timeline',
}: {
  timelineContent: ReactNode;
  /** Absent → no toggle, the timeline alone. */
  structureContent?: ReactNode;
  initialView?: MissionListView;
}) {
  const [view, setView] = useState<MissionListView>(structureContent ? initialView : 'timeline');

  const choose = (next: MissionListView) => {
    setView(next);
    const url = new URL(window.location.href);
    if (next === 'structure') url.searchParams.set('view', 'structure');
    else url.searchParams.delete('view');
    window.history.replaceState(window.history.state, '', url.toString());
  };

  const btnCls = (active: boolean) =>
    `min-h-9 border px-3 font-mono text-[12px] uppercase tracking-wider transition-colors ${
      active ? 'border-border-strong bg-surface-3 text-text-primary' : 'border-transparent text-text-muted hover:text-text-primary'
    }`;

  return (
    <div data-testid="mission-list-toggle-region">
      {structureContent && (
        <div role="group" aria-label="List view" className="mb-3 flex items-center gap-1">
          <button type="button" aria-pressed={view === 'timeline'} onClick={() => choose('timeline')} className={btnCls(view === 'timeline')}>
            Timeline
          </button>
          <button type="button" aria-pressed={view === 'structure'} onClick={() => choose('structure')} className={btnCls(view === 'structure')}>
            Structure
          </button>
        </div>
      )}
      {view === 'structure' ? structureContent : timelineContent}
    </div>
  );
}
