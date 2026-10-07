import Link from 'next/link';
import { inArray } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { workspaces as workspacesTable, type WorkspaceGitConfig } from '@buildd/core/db/schema';
import SettingsPage from '../_components/SettingsPage';
import { loadSettingsContext } from '../_lib/settings-context';
import WorkspacesTable from './WorkspacesTable';
import { buildWorkspaceRows } from './rows';
import { getTeamsPermissionOverrides } from '@/lib/permissions';

export const dynamic = 'force-dynamic';

/**
 * Settings → Workspaces: one table, a row per workspace — its team, git
 * workflow and merge policy (each linking to its editor), the green-CI switch,
 * and "Move to team…" in the row menu.
 */
export default async function WorkspacesSettingsPage() {
  const { user, teams, workspaces } = await loadSettingsContext();

  const ids = workspaces.map((ws) => ws.id);
  const configs = ids.length > 0
    ? await db
        .select({ id: workspacesTable.id, gitConfig: workspacesTable.gitConfig })
        .from(workspacesTable)
        .where(inArray(workspacesTable.id, ids))
        .catch(() => [] as Array<{ id: string; gitConfig: WorkspaceGitConfig | null }>)
    : [];
  const gitConfig = new Map(configs.map((c) => [c.id, (c.gitConfig as WorkspaceGitConfig | null) ?? null]));

  const { rows, moveTeams } = buildWorkspaceRows({
    userId: user.id,
    teams,
    overrides: await getTeamsPermissionOverrides(teams.map((t) => t.id)),
    workspaces: workspaces.map((ws) => ({ ...ws, gitConfig: gitConfig.get(ws.id) ?? null })),
  });

  return (
    <SettingsPage title="Workspaces" wide>
      <section aria-labelledby="ws-list-h">
        <div className="flex items-center justify-between gap-3 mb-3 min-h-8">
          <h2 id="ws-list-h" className="section-label">Your workspaces</h2>
          <Link href="/app/workspaces/new" className="btn btn-quiet">New workspace</Link>
        </div>
        {rows.length === 0 ? (
          <div className="card p-6 text-center">
            <p className="text-sm text-text-secondary mb-3">No workspaces.</p>
            <Link href="/app/workspaces/new" className="btn btn-primary">Create a workspace</Link>
          </div>
        ) : (
          <WorkspacesTable rows={rows} moveTeams={moveTeams} />
        )}
      </section>
    </SettingsPage>
  );
}
