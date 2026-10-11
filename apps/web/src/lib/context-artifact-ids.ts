import { db } from '@buildd/core/db';
import { artifacts, workspaces } from '@buildd/core/db/schema';
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { isUuid } from '@/lib/uuid';
import { resolveWorkspaceAccess, type WorkspaceAccessCaller } from '@/lib/workspace-access';

/**
 * `contextArtifactIds` on missions and initiatives: artifacts whose content is
 * rendered into planning prompts. Each one must be an artifact the caller could
 * read themselves (GET /api/artifacts/[id]) and must live in a workspace of the
 * owner's team, so naming an id never reads another team's or a restricted
 * workspace's artifact into this team's agents.
 */
export const MAX_CONTEXT_ARTIFACT_IDS = 50;

export type ContextArtifactIdsCheck =
  | { ok: true; ids: string[] }
  | { ok: false; error: string };

export async function checkContextArtifactIds(
  raw: unknown,
  caller: WorkspaceAccessCaller,
  teamId: string,
): Promise<ContextArtifactIdsCheck> {
  if (raw === undefined || raw === null) return { ok: true, ids: [] };
  if (!Array.isArray(raw) || raw.some((id) => typeof id !== 'string')) {
    return { ok: false, error: 'contextArtifactIds must be an array of artifact ids' };
  }
  const ids = [...new Set(raw as string[])];
  if (ids.length > MAX_CONTEXT_ARTIFACT_IDS) {
    return { ok: false, error: `contextArtifactIds takes at most ${MAX_CONTEXT_ARTIFACT_IDS} ids` };
  }
  if (ids.length === 0) return { ok: true, ids };

  const bad: string[] = ids.filter((id) => !isUuid(id));
  const rows = await db
    .select({ id: artifacts.id, workspaceId: artifacts.workspaceId, teamId: workspaces.teamId })
    .from(artifacts)
    .leftJoin(workspaces, eq(workspaces.id, artifacts.workspaceId))
    .where(inArray(artifacts.id, ids.filter(isUuid)));
  const byId = new Map(rows.map((r) => [r.id, r]));

  const readable = new Map<string, boolean>();
  for (const id of ids.filter(isUuid)) {
    const row = byId.get(id);
    if (!row?.workspaceId || row.teamId !== teamId) {
      bad.push(id);
      continue;
    }
    if (!readable.has(row.workspaceId)) {
      readable.set(row.workspaceId, (await resolveWorkspaceAccess(row.workspaceId, caller)).ok);
    }
    if (!readable.get(row.workspaceId)) bad.push(id);
  }

  // One message for missing and unreadable alike: existence outside the
  // caller's reach is not confirmed.
  if (bad.length) {
    return { ok: false, error: `contextArtifactIds not found or not accessible: ${bad.join(', ')}` };
  }
  return { ok: true, ids };
}

/**
 * Read-side scope for rendering `contextArtifactIds` into context: the ids, and
 * only artifacts in a workspace of the owning team. Rows written before
 * {@link checkContextArtifactIds} existed are never trusted.
 */
export function contextArtifactsWhere(ids: readonly string[], teamId: string): SQL {
  return and(
    inArray(artifacts.id, [...ids]),
    // Plain identifiers: a relational query (db.query.*) re-aliases every
    // interpolated column onto its own table, subquery included.
    sql`${artifacts.workspaceId} in (select ctx_ws.id from workspaces ctx_ws where ctx_ws.team_id = ${teamId})`,
  )!;
}
