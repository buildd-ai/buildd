'use client';

import { useState } from 'react';
import WorkspaceMigrationModal from '@/components/WorkspaceMigrationModal';

interface UserTeam {
    id: string;
    name: string;
}

interface Props {
    workspace: { id: string; name: string; teamId: string };
    teams: UserTeam[];
    className?: string;
}

/**
 * The single surface on the config page for moving a workspace between teams.
 *
 * Replaces the old TeamTransferSection, whose bare `PATCH /api/workspaces/<id>
 * { teamId }` reparented the row without deleting workspace-scoped secrets or
 * re-authorizing connectors. The modal runs /migrate/precheck first and requires
 * the caller to acknowledge what breaks before /migrate/execute touches anything.
 *
 * Rendered as the "Move to team…" action of the workspace health card: moving is
 * an offer, not a fix, so it is a plain button rather than a danger zone.
 */
export function TeamMigrationSection({ workspace, teams, className }: Props) {
    const [migrating, setMigrating] = useState(false);

    return (
        <>
            <button
                type="button"
                onClick={() => setMigrating(true)}
                className={className ?? 'btn min-h-11'}
            >Move to team&hellip;</button>

            {migrating && (
                <WorkspaceMigrationModal
                    workspace={workspace}
                    teams={teams}
                    onClose={() => setMigrating(false)}
                />
            )}
        </>
    );
}
