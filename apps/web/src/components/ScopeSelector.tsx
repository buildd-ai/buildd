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
  const tab = (value: ShareScope, text: string) => (
    <button
      onClick={() => onScopeChange(value)}
      className={`seg-item flex-1 sm:flex-none ${scope === value ? 'seg-item-active' : ''}`}
    >
      {text}
    </button>
  );

  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="field-label !mb-0">{label}</span>
      <div className="seg flex sm:inline-flex w-full sm:w-auto">
        {tab('team', 'This team')}
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
          className="h-8 px-2 bg-surface text-sm"
        >
          {workspaces.map((ws) => (
            <option key={ws.id} value={ws.id}>{ws.name}</option>
          ))}
        </select>
      )}
    </div>
  );
}
