'use client';

import { useState, type ReactNode } from 'react';

export default function MissionTabs({
  timelineContent,
  feedContent,
  summaryContent,
  structureContent,
  defaultTab = 'timeline',
}: {
  timelineContent: ReactNode;
  feedContent: ReactNode;
  /** When provided a Summary tab is added as the first tab. */
  summaryContent?: ReactNode;
  /** When provided a Structure tab is added (desktop only — hidden on mobile). */
  structureContent?: ReactNode;
  /** Initial active tab. Defaults to 'timeline'. */
  defaultTab?: 'summary' | 'timeline' | 'feed';
}) {
  const hasSummary = !!summaryContent;
  const hasStructure = !!structureContent;
  const [tab, setTab] = useState<'summary' | 'timeline' | 'feed' | 'structure'>(defaultTab);

  const btnCls = (active: boolean) =>
    `px-3 py-1.5 rounded-md text-[13px] font-medium transition-colors ${
      active
        ? 'bg-surface-3 text-text-primary'
        : 'text-text-muted hover:text-text-secondary hover:bg-surface-2'
    }`;

  return (
    <div>
      <div className="flex items-center gap-1 mb-4">
        {hasSummary && (
          <button onClick={() => setTab('summary')} className={btnCls(tab === 'summary')}>
            Summary
          </button>
        )}
        <button onClick={() => setTab('timeline')} className={btnCls(tab === 'timeline')}>
          Timeline
        </button>
        <button onClick={() => setTab('feed')} className={btnCls(tab === 'feed')}>
          Feed
        </button>
        {hasStructure && (
          <button
            onClick={() => setTab('structure')}
            className={`hidden md:flex ${btnCls(tab === 'structure')}`}
          >
            Structure
          </button>
        )}
      </div>

      {tab === 'summary' ? summaryContent
        : tab === 'structure' ? structureContent
        : tab === 'timeline' ? timelineContent
        : feedContent}
    </div>
  );
}
