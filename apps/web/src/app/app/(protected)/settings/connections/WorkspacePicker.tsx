'use client';

/**
 * Choose the workspaces a connection reaches: the consent page's picker
 * (lib/oauth/account-consent.ts) in React. Same model, same reducer: teams as
 * groups, 20 workspaces per page, search over workspace and team names,
 * Select all (matches while searching), Clear all and per-team select/clear.
 * The consent page runs these as form posts because it has no script; here
 * the same `applyNav` actions run in the browser.
 *
 * Only offers what the server listed as the person's teams. The server still
 * re-checks every added workspace when the change is saved.
 */
import { useMemo, useState } from 'react';
import Disclosure from '@/components/ui/Disclosure';
import {
  CONSENT_PAGE_SIZE,
  applyNav,
  filteredWorkspaces,
  type ConsentState,
  type ConsentTeam,
} from '@/lib/oauth/account-consent';

export default function WorkspacePicker({
  teams,
  initialSelected,
  onCancel,
  onSave,
  saving = false,
  clientName,
}: {
  teams: ConsentTeam[];
  initialSelected: string[];
  onCancel: () => void;
  onSave: (selected: string[]) => void;
  saving?: boolean;
  clientName: string;
}) {
  const [state, setState] = useState<ConsentState>(() => ({
    selected: initialSelected,
    actsAs: 'agent',
    write: false,
    query: '',
    pages: {},
    focusTeam: null,
  }));
  const nav = (action: string) => setState((s) => applyNav(s, action, teams));
  const selected = useMemo(() => new Set(state.selected), [state.selected]);
  const total = teams.reduce((n, t) => n + t.workspaces.length, 0);
  const searching = state.query.trim() !== '';

  function toggle(id: string) {
    setState((s) => ({
      ...s,
      selected: s.selected.includes(id) ? s.selected.filter((x) => x !== id) : [...s.selected, id],
    }));
  }

  const blocks = teams.map((team) => {
    const shown = filteredWorkspaces(team, state.query);
    if (shown.length === 0) return null;
    const pages = Math.max(1, Math.ceil(shown.length / CONSENT_PAGE_SIZE));
    const page = Math.min(Math.max(1, state.pages[team.id] ?? 1), pages);
    const visible = shown.slice((page - 1) * CONSENT_PAGE_SIZE, page * CONSENT_PAGE_SIZE);
    const chosen = team.workspaces.filter((w) => selected.has(w.id)).length;
    return (
      <Disclosure
        key={team.id}
        summary={<span className="text-title font-semibold text-text-primary">{team.name}</span>}
        count={chosen > 0 ? chosen : undefined}
        defaultOpen={chosen > 0 || teams.length === 1}
        className="border-b border-border-default"
      >
        <div data-testid="picker-team" data-team={team.id} className="pb-3 pl-5">
          <ul className="divide-y divide-[var(--line-soft)]">
            {visible.map((w) => (
              <li key={w.id}>
                <label className="flex min-h-11 cursor-pointer items-center gap-3 py-1 text-body text-text-primary">
                  <input
                    type="checkbox"
                    data-testid="picker-workspace"
                    value={w.id}
                    checked={selected.has(w.id)}
                    onChange={() => toggle(w.id)}
                    className="h-4 w-4 shrink-0"
                  />
                  <span className="min-w-0 break-words">{w.name}</span>
                </label>
              </li>
            ))}
          </ul>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button type="button" className="btn btn-quiet btn-sm h-11 md:h-8" onClick={() => nav(`team_all:${team.id}`)} aria-label={`Select all in ${team.name}`}>Select all in team</button>
            <button type="button" className="btn btn-quiet btn-sm h-11 md:h-8" onClick={() => nav(`team_clear:${team.id}`)} aria-label={`Clear ${team.name}`}>Clear team</button>
          </div>
          {pages > 1 && (
            <div className="mt-2 flex flex-wrap items-center gap-2" data-testid="picker-pager">
              {page > 1 && <button type="button" className="btn btn-sm h-11 md:h-8" onClick={() => nav(`page:${team.id}:${page - 1}`)} aria-label={`Previous page of ${team.name}`}>Previous</button>}
              <span className="text-meta text-text-muted">page <span className="font-mono">{page}</span> of <span className="font-mono">{pages}</span></span>
              {page < pages && <button type="button" className="btn btn-sm h-11 md:h-8" onClick={() => nav(`page:${team.id}:${page + 1}`)} aria-label={`Next page of ${team.name}`}>Next</button>}
            </div>
          )}
        </div>
      </Disclosure>
    );
  }).filter(Boolean);

  return (
    <div data-testid="workspace-picker" className="space-y-3">
      <p className="text-body text-text-secondary">
        Choose the workspaces {clientName} can reach. It reaches each one only while you are on its team.
      </p>
      <input
        type="search"
        value={state.query}
        onChange={(e) => {
          const query = e.target.value.slice(0, 100);
          setState((s) => applyNav({ ...s, query }, 'search', teams));
        }}
        placeholder={`Search ${total} ${total === 1 ? 'workspace' : 'workspaces'}`}
        aria-label="Search workspaces"
        className="h-11 w-full bg-card px-3 text-body text-text-primary placeholder:text-text-muted md:h-9"
      />
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn btn-quiet btn-sm h-11 md:h-8" onClick={() => nav('select_all')}>{searching ? 'Select all matches' : 'Select all'}</button>
        <button type="button" className="btn btn-quiet btn-sm h-11 md:h-8" onClick={() => nav('clear_all')}>Clear all</button>
      </div>
      <div className="border-t border-border-default">
        {blocks.length > 0 ? blocks : <p className="py-3 text-body text-text-muted">{searching ? 'No workspaces match.' : 'No workspaces.'}</p>}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-meta text-text-muted" data-testid="picker-count">
          <span className="font-mono">{state.selected.length}</span> of <span className="font-mono">{total}</span> chosen
        </span>
        <div className="flex gap-2">
          <button type="button" className="btn btn-sm h-11 md:h-8" onClick={onCancel} disabled={saving}>Cancel</button>
          <button
            type="button"
            data-testid="picker-save"
            className="btn btn-primary btn-sm h-11 md:h-8"
            disabled={saving || state.selected.length === 0}
            onClick={() => onSave(state.selected)}
          >
            {saving ? 'Saving…' : 'Save workspaces'}
          </button>
        </div>
      </div>
    </div>
  );
}
