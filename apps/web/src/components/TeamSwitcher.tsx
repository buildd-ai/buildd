'use client';

import { useState, useRef, useCallback, useId } from 'react';
import { useClickOutside } from '@/hooks/useClickOutside';
import { useEscapeClose } from '@/hooks/useEscapeClose';
import { switchTeam } from '@/lib/switch-team';

interface Team {
  id: string;
  name: string;
  slug: string;
}

export function TeamSwitcher({ teams, currentTeamId }: { teams: Team[]; currentTeamId: string | null }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const close = useCallback(() => setOpen(false), []);

  const currentTeam = teams.find(t => t.id === currentTeamId) || teams[0];

  useClickOutside(ref, close);
  useEscapeClose(open, close, triggerRef, ref);

  if (!currentTeam) return null;

  // Single team - nothing to switch to, so render the name as plain text.
  if (teams.length <= 1) {
    return (
      <span className="text-text-secondary truncate max-w-[140px]">
        {currentTeam.name}
      </span>
    );
  }

  // Multiple teams — the NAME is the affordance (turbopuffer `org | scope ⌄`,
  // Vercel `Buildd ⇕`). A bare chevron beside the name is undiscoverable, which
  // is what #1821 left behind when it hid the label below 640px to fix overflow;
  // overflow is now handled by truncation instead.
  return (
    <div ref={ref} className="relative min-w-0">
      {/* Disclosure, not an ARIA menu (the items are plain buttons reached with
          Tab). Escape closes it and refocuses the trigger. */}
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={`Switch team (current: ${currentTeam.name})`}
        // Negative margins widen the tap target without changing the breadcrumb's
        // visual baseline or line height; min-h-11 makes it 44px on touch.
        className="flex items-center gap-1 min-w-0 -mx-1 -my-1.5 px-1 py-1.5 max-md:min-h-11 rounded text-text-secondary hover:text-text-primary hover:bg-surface-3 transition-colors"
      >
        <span className="truncate max-w-[140px]">{currentTeam.name}</span>
        <svg
          className={`w-3 h-3 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div id={panelId} className="absolute top-full left-0 mt-1 w-48 bg-surface-2 border border-border-default rounded-md shadow-lg z-50 py-1">
          {teams.map(team => (
            <button
              key={team.id}
              type="button"
              aria-current={team.id === currentTeam.id ? 'true' : undefined}
              onClick={() => switchTeam(team.id)}
              className={`w-full text-left px-3 py-3 md:py-2 text-sm hover:bg-surface-3 ${
                team.id === currentTeam.id
                  ? 'text-text-primary font-medium'
                  : 'text-text-secondary'
              }`}
            >
              {team.name}
              {team.id === currentTeam.id && (
                <svg aria-hidden="true" className="inline-block w-3.5 h-3.5 ml-2" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                </svg>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
