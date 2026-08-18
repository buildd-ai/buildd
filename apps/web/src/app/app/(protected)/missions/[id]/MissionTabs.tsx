'use client';

import { useState, type ReactNode } from 'react';

export default function MissionTabs({
  timelineContent,
  feedContent,
  summaryContent,
  defaultTab = 'timeline',
}: {
  timelineContent: ReactNode;
  feedContent: ReactNode;
  summaryContent?: ReactNode;
  defaultTab?: 'summary' | 'timeline';
}) {
  const [tab, setTab] = useState<'summary' | 'timeline' | 'feed'>(
    summaryContent ? defaultTab : 'timeline',
  );

  return (
    <div>
      <div className="flex items-center gap-1 mb-4">
        {summaryContent && (
          <button
            onClick={() => setTab('summary')}
            className={`px-3 py-1.5 rounded-md text-[13px] font-medium transition-colors ${
              tab === 'summary'
                ? 'bg-surface-3 text-text-primary'
                : 'text-text-muted hover:text-text-secondary hover:bg-surface-2'
            }`}
          >
            Summary
          </button>
        )}
        <button
          onClick={() => setTab('timeline')}
          className={`px-3 py-1.5 rounded-md text-[13px] font-medium transition-colors ${
            tab === 'timeline'
              ? 'bg-surface-3 text-text-primary'
              : 'text-text-muted hover:text-text-secondary hover:bg-surface-2'
          }`}
        >
          Timeline
        </button>
        <button
          onClick={() => setTab('feed')}
          className={`px-3 py-1.5 rounded-md text-[13px] font-medium transition-colors ${
            tab === 'feed'
              ? 'bg-surface-3 text-text-primary'
              : 'text-text-muted hover:text-text-secondary hover:bg-surface-2'
          }`}
        >
          Feed
        </button>
      </div>

      {tab === 'summary' ? summaryContent : tab === 'timeline' ? timelineContent : feedContent}
    </div>
  );
}
