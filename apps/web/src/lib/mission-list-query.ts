import { and, desc, eq, ilike, inArray, notInArray, sql, type SQL } from 'drizzle-orm';
import { missions } from '@buildd/core/db/schema';

export type MissionListSort = 'priority' | 'recent';

/** `?sort=recent` → newest activity first; anything else keeps the dashboard's priority order. */
export function parseMissionListSort(raw: string | null | undefined): MissionListSort {
  return raw === 'recent' ? 'recent' : 'priority';
}

/** Escape LIKE metacharacters so a title fragment matches literally. */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, '\\$&');
}

export function buildMissionListWhere(opts: {
  teamIds: string[];
  status?: string | null;
  workspaceId?: string | null;
  q?: string | null;
}): SQL {
  const parts: SQL[] = [inArray(missions.teamId, opts.teamIds)];
  if (opts.status === 'open') {
    // Everything still in play: the list an agent means by "my missions".
    parts.push(notInArray(missions.status, ['completed', 'archived']));
  } else if (opts.status) {
    parts.push(eq(missions.status, opts.status as any));
  }
  if (opts.workspaceId) parts.push(eq(missions.workspaceId, opts.workspaceId));
  const q = opts.q?.trim();
  if (q) parts.push(ilike(missions.title, `%${escapeLike(q)}%`));
  return parts.length === 1 ? parts[0] : and(...parts)!;
}

export function missionListOrderBy(sort: MissionListSort): SQL[] {
  if (sort === 'recent') {
    // greatest() skips NULLs, so a mission with no task start sorts by updatedAt.
    return [desc(sql`greatest(${missions.lastTaskStartedAt}, ${missions.updatedAt})`), desc(missions.createdAt)];
  }
  return [desc(missions.priority), desc(missions.lastTaskStartedAt), desc(missions.updatedAt)];
}
