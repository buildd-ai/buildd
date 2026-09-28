/**
 * The workspace a rated piece of AI content belongs to.
 *
 * Feedback rows name an entity (type + id) and nothing else. Accepting a vote
 * needs to know the rater can reach that workspace, and turning votes into
 * memory needs to know whose project the lesson belongs to, so the mapping
 * lives here once:
 *
 *   note          -> mission_notes.mission_id -> missions.workspace_id
 *   orchestration -> missions.workspace_id (entity id is the mission)
 *   artifact      -> artifacts.workspace_id
 *   heartbeat     -> tasks.workspace_id (entity id is the task)
 *   summary       -> tasks.workspace_id (`task-<id>-summary` / `task-<id>-suggestion`)
 *
 * Anything else (chat turns, malformed ids, deleted rows) resolves to nothing.
 * Ids that are not UUIDs are never sent to the database.
 */
import { db } from '@buildd/core/db';
import { missionNotes, missions, artifacts, tasks } from '@buildd/core/db/schema';
import { inArray } from 'drizzle-orm';
import { isUuid } from './uuid';

export type FeedbackEntityType = 'note' | 'artifact' | 'summary' | 'orchestration' | 'heartbeat' | 'conversation_message';

export interface FeedbackEntityRef<K> {
  key: K;
  entityType: FeedbackEntityType | string;
  entityId: string;
}

const SUMMARY_ENTITY_RE = /^task-(.+)-(?:summary|suggestion)$/;

/** The task id inside a summary entity id, when it is well-formed. */
function summaryTaskId(entityId: string): string | null {
  const id = SUMMARY_ENTITY_RE.exec(entityId)?.[1];
  return id && isUuid(id) ? id : null;
}

/** Workspace id per caller key, for every ref that resolves. */
export async function resolveFeedbackEntityWorkspaces<K>(
  refs: ReadonlyArray<FeedbackEntityRef<K>>,
): Promise<Map<K, string>> {
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

  const missionIds = [...new Set([...noteMission.values(), ...idsOf('orchestration')])];
  const missionWs = new Map<string, string>();
  if (missionIds.length > 0) {
    const rows = await db.query.missions.findMany({
      where: inArray(missions.id, missionIds),
      columns: { id: true, workspaceId: true },
    });
    for (const m of rows) if (m.workspaceId) missionWs.set(m.id, m.workspaceId);
  }

  const artifactWs = new Map<string, string>();
  if (artifactIds.length > 0) {
    const rows = await db.query.artifacts.findMany({
      where: inArray(artifacts.id, artifactIds),
      columns: { id: true, workspaceId: true },
    });
    for (const a of rows) if (a.workspaceId) artifactWs.set(a.id, a.workspaceId);
  }

  const taskWs = new Map<string, string>();
  if (taskIds.length > 0) {
    const rows = await db.query.tasks.findMany({
      where: inArray(tasks.id, taskIds),
      columns: { id: true, workspaceId: true },
    });
    for (const t of rows) if (t.workspaceId) taskWs.set(t.id, t.workspaceId);
  }

  const out = new Map<K, string>();
  for (const r of refs) {
    let ws: string | undefined;
    switch (r.entityType) {
      case 'note': ws = missionWs.get(noteMission.get(r.entityId) ?? ''); break;
      case 'orchestration': ws = missionWs.get(r.entityId); break;
      case 'artifact': ws = artifactWs.get(r.entityId); break;
      case 'heartbeat': ws = taskWs.get(r.entityId); break;
      case 'summary': ws = taskWs.get(summaryTaskId(r.entityId) ?? ''); break;
    }
    if (ws) out.set(r.key, ws);
  }
  return out;
}

/** The workspace one rated entity belongs to, or null. */
export async function resolveFeedbackEntityWorkspace(
  entityType: FeedbackEntityType | string,
  entityId: string,
): Promise<string | null> {
  const out = await resolveFeedbackEntityWorkspaces([{ key: 0, entityType, entityId }]);
  return out.get(0) ?? null;
}
