/**
 * Per-workspace change version (spec 3ef37387 R-20, AC-4).
 *
 * Each workspace has one counter that goes up when its work changes. List and
 * polling reads (`/api/tasks`, `/api/missions`, `/api/missions/stages`,
 * `/api/missions/recent`, `/api/workers/queue`) send an ETag built from the
 * counters of the workspaces they read; a client that sends it back in
 * If-None-Match gets 304 before any list row is read.
 *
 * Scopes: a workspace id, or `team:<id>` for `/api/missions`, which lists
 * by team (a mission's workspace is optional). Bumped by:
 *   - every noted write of work (lib/work-changed.ts), through
 *     `changeVersionWorkListener` in the composition root (apps/web/src/modules.ts):
 *     the batch's tasks, workers, missions and PRs resolved to their
 *     workspaces and teams in one query, after the response;
 *   - the stored mission summary writer (lib/mission-summary-store.ts), for the
 *     workspaces and teams of the summaries it wrote or the reconcile repaired.
 *
 * Fail-open. With no Redis, or Redis erroring, a read carries no ETag and is
 * answered in full; a bump that fails is lost, which the time bucket bounds.
 *
 * The ETag is a hash of: the counters, the request's path and query, who asked
 * (a list's rows depend on the caller's reach), and a one-minute time bucket.
 * The bucket is the floor for what the counter cannot see: a write path that
 * forgets to note, and answers that move with the clock (the 24 h window of
 * finished tasks, a deferred task coming due, a 7-day delivered window). So a
 * 304 is never more than a minute behind; R-21 polls at most once a minute.
 *
 * Counters live in Upstash (lib/redis.ts `bumpVersionCounters` /
 * `readVersionCounters`): a missing counter starts at the current epoch ms,
 * never at 0, so one that expired cannot repeat a value a client still holds.
 */
import { createHash } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { union } from 'drizzle-orm/pg-core';
import { db } from '@buildd/core/db';
import { missions, tasks, workers, workspaces } from '@buildd/core/db/schema';
import { isUuid } from './uuid';
import { bumpVersionCounters, getKey, readVersionCounters, setWithTtl } from './redis';
import type { WorkChangeBatch } from './work-changed';

/** How long a counter lives after its last bump or read-init. */
export const CHANGE_VERSION_TTL_SEC = 30 * 24 * 60 * 60;
/** The ETag also turns over this often, whatever the counters say. */
export const CHANGE_VERSION_BUCKET_MS = 60_000;

const keyOf = (workspaceId: string) => `buildd:cv:${workspaceId}`;

export interface ChangeVersionStore {
  bump(scopes: readonly string[]): Promise<boolean>;
  /** Counter per scope, in order; null = could not ask. */
  read(scopes: readonly string[]): Promise<string[] | null>;
  /** A cached list body (R-35); null = none, or could not ask. */
  getBody(key: string): Promise<string | null>;
  setBody(key: string, body: string, ttlSec: number): Promise<void>;
}

const bodyKey = (key: string) => `buildd:lc:${key}`;

const redisStore: ChangeVersionStore = {
  bump: (ids) => bumpVersionCounters(ids.map(keyOf), Date.now(), CHANGE_VERSION_TTL_SEC),
  read: (ids) => readVersionCounters(ids.map(keyOf), Date.now(), CHANGE_VERSION_TTL_SEC),
  // Wrapped in an object: the Upstash client JSON-decodes what it reads back, so a bare JSON string would come back parsed.
  getBody: async (key) => {
    const got = await getKey<{ b?: unknown }>(bodyKey(key));
    return got && typeof got.b === 'string' ? got.b : null;
  },
  setBody: async (key, body, ttlSec) => { await setWithTtl(bodyKey(key), { b: body }, ttlSec); },
};

let store: ChangeVersionStore = redisStore;

/** Tests: swap the counter store (null restores Redis). */
export function setChangeVersionStoreForTests(next: ChangeVersionStore | null): void {
  store = next ?? redisStore;
}

/** An in-memory store, for tests and scripts. */
export function memoryChangeVersionStore(): ChangeVersionStore & { counters: Map<string, number>; bodies: Map<string, string> } {
  const counters = new Map<string, number>();
  const bodies = new Map<string, string>();
  return {
    counters,
    bodies,
    async bump(ids) { for (const id of ids) counters.set(id, (counters.get(id) ?? 0) + 1); return true; },
    async read(ids) { return ids.map(id => String(counters.get(id) ?? 0)); },
    async getBody(key) { return bodies.get(key) ?? null; },
    async setBody(key, body) { bodies.set(key, body); },
  };
}

const uniq = (ids: Iterable<string | null | undefined>) =>
  [...new Set([...ids].filter((x): x is string => typeof x === 'string' && x.length > 0))].sort();

