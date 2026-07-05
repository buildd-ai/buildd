'use client';

import { useState, useRef, useCallback } from 'react';
import { useClickOutside } from '@/hooks/useClickOutside';
import { switchTeam } from '@/lib/switch-team';

interface Team {
  id: string;
  name: string;
  slug: string;
}

function teamInitial(team: Team): string {
  return (team.name?.trim()?.[0] || '?').toUpperCase();
}

/**
 * Compact team switcher for the desktop icon rail. Shows the active team's
 * initial; clicking opens a dropdown anchored to the right of the rail. Single
 * team renders as a static badge (no dropdown). Selecting a team sets the
 * buildd-team cookie and reloads so the namespaced views re-scope.
 */
export default function TeamSwitcherRail({
  teams,
  currentTeamId,
}: {
  teams: Team[];
  currentTeamId: string | null;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, useCallback(() => setOpen(false), []));

  if (teams.length === 0) return null;

  const currentTeam = teams.find((t) => t.id === currentTeamId) || teams[0];
  const multi = teams.length > 1;

  return (
    <div ref={ref} className="relative mb-2">
      <button
        onClick={() => multi && setOpen(!open)}
        className={`group w-10 h-10 flex items-center justify-center text-xs font-semibold bg-accent-soft text-accent-text border border-border-default transition-colors ${
          multi ? 'cursor-pointer hover:border-border-strong' : 'cursor-default'
        }`}
        title={multi ? `Team: ${currentTeam.name} — click to switch` : currentTeam.name}
        aria-haspopup={multi ? 'menu' : undefined}
        aria-expanded={multi ? open : undefined}
      >
        {teamInitial(currentTeam)}
      </button>

      {open && multi && (
        <div className="absolute left-[52px] top-0 w-52 bg-card border border-border-strong shadow-[var(--card-shadow)] overflow-hidden z-50 py-1">
          <div className="px-3 py-1.5 text-[10px] uppercase tracking-wide text-text-muted">Switch team</div>
          {teams.map((team) => (
            <button
              key={team.id}
              onClick={() => switchTeam(team.id)}
              className={`w-full text-left px-3 py-2 text-sm flex items-center justify-between hover:bg-surface-3 transition-colors ${
                team.id === currentTeam.id ? 'text-text-primary font-medium' : 'text-text-secondary'
              }`}
            >
              <span className="truncate">{team.name}</span>
              {team.id === currentTeam.id && (
                <svg className="w-3.5 h-3.5 ml-2 shrink-0" fill="currentColor" viewBox="0 0 20 20">
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
