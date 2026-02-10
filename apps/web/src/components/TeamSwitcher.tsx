'use client';

import { useState, useRef, useEffect } from 'react';

interface Team {
  id: string;
  name: string;
  slug: string;
}

export function TeamSwitcher({ teams, currentTeamId }: { teams: Team[]; currentTeamId: string | null }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const currentTeam = teams.find(t => t.id === currentTeamId) || teams[0];

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  function switchTeam(teamId: string) {
    document.cookie = `buildd-team=${teamId};path=/;max-age=${60 * 60 * 24 * 365}`;
    setOpen(false);
    window.location.reload();
  }

  if (!currentTeam) return null;

  // Single team - show as plain text
  if (teams.length <= 1) {
    return (
      <span className="text-sm text-gray-500 dark:text-gray-400">
        {currentTeam.name}
      </span>
    );
  }

  // Multiple teams - show as dropdown
  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 text-sm text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white px-2 py-1 rounded-md hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
      >
        <span>{currentTeam.name}</span>
        <svg
          className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-180' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-1 w-48 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg z-50 py-1">
          {teams.map(team => (
            <button
              key={team.id}
              onClick={() => switchTeam(team.id)}
              className={`w-full text-left px-3 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-800 ${
                team.id === currentTeam.id
                  ? 'text-black dark:text-white font-medium'
                  : 'text-gray-600 dark:text-gray-400'
              }`}
            >
              {team.name}
              {team.id === currentTeam.id && (
                <svg className="inline-block w-3.5 h-3.5 ml-2" fill="currentColor" viewBox="0 0 20 20">
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
