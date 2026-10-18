/**
 * Per-team reads cached in Redis for at most 30 s: the team's plan, a
 * workspace's settings row, the runner list and the questions waiting.
 * Pages read each of these several times, and every server instance shares
 * the answer.
 *
 * Built on the caller cache's generation scheme (lib/caller-cache.ts), so the
 * same rules hold: an entry names the team (and the kind of read) it rests
 * on, `clearTeamCache` gives that a new generation and every entry on it stops
 * matching at once, on every instance; nothing outlives
 * TEAM_CACHE_MAX_TTL_SEC; Redis down means every read goes to the database
 * and nothing is stored. A null load is returned and not stored.
 *
 * These are reads of team data, not answers about who may see it: callers
 * check access first and pass a team they already know the caller reaches.
 */
import { cachedCaller, clearCallerCache, type CallerDep } from './caller-cache';

export const TEAM_CACHE_MAX_TTL_SEC = 30;

export type TeamCacheKind = 'plan' | 'workspace-settings' | 'runners' | 'questions';

const teamDep = (teamId: string): CallerDep => `team-data:${teamId}`;
const kindDep = (teamId: string, kind: TeamCacheKind): CallerDep => `team-data:${teamId}:${kind}`;
/** One workspace's settings row: its writers know the workspace, not always the team. */
const workspaceSettingsDep = (workspaceId: string): CallerDep => `workspace-settings:${workspaceId}`;

/**
 * The cached answer for this team's `kind` read (`key` tells apart reads of
 * one kind, e.g. one workspace's settings), or `load()`'s.
 */
export function cachedTeamRead<T>(
  teamId: string,
  kind: TeamCacheKind,
  load: () => Promise<T | null | undefined>,
  opts: {
    key?: string;
    /** A one-workspace read: clearWorkspaceSettingsCache(workspaceId) ends it too. */
    workspaceId?: string;
    /** Facts only the value names (caller-cache deps, e.g. each runner's links): a clear of one ends the entry. */
    depsOf?: (value: T) => readonly CallerDep[];
    ttlSec?: number;
    valid?: (value: T) => boolean;
    /** With no Redis configured, keep it in process (lib/caller-cache.ts rule 6). */
    localWithoutRedis?: boolean;
  } = {},
): Promise<T | null> {
  const ttl = Math.min(TEAM_CACHE_MAX_TTL_SEC, opts.ttlSec ?? TEAM_CACHE_MAX_TTL_SEC);
  const key = [opts.workspaceId, opts.key].filter(Boolean).join(':');
  return cachedCaller<T>(`team:${teamId}:${kind}${key ? `:${key}` : ''}`, load, {
    known: [teamDep(teamId), kindDep(teamId, kind), ...(opts.workspaceId ? [workspaceSettingsDep(opts.workspaceId)] : [])],
    depsOf: opts.depsOf,
    ttlSec: ttl,
    valid: opts.valid,
    localWithoutRedis: opts.localWithoutRedis,
  });
}

/**
 * Something about the team changed: its cached reads of `kinds` (all of
 * them when none is named) are stale from now on, on every instance. Never
 * throws; false when Redis could not take the write.
 */
export async function clearTeamCache(teamId: string | null | undefined, ...kinds: TeamCacheKind[]): Promise<boolean> {
  if (!teamId) return true;
  return clearCallerCache(...(kinds.length ? kinds.map(k => kindDep(teamId, k)) : [teamDep(teamId)]));
}

/**
 * A workspace's row changed: its cached settings read is stale from now on.
 * For writers that know the workspace but not its team. Never throws.
 */
export function clearWorkspaceSettingsCache(workspaceId: string | null | undefined): Promise<boolean> {
  if (!workspaceId) return Promise.resolve(true);
  return clearCallerCache(workspaceSettingsDep(workspaceId));
}
