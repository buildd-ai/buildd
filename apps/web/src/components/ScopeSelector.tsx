'use client';

/**
 * Shared "who can use this?" scope control — one vocabulary across every credential/
 * connector/role surface (This team / One workspace / All my teams). See
 * docs/design/unified-sharing-model.md. Presentation-only: each caller maps the
 * chosen ShareScope onto its own storage (secrets column, connectorWorkspaces mount,
 * workspaceSkills column).
 */
export type ShareScope = 'team' | 'workspace' | 'all_teams';

export function ScopeSelector({
  scope,
  onScopeChange,
  workspaceId,
  onWorkspaceChange,
  workspaces,
  allowAllTeams = false,
  allTeamsCount = 0,
  label = 'Applies to',
}: {
  scope: ShareScope;
  onScopeChange: (s: ShareScope) => void;
  workspaceId: string;
  onWorkspaceChange: (id: string) => void;
  workspaces: { id: string; name: string }[];
  allowAllTeams?: boolean;
  allTeamsCount?: number;
  label?: string;
}) {
  const tab = (value: ShareScope, text: string, first = false) => (
    <button
      onClick={() => onScopeChange(value)}
      className={`flex-1 sm:flex-none px-3 h-9 text-sm font-medium transition-colors ${first ? '' : 'border-l border-border-default'} ${scope === value ? 'bg-surface-3 text-text-primary' : 'text-text-secondary'}`}
    >
      {text}
    </button>
  );

  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="text-xs font-medium text-text-secondary">{label}</span>
      <div className="flex sm:inline-flex w-full sm:w-auto rounded-lg border border-border-default overflow-hidden">
        {tab('team', 'This team', true)}
        {tab('workspace', 'One workspace')}
        {allowAllTeams && tab('all_teams', 'All my teams')}
      </div>
      {scope === 'all_teams' && (
        <span className="text-xs text-text-muted">Applies to every team you manage ({allTeamsCount})</span>
      )}
      {scope === 'workspace' && (
        <select
          value={workspaceId}
          onChange={(e) => onWorkspaceChange(e.target.value)}
          className="h-9 px-2 rounded-lg border border-border-default bg-surface text-sm"
        >
          {workspaces.map((ws) => (
            <option key={ws.id} value={ws.id}>{ws.name}</option>
          ))}
        </select>
      )}
    </div>
  );
}
