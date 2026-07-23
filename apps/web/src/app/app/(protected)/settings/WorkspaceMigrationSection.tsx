'use client';

import { useState } from 'react';
import WorkspaceMigrationModal from '@/components/WorkspaceMigrationModal';

interface Workspace {
  id: string;
  name: string;
  teamId: string;
}

interface Team {
  id: string;
  name: string;
}

export default function WorkspaceMigrationSection({
  workspaces,
  teams,
}: {
  workspaces: Workspace[];
  teams: Team[];
}) {
  const [migrating, setMigrating] = useState<Workspace | null>(null);

  const canMigrate = teams.length >= 2;

  return (
    <section>
      <h2 className="section-label text-status-error mb-4">Danger Zone</h2>

      <div className="card border-status-error/40 p-4">
        <div className="mb-4">
          <div className="text-sm font-medium text-text-primary mb-1">Migrate Workspace</div>
          <p className="text-xs text-text-secondary">
            Move a workspace to another team. Tasks, workers, artifacts and schedules move with it.
            Workspace-scoped secrets are deleted and connectors must be re-authorized in the
            destination team.
          </p>
        </div>

        {!canMigrate ? (
          <div className="text-xs text-text-muted">
            You need admin access to a second team to migrate a workspace.
          </div>
        ) : workspaces.length === 0 ? (
          <div className="text-xs text-text-muted">No workspaces to migrate.</div>
        ) : (
          <div className="divide-y divide-border-default">
            {workspaces.map((ws) => (
              <div key={ws.id} className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
                <span className="text-sm text-text-primary truncate">{ws.name}</span>
                <button
                  onClick={() => setMigrating(ws)}
                  className="px-3 py-1.5 text-xs border border-status-error/30 text-status-error rounded-md hover:bg-status-error/10 transition-colors"
                >
                  Migrate…
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {migrating && (
        <WorkspaceMigrationModal
          workspace={migrating}
          teams={teams}
          onClose={() => setMigrating(null)}
        />
      )}
    </section>
  );
}
