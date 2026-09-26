import Link from 'next/link';
import SettingsPage from '../_components/SettingsPage';
import WorkspaceGitFeaturesSection from '../WorkspaceGitFeaturesSection';
import WorkspaceMigrationSection from '../WorkspaceMigrationSection';
import { loadSettingsContext } from '../_lib/settings-context';

export const dynamic = 'force-dynamic';

/**
 * Settings → Workspaces: one row per workspace linking to its config and merge
 * policy, the CI policy switch, and moving a workspace to another team.
 */
export default async function WorkspacesSettingsPage() {
  const { teams, workspaces } = await loadSettingsContext();
  const teamName = new Map(teams.map((t) => [t.id, t.name]));

  return (
    <SettingsPage title="Workspaces">
      <section aria-labelledby="ws-list-h">
        <div className="flex items-center justify-between gap-3 mb-3 min-h-8">
          <h2 id="ws-list-h" className="section-label">Your workspaces</h2>
          <Link href="/app/workspaces/new" className="btn btn-quiet">New workspace</Link>
        </div>
        {workspaces.length === 0 ? (
          <div className="card p-6 text-center">
            <p className="text-sm text-text-secondary mb-3">No workspaces yet. A workspace connects a repository to buildd.</p>
            <Link href="/app/workspaces/new" className="btn btn-primary">Create a workspace</Link>
          </div>
        ) : (
          <ul className="card divide-y divide-border-default">
            {workspaces.map((ws) => (
              <li key={ws.id} className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3 px-4 py-3">
                <span className="flex-1 min-w-0">
                  <span className="block text-sm font-medium text-text-primary truncate">{ws.name}</span>
                  {teams.length > 1 && (
                    <span className="block text-xs text-text-muted truncate">{teamName.get(ws.teamId) ?? 'Unknown team'}</span>
                  )}
                </span>
                <span className="flex flex-wrap gap-2 shrink-0">
                  <Link href={`/app/workspaces/${ws.id}/config`} className="btn">Git workflow</Link>
                  <Link href={`/app/settings/workspace/${ws.id}`} className="btn">Merge policy</Link>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <WorkspaceGitFeaturesSection workspaces={workspaces.map((ws) => ({ id: ws.id, name: ws.name }))} />

      <WorkspaceMigrationSection
        workspaces={workspaces.map((ws) => ({ id: ws.id, name: ws.name, teamId: ws.teamId }))}
        teams={teams.map((t) => ({ id: t.id, name: t.name }))}
      />
    </SettingsPage>
  );
}
