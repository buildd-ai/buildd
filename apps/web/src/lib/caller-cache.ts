/**
 * Who is calling, and what they reach, cached in Redis for at most 60 s.
 *
 * Every authenticated request used to re-resolve its caller from the
 * database: the key's account row, an OAuth grant and the memberships it
 * rests on, a per-task token's account and delegations, a session's user
 * row. This caches each of those answers, shared by every server instance,
 * so a repeated call makes no query to say who it is.
 *
 * Correctness rules, in order of importance:
 *
 *  1. Only an answer that lets the caller in is stored. A refusal (null) is
 *     never cached, so a grant, a new membership or a new link takes effect on
 *     the very next call.
 *  2. Each entry names the facts it rests on (its deps: `account:<id>`,
 *     `user:<id>`, `grant:<id>`, `workspace:<id>`, ...) and records each
 *     fact's generation when it was written. A change calls
 *     `clearCallerCache(dep)`, which gives that fact a new generation, and
 *     every entry resting on it stops matching at once, on every instance.
 *     Generations are random tokens, never counters, so a generation key that
 *     expires and is written again can never match an older entry.
 *  3. The generations of deps known before the load (from the cache key) are
 *     read before the database is, so a clear that races the load leaves the
 *     entry already stale rather than fresh.
 *  4. No entry outlives CALLER_CACHE_MAX_TTL_SEC, so a change with no clear
 *     hook still takes effect within 60 s. There is no in-process layer: an
 *     instance-local copy could not be cleared from another instance.
 *  5. Redis down or erroring: every read goes to the database (fail open to
 *     the DB, never to "allowed"), and nothing is written.
 *  6. No Redis configured at all (local dev, CI): a read that opts in with
 *     `localWithoutRedis` is kept in process under the same rules, as the
 *     hottest reads were before this cache existed. No instance shares a cache
 *     then; a clear reaches this instance at once, others within the TTL.
 */
import { getKey, getKeys, setWithTtl, delKey, isRedisConfigured } from './redis';

export const CALLER_CACHE_MAX_TTL_SEC = 60;
/** Must outlive every entry; any value above the entry TTL is safe (rule 2). */
const GEN_TTL_SEC = 24 * 60 * 60;

/** A fact an entry rests on: `<kind>:<id>`. */
export type CallerDep = string;

export const callerDep = {
  /** An account row: key, level, scopes, workspace list, links. */
  account: (id: string): CallerDep => `account:${id}`,
  /** An account's workspace links (account_workspaces rows). */
  accountLinks: (id: string): CallerDep => `account-links:${id}`,
  /** The stored key hash of an account: every existing account hook clears by it. */
  keyHash: (hash: string): CallerDep => `keyhash:${hash}`,
  /** A person: their memberships and their own row. */
  user: (id: string): CallerDep => `user:${id}`,
  /** A team: its accounts and members as a whole. */
  team: (id: string): CallerDep => `team:${id}`,
  /** An account-level MCP OAuth grant. */
  grant: (id: string): CallerDep => `grant:${id}`,
  /** A workspace: its team, access mode and data class. */
  workspace: (id: string): CallerDep => `workspace:${id}`,
  /** A task: its delegation. */
  task: (id: string): CallerDep => `task:${id}`,
  /** The schedules of a workspace: their delegations. */
  workspaceSchedules: (workspaceId: string): CallerDep => `schedules:${workspaceId}`,
  /**
   * Which workspaces a team holds: one created in it, moved into or out of it,
   * or deleted. A grant covering the team as a whole rests on it.
   */
  teamWorkspaces: (teamId: string): CallerDep => `team-workspaces:${teamId}`,
  /** Which of a team's workspaces are open to its accounts: a workspace created open, opened, closed or moved. */
  teamOpenWorkspaces: (teamId: string): CallerDep => `team-open:${teamId}`,
};

interface Entry<T> {
  v: T;
  /** Deps. */
  d: CallerDep[];
  /** Their generations when written, null = never cleared. */
  s: (string | null)[];
}

export interface CachedCallerOptions<T> {
  /** Deps the key already names; read before the load (rule 3). */
  known?: readonly CallerDep[];
  /** Deps only the loaded value names. */
  depsOf?: (value: T) => readonly CallerDep[];
  /** Capped at CALLER_CACHE_MAX_TTL_SEC; below 1 s the value is not stored. */
  ttlSec?: number | ((value: T) => number);
  /** A cached value failing this is a miss (e.g. written before a column existed). */
  valid?: (value: T) => boolean;
  /** Rule 6: with no Redis configured, keep this read in process. */
  localWithoutRedis?: boolean;
}

