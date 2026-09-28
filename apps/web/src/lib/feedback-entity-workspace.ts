/**
 * Where a rated piece of AI content lives: its workspace, or (for team-level
 * content with no workspace) its team.
 *
 * Feedback rows name an entity (type + id) and nothing else. Accepting a vote
 * needs to know the rater can reach that content, and turning votes into
 * memory needs to know whose project the lesson belongs to, so the mapping
 * lives here once:
 *
 *   note          -> mission_notes.mission_id -> missions (workspace, else team)
 *   orchestration -> missions (entity id is the mission)
 *   artifact      -> artifacts.workspace_id, else its mission's team, else its initiative's team
 *   heartbeat     -> tasks.workspace_id (entity id is the task)
 *   summary       -> tasks.workspace_id (`task-<id>-summary` / `task-<id>-suggestion`)
 *
 * Anything else (chat turns, malformed ids, deleted rows) does not resolve.
 * Ids that are not UUIDs are never sent to the database.
 */
import { db } from '@buildd/core/db';
import { missionNotes, missions, artifacts, tasks, initiatives } from '@buildd/core/db/schema';
import { inArray } from 'drizzle-orm';
import { isUuid } from './uuid';

export type FeedbackEntityType = 'note' | 'artifact' | 'summary' | 'orchestration' | 'heartbeat' | 'conversation_message';

export interface FeedbackEntityRef<K> {
  key: K;
  entityType: FeedbackEntityType | string;
  entityId: string;
}

/**
 * The content's home. Workspace content is gated by workspace access (which
 * also yields the team); team-level content carries its team instead.
 */
export type FeedbackEntityHome =
  | { workspaceId: string; teamId?: undefined }
  | { workspaceId: null; teamId: string };

const SUMMARY_ENTITY_RE = /^task-(.+)-(?:summary|suggestion)$/;

/** The task id inside a summary entity id, when it is well-formed. */
function summaryTaskId(entityId: string): string | null {
  const id = SUMMARY_ENTITY_RE.exec(entityId)?.[1];
  return id && isUuid(id) ? id : null;
}

type MissionHome = { workspaceId: string | null; teamId: string };

function homeOf(h: { workspaceId: string | null; teamId?: string | null } | undefined): FeedbackEntityHome | undefined {
  if (!h) return undefined;
  if (h.workspaceId) return { workspaceId: h.workspaceId };
  if (h.teamId) return { workspaceId: null, teamId: h.teamId };
  return undefined;
}

/** Home per caller key, for every ref that resolves. */
export async function resolveFeedbackEntityHomes<K>(
  refs: ReadonlyArray<FeedbackEntityRef<K>>,
): Promise<Map<K, FeedbackEntityHome>> {
  const idsOf = (type: string) => [...new Set(
    refs.filter(r => r.entityType === type && isUuid(r.entityId)).map(r => r.entityId),
  )];

  const noteIds = idsOf('note');
  const artifactIds = idsOf('artifact');
  const taskIds = [...new Set([
    ...idsOf('heartbeat'),
    ...refs.filter(r => r.entityType === 'summary').map(r => summaryTaskId(r.entityId)).filter((id): id is string => !!id),
  ])];

  const noteMission = new Map<string, string>();
  if (noteIds.length > 0) {
    const rows = await db.query.missionNotes.findMany({
      where: inArray(missionNotes.id, noteIds),
      columns: { id: true, missionId: true },
    });
    for (const n of rows) if (n.missionId) noteMission.set(n.id, n.missionId);
  }

  type ArtifactRow = { id: string; workspaceId: string | null; missionId: string | null; initiativeId: string | null };
  const artifactRows = new Map<string, ArtifactRow>();
  if (artifactIds.length > 0) {
    const rows = await db.query.artifacts.findMany({
      where: inArray(artifacts.id, artifactIds),
      columns: { id: true, workspaceId: true, missionId: true, initiativeId: true },
    });
    for (const a of rows) artifactRows.set(a.id, a);
  }

  const missionIds = [...new Set([
    ...noteMission.values(),
    ...idsOf('orchestration'),
    ...[...artifactRows.values()].filter(a => !a.workspaceId && a.missionId).map(a => a.missionId!),
  ])];
  const missionHome = new Map<string, MissionHome>();
  if (missionIds.length > 0) {
    const rows = await db.query.missions.findMany({
      where: inArray(missions.id, missionIds),
      columns: { id: true, workspaceId: true, teamId: true },
    });
    for (const m of rows) missionHome.set(m.id, { workspaceId: m.workspaceId, teamId: m.teamId });
  }

  const initiativeIds = [...new Set(
    [...artifactRows.values()].filter(a => !a.workspaceId && !a.missionId && a.initiativeId).map(a => a.initiativeId!),
  )];
  const initiativeTeam = new Map<string, string>();
  if (initiativeIds.length > 0) {
    const rows = await db.query.initiatives.findMany({
      where: inArray(initiatives.id, initiativeIds),
      columns: { id: true, teamId: true },
    });
    for (const i of rows) initiativeTeam.set(i.id, i.teamId);
  }

  const taskWs = new Map<string, string>();
  if (taskIds.length > 0) {
    const rows = await db.query.tasks.findMany({
      where: inArray(tasks.id, taskIds),
      columns: { id: true, workspaceId: true },
    });
    for (const t of rows) if (t.workspaceId) taskWs.set(t.id, t.workspaceId);
  }

  const artifactHome = (id: string): FeedbackEntityHome | undefined => {
    const a = artifactRows.get(id);
    if (!a) return undefined;
    if (a.workspaceId) return { workspaceId: a.workspaceId };
    if (a.missionId) return homeOf(missionHome.get(a.missionId));
    if (a.initiativeId) return homeOf({ workspaceId: null, teamId: initiativeTeam.get(a.initiativeId) });
    return undefined;
  };
  const taskHome = (id: string | null): FeedbackEntityHome | undefined => {
    const ws = id ? taskWs.get(id) : undefined;
    return ws ? { workspaceId: ws } : undefined;
  };

  const out = new Map<K, FeedbackEntityHome>();
  for (const r of refs) {
    let home: FeedbackEntityHome | undefined;
    switch (r.entityType) {
      case 'note': home = homeOf(missionHome.get(noteMission.get(r.entityId) ?? '')); break;
      case 'orchestration': home = homeOf(missionHome.get(r.entityId)); break;
      case 'artifact': home = artifactHome(r.entityId); break;
      case 'heartbeat': home = taskHome(r.entityId); break;
      case 'summary': home = taskHome(summaryTaskId(r.entityId)); break;
    }
    if (home) out.set(r.key, home);
  }
  return out;
}

/** Workspace id per caller key, for refs that resolve to a workspace (team-level content is left out). */
export async function resolveFeedbackEntityWorkspaces<K>(
  refs: ReadonlyArray<FeedbackEntityRef<K>>,
): Promise<Map<K, string>> {
  const homes = await resolveFeedbackEntityHomes(refs);
  const out = new Map<K, string>();
  for (const [k, h] of homes) if (h.workspaceId) out.set(k, h.workspaceId);
  return out;
}

/** Where one rated entity lives, or null when it does not resolve. */
export async function resolveFeedbackEntityHome(
  entityType: FeedbackEntityType | string,
  entityId: string,
): Promise<FeedbackEntityHome | null> {
  const out = await resolveFeedbackEntityHomes([{ key: 0, entityType, entityId }]);
  return out.get(0) ?? null;
}