/**
 * A team's own scope. `/api/missions` lists by team (a mission's workspace is
 * optional), so it versions on this; every other list on workspace ids.
 */
export const teamChangeScope = (teamId: string) => `team:${teamId}`;

/** Bump these scopes' change versions (workspace ids, or `teamChangeScope`). Never throws. */
export async function bumpChangeVersions(scopes: Iterable<string | null | undefined>): Promise<void> {
  const ids = uniq(scopes);
  if (ids.length === 0) return;
  try {
    await store.bump(ids);
  } catch (err) {
    console.error('[change-version] bump failed:', err);
  }
}

export interface ChangeTagInput {
  /** The scopes whose rows the answer reads: workspace ids, or `teamChangeScope` ids. */
  scopes: readonly string[];
  /** Who asked: a list depends on the caller's reach and identity (account or user id). */
  caller: string;
  now?: number;
}

/**
 * The ETag a list read would answer with right now, or null when the
 * counters cannot be read (then serve the read in full, with no ETag).
 */
export async function changeTag(req: Request, input: ChangeTagInput): Promise<string | null> {
  return (await changeKey(req, input))?.etag ?? null;
}

/**
 * The ETag and the response-cache key (the same hash) for this read now, or
 * null when the counters cannot be read.
 */
async function changeKey(req: Request, input: ChangeTagInput): Promise<{ etag: string; key: string } | null> {
  const ids = uniq(input.scopes);
  let versions: string[] | null;
  try {
    versions = ids.length > 0 ? await store.read(ids) : [];
  } catch {
    versions = null;
  }
  if (!versions || versions.length !== ids.length) return null;
  const url = new URL(req.url);
  const query = [...url.searchParams.entries()].sort(([a, av], [b, bv]) => (a === b ? av.localeCompare(bv) : a.localeCompare(b)));
  const bucket = Math.floor((input.now ?? Date.now()) / CHANGE_VERSION_BUCKET_MS);
  const h = createHash('sha256')
    .update(JSON.stringify([url.pathname, query, input.caller, ids.map((id, i) => `${id}:${versions![i]}`), bucket]))
    .digest('base64url')
    .slice(0, 27);
  return { etag: `W/"cv1-${h}"`, key: h };
}

