/**
 * The per-workspace change version (spec 3ef37387 R-20, AC-4): list and
 * polling reads answer "not changed" (304) to a client that already holds the
 * current version, without reading list rows.
 *
 * A version is a random token per scope (`ws:<workspaceId>`, `team:<teamId>`)
 * in Redis. A write replaces it with a fresh token, never an increment: a key
 * that expired or was evicted comes back as a new token, so an old ETag can
 * never match again by accident. Writers:
 *   - every noted write of work (lib/work-changed.ts), through the composition
 *     root's listener: the batch's tasks, workers, missions and PRs resolved to
 *     their workspaces and teams in one round of reads;
 *   - the stored mission summary writer (lib/mission-summary-store.ts), after
 *     it writes, since the mission reads serve those rows.
 * A workspace bump also bumps its team, for the team-scoped mission list.
 *
 * Readers build an ETag from the route, the caller, the query, the versions of
 * every scope the read covers, and a time bucket. The bucket bounds what no
 * note covers: a read whose answer moves with the clock (a 24 h window, a
 * cooldown) and a write path that forgets to note. Read the versions BEFORE
 * the rows: a write that lands between is then tagged with the older version
 * and the next poll reads again.
 *
 * Fails open. With Redis unconfigured, erroring or a scope never seen, there is
 * no ETag and the read answers in full; a missing scope is seeded so the next
 * read can match.
 */
import { createHash, randomBytes } from 'node:crypto';
import { NextResponse } from 'next/server';
import { eq, inArray, or } from 'drizzle-orm';
import * as redis from './redis';

/** How long a version lives with no write; refreshed on every bump. */
export const CHANGE_VERSION_TTL_SEC = 30 * 86_400;

/** The ETag's time bucket when a read names none. */
export const DEFAULT_BUCKET_MS = 5 * 60_000;

export const wsScope = (id: string) => `ws:${id}`;
export const teamScope = (id: string) => `team:${id}`;
const keyOf = (scope: string) => `buildd:cv:${scope}`;

export interface ChangeVersionTargets {
  workspaceIds?: Iterable<string | null | undefined>;
  teamIds?: Iterable<string | null | undefined>;
  missionIds?: Iterable<string | null | undefined>;
  taskIds?: Iterable<string | null | undefined>;
  workerIds?: Iterable<string | null | undefined>;
  workspacePrs?: Iterable<{ workspaceId: string; prNumber: number } | null | undefined>;
  prs?: Iterable<{ repoFullName: string; prNumber: number } | null | undefined>;
}

export interface ChangeVersionDeps {
  getKeys: (keys: string[]) => Promise<Array<string | null> | undefined>;
  setKeys: (entries: Array<[string, string]>, ttlSec: number, opts?: { nx?: boolean }) => Promise<boolean>;
  /** Workspace and team of each named row: one round of reads. */
  resolve: (t: { missionIds: string[]; taskIds: string[]; workerIds: string[]; workspaceIds: string[]; repos: string[] }) => Promise<Array<{ workspaceId: string | null; teamId: string | null }>>;
  token: () => string;
}

const ids = (xs?: Iterable<string | null | undefined>) => [...new Set([...(xs ?? [])].filter((x): x is string => typeof x === 'string' && x.length > 0))];

export const defaultChangeVersionDeps: ChangeVersionDeps = {
  // A test that mocks lib/redis without these gets no versions, never a throw.
  getKeys: async (keys) => (redis as Partial<typeof redis>).mgetKeys?.<string>(keys),
  setKeys: async (entries, ttl, opts) => (await (redis as Partial<typeof redis>).setKeys?.(entries, ttl, opts)) ?? false,
  resolve: async ({ missionIds, taskIds, workerIds, workspaceIds, repos }) => {
    const { db } = await import('@buildd/core/db');
    const { missions, tasks, workers, workspaces } = await import('@buildd/core/db/schema');
    type Row = { workspaceId: string | null; teamId: string | null };
    const reads: Array<Promise<Row[]>> = [];
    if (taskIds.length > 0) {
      reads.push(db.select({ workspaceId: tasks.workspaceId, teamId: workspaces.teamId }).from(tasks)
        .innerJoin(workspaces, eq(workspaces.id, tasks.workspaceId)).where(inArray(tasks.id, taskIds)));
    }
    if (workerIds.length > 0) {
      reads.push(db.select({ workspaceId: workers.workspaceId, teamId: workspaces.teamId }).from(workers)
        .innerJoin(workspaces, eq(workspaces.id, workers.workspaceId)).where(inArray(workers.id, workerIds)));
    }
    if (missionIds.length > 0) {
      reads.push(db.select({ workspaceId: missions.workspaceId, teamId: missions.teamId }).from(missions).where(inArray(missions.id, missionIds)));
    }
    const byWorkspace = [
      ...(workspaceIds.length > 0 ? [inArray(workspaces.id, workspaceIds)] : []),
      ...(repos.length > 0 ? [inArray(workspaces.repo, repos)] : []),
    ];
    if (byWorkspace.length > 0) {
      reads.push(db.select({ workspaceId: workspaces.id, teamId: workspaces.teamId }).from(workspaces).where(or(...byWorkspace)));
    }
    return (await Promise.all(reads)).flat();
  },
  token: () => `${Date.now().toString(36)}.${randomBytes(6).toString('hex')}`,
};

