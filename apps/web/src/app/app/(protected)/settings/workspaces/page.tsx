import Link from 'next/link';
import { inArray } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { workspaces as workspacesTable, type WorkspaceGitConfig } from '@buildd/core/db/schema';
import SettingsPage from '../_components/SettingsPage';
import { loadSettingsContext } from '../_lib/settings-context';
import WorkspacesTable from './WorkspacesTable';
import { buildWorkspaceRows, WORKSPACE_DEFAULTS } from './rows';
import { loadWorkspaceActivity } from './activity';
import { getTeamsPermissionOverrides } from '@/lib/permissions';

export const dynamic = 'force-dynamic';

/**
 * Settings → Workspaces: the defaults once, then a row per workspace showing
 * only what differs from them, where its work runs, its last task, open tasks
 * and a health hint. Policy changes live on each workspace's own settings.
 */
export default async function WorkspacesSettingsPage() {
  const { user, teams, workspaces } = await loadSettingsContext();

  const ids = workspaces.map((ws) => ws.id);
  const [configs, activity] = await Promise.all([
    ids.length > 0
      ? db
          .select({ id: workspacesTable.id, gitConfig: workspacesTable.gitConfig, webhookConfig: workspacesTable.webhookConfig })
          .from(workspacesTable)
          .where(inArray(workspacesTable.id, ids))
          .catch(() => [] as Array<{ id: string; gitConfig: WorkspaceGitConfig | null; webhookConfig: unknown }>)
      : [],
    loadWorkspaceActivity(ids),
  ]);
  const config = new Map(configs.map((c) => [c.id, c]));

  const { rows, moveTeams } = buildWorkspaceRows({
    userId: user.id,
    teams,
    overrides: await getTeamsPermissionOverrides(teams.map((t) => t.id)),
    workspaces: workspaces.map((ws) => ({
      ...ws,
      gitConfig: (config.get(ws.id)?.gitConfig as WorkspaceGitConfig | null) ?? null,
      webhookConfig: config.get(ws.id)?.webhookConfig ?? null,
    })),
    activity,
  });

  return (
    <SettingsPage title="Workspaces" wide>
      <section aria-labelledby="ws-list-h">
        <div className="flex items-center justify-between gap-3 mb-1 min-h-8">
          <h2 id="ws-list-h" className="section-label">Your workspaces</h2>
          <Link href="/app/workspaces/new" className="btn btn-quiet">New workspace</Link>
        </div>
        {rows.length === 0 ? (
          <div className="card p-6 text-center">
            <p className="text-sm text-text-secondary mb-3">No workspaces.</p>
            <Link href="/app/workspaces/new" className="btn btn-primary">Create a workspace</Link>
          </div>
        ) : (
          <WorkspacesTable rows={rows} moveTeams={moveTeams} defaults={WORKSPACE_DEFAULTS} now={new Date().toISOString()} />
        )}
      </section>
    </SettingsPage>
  );
}