/** Does If-None-Match name this ETag? Weak comparison, a list of tags, or `*`. */
export function matchesIfNoneMatch(header: string | null | undefined, etag: string): boolean {
  if (!header) return false;
  const bare = (t: string) => t.trim().replace(/^W\//, '');
  const want = bare(etag);
  return header.split(',').some(t => t.trim() === '*' || bare(t) === want);
}

const VALIDATE = 'private, no-cache';

/** 304 Not Modified: no body, the same ETag. */
export function notModifiedResponse(etag: string): Response {
  return new Response(null, { status: 304, headers: { ETag: etag, 'Cache-Control': VALIDATE } });
}

/** How long a cached list body lives (R-35); a bump makes it unreachable sooner. */
export const LIST_CACHE_TTL_SEC = Math.ceil(CHANGE_VERSION_BUCKET_MS / 1000);
/** Bodies larger than this are not cached. */
export const LIST_CACHE_MAX_BYTES = 256 * 1024;

/**
 * Answer a list read with the change version:
 *   - 304 before `load` runs when the client sent the current ETag (R-20);
 *   - the body a previous reader got at this same version, from Redis, when
 *     there is one (R-35), so a second reader costs no database query;
 *   - else `load()`, with the ETag on a 200 and its body cached.
 *
 * The cache key is the ETag's hash: route, query, caller, every scope's
 * counter and the time bucket. So it is never shared across callers, a bump
 * makes the old entry unreachable, and an entry outlives no bucket.
 *
 * The tag is taken BEFORE the rows are read, so a write landing during the
 * read makes the next poll read again rather than keep stale rows.
 */
export async function withChangeVersion<R extends Response>(
  req: Request,
  input: ChangeTagInput,
  load: () => Promise<R>,
): Promise<R | Response> {
  const k = await changeKey(req, input);
  if (k && matchesIfNoneMatch(req.headers.get('if-none-match'), k.etag)) return notModifiedResponse(k.etag);
  if (k) {
    let cached: string | null = null;
    try { cached = await store.getBody(k.key); } catch { cached = null; }
    if (cached !== null) {
      return new Response(cached, {
        status: 200,
        headers: { 'Content-Type': 'application/json', ETag: k.etag, 'Cache-Control': VALIDATE, 'X-Buildd-List-Cache': 'hit' },
      });
    }
  }
  const res = await load();
  if (k && res.status === 200) {
    res.headers.set('ETag', k.etag);
    res.headers.set('Cache-Control', VALIDATE);
    try {
      const body = await res.clone().text();
      if (body.length <= LIST_CACHE_MAX_BYTES) await store.setBody(k.key, body, LIST_CACHE_TTL_SEC);
    } catch (err) {
      console.error('[change-version] list cache write failed:', err);
    }
  }
  return res;
}

/** How long a caller's reach (the scopes it may list) is reused by list reads. */
export const REACH_CACHE_TTL_SEC = 30;

const reachCacheKey = (caller: string) => `reach:${caller}`;

/**
 * Who is asking, as the list cache sees it. Several credentials share one
 * account row (a per-task token, a grant session, a workspace-restricted key
 * all narrow the same account), so the key is the account id plus a hash of
 * everything that narrows what it may read: level, workspace list, scopes,
 * task scope and its delegations. Two callers with different reach never
 * share a key.
 */
export function listCallerKey(caller: { account: Record<string, any> } | { userId: string }): string {
  if ('userId' in caller) return `u:${caller.userId}`;
  const a = caller.account;
  const narrowing = JSON.stringify([
    a.level ?? null, a.type ?? null, a.teamId ?? null,
    Array.isArray(a.workspaceIds) ? [...a.workspaceIds].sort() : a.workspaceIds ?? null,
    Array.isArray(a.scopes) ? [...a.scopes].sort() : a.scopes ?? null,
    a.taskScope ?? null, a.oauthGrantId ?? null, a.oauthUserId ?? a.userId ?? null, a.hostRunner ?? null,
  ]);
  return `a:${a.id}:${createHash('sha256').update(narrowing).digest('base64url').slice(0, 16)}`;
}

/**
 * The scopes a caller may list, reused for `REACH_CACHE_TTL_SEC` (R-35: a
 * repeat list read at the same version makes no database query, and the reach
 * is the one read left before the version check). Keyed by caller, so it is
 * never shared (`listCallerKey`). A revoked link stops widening a list
 * within that TTL. Fail-open: no Redis computes it.
 */
export async function cachedReach(caller: string, compute: () => Promise<string[]>): Promise<string[]> {
  const key = reachCacheKey(caller);
  try {
    const hit = await store.getBody(key);
    if (hit !== null) {
      const ids = JSON.parse(hit);
      if (Array.isArray(ids) && ids.every(x => typeof x === 'string')) return ids;
    }
  } catch { /* compute it */ }
  const ids = await compute();
  try { await store.setBody(key, JSON.stringify(ids), REACH_CACHE_TTL_SEC); } catch { /* best effort */ }
  return ids;
}

// ── Bumping from noted work ───────────────────────────────────────────────

/**
 * The scopes a batch of changed work belongs to, each workspace and its team,
 * in one statement (a union over the kinds of row the batch names).
 */
export async function scopesOfWorkChange(batch: WorkChangeBatch): Promise<string[]> {
  const direct = batch.workspacePrs.map(p => p.workspaceId);
  const prUrls = batch.prs.map(pr => `https://github.com/${pr.repoFullName}/pull/${pr.prNumber}`);
  const taskIds = batch.taskIds.filter(isUuid);
  const workerIds = batch.workerIds.filter(isUuid);
  const missionIds = batch.missionIds.filter(isUuid);
  const ws = { workspaceId: workspaces.id, teamId: workspaces.teamId };
  const parts = [
    taskIds.length > 0 ? db.select(ws).from(tasks).innerJoin(workspaces, eq(workspaces.id, tasks.workspaceId)).where(inArray(tasks.id, taskIds)) : null,
    workerIds.length > 0 ? db.select(ws).from(workers).innerJoin(workspaces, eq(workspaces.id, workers.workspaceId)).where(inArray(workers.id, workerIds)) : null,
    missionIds.length > 0 ? db.select({ workspaceId: missions.workspaceId, teamId: missions.teamId }).from(missions).where(inArray(missions.id, missionIds)) : null,
    prUrls.length > 0 ? db.select(ws).from(workers).innerJoin(workspaces, eq(workspaces.id, workers.workspaceId)).where(inArray(workers.prUrl, prUrls)) : null,
    direct.length > 0 ? db.select(ws).from(workspaces).where(inArray(workspaces.id, direct.filter(isUuid))) : null,
  ].filter(<T>(x: T | null): x is T => x !== null);
  if (parts.length === 0) return [];
  const [first, second, ...rest] = parts;
  type Row = { workspaceId: string | null; teamId: string | null };
  const rows = (second ? await union(first as any, second as any, ...(rest as any[])) : await first) as unknown as Row[];
  return uniq(rows.flatMap(r => [r.workspaceId, r.teamId ? teamChangeScope(r.teamId) : null]));
}

/** The composition root's work-change listener: bump the workspaces and teams a batch touched. */
export async function changeVersionWorkListener(batch: WorkChangeBatch): Promise<void> {
  await bumpChangeVersions(await scopesOfWorkChange(batch));
}
