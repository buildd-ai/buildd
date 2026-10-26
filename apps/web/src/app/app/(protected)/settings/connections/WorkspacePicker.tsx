'use client';

/**
 * Choose specific workspaces for a connection: the consent page's picker
 * (lib/oauth/account-consent.ts) in React. Same model, same reducer: teams as
 * groups, 20 workspaces per page, search over workspace and team names, Tick
 * all listed (matches while searching), Clear and per-team tick/clear. The
 * consent page runs these as form posts because it has no script; here the
 * same `applyNav` actions run in the browser. Ticking every listed workspace
 * covers the workspaces of now only; a team's future workspaces are a
 * separate choice (All current and future workspaces, TeamAccessEditor).
 *
 * Only offers what the server listed as the person's teams. The server still
 * re-checks every added workspace when the change is saved.
 *
 * `onSelectionChange` + `hideActions`: embedded in another editor that owns
 * Save, the picker only reports the selection. Search and page survive every
 * tick, so a choice on page 2 or under a search is never lost.
 */
import { useEffect, useMemo, useState } from 'react';
import { displayWorkspaceName } from '@buildd/shared';
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
  onSelectionChange,
  hideActions = false,
}: {
  teams: ConsentTeam[];
  initialSelected: string[];
  onCancel?: () => void;
  onSave?: (selected: string[]) => void;
  saving?: boolean;
  clientName: string;
  onSelectionChange?: (selected: string[]) => void;
  hideActions?: boolean;
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
  const single = teams.length === 1;
  useEffect(() => { onSelectionChange?.(state.selected); }, [state.selected, onSelectionChange]);

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
        defaultOpen={chosen > 0 || single}
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
                  <span className="min-w-0 break-words">{displayWorkspaceName(w.name)}</span>
                </label>
              </li>
            ))}
          </ul>
          {!single && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button type="button" className="btn btn-quiet btn-sm h-11 md:h-8" onClick={() => nav(`team_all:${team.id}`)} aria-label={`Tick every workspace listed in ${team.name}`}>Tick all listed in team</button>
              <button type="button" className="btn btn-quiet btn-sm h-11 md:h-8" onClick={() => nav(`team_clear:${team.id}`)} aria-label={`Clear the ticks in ${team.name}`}>Clear team</button>
            </div>
          )}
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
      {!hideActions && (
        <p className="text-body text-text-secondary">
          Choose the workspaces {clientName} can reach. It reaches each one only while you are on its team.
        </p>
      )}
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
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn btn-quiet btn-sm h-11 md:h-8" onClick={() => nav('select_all')}>{searching ? 'Tick all matches' : 'Tick all listed'}</button>
        <button type="button" className="btn btn-quiet btn-sm h-11 md:h-8" onClick={() => nav('clear_all')}>Clear all</button>
        <span className="text-meta text-text-muted">Ticks the workspaces of now only.</span>
      </div>
      <div className="border-t border-border-default">
        {blocks.length > 0 ? blocks : <p className="py-3 text-body text-text-muted">{searching ? 'No workspaces match.' : 'No workspaces.'}</p>}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-meta text-text-muted" data-testid="picker-count" aria-live="polite">
          <span className="font-mono">{state.selected.length}</span> of <span className="font-mono">{total}</span> ticked
        </span>
        {!hideActions && <div className="flex gap-2">
          <button type="button" className="btn btn-sm h-11 md:h-8" onClick={onCancel} disabled={saving}>Cancel</button>
          <button
            type="button"
            data-testid="picker-save"
            className="btn btn-primary btn-sm h-11 md:h-8"
            disabled={saving || state.selected.length === 0}
            onClick={() => onSave?.(state.selected)}
          >
            {saving ? 'Saving…' : 'Save workspaces'}
          </button>
        </div>}
      </div>
    </div>
  );
}
