'use client';

import { useState, type ReactNode } from 'react';

export default function MissionSecondaryPanel({
  children,
  configSummary,
  variant = 'panel',
}: {
  children: ReactNode;
  configSummary?: string | null;
  /**
   * `row`: the mission page's Settings footer row, styled like the
   * Orchestrator, Records and Notes rows (a 44px tap target).
   */
  variant?: 'panel' | 'row';
}) {
  const [expanded, setExpanded] = useState(false);

  if (variant === 'row') {
    return (
      <div>
        <button
          type="button"
          data-testid="mission-settings-row"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
          className="flex min-h-11 w-full items-center gap-2 border-t border-border-default text-left font-mono text-[12px] text-text-secondary hover:text-text-primary"
        >
          <span aria-hidden="true" className="text-text-muted">─</span>
          <span className="min-w-0 flex-1 truncate">
            Settings
            {!expanded && configSummary && <span className="text-text-muted">{` · ${configSummary}`}</span>}
          </span>
          <span aria-hidden="true" className={expanded ? 'rotate-90' : ''}>›</span>
        </button>
        {expanded && <div className="space-y-4 pb-4 pt-2">{children}</div>}
      </div>
    );
  }

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
          <span className="text-[11px] text-text-secondary font-mono ml-1">· {configSummary}</span>
        )}
        <svg
          className={`w-4 h-4 text-text-secondary ml-auto transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {!expanded && (
        <p className="text-[11px] text-text-muted">Schedule and configuration</p>
      )}
      {expanded && (
        <div className="mt-3 space-y-4">
          {children}
        </div>
      )}
    </div>
  );
}