const entryKey = (key: string) => `buildd:caller:${key}`;
const genKey = (dep: CallerDep) => `buildd:caller-gen:${dep}`;

// The client parses stored JSON, so compare as strings; a token with letters
// in it cannot be read back as a number.
const norm = (g: unknown): string | null => (g == null ? null : String(g));
const newGeneration = () => `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

/** Rule 6's store. Entries are JSON, as in Redis: the same shape on a hit, and no shared object to mutate. */
const LOCAL_MAX = 5_000;
const localEntries = new Map<string, { json: string; expiresAt: number }>();
// An evicted generation reads as null, so an entry that recorded it misses.
const localGens = new Map<string, string>();
function boundedSet<V>(map: Map<string, V>, k: string, v: V) {
  map.delete(k);
  if (map.size >= LOCAL_MAX) map.delete(map.keys().next().value!);
  map.set(k, v);
}
const local = {
  get(k: string): unknown {
    const e = localEntries.get(k);
    if (!e) return null;
    if (Date.now() >= e.expiresAt) { localEntries.delete(k); return null; }
    return JSON.parse(e.json);
  },
  gens: async (ks: string[]) => ks.map((k) => localGens.get(k) ?? null),
  set: async (k: string, entry: unknown, ttlSec: number) => {
    boundedSet(localEntries, k, { json: JSON.stringify(entry), expiresAt: Date.now() + ttlSec * 1000 });
    return true;
  },
};

function isEntry<T>(raw: unknown): raw is Entry<T> {
  if (!raw || typeof raw !== 'object') return false;
  const e = raw as Entry<T>;
  return 'v' in e && Array.isArray(e.d) && Array.isArray(e.s) && e.d.length === e.s.length;
}

/**
 * The cached answer for `key`, or `load()`'s, stored when it is non-null.
 * Null from `load` (a refusal) is returned and never stored.
 */
export async function cachedCaller<T>(
  key: string,
  load: () => Promise<T | null | undefined>,
  opts: CachedCallerOptions<T> = {},
): Promise<T | null> {
  const shared = isRedisConfigured();
  if (!shared && !opts.localWithoutRedis) return (await load()) ?? null;
  const readGens = shared ? (ks: string[]) => getKeys<unknown>(ks) : local.gens;

  const ek = entryKey(key);
  const hit = shared ? await getKey<unknown>(ek) : local.get(ek);
  if (isEntry<T>(hit)) {
    const now = await readGens(hit.d.map(genKey));
    if (now && now.every((g, i) => norm(g) === norm(hit.s[i])) && (!opts.valid || opts.valid(hit.v))) return hit.v;
  }

  const known = [...new Set(opts.known ?? [])];
  const before = await readGens(known.map(genKey));
  const value = await load();
  if (value == null) return null;
  // Could not read a generation: the entry could not be checked later either.
  if (!before) return value;

  const extra = [...new Set(opts.depsOf?.(value) ?? [])].filter((d) => !known.includes(d));
  const after = await readGens(extra.map(genKey));
  if (!after) return value;

  const wanted = typeof opts.ttlSec === 'function' ? opts.ttlSec(value) : opts.ttlSec ?? CALLER_CACHE_MAX_TTL_SEC;
  const ttl = Math.floor(Math.min(CALLER_CACHE_MAX_TTL_SEC, wanted));
  if (!(ttl >= 1)) return value;
  const entry: Entry<T> = { v: value, d: [...known, ...extra], s: [...before, ...after].map(norm) };
  await (shared ? setWithTtl(ek, entry, ttl) : local.set(ek, entry, ttl));
  return value;
}

/**
 * A fact changed: every cached caller resting on it is stale from now on, on
 * every instance. Awaited by callers that answer only after the change is in
 * effect; never throws. False when Redis could not take the write (entries
 * then end on their TTL).
 */
export async function clearCallerCache(...deps: CallerDep[]): Promise<boolean> {
  const unique = [...new Set(deps.filter(Boolean))];
  if (unique.length === 0) return true;
  if (!isRedisConfigured()) {
    for (const d of unique) boundedSet(localGens, genKey(d), newGeneration());
    return true;
  }
  const results = await Promise.all(unique.map((d) => setWithTtl(genKey(d), newGeneration(), GEN_TTL_SEC)));
  return results.every(Boolean);
}

/** Drop one entry by its key (when the key itself, not a fact, is what changed). */
export async function dropCallerEntry(key: string): Promise<void> {
  localEntries.delete(entryKey(key));
  if (isRedisConfigured()) await delKey(entryKey(key));
}
