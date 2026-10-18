/**
 * One workspace's settings row, as the workspace settings page reads it,
 * from the per-team cache (lib/team-cache.ts: 30 s, cleared by the
 * workspace's writers via clearWorkspaceSettingsCache).
 *
 * The caller has already checked access and passes the workspace's team; the
 * read is scoped to it, so a workspace that moved team is a miss. The
 * dispatch webhook's bearer token is never read: only `enabled` and `events`,
 * which is all the executor resolution needs.
 */
import { db } from '@buildd/core/db';
import { workspaces } from '@buildd/core/db/schema';
import { and, eq } from 'drizzle-orm';
import { sqlWhere } from '@buildd/core/db/relational-sql';
import { cachedTeamRead } from './team-cache';

type Row = typeof workspaces.$inferSelect;

export interface WorkspaceSettingsRow extends Pick<Row,
  'id' | 'name' | 'repo' | 'teamId' | 'gitConfig' | 'configStatus' | 'accessMode' | 'releaseConfig' | 'workTrackerConfig' | 'maxConcurrentTasks'> {
  webhookConfig: { enabled?: unknown; events?: unknown } | null;
  /** A Date from the database, an ISO string from the cache (JSON). */
  newStartsPausedUntil: Date | string | null;
}

export async function loadWorkspaceSettingsUncached(teamId: string, workspaceId: string): Promise<WorkspaceSettingsRow | null> {
  const row = await db.query.workspaces.findFirst({
    where: sqlWhere(and(eq(workspaces.id, workspaceId), eq(workspaces.teamId, teamId))),
    columns: {
      id: true,
      name: true,
      repo: true,
      teamId: true,
      gitConfig: true,
      configStatus: true,
      accessMode: true,
      releaseConfig: true,
      workTrackerConfig: true,
      webhookConfig: true,
      maxConcurrentTasks: true,
      newStartsPausedUntil: true,
    },
  });
  if (!row) return null;
  const hook = row.webhookConfig as { enabled?: unknown; events?: unknown } | null;
  return {
    id: row.id,
    name: row.name,
    repo: row.repo ?? null,
    teamId: row.teamId,
    gitConfig: row.gitConfig ?? null,
    configStatus: row.configStatus,
    accessMode: row.accessMode,
    releaseConfig: row.releaseConfig ?? null,
    workTrackerConfig: row.workTrackerConfig ?? null,
    webhookConfig: hook ? { enabled: hook.enabled, events: hook.events } : null,
    maxConcurrentTasks: row.maxConcurrentTasks,
    newStartsPausedUntil: row.newStartsPausedUntil ?? null,
  };
}

export function loadWorkspaceSettings(teamId: string, workspaceId: string): Promise<WorkspaceSettingsRow | null> {
  return cachedTeamRead(teamId, 'workspace-settings', () => loadWorkspaceSettingsUncached(teamId, workspaceId), {
    workspaceId,
    valid: (v) => v?.teamId === teamId && v.id === workspaceId,
  });
}
