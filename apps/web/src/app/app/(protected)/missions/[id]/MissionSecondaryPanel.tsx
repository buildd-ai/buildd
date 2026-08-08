'use client';

import { useState, type ReactNode } from 'react';

export default function MissionSecondaryPanel({
  children,
  configSummary,
}: {
  children: ReactNode;
  configSummary?: string | null;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="mb-6">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full text-left mb-1 group"
        aria-expanded={expanded}
      >
        <svg className="w-3.5 h-3.5 text-text-secondary shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" />
        </svg>
        <h2 className="section-label">Settings</h2>
        {!expanded && configSummary && (
          <span className="text-[11px] text-text-secondary font-mono ml-1">— {configSummary}</span>
        )}
        <svg
          className={`w-4 h-4 text-text-secondary ml-auto transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {!expanded && (
        <p className="text-[11px] text-text-muted">Schedule, configuration & more</p>
      )}
      {expanded && (
        <div className="mt-3 space-y-4">
          {children}
        </div>
      )}
    </div>
  );
}
