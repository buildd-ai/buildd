/**
 * Loads a conversation's ChatReach (see in-process-api.ts): the conversation
 * team's workspaces that are not sensitive. Evaluated per turn, so a workspace
 * marked sensitive after a conversation started drops out of reach at once.
 *
 * `ownerOf` resolves every object kind a chat route can address by id
 * (reach-rules.ts OwnedKind) to its owning team/workspace.
 *
 * Fails closed: a lookup error yields an empty workspace set, and an owner
 * lookup error reads as "unknown", which is out of reach.
 */

import { eq } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import {
  artifacts, experiments, initiatives, missions, releases, specDiscrepancies, taskSchedules, tasks,
  watchedProjects, workers, workspaceSkills, workspaces,
} from '@buildd/core/db/schema';
import type { ChatObjectOwner, ChatReach } from './in-process-api';
import type { OwnedKind } from './reach-rules';

/** Sensitive by either marker: the column, or the older gitConfig flag. */
export function isStandardWorkspace(ws: { dataClass?: string | null; gitConfig?: { dataClass?: string } | null }): boolean {
  return ws.dataClass === 'standard' && ws.gitConfig?.dataClass !== 'sensitive';
}

type Owner = ChatObjectOwner;

async function one<T>(rows: Promise<T[]>): Promise<T | null> {
  const r = await rows;
  return r[0] ?? null;
}

/** Owner of each id-addressed kind. Every OwnedKind must have an entry (a test checks). */
export const OWNER_LOOKUPS: Record<OwnedKind, (id: string) => Promise<Owner | null>> = {
  task: async (id) => {
    const t = await db.query.tasks.findFirst({
      where: eq(tasks.id, id),
      columns: { workspaceId: true },
      with: { workspace: { columns: { teamId: true } } },
    });
    return t ? { teamId: (t.workspace as { teamId?: string } | null)?.teamId ?? null, workspaceId: t.workspaceId } : null;
  },
  mission: async (id) => {
    const row = await one(db.select({ teamId: missions.teamId, workspaceId: missions.workspaceId })
      .from(missions).where(eq(missions.id, id)).limit(1));
    if (!row) return null;
    // A team-level mission's tasks can sit in any team workspace, and a
    // mission read returns their titles and results.
    const kids = await db.selectDistinct({ workspaceId: tasks.workspaceId }).from(tasks).where(eq(tasks.missionId, id));
    return { ...row, childWorkspaceIds: kids.map(k => k.workspaceId) };
  },
  initiative: async (id) => one(db.select({ teamId: initiatives.teamId, workspaceId: initiatives.workspaceId })
    .from(initiatives).where(eq(initiatives.id, id)).limit(1)),
  worker: async (id) => {
    const row = await one(db.select({ workspaceId: workers.workspaceId }).from(workers).where(eq(workers.id, id)).limit(1));
    return row ? { teamId: null, workspaceId: row.workspaceId } : null;
  },
  artifact: async (id) => {
    const row = await one(db.select({ workspaceId: artifacts.workspaceId, missionId: artifacts.missionId })
      .from(artifacts).where(eq(artifacts.id, id)).limit(1));
    if (!row) return null;
    if (row.workspaceId) return { teamId: null, workspaceId: row.workspaceId };
    // A mission artifact with no workspace belongs to the mission.
    return row.missionId ? OWNER_LOOKUPS.mission(row.missionId) : null;
  },
  schedule: async (id) => {
    const row = await one(db.select({ workspaceId: taskSchedules.workspaceId }).from(taskSchedules).where(eq(taskSchedules.id, id)).limit(1));
    return row ? { teamId: null, workspaceId: row.workspaceId } : null;
  },
  skill: async (id) => one(db.select({ teamId: workspaceSkills.teamId, workspaceId: workspaceSkills.workspaceId })
    .from(workspaceSkills).where(eq(workspaceSkills.id, id)).limit(1)),
  watched_project: async (id) => {
    const row = await one(db.select({ workspaceId: watchedProjects.workspaceId }).from(watchedProjects).where(eq(watchedProjects.id, id)).limit(1));
    return row ? { teamId: null, workspaceId: row.workspaceId } : null;
  },
  discrepancy: async (id) => {
    const row = await one(db.select({ workspaceId: specDiscrepancies.workspaceId }).from(specDiscrepancies).where(eq(specDiscrepancies.id, id)).limit(1));
    return row ? { teamId: null, workspaceId: row.workspaceId } : null;
  },
  release: async (id) => {
    const row = await one(db.select({ workspaceId: releases.workspaceId }).from(releases).where(eq(releases.id, id)).limit(1));
    return row ? { teamId: null, workspaceId: row.workspaceId } : null;
  },
  experiment: async (id) => {
    const row = await one(db.select({ teamId: experiments.teamId }).from(experiments).where(eq(experiments.id, id)).limit(1));
    return row ? { teamId: row.teamId, workspaceId: null } : null;
  },
};

export async function loadChatReach(teamId: string): Promise<ChatReach> {
  let workspaceIds = new Set<string>();
  try {
    const rows = await db.query.workspaces.findMany({
      where: eq(workspaces.teamId, teamId),
      columns: { id: true, dataClass: true, gitConfig: true },
    });
    workspaceIds = new Set(rows.filter(isStandardWorkspace).map(r => r.id));
  } catch (e) {
    console.error('[chat] reach lookup failed; tools see no workspace:', e);
  }

  const ownerOf: ChatReach['ownerOf'] = async (kind, id) => {
    const lookup = OWNER_LOOKUPS[kind];
    if (!lookup) return null;
    try {
      return await lookup(id);
    } catch {
      return null;
    }
  };

  return { teamId, workspaceIds, ownerOf };
}