export function createChangeVersions(deps: ChangeVersionDeps) {
  /** Replace the version of every scope these rows belong to. Never throws. */
  async function bump(t: ChangeVersionTargets): Promise<string[]> {
    try {
      const workspaceIds = ids(t.workspaceIds);
      for (const pr of t.workspacePrs ?? []) if (pr?.workspaceId) workspaceIds.push(pr.workspaceId);
      const repos = ids([...(t.prs ?? [])].map(pr => pr?.repoFullName));
      const lookup = { missionIds: ids(t.missionIds), taskIds: ids(t.taskIds), workerIds: ids(t.workerIds), workspaceIds: ids(workspaceIds), repos };
      const scopes = new Set<string>(ids(t.teamIds).map(teamScope));
      if (lookup.missionIds.length + lookup.taskIds.length + lookup.workerIds.length + lookup.workspaceIds.length + repos.length > 0) {
        for (const r of await deps.resolve(lookup)) {
          if (r.workspaceId) scopes.add(wsScope(r.workspaceId));
          if (r.teamId) scopes.add(teamScope(r.teamId));
        }
      }
      if (scopes.size === 0) return [];
      const token = deps.token();
      await deps.setKeys([...scopes].map(s => [keyOf(s), token]), CHANGE_VERSION_TTL_SEC);
      return [...scopes].sort();
    } catch (err) {
      console.error('[change-version] bump failed:', err);
      return [];
    }
  }

  /**
   * The current version of each scope, in order; null when any is unknown
   * (Redis unavailable, or a scope never written: seeded here for next time).
   */
  async function read(scopes: string[]): Promise<string[] | null> {
    try {
      const values = await deps.getKeys(scopes.map(keyOf));
      if (!values || values.length !== scopes.length) return null;
      const missing = scopes.filter((_, i) => typeof values[i] !== 'string' || !values[i]);
      if (missing.length > 0) {
        await deps.setKeys(missing.map(s => [keyOf(s), deps.token()]), CHANGE_VERSION_TTL_SEC, { nx: true });
        return null;
      }
      return values as string[];
    } catch {
      return null;
    }
  }

  return { bump, read };
}

let store = createChangeVersions(defaultChangeVersionDeps);

/** Tests: swap the module's store; returns the previous one. */
export function setChangeVersionsForTests(next: ReturnType<typeof createChangeVersions>) {
  const prev = store;
  store = next;
  return prev;
}

/** Replace the version of every workspace and team these rows belong to. Never throws. */
export function bumpChangeVersions(t: ChangeVersionTargets): Promise<string[]> {
  return store.bump(t);
}

export interface ListTagInput {
  /** The route, e.g. `/api/tasks`. */
  route: string;
  /** Who is asking: the answer may differ per caller over the same scopes. */
  caller: string;
  /** Every workspace and team scope the answer reads. */
  scopes: string[];
  /** The query that shapes the answer, and anything else it depends on. */
  vary?: Array<string | number | boolean | null | undefined>;
  bucketMs?: number;
  now?: number;
}

/** The read's ETag, or null when it cannot be versioned (fail open: answer in full). */
export async function listTag(input: ListTagInput): Promise<string | null> {
  const scopes = [...new Set(input.scopes)].sort();
  if (scopes.length === 0) return null;
  const versions = await store.read(scopes);
  if (!versions) return null;
  const bucket = Math.floor((input.now ?? Date.now()) / (input.bucketMs ?? DEFAULT_BUCKET_MS));
  const h = createHash('sha256')
    .update(JSON.stringify([input.route, input.caller, input.vary ?? [], bucket, scopes, versions]))
    .digest('base64url')
    .slice(0, 22);
  return `W/"cv1-${h}"`;
}

/** The sorted query string, for `vary`. */
export function queryKey(params: URLSearchParams): string {
  return [...params.entries()].sort(([a, x], [b, y]) => (a === b ? x.localeCompare(y) : a.localeCompare(b))).map(([k, v]) => `${k}=${v}`).join('&');
}

/** Does If-None-Match hold this tag (weak comparison, a list, or `*`)? */
export function ifNoneMatchHolds(header: string | null | undefined, tag: string | null): boolean {
  if (!header || !tag) return false;
  const bare = (t: string) => t.trim().replace(/^W\//, '');
  const want = bare(tag);
  return header.split(',').some(t => t.trim() === '*' || bare(t) === want);
}

const CACHE_CONTROL = 'private, no-cache';

/** 304 for a client that holds `tag`, else null. */
export function notModifiedFor(req: { headers: Headers }, tag: string | null): NextResponse | null {
  if (!ifNoneMatchHolds(req.headers.get('if-none-match'), tag)) return null;
  return new NextResponse(null, { status: 304, headers: { ETag: tag!, 'Cache-Control': CACHE_CONTROL } });
}

/** Stamp a full answer with its tag (nothing when there is none). */
export function withTag<T extends Response>(res: T, tag: string | null): T {
  if (tag && res.status === 200) {
    res.headers.set('ETag', tag);
    res.headers.set('Cache-Control', CACHE_CONTROL);
  }
  return res;
}
