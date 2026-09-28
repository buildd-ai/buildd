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

/**
 * `recent` sorts by what the list prints as lastActivityAt (latest task start or
 * task update), falling back to updatedAt so a mission with no tasks is not NULL
 * (NULLs sort first under desc). With `q`, an exact title match ranks first so a
 * full title is reachable however many newer missions contain it.
 */
export function missionListOrderBy(sort: MissionListSort, q?: string | null): SQL[] {
  const title = q?.trim();
  const exactFirst = title ? [desc(sql`lower(${missions.title}) = lower(${title})`)] : [];
  if (sort === 'recent') {
    // Raw identifiers inside the subquery: db.query re-aliases every Column
    // chunk in orderBy to the root table, which would turn tasks.x into missions.x.
    const lastTaskUpdate = sql`(select max(t.updated_at) from tasks t where t.mission_id = ${missions.id})`;
    return [
      ...exactFirst,
      desc(sql`coalesce(greatest(${missions.lastTaskStartedAt}, ${lastTaskUpdate}), ${missions.updatedAt})`),
      desc(missions.createdAt),
    ];
  }
  return [...exactFirst, desc(missions.priority), desc(missions.lastTaskStartedAt), desc(missions.updatedAt)];
}
